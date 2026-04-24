import { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../config/db";
import { env } from "../config/env";

export interface AuthenticatedRequest extends FastifyRequest {
  customerId?: string;
  customerPrompt?: string;
  /** When true, RAG uses OpenAI only (no self-hosted LLM). From `customer_settings` / `customers`. */
  ragUseOpenaiOnly?: boolean;
}

export async function apiKeyAuth(
  request: AuthenticatedRequest,
  reply: FastifyReply
) {
  const apiKey = request.headers["x-api-key"] as string | undefined;

  if (!apiKey) {
    return reply.status(401).send({ error: "Missing x-api-key header" });
  }

  const result = await pool.query(
    `SELECT ak.customer_id,
            c.system_prompt,
            c.rag_use_openai_only           AS legacy_rag_openai_only,
            cs.rag_use_openai_only          AS settings_rag_openai_only
     FROM api_keys ak
     JOIN customers c ON c.id = ak.customer_id
     LEFT JOIN customer_settings cs ON cs.customer_id = ak.customer_id
     WHERE ak.key = $1 AND ak.is_active = TRUE`,
    [apiKey]
  );

  if (result.rows.length === 0) {
    return reply.status(401).send({ error: "Invalid or inactive API key" });
  }

  const row = result.rows[0];
  request.customerId = row.customer_id;
  request.customerPrompt = row.system_prompt;
  // Prefer the new customer_settings row; fall back to legacy `customers` column
  // for databases where migration 005 has not been applied yet.
  request.ragUseOpenaiOnly =
    row.settings_rag_openai_only === true ||
    (row.settings_rag_openai_only == null && row.legacy_rag_openai_only === true);
}

export async function adminAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const token = request.headers["x-admin-token"] as string | undefined;

  if (!env.adminToken) {
    return reply.status(503).send({ error: "Admin token not configured" });
  }

  if (!token || token !== env.adminToken) {
    return reply.status(401).send({ error: "Missing or invalid x-admin-token" });
  }
}
