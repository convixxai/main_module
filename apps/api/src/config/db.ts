import type { FastifyBaseLogger } from "fastify";
import { Pool } from "pg";
import { env } from "./env";

export const pool = new Pool({
  host: env.pg.host,
  port: env.pg.port,
  user: env.pg.user,
  password: env.pg.password,
  database: env.pg.database,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

let queryLoggingAttached = false;

/** Wrap `pool.query` to log SQL + duration when `LOG_DB_QUERIES=true`. Call once from `buildApp`. */
export function attachPoolQueryLogging(log: FastifyBaseLogger): void {
  if (!env.logDbQueries || queryLoggingAttached) return;
  queryLoggingAttached = true;

  const orig = pool.query.bind(pool);
  // pg overloads — delegate with any to preserve behaviour
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (pool as any).query = (...args: any[]) => {
    const first = args[0];
    const text =
      typeof first === "string" ? first : (first?.text ?? String(first));
    const start = Date.now();
    return (orig as (...a: any[]) => Promise<{ rowCount?: number | null }>)(...args).then(
      (res: { rowCount?: number | null }) => {
        log.debug(
          {
            durationMs: Date.now() - start,
            rowCount: res.rowCount,
            sql: String(text).slice(0, 2000),
          },
          "db.query"
        );
        return res;
      },
      (err: unknown) => {
        log.error(
          {
            err,
            durationMs: Date.now() - start,
            sql: String(text).slice(0, 500),
          },
          "db.query failed"
        );
        return Promise.reject(err);
      }
    );
  };
}
