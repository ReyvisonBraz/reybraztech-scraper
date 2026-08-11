import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';
import puppeteer from 'puppeteer';
import { claimNextJob, markJobDone, markJobFailed, MAX_JOB_ATTEMPTS } from './renewal-queue';
import { notifyRenewComplete, notifyError } from './telegram';
import { loginToPanel } from './login';
import { searchAndExtractClient } from './scrape';
import { renewClient } from './renew';
import { updateSingleClient } from './update-db';

const app = express();
app.use(express.json());

const TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const API_KEY = process.env.SCRAPER_API_KEY;

// ─── Structured Logger ────────────────────────────────────────────────────────
function log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) {
  const entry = {
    level,
    msg,
    ts: new Date().toISOString(),
    ...(meta || {}),
  };
  if (level === 'error') {
    process.stderr.write(JSON.stringify(entry) + '\n');
  } else {
    process.stdout.write(JSON.stringify(entry) + '\n');
  }
}

function sanitizeLogChunk(text: string): string {
  return text
    .replace(/(Senha:\s*)[^\r\n]+/gi, '$1[redacted]')
    .replace(/(Password:\s*)[^\r\n]+/gi, '$1[redacted]');
}

// Remove códigos ANSI/cor antes de expor o stdout do filho como log de progresso.
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

function sanitizeSearchResult(result: { success: boolean; data?: any; error?: string }) {
  if (!result.data) return result;
  return {
    ...result,
    data: result.data.map((client: any) => ({
      ...client,
      password: undefined,
    })),
  };
}

// ─── Telegram helper ──────────────────────────────────────────────────────────
async function sendTelegram(text: string): Promise<void> {
  if (!TOKEN || !CHAT_ID) return;
  try {
    await axios.post(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      chat_id: CHAT_ID, text, parse_mode: 'HTML',
    });
  } catch (err: any) {
    log('warn', 'Failed to send Telegram message', { error: err.message });
  }
}

