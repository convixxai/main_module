// ============================================================
// Is migration N applied yet? Cached checks for optional columns / tables,
// so new code can be deployed before its migration runs: until then the
// new fields are simply not written (old queries are used) instead of the
// request failing. A "yes" is cached for good; a "no" is re-checked after a
// minute (the migration may have just run).
// Never used on the per-turn call path.
// ============================================================

import { pool } from "../config/db";

const RECHECK_MS = 60_000;
const cache = new Map<string, { ok: boolean; at: number; pending?: Promise<boolean> }>();

async function check(key: string, sql: string, params: unknown[]): Promise<boolean> {
  const hit = cache.get(key);
  if (hit?.ok) return true;
  if (hit?.pending) return hit.pending;
  if (hit && Date.now() - hit.at < RECHECK_MS) return false;
  const pending = pool
    .query(sql, params)
    .then((r) => Boolean(r.rows[0]?.ok))
    .catch(() => false)
    .then((ok) => {
      cache.set(key, { ok, at: Date.now() });
      return ok;
    });
  cache.set(key, { ok: false, at: Date.now(), pending });
  return pending;
}

export function columnExists(table: string, column: string): Promise<boolean> {
  return check(
    `c:${table}.${column}`,
    `SELECT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2) AS ok`,
    [table, column]
  );
}

export function tableExists(table: string): Promise<boolean> {
  return check(`t:${table}`, `SELECT to_regclass($1) IS NOT NULL AS ok`, [`public.${table}`]);
}

/** Reply for an endpoint whose table is not there yet. */
export const MIGRATION_028_MISSING = {
  error: "Not available yet: database migration 028_saas_requests.sql has not been run",
  code: "migration_pending",
};
