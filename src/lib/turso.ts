// src/lib/turso.ts
// عميل Turso (libSQL عبر HTTP) — مناسب لبيئة Vercel serverless.
// ننشئ المخطط بـ CREATE TABLE IF NOT EXISTS عند أول وصول فلا حاجة لأداة migrations.

import { createClient, type Client } from "@libsql/client";

let _client: Client | null = null;

/** عميل وحيد مُعاد استخدامه بين الاستدعاءات. */
export function db(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url) throw new Error("TURSO_DATABASE_URL is not set");
    _client = createClient({ url, authToken });
  }
  return _client;
}

/** فحص الجهوزية: SELECT 1 */
export async function dbHealthy(): Promise<boolean> {
  try {
    await db().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

/** إنشاء جميع الجداول إن لم تكن موجودة. */
export async function ensureSchema(): Promise<void> {
  const c = db();
  await c.batch([
    {
      sql: `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        provider TEXT,
        provider_task_id TEXT,
        key_id TEXT,
        model TEXT NOT NULL,
        type TEXT NOT NULL,
        prompt TEXT DEFAULT '',
        params_json TEXT DEFAULT '{}',
        status TEXT NOT NULL,
        progress INTEGER DEFAULT 0,
        result_urls_json TEXT,
        error_message TEXT,
        attempts_json TEXT DEFAULT '[]',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        completed_at TEXT
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        label TEXT DEFAULT '',
        api_key TEXT NOT NULL,
        status TEXT DEFAULT 'active',
        usage_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_used_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
    },
    // جداول خدمة الدمج (نستضيفها داخل نفس المشروع على /api/jobs)
    {
      sql: `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        progress INTEGER DEFAULT 0,
        total_sources INTEGER DEFAULT 0,
        video_url TEXT,
        download_url TEXT,
        size INTEGER,
        duration REAL,
        resolution TEXT,
        error TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        expires_at TEXT
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS sources (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        url TEXT,
        name TEXT,
        size INTEGER,
        mime TEXT,
        status TEXT DEFAULT 'pending',
        PRIMARY KEY (job_id, seq)
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS source_chunks (
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, seq, chunk)
      )`,
    },
    {
      sql: `CREATE TABLE IF NOT EXISTS output_chunks (
        job_id TEXT NOT NULL,
        chunk INTEGER NOT NULL,
        data BLOB NOT NULL,
        PRIMARY KEY (job_id, chunk)
      )`,
    },
  ]);
}

// ============ أنواع المهام ============

export interface TaskRow {
  id: string;
  provider: string | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: "image" | "video" | "merge";
  prompt: string;
  params_json: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface ApiKeyRow {
  id: string;
  provider: "kie" | "cometapi";
  label: string;
  api_key: string;
  status: "active" | "exhausted" | "disabled";
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

export interface AttemptEntry {
  provider: string;
  keyId: string;
  keyLabel: string;
  ok: boolean;
  errorClass?: string;
  error?: string;
  at: string;
}

// ============ عمليات المهام ============

export async function insertTask(row: {
  id: string;
  provider: string | null;
  provider_task_id?: string | null;
  key_id?: string | null;
  model: string;
  type: TaskRow["type"];
  prompt?: string;
  params_json?: string;
  status?: TaskRow["status"];
  progress?: number;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, attempts_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`,
    args: [
      row.id,
      row.provider,
      row.provider_task_id ?? null,
      row.key_id ?? null,
      row.model,
      row.type,
      row.prompt ?? "",
      row.params_json ?? "{}",
      row.status ?? "pending",
      row.progress ?? 0,
    ],
  });
}

export async function getTask(id: string): Promise<TaskRow | null> {
  const r = await db().execute({ sql: "SELECT * FROM tasks WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as TaskRow) ?? null;
}

export async function updateTask(
  id: string,
  patch: Partial<Omit<TaskRow, "id" | "created_at">> & { addAttempt?: AttemptEntry },
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (k === "addAttempt") continue;
    if (k === "attempts_json") continue;
    sets.push(`${k} = ?`);
    args.push(v as string | number | null);
  }
  // ضبط completed_at تلقائيًا عند الاكتمال
  if (patch.status === "completed" && !patch.completed_at) {
    sets.push("completed_at = datetime('now')");
  }
  // إضافة محاولة للسجل
  if (patch.addAttempt) {
    sets.push(`attempts_json = (
      CASE WHEN attempts_json IS NULL OR attempts_json = '' THEN '[]'
           ELSE attempts_json END
    )`);
    sets.push(`attempts_json = json_set(
      CASE WHEN attempts_json IS NULL OR attempts_json = '' THEN '[]' ELSE attempts_json END,
      '$[' || json_array_length(CASE WHEN attempts_json IS NULL OR attempts_json = '' THEN '[]' ELSE attempts_json END) || ']',
      json('${JSON.stringify(patch.addAttempt).replace(/'/g, "''")}')
    )`);
  }
  sets.push("updated_at = datetime('now')");
  args.push(id);
  await db().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args,
  });
}

export async function listRecentTasks(
  limit: number,
  filter: { type?: string; status?: string } = {},
): Promise<TaskRow[]> {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.type) {
    where.push("type = ?");
    args.push(filter.type);
  }
  if (filter.status) {
    where.push("status = ?");
    args.push(filter.status);
  }
  const wsql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  args.push(limit);
  const r = await db().execute({
    sql: `SELECT * FROM tasks ${wsql} ORDER BY created_at DESC LIMIT ?`,
    args,
  });
  return r.rows as unknown as TaskRow[];
}

export async function taskStats(): Promise<{
  total: number;
  completed: number;
  failed: number;
  processing: number;
}> {
  const r = await db().execute({
    sql: `SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status IN ('processing','pending') THEN 1 ELSE 0 END) AS processing
    FROM tasks`,
  });
  const row = r.rows[0] as Record<string, number | null>;
  return {
    total: row.total ?? 0,
    completed: row.completed ?? 0,
    failed: row.failed ?? 0,
    processing: row.processing ?? 0,
  };
}

// ============ عمليات المفاتيح ============

export async function listApiKeys(): Promise<ApiKeyRow[]> {
  const r = await db().execute({ sql: "SELECT * FROM api_keys ORDER BY created_at ASC, id ASC" });
  return r.rows as unknown as ApiKeyRow[];
}

export async function getApiKey(id: string): Promise<ApiKeyRow | null> {
  const r = await db().execute({ sql: "SELECT * FROM api_keys WHERE id = ?", args: [id] });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

export async function insertApiKey(row: {
  id: string;
  provider: ApiKeyRow["provider"];
  api_key: string;
  label?: string;
}): Promise<void> {
  await db().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key, status)
          VALUES (?, ?, ?, ?, 'active')`,
    args: [row.id, row.provider, row.label ?? "", row.api_key],
  });
}

export async function findDuplicateKey(provider: string, apiKey: string): Promise<ApiKeyRow | null> {
  const r = await db().execute({
    sql: "SELECT * FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return (r.rows[0] as unknown as ApiKeyRow) ?? null;
}

export async function updateApiKey(
  id: string,
  patch: Partial<Omit<ApiKeyRow, "id" | "created_at">>,
): Promise<void> {
  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    sets.push(`${k} = ?`);
    args.push(v as string | number | null);
  }
  if (sets.length === 0) return;
  args.push(id);
  await db().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args });
}

export async function deleteApiKey(id: string): Promise<void> {
  await db().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
}

/** إخفاء المفتاح: أول 7 أحرف + •••••••• + آخر 4 (للقصير: أول 3 + ••••). */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 11) return `${key.slice(0, 3)}••••`;
  return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
}