// ─── Auth middleware ──────────────────────────────────────────────────────────
function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (!API_KEY) {
    log('error', 'SCRAPER_API_KEY not configured — rejecting all requests');
    res.status(500).json({ error: 'Server misconfiguration: SCRAPER_API_KEY not set' });
    return;
  }
  const provided = req.headers['x-api-key'] as string;
  if (!provided || provided !== API_KEY) {
    log('warn', 'Unauthorized scraper API access attempt', { ip: req.ip });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// ─── Concurrency Lock ─────────────────────────────────────────────────────────
// Usamos a referência do ChildProcess (e não o PID cru) para o lock: `kill(pid,0)`
// pode dar falso-positivo se o SO reciclar o PID para outro processo, travando o
// scraper "em execução" para sempre. Com a referência do child, o estado real é
// lido via `exitCode === null` (ainda vivo) - livre de reuso de PID.
let activeChild: import('child_process').ChildProcess | null = null;
let pageBusy = false;

interface ActiveOp { op: string; startedAt: string; query?: string; }
let activeOp: ActiveOp | null = null;

function beginOp(op: Omit<ActiveOp, 'startedAt'>): void {
  activeOp = { ...op, startedAt: new Date().toISOString() };
}
function endOp(): void {
  activeOp = null;
}
function currentOpLabel(): string {
  return activeOp ? `${activeOp.op}${activeOp.query ? ` (${activeOp.query})` : ''} desde ${new Date(activeOp.startedAt).toLocaleTimeString('pt-BR')}` : 'nenhuma operação';
}

function isScraperRunning(): boolean {
  if (pageBusy) return true;
  if (activeChild) {
    if (activeChild.exitCode === null) return true; // processo filho ainda vivo
    activeChild = null;
    return false;
  }
  return false;
}

/**
 * Executa fn() dentro do lock único do scraper.
 * - Com sessão persistente: protege a aba única (nunca navega em paralelo).
 * - Sem sessão persistente: não muda nada (o lock continua sendo o PID).
 */
async function withPageLock<T>(fn: () => Promise<T>): Promise<T> {
  if (!KEEP_OPEN) return fn();
  if (pageBusy) {
    throw new Error('Outra operação está usando a sessão persistente. Aguarde.');
  }
  pageBusy = true;
  try {
    return await fn();
  } finally {
    pageBusy = false;
  }
}

// Similar ao withPageLock, mas registra a operação em andamento para dar
// visibilidade no /health e na mensagem de 409 (evita o "travado à toa").
async function withOp<T>(info: Omit<ActiveOp, 'startedAt'>, fn: () => Promise<T>): Promise<T> {
  beginOp(info);
  try {
    return await fn();
  } finally {
    endOp();
  }
}

// ─── Sessão de browser persistente ───────────────────────────────────────────
// Mantém uma página logada no painel e reusa nas renovações/buscas em vez de
// spawnar processo novo (relançar Chromium). Padrão ÚNICO: ON por default
// (dev local e VPS com docker). Desliga só com SCRAPER_KEEP_SESSION_OPEN=false.
const KEEP_OPEN = process.env.SCRAPER_KEEP_SESSION_OPEN !== 'false';
let persistentBrowser: import('puppeteer').Browser | null = null;
let persistentPage: import('puppeteer').Page | null = null;
let persistentPagePromise: Promise<import('puppeteer').Page> | null = null;

function panelConfig() {
  return {
    url: process.env.PANEL_URL || 'https://panel.web.starhome.vip',
    account: process.env.PANEL_ACCOUNT || '',
    password: process.env.PANEL_PASSWORD || '',
    headless: process.env.HEADLESS === 'false' ? false : true,
    proxy: process.env.PROXY_SERVER || undefined,
    proxyAuth: process.env.PROXY_USERNAME ? { username: process.env.PROXY_USERNAME, password: process.env.PROXY_PASSWORD || '' } : undefined,
  };
}

async function ensurePersistentPage(): Promise<import('puppeteer').Page> {
  if (!KEEP_OPEN) {
    throw new Error('SCRAPER_KEEP_SESSION_OPEN não está ativada');
  }
  if (persistentPage && !persistentPage.isClosed()) {
    return persistentPage;
  }
  if (persistentPagePromise) {
    return persistentPagePromise;
  }
  persistentPagePromise = (async () => {
    log('info', 'Iniciando sessão de browser persistente...');
    const cfg = panelConfig();
    if (!cfg.account || !cfg.password) {
      throw new Error('PANEL_ACCOUNT e PANEL_PASSWORD são obrigatórios para a sessão persistente');
    }
    const session = await loginToPanel(cfg);
    persistentBrowser = session.browser;
    persistentPage = session.page;
    log('info', 'Sessão persistente pronta');
    return session.page;
  })();
  try {
    return await persistentPagePromise;
  } finally {
    persistentPagePromise = null;
  }
}

/**
 * Reconecta se a sessão persistente caiu (URL contém /login).
 * Se a reconexão falhar, lança — tratado como falha de job normal (backoff).
 */
async function getReadyPersistentPage(): Promise<import('puppeteer').Page> {
  const page = await ensurePersistentPage();
  const currentUrl = page.url() || '';
  if (currentUrl.includes('/login')) {
    log('warn', 'Sessão persistente caiu — relogando');
    if (persistentBrowser) {
      try { await persistentBrowser.close(); } catch {}
    }
    persistentBrowser = null;
    persistentPage = null;
    return ensurePersistentPage();
  }
  return page;
}

// ─── Fila de renovação (renewal_jobs) ────────────────────────────────────────
// Poller a cada 30s: pega o próximo job 'queued' vencido e executa a renovação.
// Concorrência 1: só age quando nenhum outro processo/job está rodando.
const RENEWAL_POLL_INTERVAL_MS = 30_000;

async function pollRenewalJobs(): Promise<void> {
  try {
    if (isScraperRunning()) return;

    const job = await claimNextJob();
    if (!job) return;

    log('info', 'Renewal job claimed', { jobId: job.id, account: job.starhome_account, attempts: job.attempts });

    let result: { success: boolean; account?: string; clientName?: string; error?: string };
    try {
      result = await withOp({ op: 'queue-renew', query: job.starhome_account }, () => withPageLock(() => runRenew(job.starhome_account, 'account')));
    } catch (err: any) {
      result = { success: false, error: err.message || String(err) };
    }

    const attempts = job.attempts + 1;

    if (result.success) {
      await markJobDone(job.id);
      log('info', 'Renewal job done', { jobId: job.id, account: result.account || job.starhome_account });
      await notifyRenewComplete(result.clientName || result.account || job.starhome_account, result.account || job.starhome_account, 0).catch(() => {});
    } else {
      const errorMsg = result.error || 'Falha desconhecida na renovação';
      log('warn', 'Renewal job failed', { jobId: job.id, attempts, error: errorMsg });
      await markJobFailed(job.id, errorMsg, attempts, MAX_JOB_ATTEMPTS);
      if (attempts >= MAX_JOB_ATTEMPTS) {
        // Alerta humano: único, só no esgotamento das tentativas de job
        await notifyError(
          'Renovação StarHome',
          errorMsg,
          `Account: ${job.starhome_account}\nTentativas: ${attempts}/${MAX_JOB_ATTEMPTS}\nJob: ${job.id}`
        ).catch(() => {});
      }
    }
  } catch (err: any) {
    log('error', 'pollRenewalJobs error', { error: err.message });
  }
}

// ─── Persistent Job Store ─────────────────────────────────────────────────────
interface Job {
  id: string;
  status: 'running' | 'done' | 'error';
  startedAt: string;
  finishedAt?: string;
  logs: string[];
  result?: { success: boolean; clients?: number; stats?: any; error?: string; data?: any };
}

const JOBS_DIR = path.join(__dirname, '..', 'output', 'jobs');
const MAX_JOBS_ON_DISK = 50;

function ensureJobsDir() {
  if (!fs.existsSync(JOBS_DIR)) {
    fs.mkdirSync(JOBS_DIR, { recursive: true });
  }
}

function jobPath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

function saveJob(job: Job): void {
  ensureJobsDir();
  fs.writeFileSync(jobPath(job.id), JSON.stringify(job, null, 2));
  cleanupOldJobs();
}

function loadJob(id: string): Job | null {
  const p = jobPath(id);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as Job;
  } catch {
    return null;
  }
}

