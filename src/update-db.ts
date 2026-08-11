// Usa variáveis de ambiente do sistema (não carrega .env)
import * as path from 'path';
import postgres from 'postgres';
import bcrypt from 'bcryptjs';

interface ClientData {
  account: string;
  password: string;
  days_remaining: number;
  package_name: string;
  buyer_name: string;
  in_use: string;
  expired: string;
  expiration_date: string | null;
  first_login?: string | null;
  creation_time?: string | null;
}

// ── Conexão lazy: só conecta quando updateDatabase() é chamada ──────────────
// Isso permite que --search funcione localmente sem DATABASE_URL
let _sql: ReturnType<typeof postgres> | null = null;

function getDb() {
  if (_sql) return _sql;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('❌ DATABASE_URL não definido no .env (necessário para --sync)');
  }
  const useSsl = process.env.DATABASE_SSL !== 'false';
  _sql = postgres(connectionString, {
    ssl: useSsl ? 'require' : false,
    max: 10,
    idle_timeout: 20,
    prepare: false,
  });
  return _sql;
}

function normalizeName(name: string): { firstName: string; lastName: string } {
  if (!name || name.trim() === '') {
    return { firstName: '', lastName: '' };
  }
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || '';
  const lastName = parts.slice(1).join(' ') || '';
  return { firstName, lastName };
}

async function encryptPassword(password: string): Promise<string> {
  try {
    const salt = await bcrypt.genSalt(10);
    return await bcrypt.hash(password, salt);
  } catch (err) {
    console.error('❌ Erro ao criptografar senha:', err);
    return password;
  }
}

/**
 * Atualiza um único cliente no banco pelo starhome_account.
 * Usado após renew para evitar sync completo.
 * 2 queries: 1 SELECT + 1 UPDATE. Sem bcrypt, sem matching por nome.
 */
export async function updateSingleClient(client: ClientData): Promise<void> {
  const starhomeStatus = client.in_use === 'Used' && client.expired !== 'Expired' ? 'Ativo' : 'Inativo';
  const now = new Date();
  const expirationDate = client.expiration_date ? new Date(client.expiration_date) : null;

  const [row] = await getDb()`
    SELECT id FROM clients WHERE starhome_account = ${client.account} LIMIT 1
  `;

  if (!row) {
    console.log(`   ⚠️  ${client.account} não encontrado no banco — pulando atualização pós-renew`);
    return;
  }

  await getDb()`
    UPDATE clients SET
      app_password             = ${client.password},
      starhome_password        = ${client.password},
      days_remaining           = ${client.days_remaining},
      plan                     = ${client.package_name},
      status                   = ${starhomeStatus},
      starhome_days_remaining  = ${client.days_remaining},
      starhome_in_use          = ${client.in_use},
      starhome_package         = ${client.package_name},
      starhome_expiration_date = ${expirationDate},
      starhome_last_sync       = ${now}
    WHERE id = ${row.id}
  `;
  console.log(`   ✅ ${client.buyer_name || client.account} → atualizado pós-renew (${client.days_remaining} dias)`);
}

export async function updateDatabase(clients: ClientData[]) {
  console.log(`\n💾 Sincronizando ${clients.length} clientes no banco...`);

  const now = new Date();
  const sql = getDb();
  let updated = 0;
  let inserted = 0;
  let errors = 0;

  // ── Pré-carrega todos os clientes existentes do banco em 2 queries ──
  type DbClient = { id: number; starhome_account: string | null; name: string; whatsapp: string | null };
  const existing = await sql`SELECT id, starhome_account, name, whatsapp FROM clients`;

  // Cria mapas para lookup rápido
  const byStarhome = new Map<string, number>();
  for (const row of existing) {
    if (row.starhome_account) byStarhome.set(row.starhome_account, row.id);
  }

  // ── Processa cada cliente em lote ──
  const updates: any[] = [];
  const inserts: any[] = [];

  for (const client of clients) {
    try {
      const starhomeStatus = client.in_use === 'Used' && client.expired !== 'Expired' ? 'Ativo' : 'Inativo';
      const expirationDate = client.expiration_date ? new Date(client.expiration_date) : null;

      let phoneFound = '';
      if (client.buyer_name) {
        const phoneMatch = client.buyer_name.match(/\d{10,11}/);
        if (phoneMatch) phoneFound = phoneMatch[0];
      }

      // Tenta encontrar por starhome_account primeiro (mais rápido)
      let existingId = byStarhome.get(client.account);

      // Fallback: busca por nome/whatsapp se não encontrou por account
      if (!existingId) {
        const { firstName, lastName } = normalizeName(client.buyer_name);

        for (const row of existing) {
          // Nome completo
          if (firstName && lastName && row.name &&
              row.name.toLowerCase().includes(firstName.toLowerCase()) &&
              row.name.toLowerCase().includes(lastName.toLowerCase())) {
            existingId = row.id;
            break;
          }
          // Primeiro nome
          if (firstName && row.name &&
              row.name.toLowerCase().includes(firstName.toLowerCase())) {
            existingId = row.id;
            break;
          }
          // WhatsApp
          if (phoneFound && row.whatsapp && row.whatsapp.includes(phoneFound)) {
            existingId = row.id;
            break;
          }
        }
      }

      if (existingId) {
        // UPDATE em lote (sem bcrypt - starhome_password fica em plaintext)
        updates.push(sql`
          UPDATE clients SET
            starhome_account         = ${client.account},
            starhome_password        = ${client.password},
            app_account              = CASE WHEN app_account IS NULL OR app_account = '' THEN ${client.account} ELSE app_account END,
            app_password             = CASE WHEN app_password IS NULL OR app_password = '' THEN ${client.password} ELSE app_password END,
            days_remaining           = ${client.days_remaining},
            plan                     = ${client.package_name},
            status                   = ${starhomeStatus},
            starhome_days_remaining  = ${client.days_remaining},
            starhome_in_use          = ${client.in_use},
            starhome_package         = ${client.package_name},
            starhome_expiration_date = ${expirationDate},
            starhome_last_sync       = ${now}
          WHERE id = ${existingId}
        `);
        updated++;
      } else {
        // INSERT em lote (com bcrypt só pra password_hash do app)
        const passwordHash = await encryptPassword(client.password);
        inserts.push(sql`
          INSERT INTO clients (
            name, whatsapp, device, email, password_hash,
            starhome_account, app_account, app_password,
            days_remaining, plan, status,
            starhome_days_remaining, starhome_in_use, starhome_package,
            starhome_expiration_date, starhome_last_sync
          ) VALUES (
            ${client.buyer_name || `Cliente (${client.account})`},
            ${phoneFound || null}, '', '',
            ${passwordHash},
            ${client.account}, ${client.account}, ${client.password},
            ${client.days_remaining}, ${client.package_name}, ${starhomeStatus},
            ${client.days_remaining}, ${client.in_use}, ${client.package_name},
            ${expirationDate}, ${now}
          )
        `);
        inserted++;
      }
    } catch (err: any) {
      errors++;
      console.error(`   ❌ Erro ${client.account}: ${err.message.split('\n')[0]}`);
    }
  }

  // ── Executa tudo em paralelo ──
  await Promise.allSettled([...updates, ...inserts]);

  console.log(`\n✅ Sincronização concluída:`);
  console.log(`   🔄 ${updated} atualizados`);
  console.log(`   ➕ ${inserted} novos`);
  console.log(`   ❌ ${errors} erros`);

  return { updated, notFound: inserted, errors };
}
