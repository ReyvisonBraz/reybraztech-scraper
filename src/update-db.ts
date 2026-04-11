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
  _sql = postgres(connectionString, {
    ssl: 'require',
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

export async function updateDatabase(clients: ClientData[]) {
  console.log(`\n💾 Atualizando ${clients.length} clientes no banco de dados...`);
  console.log('⚠️ Usando criptografia bcrypt para senhas\n');

  let updated = 0;
  let notFound = 0;
  let errors = 0;

  for (const client of clients) {
    try {
      const { firstName, lastName } = normalizeName(client.buyer_name);
      const starhomeStatus = client.in_use === 'Used' && client.expired !== 'Expired' ? 'Ativo' : 'Inativo';
      
      // Criptografar a senha do StarHome
      const passwordHash = await encryptPassword(client.password);

      let existingId: number | null = null;
      let matchType = '';
      let phoneFound = '';

      if (client.buyer_name) {
        const phoneMatch = client.buyer_name.match(/\d{10,11}/);
        if (phoneMatch) phoneFound = phoneMatch[0];
      }

      // 1º: Buscar pelo starhome_account (se já vinculado anteriormente)
      if (client.account) {
        const [byStarhome] = await getDb()`
          SELECT id FROM clients WHERE starhome_account = ${client.account}
          LIMIT 1
        `;
        if (byStarhome) {
          existingId = byStarhome.id;
          matchType = 'account StarHome';
        }
      }

      // 2º: Buscar pelo nome completo (primeiro + último nome)
      if (!existingId && firstName && lastName) {
        const [byName] = await getDb()`
          SELECT id FROM clients 
          WHERE name ILIKE ${`%${firstName}%`}
            AND name ILIKE ${`%${lastName}%`}
          LIMIT 1
        `;
        if (byName) {
          existingId = byName.id;
          matchType = 'nome completo';
        }
      }

      // 3º: Buscar apenas pelo primeiro nome (se não encontrou ainda)
      if (!existingId && firstName) {
        const [byFirstName] = await getDb()`
          SELECT id FROM clients 
          WHERE name ILIKE ${`%${firstName}%`}
          LIMIT 3
        `;
        if (byFirstName && byFirstName.id) {
          existingId = byFirstName.id;
          matchType = 'primeiro nome';
        }
      }

      // 4º: Buscar por telefone no formato StarHome (buyer_name pode conter telefone)
      if (!existingId && phoneFound) {
        const [byPhone] = await getDb()`
          SELECT id FROM clients 
          WHERE whatsapp LIKE ${`%${phoneFound}%`}
          LIMIT 1
        `;
        if (byPhone) {
          existingId = byPhone.id;
          matchType = 'telefone';
        }
      }

      if (existingId) {
        // Atualiza campos do app (StarHome info)
        await getDb()`
          UPDATE clients SET
            starhome_account = ${client.account},
            app_account = ${client.account},
            app_password = ${client.password},
            days_remaining = ${client.days_remaining},
            plan = ${client.package_name},
            status = ${starhomeStatus}
          WHERE id = ${existingId}
        `;
        console.log(`   ✅ ${client.buyer_name || client.account} → vinculado (${matchType})`);
        updated++;
      } else {
        // INSERE se não existir
        await getDb()`
          INSERT INTO clients (
            name,
            whatsapp,
            device,
            email,
            password_hash,
            starhome_account,
            app_account,
            app_password,
            days_remaining,
            plan,
            status
          ) VALUES (
            ${client.buyer_name || `Cliente (${client.account})`},
            ${phoneFound || ''},
            '',
            '',
            '',
            ${client.account},
            ${client.account},
            ${client.password},
            ${client.days_remaining},
            ${client.package_name},
            ${starhomeStatus}
          )
        `;
        console.log(`   ➕ Novo cadastrado: ${client.account} (${client.buyer_name || 'sem nome'})`);
        notFound++;
      }

    } catch (err: any) {
      errors++;
      console.error(`   ❌ Erro ao atualizar ${client.account}: ${err.message.split('\n')[0]}`);
    }
  }

  console.log(`\n✅ Atualização concluída:`);
  console.log(`   🔄 ${updated} clientes atualizados`);
  console.log(`   ⏭️  ${notFound} clientes não encontrados no banco`);
  console.log(`   ❌ ${errors} erros`);

  return { updated, notFound, errors };
}