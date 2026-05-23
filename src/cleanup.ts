import * as fs from 'fs';
import * as path from 'path';

const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const RESULT_FILES = new Set([
  'clients_extracted.json',
  'client_search.json',
  'renew_result.json',
]);

/** Só salva screenshot se NÃO estiver em produção headless */
export function shouldSaveScreenshots(): boolean {
  return process.env.HEADLESS !== 'true';
}

/** Salva screenshot apenas em modo debug (headless=false) */
export async function debugScreenshot(
  page: any,
  filePath: string
): Promise<void> {
  if (!shouldSaveScreenshots()) return;
  try {
    await page.screenshot({ path: filePath });
  } catch {
    // ignora erro de screenshot
  }
}

/** Limpa arquivos temporários do output/ mantendo apenas jobs/ */
export function cleanupOutput(): void {
  if (!fs.existsSync(OUTPUT_DIR)) return;

  const files = fs.readdirSync(OUTPUT_DIR);
  let deleted = 0;

  for (const file of files) {
    const fullPath = path.join(OUTPUT_DIR, file);
    const stat = fs.statSync(fullPath);

    // Mantém o diretório jobs/ (usado pelo servidor REST)
    if (stat.isDirectory() && file === 'jobs') continue;
    if (!stat.isDirectory() && RESULT_FILES.has(file)) continue;

    try {
      if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        fs.unlinkSync(fullPath);
      }
      deleted++;
    } catch {
      // ignora erros de permissão
    }
  }

  if (deleted > 0) {
    console.log(`  🗑️  ${deleted} arquivos temporários removidos de output/`);
  }
}
