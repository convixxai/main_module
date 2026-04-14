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
        `SELECT
           cm.id,
           cm.role,
           cm.content,
           cm.source,
           cm.openai_cost_usd,
           cm.created_at,
           cm.exotel_call_session_id,
           ecs.exotel_call_sid,
           ecs.exotel_stream_sid
         FROM chat_messages cm
         LEFT JOIN exotel_call_sessions ecs ON ecs.id = cm.exotel_call_session_id
         WHERE cm.session_id = $1
         ORDER BY cm.created_at ASC`,
        [session_id]
      );

      const messages = result.rows.map((row) => ({
        id: row.id,
        role: row.role,
        content: decrypt(row.content),
        source: row.source,
        openai_cost_usd: row.openai_cost_usd,
        created_at: row.created_at,
        exotel_call_session_id: row.exotel_call_session_id,
        exotel_call_sid: row.exotel_call_sid,
        exotel_stream_sid: row.exotel_stream_sid,
      }));

      return messages;
    }
  );
}
