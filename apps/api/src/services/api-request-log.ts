// ============================================================
// API key request log (C1): one row per request made with a customer API key
// (x-api-key) in api_request_log — method, path (no query string), status,
// duration, time, key id. Never bodies or headers.
//
// Never inside the request: the response hook only pushes the row into an
// in-memory buffer (no await, no I/O). A timer writes the buffer every few
// seconds as one multi-row INSERT and deletes rows older than 30 days once an
// hour. If the database is slow or the table is missing (migration 028 not
// run), rows are dropped; the API is never affected. Off switch:
// API_REQUEST_LOG_ENABLED=false.
// ============================================================

import { pool } from "../config/db";
import { tableExists } from "./schema-features";

export interface ApiRequestRow {
  customerId: string;
  apiKeyId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  at: Date;
}

const FLUSH_MS = 5_000;
const MAX_BUFFER = 10_000;
const MAX_ROWS_PER_INSERT = 1_000;
const RETENTION_DAYS = 30;
const PURGE_MS = 60 * 60_000;

let buffer: ApiRequestRow[] = [];
let dropped = 0;
let timer: NodeJS.Timeout | null = null;
let purgeTimer: NodeJS.Timeout | null = null;
let flushing = false;
let log: { warn: (o: object, m: string) => void } | null = null;

export function apiRequestLogEnabled(): boolean {
  return !/^(0|false|off|no)$/i.test(String(process.env.API_REQUEST_LOG_ENABLED ?? "true").trim());
}

/** Starts the background writer (once, from app start). */
export function startApiRequestLog(logger: { warn: (o: object, m: string) => void }): void {
  if (!apiRequestLogEnabled() || timer) return;
  log = logger;
  timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref?.();
  purgeTimer = setInterval(() => void purge(), PURGE_MS);
  purgeTimer.unref?.();
}

/** Called from the response hook: buffer only, returns at once. */
export function recordApiRequest(row: ApiRequestRow): void {
  if (!timer) return;
  if (buffer.length >= MAX_BUFFER) {
    buffer.shift();
    dropped++;
  }
  buffer.push(row);
}

async function flush(): Promise<void> {
  if (flushing || buffer.length === 0) return;
  flushing = true;
  const rows = buffer;
  buffer = [];
  try {
    if (!(await tableExists("api_request_log"))) return; // migration 028 not run: drop
    for (let i = 0; i < rows.length; i += MAX_ROWS_PER_INSERT) {
      const chunk = rows.slice(i, i + MAX_ROWS_PER_INSERT);
      await pool.query(
        `INSERT INTO api_request_log (customer_id, api_key_id, method, path, status, duration_ms, created_at)
         SELECT * FROM UNNEST($1::uuid[], $2::uuid[], $3::text[], $4::text[], $5::int[], $6::int[], $7::timestamptz[])`,
        [
          chunk.map((r) => r.customerId),
          chunk.map((r) => r.apiKeyId),
          chunk.map((r) => r.method),
          chunk.map((r) => r.path),
          chunk.map((r) => r.status),
          chunk.map((r) => r.durationMs),
          chunk.map((r) => r.at.toISOString()),
        ]
      );
    }
    if (dropped > 0) {
      log?.warn({ dropped }, "api-request-log: buffer was full, oldest rows dropped");
      dropped = 0;
    }
  } catch (err) {
    log?.warn({ err, rows: rows.length }, "api-request-log: write failed, rows dropped (API unaffected)");
  } finally {
    flushing = false;
  }
}

async function purge(): Promise<void> {
  try {
    if (!(await tableExists("api_request_log"))) return;
    // Small batches so the delete never holds the table for long.
    for (let i = 0; i < 50; i++) {
      const r = await pool.query(
        `DELETE FROM api_request_log WHERE id IN (
           SELECT id FROM api_request_log WHERE created_at < now() - interval '${RETENTION_DAYS} days' LIMIT 5000)`
      );
      if ((r.rowCount ?? 0) < 5000) break;
    }
  } catch (err) {
    log?.warn({ err }, "api-request-log: purge failed");
  }
}

/** For tests and shutdown: write what is buffered now. */
export async function flushApiRequestLog(): Promise<void> {
  await flush();
}
