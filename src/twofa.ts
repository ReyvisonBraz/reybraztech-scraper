/**
 * twofa.ts — Módulo de 2FA via arquivo compartilhado
 *
 * Funciona tanto localmente (readline terminal) quanto no Render (arquivo temp).
 * O servidor (server.ts) escreve o code no arquivo 2fa_code.txt.
 * O filho (login.ts) lê esse arquivo e continua o fluxo.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const OUTPUT_DIR   = path.join(__dirname, '..', 'output');
const WAITING_FILE = path.join(OUTPUT_DIR, '2fa_waiting.flag');
const CODE_FILE    = path.join(OUTPUT_DIR, '2fa_code.txt');

/** Garante que o diretório de output existe */
function ensureOutput() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

/** Sinaliza que o scraper está aguardando um código 2FA */
export function signal2FAWaiting(message = 'Código 2FA necessário') {
  ensureOutput();
  // Remove código antigo se existir
  if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);
  // Escreve o arquivo de sinalização
  fs.writeFileSync(WAITING_FILE, JSON.stringify({
    waiting: true,
    message,
    timestamp: new Date().toISOString(),
  }));
  console.log('  🚩 Sinalização de 2FA escrita em output/2fa_waiting.flag');
}

/** Limpa os arquivos de 2FA após uso */
export function clear2FAFiles() {
  try { if (fs.existsSync(WAITING_FILE)) fs.unlinkSync(WAITING_FILE); } catch {}
  try { if (fs.existsSync(CODE_FILE))    fs.unlinkSync(CODE_FILE);    } catch {}
}

/**
 * Aguarda o código 2FA:
 * 1. Polling do arquivo 2fa_code.txt (escrito pelo servidor via POST /2fa)
 * 2. Fallback: readline do terminal (para testes locais)
 */
export async function waitFor2FACode(
  timeoutMs = 300000,
  label = 'código 2FA'
): Promise<string | null> {
  ensureOutput();
  signal2FAWaiting(`Aguardando ${label}`);

  const start = Date.now();
  const pollInterval = 2000;
  const isTTY = process.stdin.isTTY; // true = terminal real, false = pipe/servidor

  console.log(`  ⏳ Aguardando ${label} (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  if (isTTY) {
    // ─── Modo local: lê do terminal E do arquivo em paralelo ──────────────
    console.log(`  💡 LOCAL: Digite o código no terminal OU aguarde o painel Admin enviar.`);

    return new Promise<string | null>((resolve) => {
      let resolved = false;

      // Readline para terminal
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(`\n  🖐  ${label}: `, (answer) => {
        if (!resolved) {
          resolved = true;
          rl.close();
          clear2FAFiles();
          resolve(answer.trim() || null);
        }
      });

      // Polling de arquivo em paralelo
      const poll = setInterval(() => {
        if (resolved) { clearInterval(poll); return; }
        if (Date.now() - start > timeoutMs) {
          if (!resolved) { resolved = true; clearInterval(poll); rl.close(); clear2FAFiles(); resolve(null); }
          return;
        }
        if (fs.existsSync(CODE_FILE)) {
          const code = fs.readFileSync(CODE_FILE, 'utf-8').trim();
          if (code && !resolved) {
            resolved = true;
            clearInterval(poll);
            rl.close();
            clear2FAFiles();
            console.log(`\n  ✅ ${label} recebido via painel Admin: "${code}"`);
            resolve(code);
          }
        }
      }, pollInterval);
    });
  } else {
    // ─── Modo servidor (Render): apenas polling de arquivo ─────────────────
    console.log(`  📡 Aguardando ${label} via painel Admin (POST /2fa)...`);
    let elapsed = 0;
    while (elapsed < timeoutMs) {
      if (fs.existsSync(CODE_FILE)) {
        const code = fs.readFileSync(CODE_FILE, 'utf-8').trim();
        if (code) {
          clear2FAFiles();
          console.log(`  ✅ ${label} recebido: "${code}"`);
          return code;
        }
      }
      await new Promise(r => setTimeout(r, pollInterval));
      elapsed += pollInterval;
      if (elapsed % 30000 === 0) {
        console.log(`  ⏳ Ainda aguardando ${label}... ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s`);
      }
    }
    clear2FAFiles();
    console.log(`  ⏰ Timeout: nenhum ${label} recebido.`);
    return null;
  }
}

/** Verifica se o scraper está aguardando 2FA (usado pelo servidor) */
export function is2FAWaiting(): boolean {
  return fs.existsSync(WAITING_FILE);
}

/** Entrega o código 2FA para o scraper (usado pelo servidor no POST /2fa) */
export function deliver2FACode(code: string): boolean {
  if (!fs.existsSync(WAITING_FILE)) return false;
  ensureOutput();
  fs.writeFileSync(CODE_FILE, code.trim());
  console.log(`  🔐 Código 2FA entregue ao scraper: "${code}"`);
  return true;
}
