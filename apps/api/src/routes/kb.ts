import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { generateEmbedding } from "../services/llm";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { columnExists, tableExists, MIGRATION_028_MISSING } from "../services/schema-features";

// ------------------------------------------------------------
// Source and archive (migration 028).
//   source    how an entry was added: manual | json_upload | csv_upload | api
//             (null for entries added before it was recorded).
//   archive   PATCH /kb/entries/:id {"archived": true} moves the entry (and
//             its translations) to kb_entries_archived; {"archived": false}
//             moves it back with the same id. Answers only ever read
//             kb_entries, so an archived entry is never used, and /ask is
//             unchanged (no extra filter on the KB search).
// GET /kb/entries keeps returning a plain array; new keys only.
// ------------------------------------------------------------
const KB_SOURCES = ["manual", "json_upload", "csv_upload", "api"] as const;
const kbSource = z.enum(KB_SOURCES);

const listQuery = z.object({
  source: kbSource.optional(),
  /** active (default) | archived | all */
  status: z.enum(["active", "archived", "all"]).default("active"),
  /** Optional paging; without limit every entry is returned, as before. */
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const patchSchema = z.object({ archived: z.boolean() }).strict();

/** Saves `source` on entries just created, inside the caller's transaction (skipped before migration 028). */
async function tagSource(client: { query: typeof pool.query }, ids: string[], source: string | null, hasColumn: boolean): Promise<void> {
  if (!source || ids.length === 0 || !hasColumn) return;
  await client.query(`UPDATE kb_entries SET source = $1 WHERE id = ANY($2::uuid[])`, [source, ids]);
}

const ACTIVE_COLS = `id, question, answer, created_at, (to_jsonb(kb_entries) ->> 'source') AS source, 'active' AS status, NULL::timestamptz AS archived_at`;
const ARCHIVED_COLS = `id, question, answer, created_at, source, 'archived' AS status, archived_at`;

const uploadSchema = z.object({
  entries: z
    .array(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
      })
    )
    .min(1),
  /** How these entries were added (default "api"). */
  source: kbSource.optional(),
});

const updateSchema = z.object({
  question: z.string().min(1).optional(),
  answer: z.string().min(1).optional(),
});

