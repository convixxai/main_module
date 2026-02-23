import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";

const createAgentSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional().default(""),
  system_prompt: z.string().optional().default("You are a helpful assistant."),
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  system_prompt: z.string().optional(),
});

export async function agentRoutes(app: FastifyInstance) {
  app.post(
    "/agents",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = createAgentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { name, description, system_prompt } = body.data;

      const result = await pool.query(
        `INSERT INTO agents (customer_id, name, description, system_prompt)
         VALUES ($1, $2, $3, $4)
         RETURNING id, customer_id, name, description, system_prompt, is_active, created_at, updated_at`,
        [customerId, name, description, system_prompt]
      );

      return reply.status(201).send(result.rows[0]);
    }
  );

  app.get(
    "/agents",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest) => {
      const customerId = request.customerId!;

      const result = await pool.query(
        `SELECT id, name, description, system_prompt, is_active, created_at, updated_at
         FROM agents
         WHERE customer_id = $1
         ORDER BY created_at DESC`,
        [customerId]
      );

      return result.rows;
    }
  );

  app.get<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      const result = await pool.query(
        `SELECT id, name, description, system_prompt, is_active, created_at, updated_at
         FROM agents
         WHERE id = $1 AND customer_id = $2`,
        [id, customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      return result.rows[0];
    }
  );

  app.put<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = updateAgentSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const { id } = request.params as { id: string };
      const { name, description, system_prompt } = body.data;

      if (!name && description === undefined && system_prompt === undefined) {
        return reply
          .status(400)
          .send({ error: "Provide at least one field to update" });
      }

      const existing = await pool.query(
        "SELECT id FROM agents WHERE id = $1 AND customer_id = $2",
        [id, customerId]
      );

      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      const sets: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (name) {
        sets.push(`name = $${idx++}`);
        values.push(name);
      }
      if (description !== undefined) {
        sets.push(`description = $${idx++}`);
        values.push(description);
      }
      if (system_prompt !== undefined) {
        sets.push(`system_prompt = $${idx++}`);
        values.push(system_prompt);
      }

      sets.push(`updated_at = NOW()`);
      values.push(id);
      values.push(customerId);

      const result = await pool.query(
        `UPDATE agents SET ${sets.join(", ")}
         WHERE id = $${idx++} AND customer_id = $${idx}
         RETURNING id, name, description, system_prompt, is_active, created_at, updated_at`,
        values
      );

      return result.rows[0];
    }
  );

  app.delete<{ Params: { id: string } }>(
    "/agents/:id",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const { id } = request.params as { id: string };

      const result = await pool.query(
        "DELETE FROM agents WHERE id = $1 AND customer_id = $2 RETURNING id",
        [id, customerId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Agent not found" });
      }

      return { message: "Agent deleted", id };
    }
  );
}
