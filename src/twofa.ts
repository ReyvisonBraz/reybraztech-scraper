/**
 * twofa.ts — Módulo de 2FA
 *
 * Atende a dois modos:
 *  - Modo compartilhado (sessão persistente): login e API rodam no MESMO
 *    processo. Usa um canal em memória (resolver da Promise), rápido e sem
 *    arquivos órfãos.
 *  - Modo filho (spawn de dist/index.js): o child aguarda o código e o pai
 *    serve o POST /2fa. Usa IPC por arquivo com sessionId + TTL.
 *
 * Em ambos os modos o estado de espera é modelado com um identificador de
 * tentativa e uma expiração, e o servidor expõe `waiting | consumed | accepted
 * | rejected/expired | none` ao Console.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import * as crypto from 'crypto';

const OUTPUT_DIR   = path.join(__dirname, '..', 'output');
const WAITING_FILE = path.join(OUTPUT_DIR, '2fa_waiting.flag');
const CODE_FILE    = path.join(OUTPUT_DIR, '2fa_code.txt');

/** TTL padrão de uma tentativa de 2FA (5 min) */
export const DEFAULT_2FA_TTL_MS = 300000;

/** Quanto tempo o estado terminal (consumed/accepted/rejected) fica observável
 * após o fim da espera, antes de voltar a `none`. */
export const TERMINAL_RETENTION_MS = 15000;

export type TwoFAState =
  | 'none'       // sem tentativa ativa
  | 'waiting'    // aguardando código
  | 'consumed'   // código recebido, processando/confirmando no painel
  | 'accepted'   // código aceito pelo StarHome, autenticação concluída
  | 'rejected';  // código recusado, expirado ou falha no fluxo

interface WaitingPayload {
  sessionId: string;
  message: string;
  timestamp: string;
  expiresAt: number;
  state: TwoFAState;
}

/** Estado em memória usado quando login e API compartilham o processo. */
let activeWait: {
  sessionId: string;
  expiresAt: number;
  state: TwoFAState;
  resolve?: (code: string | null) => void;
} | null = null;

