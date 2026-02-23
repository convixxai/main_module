import { FastifyInstance } from "fastify";
import { pool } from "../config/db";
import { selfHostedLLM, generateEmbedding } from "../services/llm";
import { env } from "../config/env";

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  app.get("/health/db", async (_req, reply) => {
    try {
      const result = await pool.query("SELECT NOW() as time");
      return { status: "ok", time: result.rows[0].time };
    } catch (err: any) {
      return reply.status(503).send({ status: "error", message: err.message });
    }
  });

  app.get("/health/vector", async (_req, reply) => {
    try {
      const result = await pool.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'"
      );
      if (result.rows.length === 0) {
        return reply
          .status(503)
          .send({ status: "error", message: "pgvector extension not found" });
      }
      return { status: "ok", pgvector_version: result.rows[0].extversion };
    } catch (err: any) {
      return reply.status(503).send({ status: "error", message: err.message });
    }
  });

  app.get("/health/llm", async (_req, reply) => {
    try {
      const res = await selfHostedLLM.chat.completions.create({
        model: env.llm.model,
        messages: [{ role: "user", content: "Say hi" }],
        max_tokens: 10,
      });
      const content = res.choices[0]?.message?.content || "";
      return { status: "ok", response: content };
    } catch (err: any) {
      return reply.status(503).send({ status: "error", message: err.message });
    }
  });

  app.get("/health/embedding", async (_req, reply) => {
    try {
      const embedding = await generateEmbedding("test");
      return {
        status: "ok",
        dimensions: embedding.length,
      };
    } catch (err: any) {
      return reply.status(503).send({ status: "error", message: err.message });
    }
  });
}