function listJobs(): Job[] {
  ensureJobsDir();
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  return files.slice(0, 20).map(f => {
    try {
      return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf-8')) as Job;
    } catch {
      return null;
    }
  }).filter(Boolean) as Job[];
}

function cleanupOldJobs(): void {
  ensureJobsDir();
  const files = fs.readdirSync(JOBS_DIR).filter(f => f.endsWith('.json')).sort();
  while (files.length > MAX_JOBS_ON_DISK) {
    fs.unlinkSync(path.join(JOBS_DIR, files.shift()!));
  }
}

function createJob(): Job {
  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const job: Job = { id, status: 'running', startedAt: new Date().toISOString(), logs: [] };
  saveJob(job);
  return job;
}

function updateJob(job: Job): void {
  saveJob(job);
}

// ─── Run full scraper ─────────────────────────────────────────────────────────
async function runScraper(onProgress?: (chunk: string) => void): Promise<{ success: boolean; clients: number; stats?: any; error?: string }> {
  return new Promise(resolve => {
    // In dev: __dirname = scraper/dist, projectRoot = scraper
    // In prod: __dirname = scraper/dist, projectRoot = scraper
    const projectRoot = path.resolve(__dirname, '..');
    const child = spawn('node', ['dist/index.js', '--sync'], {
      cwd: projectRoot,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeChild = child;

    let stderr = '';

    child.stdout.on('data', (d: Buffer) => {
      const t = d.toString();
      log('info', 'scraper stdout', { chunk: sanitizeLogChunk(t).slice(0, 200) });
      if (onProgress) onProgress(t);
    });
    child.stderr.on('data', (d: Buffer) => {
      const t = sanitizeLogChunk(d.toString());
      stderr = (stderr + t).slice(-5000);
      log('error', 'scraper stderr', { chunk: t.slice(0, 200) });
    });

    child.on('close', async (code: number) => {
      activeChild = null;
      if (code !== 0) {
        log('error', 'Scraper process exited with non-zero code', { code, stderr: stderr.slice(-500) });
        resolve({ success: false, clients: 0, error: stderr.slice(-500) });
        return;
      }
      try {
        // O script (exportAll) grava em output/clients.json. Antes lia
        // clients_extracted.json (nunca escrito) e o sync sempre reportava 0.
        const jsonPath = path.join(__dirname, '..', 'output', 'clients.json');
        if (fs.existsSync(jsonPath)) {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          const list = Array.isArray(data) ? data : (data.clients || []);
          resolve({
            success: true, clients: list.length,
            stats: {
              active:   list.filter((c: any) => c.in_use === 'Used').length,
              inactive: list.filter((c: any) => c.in_use === 'Unused').length,
              expiring: list.filter((c: any) => c.days_remaining <= 7 && c.days_remaining > 0).length,
              expired:  list.filter((c: any) => c.days_remaining <= 0 || c.expired === 'Expired').length,
            },
          });
        } else {
          log('warn', 'clients.json not found after scraper run');
          resolve({ success: true, clients: 0 });
        }
      } catch (e: any) {
        log('error', 'Failed to parse scraper output', { error: e.message });
        resolve({ success: false, clients: 0, error: e.message });
      }
    });

    child.on('error', (e: Error) => {
      activeChild = null;
      log('error', 'Scraper spawn error', { error: e.message });
      resolve({ success: false, clients: 0, error: e.message });
    });
  });
}

// ─── Renew single client ──────────────────────────────────────────────────────
async function runRenew(query: string, searchBy: string): Promise<{ success: boolean; account?: string; clientName?: string; error?: string }> {
  // Sessão persistente ativa: reusa a página logada (sem religar o Chromium)
  if (KEEP_OPEN) {
    try {
      const page = await getReadyPersistentPage();
      let targetAccount = query;
      let clientName = query;

      if (searchBy !== 'account') {
        const client = await searchAndExtractClient(page, query, searchBy as 'buyer_name' | 'phone');
        if (!client) {
          return { success: false, error: `Cliente não encontrado: "${query}"` };
        }
        targetAccount = client.account;
        clientName = client.buyer_name;
      }

      const success = await renewClient(page, targetAccount, false);
      if (!success) {
        return { success: false, account: targetAccount, clientName, error: 'Processo de renovação falhou no painel' };
      }

      // Atualiza só o cliente no banco (mesmo fluxo do index.ts)
      if (process.env.DATABASE_URL) {
        try {
          const fresh = await searchAndExtractClient(page, targetAccount, 'account');
          if (fresh) await updateSingleClient(fresh);
        } catch (dbErr: any) {
          log('warn', 'Falha ao atualizar banco pós-renew', { error: dbErr.message });
        }
      }

      return { success: true, account: targetAccount, clientName };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // Modelo padrão (produção hoje): spawn de processo filho
  return new Promise(resolve => {
    const projectRoot = path.resolve(__dirname, '..');
    const args = ['--renew=' + query];
    if (searchBy !== 'account') args.push('--by=' + (searchBy === 'buyer_name' ? 'name' : searchBy));

    const child = spawn('node', ['dist/index.js', ...args], {
      cwd: projectRoot, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeChild = child;

    let stderr = '';
    child.stdout.on('data', (d: Buffer) => log('info', 'renew stdout', { chunk: sanitizeLogChunk(d.toString()).slice(0, 200) }));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + sanitizeLogChunk(d.toString())).slice(-5000);
    });

    child.on('close', (code: number) => {
      activeChild = null;
      if (code !== 0) { resolve({ success: false, error: stderr.slice(-500) }); return; }
      try {
        const jsonPath = path.join(__dirname, '..', 'output', 'renew_result.json');
        if (fs.existsSync(jsonPath)) {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          resolve(data.success
            ? { success: true, account: data.account, clientName: data.clientName }
            : { success: false, error: data.error || 'Falha na renovação' });
        } else {
          resolve({ success: false, error: 'Arquivo de resultado não encontrado' });
        }
      } catch (e: any) { resolve({ success: false, error: e.message }); }
    });

    child.on('error', (e: Error) => {
      activeChild = null;
      resolve({ success: false, error: e.message });
    });
  });
}

// ─── Search single client ─────────────────────────────────────────────────────
async function runSearch(query: string, searchBy: string): Promise<{ success: boolean; data?: any; error?: string }> {
  // Sessão persistente ativa: busca na página já logada
  if (KEEP_OPEN) {
    try {
      const page = await getReadyPersistentPage();
      const client = await searchAndExtractClient(page, query, searchBy as 'account' | 'buyer_name' | 'phone');
      if (!client) {
        return { success: false, error: 'Cliente não encontrado' };
      }
      return { success: true, data: [client] };
    } catch (err: any) {
      return { success: false, error: err.message || String(err) };
    }
  }

  // Modelo padrão (produção hoje): spawn de processo filho
  return new Promise(resolve => {
    const projectRoot = path.resolve(__dirname, '..');
    const args = ['--search=' + query];
    if (searchBy !== 'account') args.push('--by=' + (searchBy === 'buyer_name' ? 'name' : searchBy));

    const child = spawn('node', ['dist/index.js', ...args], {
      cwd: projectRoot, env: { ...process.env }, stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeChild = child;

    let stderr = '';
    child.stdout.on('data', (d: Buffer) => log('info', 'search stdout', { chunk: sanitizeLogChunk(d.toString()).slice(0, 200) }));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + sanitizeLogChunk(d.toString())).slice(-5000);
    });

    child.on('close', (code: number) => {
      activeChild = null;
      if (code !== 0) { resolve({ success: false, error: stderr.slice(-500) }); return; }
      try {
        const jsonPath = path.join(__dirname, '..', 'output', 'client_search.json');
        if (fs.existsSync(jsonPath)) {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          resolve(data?.length > 0 ? { success: true, data } : { success: false, error: 'Cliente não encontrado' });
        } else {
          resolve({ success: false, error: 'Arquivo de busca não encontrado' });
        }
      } catch (e: any) { resolve({ success: false, error: e.message }); }
    });

    child.on('error', (e: Error) => {
      activeChild = null;
      resolve({ success: false, error: e.message });
    });
  });
}

// ─── POST /run — dispara em background e retorna imediatamente ────────────────
app.post('/run', authenticate, async (req, res) => {
  const { action, query, searchBy } = req.body;
  log('info', 'Received /run request', { action, query, searchBy, ip: req.ip });

  const validActions = new Set(['sync', 'search', 'renew']);
  const validSearchTypes = new Set(['account', 'buyer_name', 'phone']);

  if (typeof action !== 'string' || !validActions.has(action)) {
    res.status(400).json({ error: 'Ação inválida. Use action: sync | search | renew' });
    return;
  }

  if (searchBy !== undefined &&
      (typeof searchBy !== 'string' || !validSearchTypes.has(searchBy))) {
    res.status(400).json({ error: 'searchBy inválido. Use account | buyer_name | phone' });
    return;
  }

  if ((action === 'search' || action === 'renew') &&
      (typeof query !== 'string' || query.trim().length === 0 || query.length > 200)) {
    res.status(400).json({ error: 'query deve ser um texto entre 1 e 200 caracteres' });
    return;
  }

  if (isScraperRunning()) {
    log('warn', 'Rejected /run — scraper already running', { op: activeOp });
    res.status(409).json({ error: `Scraper ocupado (${currentOpLabel()}). Aguarde a conclusão.` });
    return;
  }

  if (action === 'sync') {
    const job = createJob();
    res.json({ jobId: job.id, message: 'Sincronização iniciada em background!' });

    ;(async () => {
      const addLog = (m: string) => {
        const entry = `[${new Date().toLocaleTimeString('pt-BR')}] ${m}`;
        job.logs.push(entry);
        updateJob(job);
        log('info', entry);
      };
      try {
        addLog('🔄 Iniciando scraper...');
        await sendTelegram('🔄 <b>Scraper iniciado!</b>\n\nExecutando sincronização completa...');
        const result = await withOp({ op: 'sync' }, () => runScraper((chunk) => {
          // Streama o progresso do processo filho para o job (feedback ao vivo).
          const lines = stripAnsi(chunk)
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.length > 0 && !l.startsWith('[') && !l.startsWith('{'));
          for (const line of lines) addLog(line);
        }));
        job.result = result;

        if (result.success && result.stats) {
          addLog(`✅ Concluído! ${result.clients} clientes | Ativos: ${result.stats.active} | Inativos: ${result.stats.inactive}`);
          await sendTelegram(
            `✅ <b>Sincronização Concluída!</b>\n\n` +
            `📊 Total: ${result.clients}\n✅ Ativos: ${result.stats.active}\n` +
            `❌ Inativos: ${result.stats.inactive}\n⚠️ Expirando: ${result.stats.expiring}\n🔴 Expirados: ${result.stats.expired}`
          );
          job.status = 'done';
        } else {
          addLog(`❌ Falha: ${result.error}`);
          await sendTelegram(`🚨 <b>Erro na Sincronização!</b>\n\n${result.error}`);
          job.status = 'error';
        }
      } catch (err: any) {
        addLog(`❌ Erro crítico: ${err.message}`);
        job.status = 'error';
        job.result = { success: false, error: err.message };
      }
      job.finishedAt = new Date().toISOString();
      updateJob(job);
    })();
    return;
  }

  if (action === 'search') {
    const job = createJob();
    res.json({ jobId: job.id, message: 'Busca iniciada em background!' });

    ;(async () => {
      const addLog = (m: string) => { job.logs.push(m); updateJob(job); };
      const by = searchBy || 'account';
      try {
        addLog(`🔍 Buscando "${query}" por ${by}...`);
        const result = await withOp({ op: 'search', query }, () => withPageLock(() => runSearch(query.trim(), by)));
        job.result = sanitizeSearchResult(result);
        if (result.success && result.data) {
          const c = result.data[0];
          addLog(`✅ Encontrado: ${c.buyer_name} | ${c.account} | ${c.days_remaining}d`);
          await sendTelegram(`✅ <b>Cliente Encontrado</b>\n\nAccount: ${c.account}\nNome: ${c.buyer_name}\nDias: ${c.days_remaining}\nStatus: ${c.in_use}`);
          job.status = 'done';
        } else {
          addLog(`❌ Não encontrado: ${query}`);
          await sendTelegram(`❌ Não encontrado: "${query}"`);
          job.status = 'error';
        }
      } catch (err: any) {
        job.status = 'error';
        job.result = { success: false, error: err.message };
      }
      job.finishedAt = new Date().toISOString();
      updateJob(job);
    })();
    return;
  }

  if (action === 'renew') {
    if (!query) {
      res.status(400).json({ error: 'Campo "query" é obrigatório para renew' });
      return;
    }
    const job = createJob();
    res.json({ jobId: job.id, message: 'Renovação iniciada em background!' });

    ;(async () => {
      const addLog = (m: string) => { job.logs.push(m); updateJob(job); };
      const by = searchBy || 'buyer_name';
      // Heartbeat: como a renovação usa a sessão persistente (sem stdout a
      // streamar), emitimos um progresso periódico para a tela não ficar muda.
      const heartbeat = setInterval(() => addLog(`⏳ Ainda renovando "${query}"...`), 15000);
      try {
        addLog(`🔍 Buscando "${query}" por ${by}...`);
        const result = await withOp({ op: 'renew', query }, () => withPageLock(() => runRenew(query.trim(), by)));
        job.result = result;
        if (result.success) {
          addLog(`✅ Renovado: ${result.clientName} | ${result.account}`);
          await sendTelegram(`✅ <b>Cliente Renovado!</b>\n\nNome: ${result.clientName}\nAccount: ${result.account}`);
          job.status = 'done';
        } else {
          addLog(`❌ Falha na renovação: ${result.error}`);
          await sendTelegram(`❌ <b>Falha ao renovar "${query}"</b>\n\n${result.error}`);
          job.status = 'error';
        }
      } catch (err: any) {
        job.status = 'error';
        job.result = { success: false, error: err.message };
      } finally {
        clearInterval(heartbeat);
      }
      job.finishedAt = new Date().toISOString();
      updateJob(job);
    })();
    return;
  }

  res.status(400).json({ error: 'Ação inválida. Use action: sync | search | renew' });
});

// ─── GET /job/:id — polling do status ─────────────────────────────────────────
app.get('/job/:id', authenticate, (req, res) => {
  const job = loadJob(req.params.id);
  if (!job) { res.status(404).json({ error: 'Job não encontrado' }); return; }
  res.json({
    jobId:      job.id,
    status:     job.status,
    startedAt:  job.startedAt,
    finishedAt: job.finishedAt,
    logs:       job.logs.slice(-30),
    result:     job.result,
  });
});

// ─── GET /jobs — listar todos os jobs recentes ────────────────────────────────
app.get('/jobs', authenticate, (_req, res) => {
  res.json(listJobs().map(j => ({
    jobId: j.id, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt,
  })));
});

// ─── 2FA via API ──────────────────────────────────────────────────────────────
import { deliver2FACode, get2FAStatus, cleanupStale2FA } from './twofa.js';

// Limpa estado 2FA que possa ter sobrevivido a um crash (arquivo órfão).
cleanupStale2FA();

app.get('/2fa-status', authenticate, (_req, res) => {
  const status = get2FAStatus();
  res.json({
    waiting: status.state === 'waiting',
    state: status.state,
    sessionId: status.sessionId,
    remainingMs: status.remainingMs,
  });
});

app.post('/2fa', authenticate, (req, res) => {
  const { code, sessionId } = req.body as { code?: string; sessionId?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Código 2FA é obrigatório' }); return;
  }
  const normalizedCode = code.trim();
  if (!/^\d{6}$/.test(normalizedCode)) {
    res.status(400).json({ error: 'Código 2FA deve conter exatamente 6 dígitos' }); return;
  }
  const result = deliver2FACode(normalizedCode, { sessionId });
  if (result.ok) {
    log('info', '2FA code delivered to scraper', { status: result.status });
    res.json({ ok: true, message: 'Código 2FA recebido. Scraper retomando...', state: result.status });
  } else {
    // none / consumed / accepted / rejected — fora da janela ou duplicado
    res.status(409).json({ error: result.error, state: result.status });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    scraperRunning: isScraperRunning(),
    activeOp: activeOp ? { ...activeOp } : null,
    uptime: process.uptime(),
  });
});

