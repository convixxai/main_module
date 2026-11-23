// ============================================================
// Suggested knowledgebase review API (for the SaaS).
//
// Rows come from services/suggested-kb.ts (written in the background from
// live calls and the chat API). The customer reviews them and sets the
// status: pending -> added (put into the KB) or rejected. This API only
// reads rows and changes their status; adding the KB entry itself is done
// with the normal KB API (POST /kb/upload), then PATCH status "added" with
// the new kb_entry_id.
//
// Auth: x-api-key, or x-admin-token with x-customer-id / customer_id.
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyOrAdminAuth, AuthenticatedRequest } from "../middleware/auth";
import { decrypt } from "../services/crypto";

const STATUSES = ["pending", "added", "rejected"] as const;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const IST_DAY_START = (p: string) => `((${p})::date::timestamp AT TIME ZONE 'Asia/Kolkata')`;

const listQuery = z.object({
  status: z.enum([...STATUSES, "all"]).default("pending"),
  kind: z.enum(["unanswered", "ai_answered"]).optional(),
  q: z.string().max(200).optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
  sort: z.enum(["recent", "most_asked"]).default("recent"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const patchBody = z
  .object({
    status: z.enum(STATUSES),
    kb_entry_id: z.string().uuid().nullable().optional(),
    review_note: z.string().max(1000).nullable().optional(),
  })
  .strict();

function istText(d: unknown): string | null {
  if (!d) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).format(new Date(d as string)).replace(",", "");
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

const COLUMNS = `s.id, s.question, s.question_language_code, s.answer_given, s.kind, s.status, s.source,
  s.occurrence_count, s.first_asked_at, s.last_asked_at, s.kb_top_distance, s.agent_id, a.name AS agent_name,
  s.last_session_id, s.kb_entry_id, s.reviewed_at, s.review_note`;

function present(r: Record<string, any>) {
  return {
    id: r.id,
    question: r.question,
    answer_given: r.answer_given ?? null,
    kind: r.kind,
    status: r.status,
    language_code: r.question_language_code ?? null,
    times_asked: r.occurrence_count,
    first_asked_at: iso(r.first_asked_at),
    first_asked_at_ist: istText(r.first_asked_at),
    last_asked_at: iso(r.last_asked_at),
    last_asked_at_ist: istText(r.last_asked_at),
    kb_top_distance: r.kb_top_distance == null ? null : Number(r.kb_top_distance),
    source: r.source ?? null,
    agent: r.agent_id ? { id: r.agent_id, name: r.agent_name ?? null } : null,
    last_session_id: r.last_session_id ?? null,
    kb_entry_id: r.kb_entry_id ?? null,
    reviewed_at: iso(r.reviewed_at),
    review_note: r.review_note ?? null,
  };
}

export async function kbSuggestionRoutes(app: FastifyInstance) {
  // List suggestions (default: pending, newest first) + counts per status.
  app.get("/kb/suggestions", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const q = listQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
    const f = q.data;
    if (f.from && f.to && f.to < f.from) return reply.status(400).send({ error: "`to` is before `from`" });
    const params: unknown[] = [request.customerId];
    const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const where = [`s.customer_id = $1`];
    if (f.status !== "all") where.push(`s.status = ${add(f.status)}`);
    if (f.kind) where.push(`s.kind = ${add(f.kind)}`);
    if (f.q) where.push(`(s.question ILIKE ${add(`%${f.q}%`)} OR s.answer_given ILIKE $${params.length})`);
    if (f.from) where.push(`s.last_asked_at >= ${IST_DAY_START(add(f.from))}`);
    if (f.to) where.push(`s.last_asked_at < ${IST_DAY_START(add(f.to))} + interval '1 day'`);
    const order = f.sort === "most_asked" ? `s.occurrence_count DESC, s.last_asked_at DESC` : `s.last_asked_at DESC`;
    const from = `FROM suggested_kb_entries s LEFT JOIN agents a ON a.id = s.agent_id WHERE ${where.join(" AND ")}`;
    const [rows, total, counts] = await Promise.all([
      pool.query(`SELECT ${COLUMNS} ${from} ORDER BY ${order} LIMIT ${f.limit} OFFSET ${f.offset}`, params),
      pool.query(`SELECT COUNT(*)::int AS n ${from}`, params),
      pool.query(
        `SELECT status, COUNT(*)::int AS n FROM suggested_kb_entries WHERE customer_id = $1 GROUP BY status`,
        [request.customerId]
      ),
    ]);
    const byStatus: Record<string, number> = { pending: 0, added: 0, rejected: 0 };
    for (const r of counts.rows) byStatus[r.status] = r.n;
    return reply.send({
      filters: { status: f.status, kind: f.kind ?? null, q: f.q ?? null, from: f.from ?? null, to: f.to ?? null, sort: f.sort },
      counts: byStatus,
      total: total.rows[0].n,
      limit: f.limit,
      offset: f.offset,
      suggestions: rows.rows.map(present),
    });
  });

  // One suggestion + the conversation it last came from.
  app.get<{ Params: { id: string } }>("/kb/suggestions/:id", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "Suggestion not found" });
    const r = await pool.query(
      `SELECT ${COLUMNS} FROM suggested_kb_entries s LEFT JOIN agents a ON a.id = s.agent_id
        WHERE s.id = $1 AND s.customer_id = $2`,
      [id, request.customerId]
    );
    const row = r.rows[0];
    if (!row) return reply.status(404).send({ error: "Suggestion not found" });
    let conversation: { role: string; text: string; at: string | null }[] = [];
    if (row.last_session_id) {
      const m = await pool.query(
        `SELECT m.role, m.content, m.created_at FROM chat_messages m
           JOIN chat_sessions cs ON cs.id = m.session_id AND cs.customer_id = $2
          WHERE m.session_id = $1 ORDER BY m.created_at ASC, m.id ASC LIMIT 200`,
        [row.last_session_id, request.customerId]
      );
      conversation = m.rows.map((x) => {
        let text = "";
        try { text = decrypt(x.content); } catch { text = ""; }
        return { role: x.role === "assistant" ? "bot" : x.role === "user" ? "customer" : x.role, text, at: iso(x.created_at) };
      });
    }
    return reply.send({ suggestion: present(row), conversation });
  });

  // Review: set status to added / rejected (or back to pending).
  app.patch<{ Params: { id: string } }>("/kb/suggestions/:id", { preHandler: apiKeyOrAdminAuth }, async (request: AuthenticatedRequest, reply) => {
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "Suggestion not found" });
    const body = patchBody.safeParse(request.body ?? {});
    if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
    const b = body.data;
    if (b.kb_entry_id) {
      const kb = await pool.query(`SELECT 1 FROM kb_entries WHERE id = $1 AND customer_id = $2`, [b.kb_entry_id, request.customerId]);
      if (kb.rows.length === 0) return reply.status(400).send({ error: "kb_entry_id is not a KB entry of this customer" });
    }
    const r = await pool.query(
      `UPDATE suggested_kb_entries s
          SET status = $3,
              reviewed_at = CASE WHEN $3 = 'pending' THEN NULL ELSE now() END,
              kb_entry_id = CASE WHEN $3 = 'added' THEN COALESCE($4::uuid, s.kb_entry_id) ELSE NULL END,
              review_note = CASE WHEN $5::boolean THEN $6 ELSE s.review_note END,
              updated_at = now()
        WHERE s.id = $1 AND s.customer_id = $2
        RETURNING id`,
      [id, request.customerId, b.status, b.kb_entry_id ?? null, b.review_note !== undefined, b.review_note ?? null]
    );
    if (r.rows.length === 0) return reply.status(404).send({ error: "Suggestion not found" });
    const full = await pool.query(
      `SELECT ${COLUMNS} FROM suggested_kb_entries s LEFT JOIN agents a ON a.id = s.agent_id WHERE s.id = $1`,
      [id]
    );
    return reply.send({ suggestion: present(full.rows[0]) });
  });
}
