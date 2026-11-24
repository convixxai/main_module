// ============================================================
// Usage per customer (read only, nothing on the call path).
//
//   GET /customers/:id/api-keys/:keyId/requests   requests made with one API key (C1)
//   GET /customers/:id/usage                      counters for a period (C2)
//
// Auth: x-api-key (its own customer only), or x-admin-token + x-customer-id.
// :id must be the authenticated customer.
// ============================================================

import fsp from "fs/promises";
import path from "path";
import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyOrAdminAuth, AuthenticatedRequest } from "../middleware/auth";
import { tableExists, MIGRATION_028_MISSING } from "../services/schema-features";

const UUID = z.string().uuid();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const requestsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** ISO time: only requests before it (for the next page, pass the last row's `at`). */
  before: z.string().datetime({ offset: true }).optional(),
});

const usageQuery = z.object({
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});

function istToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** :id must be the customer the request is authenticated as. */
function sameCustomer(request: AuthenticatedRequest, reply: FastifyReply, id: string): boolean {
  if (!UUID.safeParse(id).success || id !== request.customerId) {
    reply.status(404).send({ error: "Customer not found" });
    return false;
  }
  return true;
}

export async function usageRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string; keyId: string } }>(
    "/customers/:id/api-keys/:keyId/requests",
    { preHandler: apiKeyOrAdminAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id, keyId } = request.params as { id: string; keyId: string };
      if (!sameCustomer(request, reply, id)) return;
      const q = requestsQuery.safeParse(request.query ?? {});
      if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
      if (!UUID.safeParse(keyId).success) return reply.status(404).send({ error: "API key not found" });
      const key = await pool.query(`SELECT id FROM api_keys WHERE id = $1 AND customer_id = $2`, [keyId, id]);
      if (key.rows.length === 0) return reply.status(404).send({ error: "API key not found" });
      if (!(await tableExists("api_request_log"))) return reply.status(503).send(MIGRATION_028_MISSING);

      const params: unknown[] = [keyId, id];
      const before = q.data.before ? (params.push(q.data.before), ` AND created_at < $${params.length}::timestamptz`) : "";
      const r = await pool.query(
        `SELECT method, path, status, duration_ms, created_at FROM api_request_log
          WHERE api_key_id = $1 AND customer_id = $2${before}
          ORDER BY created_at DESC LIMIT ${q.data.limit}`,
        params
      );
      const rows = r.rows.map((x) => ({
        method: x.method,
        path: x.path,
        status: x.status,
        duration_ms: x.duration_ms,
        at: new Date(x.created_at).toISOString(),
      }));
      return reply.send({
        key_id: keyId,
        retention_days: 30,
        limit: q.data.limit,
        next_before: rows.length === q.data.limit ? rows[rows.length - 1].at : null,
        requests: rows,
      });
    }
  );

  app.get<{ Params: { id: string } }>(
    "/customers/:id/usage",
    { preHandler: apiKeyOrAdminAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { id } = request.params as { id: string };
      if (!sameCustomer(request, reply, id)) return;
      const q = usageQuery.safeParse(request.query ?? {});
      if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
      const to = q.data.to ?? istToday();
      const from = q.data.from ?? addDays(to, -29);
      if (to < from) return reply.status(400).send({ error: "`to` is before `from`" });
      if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) return reply.status(400).send({ error: "The range may be at most 366 days" });

      // IST day bounds as UTC instants.
      const fromTs = `(($2)::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;
      const toTs = `((($3)::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')`;
      const [hasLog, hasArchive] = await Promise.all([tableExists("api_request_log"), tableExists("kb_entries_archived")]);
      const [api, kb, archived, calls, audio] = await Promise.all([
        hasLog
          ? pool.query(`SELECT COUNT(*)::int AS n FROM api_request_log WHERE customer_id = $1 AND created_at >= ${fromTs} AND created_at < ${toTs}`, [id, from, to])
          : null,
        pool.query(`SELECT COUNT(*)::int AS n FROM kb_entries WHERE customer_id = $1`, [id]),
        hasArchive ? pool.query(`SELECT COUNT(*)::int AS n FROM kb_entries_archived WHERE customer_id = $1`, [id]) : null,
        // exotel_call_sessions.started_at is UTC wall-clock (no zone).
        pool.query(
          `SELECT COUNT(*)::int AS calls,
                  COUNT(*) FILTER (WHERE metadata->>'provider' = 'vodafone')::int AS vodafone,
                  COUNT(*) FILTER (WHERE COALESCE(metadata->>'provider', 'exotel') <> 'vodafone')::int AS exotel,
                  COALESCE(SUM(GREATEST(0, EXTRACT(EPOCH FROM (ended_at - started_at)))) FILTER (WHERE ended_at IS NOT NULL), 0)::int AS talk_seconds
             FROM exotel_call_sessions
            WHERE customer_id = $1
              AND started_at >= (${fromTs} AT TIME ZONE 'UTC') AND started_at < (${toTs} AT TIME ZONE 'UTC')`,
          [id, from, to]
        ),
        pool.query(`SELECT audio_file_path FROM outbound_campaigns WHERE customer_id = $1 AND audio_file_path IS NOT NULL LIMIT 1000`, [id]),
      ]);

      // Files the engine stores for this customer: campaign script audio (uploads/campaigns).
      const uploadRoot = path.resolve(process.cwd(), "uploads");
      let audioBytes = 0;
      let audioFiles = 0;
      await Promise.all(
        audio.rows.map(async (r) => {
          const p = path.resolve(String(r.audio_file_path));
          if (!p.startsWith(uploadRoot + path.sep)) return;
          try {
            const st = await fsp.stat(p);
            audioBytes += st.size;
            audioFiles++;
          } catch {
            /* file gone */
          }
        })
      );

      return reply.send({
        customer_id: id,
        period: { from, to, timezone: "Asia/Kolkata" },
        api_requests: api ? api.rows[0].n : null,
        api_requests_note: api ? "Requests made with this customer's API keys (kept 30 days)" : MIGRATION_028_MISSING.error,
        kb_entries: { active: kb.rows[0].n, archived: archived ? archived.rows[0].n : 0 },
        storage: {
          campaign_audio_bytes: audioBytes,
          campaign_audio_files: audioFiles,
          recordings_bytes: 0,
          total_bytes: audioBytes,
          note: "Call recordings are not stored by the engine (Vodafone keeps its own; Exotel links are kept by Exotel).",
        },
        calls: calls.rows[0],
      });
    }
  );
}
