// ============================================================
// Post-call analysis: settings and results (read/write here; the analysis
// itself runs in the separate call-insights worker, after calls end).
//
//   GET /settings/call-insights        {enabled, markers_enabled}
//   PUT /settings/call-insights        {enabled?, markers_enabled?}
//   GET /calls/:id/insights            one call's result (any provider)
//
// Auth: x-api-key, or x-admin-token + x-customer-id.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyOrAdminAuth, AuthenticatedRequest } from "../middleware/auth";
import { tableExists, MIGRATION_028_MISSING } from "../services/schema-features";

const putSchema = z
  .object({ enabled: z.boolean().optional(), markers_enabled: z.boolean().optional() })
  .strict()
  .refine((b) => b.enabled !== undefined || b.markers_enabled !== undefined, { message: "Send enabled and/or markers_enabled" });

async function settings(customerId: string) {
  const r = await pool.query(`SELECT enabled, markers_enabled, updated_at FROM call_insight_settings WHERE customer_id = $1`, [customerId]);
  const row = r.rows[0];
  return {
    enabled: row ? row.enabled : true,
    markers_enabled: row ? row.markers_enabled : false,
    updated_at: row?.updated_at ? new Date(row.updated_at).toISOString() : null,
    note: "Calls are analysed after they end by the call-insights worker (one LLM request per call with a conversation). Markers add a little to that request.",
  };
}

export async function callInsightRoutes(app: FastifyInstance) {
  app.get("/settings/call-insights", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    if (!(await tableExists("call_insight_settings"))) return reply.status(503).send(MIGRATION_028_MISSING);
    return settings(request.customerId!);
  });

  app.put("/settings/call-insights", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const body = putSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    if (!(await tableExists("call_insight_settings"))) return reply.status(503).send(MIGRATION_028_MISSING);
    await pool.query(
      `INSERT INTO call_insight_settings (customer_id, enabled, markers_enabled, updated_at)
       VALUES ($1, COALESCE($2, TRUE), COALESCE($3, FALSE), NOW())
       ON CONFLICT (customer_id) DO UPDATE SET
         enabled = COALESCE($2, call_insight_settings.enabled),
         markers_enabled = COALESCE($3, call_insight_settings.markers_enabled),
         updated_at = NOW()`,
      [request.customerId, body.data.enabled ?? null, body.data.markers_enabled ?? null]
    );
    return settings(request.customerId!);
  });

  app.get<{ Params: { id: string } }>("/calls/:id/insights", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "Call not found" });
    const call = await pool.query(`SELECT id, ended_at FROM exotel_call_sessions WHERE id = $1 AND customer_id = $2`, [id, request.customerId]);
    if (call.rows.length === 0) return reply.status(404).send({ error: "Call not found" });
    if (!(await tableExists("call_insights"))) return reply.status(503).send(MIGRATION_028_MISSING);
    const r = await pool.query(
      `SELECT status, disposition, disposition_confidence, sentiment, sentiment_score, is_voicemail, markers, model, error, attempts, updated_at
         FROM call_insights WHERE call_session_id = $1 AND customer_id = $2`,
      [id, request.customerId]
    );
    const x = r.rows[0];
    if (!x) {
      return reply.send({ call_id: id, status: call.rows[0].ended_at ? "pending" : "call_in_progress", insights: null });
    }
    const num = (v: unknown) => (v == null ? null : Number(v));
    return reply.send({
      call_id: id,
      status: x.status,
      insights:
        x.status === "done"
          ? {
              disposition: x.disposition,
              disposition_confidence: num(x.disposition_confidence),
              sentiment: x.sentiment,
              sentiment_score: num(x.sentiment_score),
              is_voicemail: x.is_voicemail,
              markers: x.markers,
              model: x.model,
              analysed_at: new Date(x.updated_at).toISOString(),
            }
          : null,
      error: x.status === "error" ? { message: x.error, attempts: x.attempts } : null,
    });
  });
}
