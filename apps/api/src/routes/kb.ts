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
}
