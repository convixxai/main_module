import { FastifyInstance } from "fastify";
import { pool } from "../config/db";
import { selfHostedLLM, generateEmbedding } from "../services/llm";
import { env } from "../config/env";
import { adminAuth } from "../middleware/auth";
import { checkDependency, DEPENDENCIES, DEPENDENCY_GROUPS } from "../services/dependency-health";

export async function healthRoutes(app: FastifyInstance) {
  // ---- Outside services (C3): admin only, cached 60 s, never on the call path ----
  // GET /health/dependencies            every check
  // GET /health/dep/:name               one: sarvam | cartesia | elevenlabs | google_tts | openai | vodafone | exotel | redis
  // GET /health/stt | /health/tts | /health/telephony | /health/redis   groups (ok = every configured one is ok)
  const group = async (names: string[]) => {
    const entries = await Promise.all(names.map(async (n) => [n, await checkDependency(n)] as const));
    const checked = entries.filter(([, v]) => v && v.ok !== null);
    return {
      ok: checked.length === 0 ? null : checked.every(([, v]) => v!.ok === true),
      latency_ms: checked.length ? Math.max(...checked.map(([, v]) => v!.latency_ms ?? 0)) : null,
      checked_at: new Date().toISOString(),
      providers: Object.fromEntries(entries),
    };
  };
  app.get("/health/dependencies", { preHandler: adminAuth }, async () => group(DEPENDENCIES));
  app.get<{ Params: { name: string } }>("/health/dep/:name", { preHandler: adminAuth }, async (request, reply) => {
    const r = await checkDependency(request.params.name);
    if (!r) return reply.status(404).send({ error: `Unknown dependency. One of: ${DEPENDENCIES.join(", ")}` });
    return r;
  });
  for (const [name, members] of Object.entries(DEPENDENCY_GROUPS)) {
    app.get(`/health/${name}`, { preHandler: adminAuth }, async () => group(members));
  }
  app.get("/health/redis", { preHandler: adminAuth }, async () => checkDependency("redis"));

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
