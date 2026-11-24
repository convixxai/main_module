import { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../config/db";
import { env } from "../config/env";

export interface AuthenticatedRequest extends FastifyRequest {
  customerId?: string;
  customerPrompt?: string;
  /** When true, RAG uses OpenAI only (no self-hosted LLM). From `customer_settings` / `customers`. */
  ragUseOpenaiOnly?: boolean;
  /** api_keys.id of the x-api-key used (set by apiKeyAuth; for the API request log). */
  apiKeyId?: string;
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
            ak.id AS api_key_id,
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
  request.apiKeyId = row.api_key_id;
  // Prefer the new customer_settings row; fall back to legacy `customers` column
  // for databases where migration 005 has not been applied yet.
  request.ragUseOpenaiOnly =
    row.settings_rag_openai_only === true ||
    (row.settings_rag_openai_only == null && row.legacy_rag_openai_only === true);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Customer key OR admin token (for read-only report routes).
 *  - `x-api-key`: the customer is the key's owner (same as apiKeyAuth).
 *  - `x-admin-token` + the customer to read, as `x-customer-id` header or
 *    `customer_id` query parameter (a customers.id UUID).
 * Anything else is 401 (no customer can be read without one of the two).
 */
export async function apiKeyOrAdminAuth(
  request: AuthenticatedRequest,
  reply: FastifyReply
) {
  if (request.headers["x-api-key"]) return apiKeyAuth(request, reply);

  const token = request.headers["x-admin-token"] as string | undefined;
  if (!token) {
    return reply.status(401).send({ error: "Send x-api-key, or x-admin-token with x-customer-id" });
  }
  if (!env.adminToken) {
    return reply.status(503).send({ error: "Admin token not configured" });
  }
  if (token !== env.adminToken) {
    return reply.status(401).send({ error: "Missing or invalid x-admin-token" });
  }

  const fromHeader = request.headers["x-customer-id"];
  const fromQuery = (request.query as Record<string, unknown> | undefined)?.customer_id;
  const customerId = String((Array.isArray(fromHeader) ? fromHeader[0] : fromHeader) ?? fromQuery ?? "").trim();
  if (!customerId) {
    return reply.status(400).send({ error: "With x-admin-token, send the customer as x-customer-id header or customer_id query parameter" });
  }
  if (!UUID_RE.test(customerId)) {
    return reply.status(400).send({ error: "customer id must be a UUID" });
  }
  const c = await pool.query(`SELECT id, system_prompt FROM customers WHERE id = $1`, [customerId]);
  if (c.rows.length === 0) {
    return reply.status(404).send({ error: "No such customer" });
  }
  request.customerId = c.rows[0].id;
  request.customerPrompt = c.rows[0].system_prompt;
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
