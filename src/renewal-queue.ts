// Fila de renovação StarHome (renewal_jobs) — consumida pelo worker do server.ts
// Mesmo padrão de conexão lazy de update-db.ts
import postgres from 'postgres';

export const BACKOFF_MIN = [2, 10, 30]; // minutos entre tentativas de job
export const MAX_JOB_ATTEMPTS = 3;

let _sql: ReturnType<typeof postgres> | null = null;

function getDb() {
  if (_sql) return _sql;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('❌ DATABASE_URL não definido (necessário para o worker da fila)');
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

export interface RenewalJob {
  id: string;
  client_id: number;
  order_id: string | null;
  starhome_account: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Pega o próximo job 'queued' vencido, atomicamente (concorrência 1).
 * UPDATE ... RETURNING com FOR UPDATE SKIP LOCKED garante que dois workers
 * nunca peguem o mesmo job. Se SKIP LOCKED não for suportado, o fallback é
 * SELECT LIMIT 1 + UPDATE ... WHERE status='queued' checando se retornou linha.
 */
export async function claimNextJob(): Promise<RenewalJob | null> {
  try {
    const rows = await getDb()`
      UPDATE renewal_jobs
      SET status = 'running', updated_at = NOW()
      WHERE id = (
        SELECT id FROM renewal_jobs
        WHERE status = 'queued' AND next_attempt_at <= NOW()
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, client_id, order_id, starhome_account, attempts, max_attempts
    `;
    const row = rows[0] as unknown as RenewalJob | undefined;
    return row ?? null;
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes('skip locked')) {
      // Fallback: versão do Postgres/Supabase sem SKIP LOCKED
      const [candidate] = await getDb()`
        SELECT id FROM renewal_jobs
        WHERE status = 'queued' AND next_attempt_at <= NOW()
        ORDER BY created_at ASC LIMIT 1
      `;
      if (!candidate) return null;
      const rows = await getDb()`
        UPDATE renewal_jobs
        SET status = 'running', updated_at = NOW()
        WHERE id = ${candidate.id} AND status = 'queued'
        RETURNING id, client_id, order_id, starhome_account, attempts, max_attempts
      `;
      const row = rows[0] as unknown as RenewalJob | undefined;
      return row ?? null;
    }
    throw err;
  }
}

export async function markJobDone(id: string, completedAt: Date = new Date()): Promise<void> {
  await getDb()`
    UPDATE renewal_jobs
    SET status = 'done', completed_at = ${completedAt}, updated_at = NOW()
    WHERE id = ${id}
  `;
}

export async function markJobFailed(id: string, error: string, attempts: number, maxAttempts: number): Promise<void> {
  if (attempts >= maxAttempts) {
    await getDb()`
      UPDATE renewal_jobs
      SET status = 'failed', attempts = attempts + 1, last_error = ${error}, updated_at = NOW()
      WHERE id = ${id}
    `;
  } else {
    const delayMin = BACKOFF_MIN[attempts - 1] ?? 30;
    await getDb()`
      UPDATE renewal_jobs
      SET status = 'queued', attempts = attempts + 1, last_error = ${error},
          next_attempt_at = NOW() + make_interval(mins => ${delayMin}),
          updated_at = NOW()
      WHERE id = ${id}
    `;
  }
}
