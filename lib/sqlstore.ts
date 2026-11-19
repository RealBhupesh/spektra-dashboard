// Postgres key/value backend (Neon over HTTP in production). It mirrors the
// blob contract exactly: write-once keys, read one key, list by prefix. One
// row per key means appends are unique inserts and can never overwrite or
// lose another instance's write. A list returns values in the same query, so
// a refresh is one round trip instead of one list plus one download per row.
// Tests set SQL_DRIVER=pglite for an embedded Postgres; production uses Neon.

type Q = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

let q: Q | null = null;
let ready: Promise<void> | null = null;

export const sqlConfigured = () => Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SQL_DRIVER === "pglite");

async function driver(): Promise<Q> {
  if (q) return q;
  if (process.env.SQL_DRIVER === "pglite") {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite(process.env.PGLITE_DIR || undefined);
    q = async (text, params) => ({ rows: (await db.query(text, params as unknown[])).rows as Record<string, unknown>[] });
  } else {
    const { neon } = await import("@neondatabase/serverless");
    const run = neon((process.env.DATABASE_URL || process.env.POSTGRES_URL)!);
    q = async (text, params) => ({ rows: (await run.query(text, params ?? [])) as unknown as Record<string, unknown>[] });
  }
  return q;
}

async function exec(text: string, params?: unknown[]) {
  const run = await driver();
  ready ??= run("CREATE TABLE IF NOT EXISTS spektra_kv (key text PRIMARY KEY, body jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now())").then(() => undefined);
  await ready;
  return run(text, params);
}

/** Insert once. Returns false when the key already exists (never overwrites). */
export async function kvPutNew(key: string, body: unknown): Promise<boolean> {
  const r = await exec("INSERT INTO spektra_kv (key, body) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO NOTHING RETURNING key", [key, JSON.stringify(body)]);
  return r.rows.length === 1;
}

export async function kvGet(key: string): Promise<unknown | null> {
  const r = await exec("SELECT body FROM spektra_kv WHERE key = $1", [key]);
  return r.rows.length ? r.rows[0].body : null;
}

export async function kvList(prefix: string): Promise<{ key: string; body: unknown }[]> {
  const r = await exec("SELECT key, body FROM spektra_kv WHERE left(key, length($1)) = $1 ORDER BY key", [prefix]);
  return r.rows.map((x) => ({ key: String(x.key), body: x.body }));
}
