import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { generateEmbedding } from "../services/llm";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";

const uploadSchema = z.object({
  entries: z
    .array(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
      })
    )
    .min(1),
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (let i = 0; i < entries.length; i++) {
          const embeddingStr = `[${embeddings[i].join(",")}]`;
          await client.query(
            `INSERT INTO kb_entries (customer_id, question, answer, embedding)
             VALUES ($1, $2, $3, $4)`,
            [customerId, entries[i].question, entries[i].answer, embeddingStr]
          );
        }

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
    async (request: AuthenticatedRequest) => {
      const customerId = request.customerId!;
      const result = await pool.query(
        `SELECT id, question, answer, created_at
         FROM kb_entries
         WHERE customer_id = $1
         ORDER BY created_at DESC`,
        [customerId]
      );
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

      const result = await pool.query(
        `SELECT id, question, answer, created_at
         FROM kb_entries
         WHERE id = $1 AND customer_id = $2`,
        [id, customerId]
      );

      if (result.rows.length === 0) {
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

      const result = await pool.query(
        "DELETE FROM kb_entries WHERE id = $1 AND customer_id = $2 RETURNING id",
        [id, customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "KB entry not found" });
      }

      return { message: "KB entry deleted", id };
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

      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        for (let i = 0; i < entries.length; i++) {
          const embeddingStr = `[${embeddings[i].join(",")}]`;
          await client.query(
            `INSERT INTO kb_entries (customer_id, question, answer, embedding)
             VALUES ($1, $2, $3, $4)`,
            [customerId, entries[i].question, entries[i].answer, embeddingStr]
          );
        }

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
