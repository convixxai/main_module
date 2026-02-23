import { FastifyInstance } from "fastify";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { decrypt } from "../services/crypto";

export async function chatRoutes(app: FastifyInstance) {
  // List all chat sessions for the authenticated customer
  app.get(
    "/chat/sessions",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      const customerId = request.customerId!;
      const result = await pool.query(
        `SELECT
           cs.id AS session_id,
           cs.created_at,
           cs.updated_at,
           (SELECT COUNT(*) FROM chat_messages cm WHERE cm.session_id = cs.id)::int AS message_count
         FROM chat_sessions cs
         WHERE cs.customer_id = $1
         ORDER BY cs.updated_at DESC`,
        [customerId]
      );
      return result.rows;
    }
  );

  // Get all messages for a specific session
  app.get(
    "/chat/sessions/:session_id/messages",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { session_id } = request.params as { session_id: string };

      const session = await pool.query(
        "SELECT id FROM chat_sessions WHERE id = $1 AND customer_id = $2",
        [session_id, customerId]
      );
      if (session.rows.length === 0) {
        return reply
          .status(404)
          .send({ error: "Session not found or does not belong to this customer" });
      }

      const result = await pool.query(
        `SELECT id, role, content, source, openai_cost_usd, created_at
         FROM chat_messages
         WHERE session_id = $1
         ORDER BY created_at ASC`,
        [session_id]
      );

      const messages = result.rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: decrypt(row.content),
        source: row.source,
        openai_cost_usd: row.openai_cost_usd,
        created_at: row.created_at,
      }));

      return messages;
    }
  );
}