function ensureOutput() {
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function now(): number {
  return Date.now();
}

/** Gera um id único por tentativa de 2FA. */
export function new2FASessionId(): string {
  return crypto.randomUUID();
}

/** Remove arquivos de estado de 2FA (sem lançar). */
export function clear2FAFiles() {
  try { if (fs.existsSync(WAITING_FILE)) fs.unlinkSync(WAITING_FILE); } catch {}
  try { if (fs.existsSync(CODE_FILE))    fs.unlinkSync(CODE_FILE);    } catch {}
}

/**
 * Limpa estado de 2FA que sobrou de um processo morto. Deve ser chamado no
 * boot do servidor para não aceitar códigos sem consumidor.
 */
export function cleanupStale2FA(): void {
  if (fs.existsSync(WAITING_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf-8'));
      if (typeof raw.expiresAt !== 'number' || now() > raw.expiresAt) {
        clear2FAFiles();
        console.log('  🧹 Estado 2FA velho/expirado removido no boot.');
      }
    } catch {
      // Arquivo corrompido ou sem TTL — remove para não persistir estado morto
      clear2FAFiles();
    }
  } else if (fs.existsSync(CODE_FILE)) {
    clear2FAFiles();
  }
}

/**
 * Sinaliza que o scraper está aguardando um código 2FA para esta tentativa.
 * Retorna o sessionId da tentativa.
 */
export function signal2FAWaiting(sessionId: string, message = 'Código 2FA necessário', ttlMs = DEFAULT_2FA_TTL_MS): string {
  ensureOutput();
  if (fs.existsSync(CODE_FILE)) fs.unlinkSync(CODE_FILE);

  const payload: WaitingPayload = {
    sessionId,
    message,
    timestamp: new Date().toISOString(),
    expiresAt: now() + ttlMs,
    state: 'waiting',
  };
  fs.writeFileSync(WAITING_FILE, JSON.stringify(payload));
  console.log(`  🚩 Sinalização de 2FA escrita (session=${sessionId}, ttl=${Math.round(ttlMs / 1000)}s)`);
  return sessionId;
}

/**
 * Lê o estado de espera atual, considerando expiração e, opcionalmente, o
 * sessionId da tentativa esperada.
 */
export function get2FAStatus(expectedSessionId?: string): {
  state: TwoFAState;
  sessionId: string | null;
  remainingMs: number;
  matches: boolean;
} {
  // Prioridade: estado em memória (modo compartilhado)
  if (activeWait) {
    const remainingMs = activeWait.expiresAt - now();
    if (remainingMs <= 0) {
      // Memória expirou: remove também o arquivo da mesma sessão para que o
      // estado terminal não "reapareça" vindo do fallback na chamada seguinte.
      const expiredSession = activeWait.sessionId;
      activeWait = null;
      if (fs.existsSync(WAITING_FILE)) {
        try {
          const raw = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf-8')) as Partial<WaitingPayload>;
          if (raw.sessionId === expiredSession) fs.unlinkSync(WAITING_FILE);
        } catch {}
      }
      return { state: 'none', sessionId: null, remainingMs: 0, matches: true };
    }
    if (expectedSessionId && activeWait.sessionId !== expectedSessionId) {
      // Existe uma sessão ativa, mas pertence a outra tentativa.
      return { state: activeWait.state, sessionId: activeWait.sessionId, remainingMs, matches: false };
    }
    return { state: activeWait.state, sessionId: activeWait.sessionId, remainingMs, matches: true };
  }

  // Fallback: arquivo (modo filho)
  if (fs.existsSync(WAITING_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf-8')) as Partial<WaitingPayload>;
      const remainingMs = typeof raw.expiresAt === 'number' ? raw.expiresAt - now() : 0;
      if (remainingMs <= 0) {
        clear2FAFiles();
        return { state: 'none', sessionId: null, remainingMs: 0, matches: true };
      }
      const sessionId = raw.sessionId ?? null;
      if (expectedSessionId && sessionId !== expectedSessionId) {
        return { state: raw.state ?? 'waiting', sessionId, remainingMs, matches: false };
      }
      return { state: raw.state ?? 'waiting', sessionId, remainingMs, matches: true };
    } catch {
      return { state: 'none', sessionId: null, remainingMs: 0, matches: true };
    }
  }
  return { state: 'none', sessionId: null, remainingMs: 0, matches: true };
}

/** Verifica se há espera ativa para o sessionId dado. */
export function is2FAWaiting(sessionId?: string): boolean {
  return get2FAStatus(sessionId).state === 'waiting';
}

/** Marca o estado atual da tentativa (consumed/accepted/rejected).
 * Para estados terminais, estende expiresAt por TERMINAL_RETENTION_MS em
 * memória E no arquivo, para que o status seja observável o mesmo tempo nos
 * dois modos (compartilhado e filho). */
export function set2FAState(sessionId: string, state: TwoFAState): void {
  const isTerminal = state === 'consumed' || state === 'accepted' || state === 'rejected';
  const terminalExpiry = now() + TERMINAL_RETENTION_MS;
  if (activeWait && activeWait.sessionId === sessionId) {
    activeWait.state = state;
    if (isTerminal) activeWait.expiresAt = terminalExpiry;
  }
  if (fs.existsSync(WAITING_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(WAITING_FILE, 'utf-8')) as WaitingPayload;
      if (raw.sessionId === sessionId) {
        raw.state = state;
        if (isTerminal) raw.expiresAt = terminalExpiry;
        fs.writeFileSync(WAITING_FILE, JSON.stringify(raw));
      }
    } catch {}
  }
}

/**
 * Entrega o código 2FA. Valida TTL e, se informado, o sessionId da tentativa.
 * Retorna detalhe do resultado para o servidor propagar o status correto.
 */
export function deliver2FACode(
  code: string,
  opts?: { sessionId?: string },
): { ok: boolean; error?: string; status: TwoFAState } {
  const expected = opts?.sessionId;
  const status = get2FAStatus(expected);

  if (status.state === 'none') {
    return { ok: false, status: 'none', error: 'Nenhuma sessão 2FA aguardando código no momento.' };
  }
  if (!status.matches) {
    return { ok: false, status: status.state, error: 'Sessão 2FA divergente: o código pertence a outra tentativa.' };
  }
  if (status.state !== 'waiting') {
    return { ok: false, status: status.state, error: `Sessão 2FA já ${status.state === 'consumed' ? 'recebeu um código' : 'finalizada'}.` };
  }

  const normalized = code.trim();
  if (!/^\d{6}$/.test(normalized)) {
    return { ok: false, status: status.state, error: 'Código 2FA deve conter exatamente 6 dígitos.' };
  }

  const sid = status.sessionId as string;

  // Modo compartilhado: resolve a Promise que o login aguarda.
  if (activeWait && activeWait.sessionId === sid && activeWait.resolve) {
    activeWait.state = 'consumed';
    activeWait.resolve(normalized);
    console.log(`  🔐 Código 2FA entregue via memória (session=${sid}).`);
    return { ok: true, status: 'consumed' };
  }

  // Modo filho: grava o arquivo que o child lê.
  ensureOutput();
  fs.writeFileSync(CODE_FILE, normalized);
  set2FAState(sid, 'consumed');
  console.log(`  🔐 Código 2FA entregue via arquivo (session=${sid}).`);
  return { ok: true, status: 'consumed' };
}

