import * as fs from 'fs';
import * as path from 'path';
import { ClientData } from './scrape';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');

/**
 * Garante que o diretório de output existe.
 */
function ensureOutputDir(): void {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
}

/**
 * Exporta os dados dos clientes para JSON.
 */
export function exportToJSON(clients: ClientData[]): string {
  ensureOutputDir();

  const data = {
    extracted_at: new Date().toISOString(),
    total_clients: clients.length,
    clients: clients,
  };

  const filePath = path.join(OUTPUT_DIR, 'clients.json');
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  console.log(`  💾 JSON salvo: ${filePath}`);
  return filePath;
}

/**
 * Exporta os dados dos clientes para CSV.
 */
export function exportToCSV(clients: ClientData[]): string {
  ensureOutputDir();

  const headers = [
    'Index',
    'Account',
    'Password',
    'Days Remaining',
    'Package',
    'Buyer Name',
    'First Login',
    'Expiration Date',
    'Creation Time',
    'In Use',
    'Expired',
  ];

  const rows = clients.map((c) => [
    c.index,
    c.account,
    c.password,
    c.days_remaining,
    c.package_name,
    `"${c.buyer_name}"`, // aspas para nomes com vírgula
    c.first_login || '',
    c.expiration_date || '',
    c.creation_time || '',
    c.in_use,
    c.expired,
  ].join(','));

  const csv = [headers.join(','), ...rows].join('\n');

  const filePath = path.join(OUTPUT_DIR, 'clients.csv');
  fs.writeFileSync(filePath, csv, 'utf-8');
  console.log(`  💾 CSV salvo: ${filePath}`);
  return filePath;
}

/**
 * Exporta os dados nos dois formatos.
 */
export function exportAll(clients: ClientData[]): { json: string; csv: string } {
  console.log('\n📁 Exportando dados...\n');
  const json = exportToJSON(clients);
  const csv = exportToCSV(clients);
  console.log(`\n  ✅ ${clients.length} clientes exportados com sucesso!\n`);
  return { json, csv };
}
