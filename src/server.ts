import express from 'express';
import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs';
import axios from 'axios';
import crypto from 'crypto';

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
let activeScraperPid: number | null = null;

function isScraperRunning(): boolean {
  if (activeScraperPid === null) return false;
  try {
    process.kill(activeScraperPid, 0);
    return true;
  } catch {
    activeScraperPid = null;
    return false;
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
async function runScraper(): Promise<{ success: boolean; clients: number; stats?: any; error?: string }> {
  return new Promise(resolve => {
    // In dev: __dirname = scraper/src, projectRoot = scraper
    // In prod: __dirname = scraper/dist/src, projectRoot = scraper
    const projectRoot = path.resolve(__dirname, '../..');
    const child = spawn('npx', ['ts-node', 'src/index.ts', '--sync'], {
      cwd: projectRoot,
      env: { ...process.env },
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeScraperPid = child.pid || null;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => {
      const t = d.toString();
      stdout += t;
      log('info', 'scraper stdout', { chunk: t.slice(0, 200) });
    });
    child.stderr.on('data', (d: Buffer) => {
      const t = d.toString();
      stderr += t;
      log('error', 'scraper stderr', { chunk: t.slice(0, 200) });
    });

    child.on('close', async (code: number) => {
      activeScraperPid = null;
      if (code !== 0) {
        log('error', 'Scraper process exited with non-zero code', { code, stderr: stderr.slice(-500) });
        resolve({ success: false, clients: 0, error: stderr.slice(-500) });
        return;
      }
      try {
        const jsonPath = path.join(__dirname, '..', 'output', 'clients.json');
        if (fs.existsSync(jsonPath)) {
          const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
          const list = data.clients || [];
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
      activeScraperPid = null;
      log('error', 'Scraper spawn error', { error: e.message });
      resolve({ success: false, clients: 0, error: e.message });
    });
  });
}

// ─── Search single client ─────────────────────────────────────────────────────
async function runSearch(query: string, searchBy: string): Promise<{ success: boolean; data?: any; error?: string }> {
  return new Promise(resolve => {
    const projectRoot = path.resolve(__dirname, '../..');
    const args = ['--search=' + query];
    if (searchBy !== 'account') args.push('--by=' + (searchBy === 'buyer_name' ? 'name' : searchBy));

    const child = spawn('npx', ['ts-node', 'src/index.ts', ...args], {
      cwd: projectRoot, env: { ...process.env }, shell: true, stdio: ['pipe', 'pipe', 'pipe'],
    });

    activeScraperPid = child.pid || null;

    let stderr = '';
    child.stdout.on('data', (d: Buffer) => log('info', 'search stdout', { chunk: d.toString().slice(0, 200) }));
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });

    child.on('close', (code: number) => {
      activeScraperPid = null;
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
      activeScraperPid = null;
      resolve({ success: false, error: e.message });
    });
  });
}

// ─── POST /run — dispara em background e retorna imediatamente ────────────────
app.post('/run', authenticate, async (req, res) => {
  const { action, query, searchBy } = req.body;
  log('info', 'Received /run request', { action, query, searchBy, ip: req.ip });

  if (isScraperRunning()) {
    log('warn', 'Rejected /run — scraper already running');
    res.status(409).json({ error: 'Scraper já está em execução. Aguarde a conclusão.' });
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
        const result = await runScraper();
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
        const result = await runSearch(query, by);
        job.result = result;
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

  res.status(400).json({ error: 'Ação inválida. Use action: sync | search' });
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
import { deliver2FACode, is2FAWaiting } from './twofa.js';

app.get('/2fa-status', authenticate, (_req, res) => {
  res.json({ waiting: is2FAWaiting() });
});

app.post('/2fa', authenticate, (req, res) => {
  const { code } = req.body as { code?: string };
  if (!code || typeof code !== 'string') {
    res.status(400).json({ error: 'Código 2FA é obrigatório' }); return;
  }
  const ok = deliver2FACode(code.trim());
  if (ok) {
    log('info', '2FA code delivered to scraper');
    res.json({ ok: true, message: 'Código 2FA recebido. Scraper retomando...' });
  } else {
    res.status(409).json({ error: 'Nenhuma sessão 2FA aguardando código no momento.' });
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    scraperRunning: isScraperRunning(),
    uptime: process.uptime(),
  });
});

// ─── Ready check ──────────────────────────────────────────────────────────────
app.get('/ready', (_req, res) => {
  const checks = {
    apiKeyConfigured: !!API_KEY,
    panelConfigured: !!(process.env.PANEL_ACCOUNT && process.env.PANEL_PASSWORD),
    outputDirWritable: (() => {
      try {
        const testPath = path.join(__dirname, '..', 'output', '.healthcheck');
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
  if (activeScraperPid) {
    try { process.kill(activeScraperPid, 'SIGTERM'); } catch {}
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  log('info', 'SIGINT received — shutting down gracefully');
  if (activeScraperPid) {
    try { process.kill(activeScraperPid, 'SIGINT'); } catch {}
  }
  process.exit(0);
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log('info', `Scraper server started`, { port: PORT, env: process.env.NODE_ENV || 'development' });
});

export default app;