// ─── Ready check ──────────────────────────────────────────────────────────────
app.get('/ready', (_req, res) => {
  const checks = {
    apiKeyConfigured: !!API_KEY,
    panelConfigured: !!(process.env.PANEL_ACCOUNT && process.env.PANEL_PASSWORD),
    chromeExecutable: (() => {
      try {
        const executablePath = puppeteer.executablePath();
        return !!executablePath && fs.existsSync(executablePath);
      } catch {
        return false;
      }
    })(),
    outputDirWritable: (() => {
      try {
        const testPath = path.join(__dirname, '..', 'output', '.healthcheck');
        fs.mkdirSync(path.dirname(testPath), { recursive: true });
        fs.writeFileSync(testPath, 'ok');
        fs.unlinkSync(testPath);
        return true;
      } catch {
        return false;
      }
    })(),
  };
  const allOk = Object.values(checks).every(Boolean);
  res.status(allOk ? 200 : 503).json({ status: allOk ? 'ok' : 'degraded', checks });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  log('error', 'Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ error: 'Internal server error' });
});

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
process.on('SIGTERM', () => {
  log('info', 'SIGTERM received — shutting down gracefully');
  if (activeChild) {
    try { activeChild.kill('SIGTERM'); } catch {}
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received — shutting down gracefully');
  if (activeChild) {
    try { activeChild.kill('SIGINT'); } catch {}
  }
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Scraper server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
  sendTelegram(
    `🟢 <b>Servidor Scraper Online!</b>\n\n` +
    `🌐 Porta: <b>${PORT}</b>\n` +
    `🔧 Ambiente: <b>${process.env.NODE_ENV || 'development'}</b>\n` +
    `🕐 ${new Date().toLocaleString('pt-BR')}`
  ).catch(() => {});
});

// Worker da fila de renovação (renewal_jobs) — roda enquanto o servidor estiver vivo
setInterval(pollRenewalJobs, RENEWAL_POLL_INTERVAL_MS);
log('info', 'Renewal queue worker started', { intervalMs: RENEWAL_POLL_INTERVAL_MS });

export default app;
