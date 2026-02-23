import { FastifyInstance } from "fastify";
import { z } from "zod";
import crypto from "crypto";
import { pool } from "../config/db";
import { adminAuth } from "../middleware/auth";

const createCustomerSchema = z.object({
  name: z.string().min(1),
  system_prompt: z.string().optional(),
});

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  system_prompt: z.string().optional(),
});

export async function customerRoutes(app: FastifyInstance) {
  app.post("/customers", { preHandler: adminAuth }, async (request, reply) => {
    const body = createCustomerSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: body.error.flatten() });
    }

    const { name, system_prompt } = body.data;
    const result = await pool.query(
      `INSERT INTO customers (name, system_prompt)
       VALUES ($1, $2)
       RETURNING id, name, system_prompt, created_at`,
      [name, system_prompt || "You are a helpful assistant."]
    );

    return reply.status(201).send(result.rows[0]);
  });

  app.get("/customers", { preHandler: adminAuth }, async () => {
    const result = await pool.query(
      "SELECT id, name, system_prompt, created_at FROM customers ORDER BY created_at DESC"
    );
    return result.rows;
  });

  app.get<{ Params: { id: string } }>(
    "/customers/:id",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { id } = request.params;

      const result = await pool.query(
        "SELECT id, name, system_prompt, created_at FROM customers WHERE id = $1",
        [id]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      return result.rows[0];
    }
  );

  app.put<{ Params: { id: string } }>(
    "/customers/:id",
    { preHandler: adminAuth },
    async (request, reply) => {
      const body = updateCustomerSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const { id } = request.params;
      const { name, system_prompt } = body.data;

      if (!name && system_prompt === undefined) {
        return reply
          .status(400)
          .send({ error: "Provide at least name or system_prompt to update" });
      }

      const existing = await pool.query(
        "SELECT id FROM customers WHERE id = $1",
        [id]
      );
      if (existing.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      const sets: string[] = [];
      const values: any[] = [];
      let idx = 1;

      if (name) {
        sets.push(`name = $${idx++}`);
        values.push(name);
      }
      if (system_prompt !== undefined) {
        sets.push(`system_prompt = $${idx++}`);
        values.push(system_prompt);
      }

      values.push(id);

      const result = await pool.query(
        `UPDATE customers SET ${sets.join(", ")}
         WHERE id = $${idx}
         RETURNING id, name, system_prompt, created_at`,
        values
      );

      return result.rows[0];
    }
  );

  app.post<{ Params: { id: string } }>(
    "/customers/:id/api-key",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { id } = request.params;

      const customer = await pool.query(
        "SELECT id FROM customers WHERE id = $1",
        [id]
      );
      if (customer.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      const key = "cvx_" + crypto.randomBytes(32).toString("hex");

      const result = await pool.query(
        `INSERT INTO api_keys (customer_id, key)
         VALUES ($1, $2)
         RETURNING id, key, created_at`,
        [id, key]
      );

      return reply.status(201).send({
        api_key: result.rows[0].key,
        created_at: result.rows[0].created_at,
      });
    }
  );
}