/**
 * Aguarda o código 2FA:
 *  - Modo compartilhado: registra um resolver em memória e aguarda a Promise.
 *  - Modo filho: polling do arquivo 2fa_code.txt (escrito pelo POST /2fa).
 *  - Fallback (terminal local): readline.
 */
export async function waitFor2FACode(
  sessionId: string,
  timeoutMs = DEFAULT_2FA_TTL_MS,
  label = 'código 2FA',
): Promise<string | null> {
  ensureOutput();
  signal2FAWaiting(sessionId, `Aguardando ${label}`, timeoutMs);

  const start = now();
  const pollInterval = 2000;
  const isTTY = process.stdin.isTTY;

  console.log(`  ⏳ Aguardando ${label} (session=${sessionId}, timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  if (!isTTY) {
    // Modo servidor (Render) ou processo filho.
    // Se este processo também serve a API (modo compartilhado), registra o
    // resolver para entrega em memória; o polling de arquivo cobre o modo filho.
    const inMemory = new Promise<string | null>((resolve) => {
      activeWait = {
        sessionId,
        expiresAt: start + timeoutMs,
        state: 'waiting',
        resolve,
      };
    });

    let aborted = false;
    const fromFile = (async () => {
      let elapsed = 0;
      while (elapsed < timeoutMs) {
        if (aborted) break;
        if (get2FAStatus(sessionId).state !== 'waiting') {
          break;
        }
        if (fs.existsSync(CODE_FILE)) {
          const code = fs.readFileSync(CODE_FILE, 'utf-8').trim();
          if (code) {
            fs.unlinkSync(CODE_FILE);
            console.log(`  ✅ ${label} recebido via arquivo: "${code}"`);
            return code;
          }
        }
        await new Promise(r => setTimeout(r, pollInterval));
        elapsed += pollInterval;
        if (elapsed % 30000 === 0) {
          console.log(`  ⏳ Ainda aguardando ${label}... ${Math.round(elapsed / 1000)}s / ${Math.round(timeoutMs / 1000)}s`);
        }
      }
      return null;
    })();

    const code = await Promise.race([inMemory, fromFile]);

    // Fim da espera: marca o estado e mantém o registro por um curto TTL para
    // que accepted/rejected (definidos por loginToPanel) fiquem observáveis.
    // set2FAState estende expiresAt para TERMINAL_RETENTION_MS em memória e no
    // arquivo, mantendo ambos os modos (compartilhado/filho) coerentes.
    aborted = true;
    if (activeWait && activeWait.sessionId === sessionId) {
      activeWait.resolve = undefined;
      set2FAState(sessionId, code ? 'consumed' : 'rejected');
    }
    // No modo filho, persiste o estado terminal no arquivo para o pai ler.
    if (fs.existsSync(WAITING_FILE) && !code) {
      set2FAState(sessionId, 'rejected');
    }

    if (code) {
      console.log(`  ✅ ${label} recebido: "${code}"`);
      return code;
    }
    console.log(`  ⏰ Timeout: nenhum ${label} recebido.`);
    return null;
  }

  // Modo local: lê do terminal E do arquivo em paralelo.
  console.log(`  💡 LOCAL: Digite o código no terminal OU aguarde o painel Admin enviar.`);
  return new Promise<string | null>((resolve) => {
    let resolved = false;
    activeWait = { sessionId, expiresAt: start + timeoutMs, state: 'waiting' };

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  🖐  ${label}: `, (answer) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        activeWait = null;
        clear2FAFiles();
        resolve(answer.trim() || null);
      }
    });

    const poll = setInterval(() => {
      if (resolved) { clearInterval(poll); return; }
      if (now() - start > timeoutMs) {
        if (!resolved) { resolved = true; clearInterval(poll); rl.close(); activeWait = null; clear2FAFiles(); resolve(null); }
        return;
      }
      if (fs.existsSync(CODE_FILE)) {
        const code = fs.readFileSync(CODE_FILE, 'utf-8').trim();
        if (code && !resolved) {
          resolved = true;
          clearInterval(poll);
          rl.close();
          activeWait = null;
          clear2FAFiles();
          console.log(`\n  ✅ ${label} recebido via painel Admin: "${code}"`);
          resolve(code);
        }
      }
    }, pollInterval);
  });
}
