import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";

const patchRagSchema = z.object({
  rag_use_openai_only: z.boolean(),
});

export async function settingsRoutes(app: FastifyInstance) {
  app.get(
    "/settings/rag",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const result = await pool.query(
        `SELECT rag_use_openai_only FROM customers WHERE id = $1`,
        [customerId]
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return {
        rag_use_openai_only: result.rows[0].rag_use_openai_only === true,
      };
    }
  );

  app.patch(
    "/settings/rag",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = patchRagSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }
      const customerId = request.customerId!;
      const result = await pool.query(
        `UPDATE customers SET rag_use_openai_only = $1 WHERE id = $2
         RETURNING rag_use_openai_only`,
        [body.data.rag_use_openai_only, customerId]
      );
      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return {
        rag_use_openai_only: result.rows[0].rag_use_openai_only === true,
      };
    }
  );
}
