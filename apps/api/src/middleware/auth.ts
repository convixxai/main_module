import { FastifyRequest, FastifyReply } from "fastify";
import { pool } from "../config/db";

export interface AuthenticatedRequest extends FastifyRequest {
  customerId?: string;
  customerPrompt?: string;
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
    `SELECT ak.customer_id, c.system_prompt
     FROM api_keys ak
     JOIN customers c ON c.id = ak.customer_id
     WHERE ak.key = $1 AND ak.is_active = TRUE`,
    [apiKey]
  );

  if (result.rows.length === 0) {
    return reply.status(401).send({ error: "Invalid or inactive API key" });
  }

  request.customerId = result.rows[0].customer_id;
  request.customerPrompt = result.rows[0].system_prompt;
}