export async function kbRoutes(app: FastifyInstance) {
  // Upload Q&A pairs
  app.post(
    "/kb/upload",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = uploadSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { entries } = body.data;

      const embeddings = await Promise.all(
        entries.map((e) => generateEmbedding(e.question))
      );
      const hasSource = await columnExists("kb_entries", "source");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const ids: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          const embeddingStr = `[${embeddings[i].join(",")}]`;
          const r = await client.query(
            `INSERT INTO kb_entries (customer_id, question, answer, embedding)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [customerId, entries[i].question, entries[i].answer, embeddingStr]
          );
          ids.push(r.rows[0].id);
        }
        await tagSource(client, ids, body.data.source ?? "api", hasSource);

        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }

      return reply.status(201).send({
        message: `${entries.length} Q&A entries uploaded`,
        customer_id: customerId,
      });
    }
  );

  // List all KB entries
  app.get(
    "/kb/entries",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const q = listQuery.safeParse(request.query ?? {});
      if (!q.success) return reply.status(400).send({ error: q.error.flatten() });
      const f = q.data;
      const archive = f.status !== "active" && (await tableExists("kb_entries_archived"));
      if (f.status === "archived" && !archive) return [];
      const params: unknown[] = [customerId];
      const sourceFilter = f.source ? (params.push(f.source), ` AND source = $${params.length}`) : "";
      const parts: string[] = [];
      if (f.status !== "archived") {
        parts.push(`SELECT * FROM (SELECT ${ACTIVE_COLS} FROM kb_entries WHERE customer_id = $1) a WHERE TRUE${sourceFilter}`);
      }
      if (archive) {
        parts.push(`SELECT ${ARCHIVED_COLS} FROM kb_entries_archived WHERE customer_id = $1${sourceFilter}`);
      }
      const page = f.limit ? ` LIMIT ${f.limit} OFFSET ${f.offset}` : f.offset ? ` OFFSET ${f.offset}` : "";
      const result = await pool.query(`${parts.join(" UNION ALL ")} ORDER BY created_at DESC${page}`, params);
      return result.rows;
    }
  );

  // Get single KB entry by ID
  app.get(
    "/kb/entries/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "KB entry not found" });
      const result = await pool.query(
        `SELECT ${ACTIVE_COLS}
         FROM kb_entries
         WHERE id = $1 AND customer_id = $2`,
        [id, customerId]
      );

      if (result.rows.length === 0) {
        if (await tableExists("kb_entries_archived")) {
          const archived = await pool.query(`SELECT ${ARCHIVED_COLS} FROM kb_entries_archived WHERE id = $1 AND customer_id = $2`, [id, customerId]);
          if (archived.rows[0]) return archived.rows[0];
        }
        return reply.status(404).send({ error: "KB entry not found" });
      }

      return result.rows[0];
    }
  );

  // Update a KB entry (re-generates embedding if question changes)
  app.put(
    "/kb/entries/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      const body = updateSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { question, answer } = body.data;
      if (!question && !answer) {
        return reply
          .status(400)
          .send({ error: "Provide at least question or answer to update" });
      }

      const existing = await pool.query(
        "SELECT id, question, answer FROM kb_entries WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: "KB entry not found" });
      }

      const newQuestion = question || existing.rows[0].question;
      const newAnswer = answer || existing.rows[0].answer;
      const questionChanged = !!question;

      if (questionChanged) {
        const embedding = await generateEmbedding(newQuestion);
        const embeddingStr = `[${embedding.join(",")}]`;
        await pool.query(
          `UPDATE kb_entries
           SET question = $1, answer = $2, embedding = $3
           WHERE id = $4 AND customer_id = $5`,
          [newQuestion, newAnswer, embeddingStr, id, customerId]
        );
      } else {
        await pool.query(
          `UPDATE kb_entries SET answer = $1 WHERE id = $2 AND customer_id = $3`,
          [newAnswer, id, customerId]
        );
      }

      const updated = await pool.query(
        "SELECT id, question, answer, created_at FROM kb_entries WHERE id = $1",
        [id]
      );

      return updated.rows[0];
    }
  );

  // Delete a KB entry
  app.delete(
    "/kb/entries/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "KB entry not found" });
      const result = await pool.query(
        "DELETE FROM kb_entries WHERE id = $1 AND customer_id = $2 RETURNING id",
        [id, customerId]
      );

      if (result.rows.length === 0) {
        const archived = (await tableExists("kb_entries_archived"))
          ? await pool.query("DELETE FROM kb_entries_archived WHERE id = $1 AND customer_id = $2 RETURNING id", [id, customerId])
          : { rows: [] };
        if (archived.rows.length === 0) return reply.status(404).send({ error: "KB entry not found" });
      }

      return { message: "KB entry deleted", id };
    }
  );

  // Archive / unarchive one KB entry (B5). Archived entries are never used for answers.
  app.patch(
    "/kb/entries/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };
      const body = patchSchema.safeParse(request.body ?? {});
      if (!body.success) return reply.status(400).send({ error: body.error.flatten() });
      if (!z.string().uuid().safeParse(id).success) return reply.status(404).send({ error: "KB entry not found" });
      if (!(await tableExists("kb_entries_archived"))) return reply.status(503).send(MIGRATION_028_MISSING);

      let moved = false;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        if (body.data.archived) {
          const archivedRow = await client.query(
            `INSERT INTO kb_entries_archived (id, customer_id, question, answer, embedding, agent_id, source_language_code, source, created_at, translations)
             SELECT e.id, e.customer_id, e.question, e.answer, e.embedding, e.agent_id, e.source_language_code, e.source, e.created_at,
                    COALESCE((SELECT jsonb_agg(to_jsonb(t)) FROM kb_entry_translations t WHERE t.kb_entry_id = e.id), '[]'::jsonb)
               FROM kb_entries e WHERE e.id = $1 AND e.customer_id = $2
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [id, customerId]
          );
          if (archivedRow.rows.length > 0) {
            await client.query(`DELETE FROM kb_entries WHERE id = $1 AND customer_id = $2`, [id, customerId]);
            moved = true;
          }
        } else {
          const restored = await client.query(
            `INSERT INTO kb_entries (id, customer_id, question, answer, embedding, agent_id, source_language_code, source, created_at)
             SELECT id, customer_id, question, answer, embedding, agent_id, source_language_code, source, created_at
               FROM kb_entries_archived WHERE id = $1 AND customer_id = $2
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            [id, customerId]
          );
          if (restored.rows.length > 0) {
            await client.query(
              `INSERT INTO kb_entry_translations
               SELECT r.* FROM kb_entries_archived a,
                      jsonb_populate_recordset(NULL::kb_entry_translations, a.translations) r
                WHERE a.id = $1 AND a.customer_id = $2
               ON CONFLICT DO NOTHING`,
              [id, customerId]
            );
            await client.query(`DELETE FROM kb_entries_archived WHERE id = $1 AND customer_id = $2`, [id, customerId]);
            moved = true;
          }
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
      const status = body.data.archived ? "archived" : "active";
      if (moved) return reply.send({ id, status, changed: true });
      // Nothing moved: already in the asked state, or not this customer's entry.
      const where = body.data.archived ? "kb_entries_archived" : "kb_entries";
      const already = await pool.query(`SELECT 1 FROM ${where} WHERE id = $1 AND customer_id = $2`, [id, customerId]);
      return already.rows.length
        ? reply.send({ id, status, changed: false })
        : reply.status(404).send({ error: "KB entry not found" });
    }
  );

  // GET /kb/sample — Sample JSON to download
  app.get(
    "/kb/sample",
    { preHandler: apiKeyAuth },
    async (request, reply) => {
      const sampleData = [
        {
          question: "What are the check-in and check-out timings at Chhavani Resort?",
          answer: "Our standard check-in time is 2:00 PM and check-out time is 11:00 AM."
        },
        {
          question: "Do you have dynamic industry context/tone support?",
          answer: "Yes! You can define custom sentiment guidelines and tonality per-tenant."
        }
      ];
      return reply
        .header("Content-Disposition", 'attachment; filename="kb_sample.json"')
        .header("Content-Type", "application/json")
        .send(JSON.stringify(sampleData, null, 2));
    }
  );

  // POST /kb/upload-file — Accepts a JSON file upload containing an array of Q&A pairs
  app.post(
    "/kb/upload-file",
    { preHandler: apiKeyAuth },
    async (request: any, reply) => {
      const customerId = request.customerId!;
      const srcQ = kbSource.safeParse((request.query as Record<string, unknown> | undefined)?.source ?? "json_upload");
      if (!srcQ.success) return reply.status(400).send({ error: `source must be one of ${KB_SOURCES.join(", ")}` });
      let rawData = "";

      if (request.isMultipart?.()) {
        const fileData = await request.file();
        if (!fileData) {
          return reply.status(400).send({ error: "No file uploaded" });
        }
        const buffer = await fileData.toBuffer();
        rawData = buffer.toString("utf-8");
      } else {
        // Fallback to text/plain or raw JSON body
        if (typeof request.body === "string") {
          rawData = request.body;
        } else if (typeof request.body === "object" && request.body !== null) {
          rawData = JSON.stringify(request.body);
        }
      }

      let entries: any[] = [];
      try {
        const parsed = JSON.parse(rawData);
        if (Array.isArray(parsed)) {
          entries = parsed;
        } else if (parsed && Array.isArray(parsed.entries)) {
          entries = parsed.entries;
        } else {
          return reply.status(400).send({ error: "Invalid file format. Must be a JSON array of entries or an object containing an 'entries' array." });
        }
      } catch (e) {
        return reply.status(400).send({ error: "Invalid JSON in file. Please provide valid JSON content." });
      }

      if (entries.length === 0) {
        return reply.status(400).send({ error: "No entries found in file" });
      }

      const embeddings = await Promise.all(
        entries.map(async (e: any) => {
          if (!e.question || !e.answer) {
            throw new Error("Each entry must contain both a 'question' and 'answer' field");
          }
          return generateEmbedding(e.question);
        })
      );
      const hasSource = await columnExists("kb_entries", "source");

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const ids: string[] = [];
        for (let i = 0; i < entries.length; i++) {
          const embeddingStr = `[${embeddings[i].join(",")}]`;
          const r = await client.query(
            `INSERT INTO kb_entries (customer_id, question, answer, embedding)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [customerId, entries[i].question, entries[i].answer, embeddingStr]
          );
          ids.push(r.rows[0].id);
        }
        await tagSource(client, ids, srcQ.data, hasSource);

        await client.query("COMMIT");
      } catch (err: any) {
        await client.query("ROLLBACK");
        return reply.status(500).send({ error: err.message || "Failed to save entries to the database" });
      } finally {
        client.release();
      }

      return reply.status(201).send({
        message: `${entries.length} Q&A entries uploaded from file successfully`,
        customer_id: customerId,
      });
    }
  );
}
