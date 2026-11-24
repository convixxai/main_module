// ============================================================
// company_phone_numbers Admin Routes — Feature 3 (one company, many numbers)
// CRUD, admin token required — mirrors routes/exotel-settings.ts's pattern.
// Reference: docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.3
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { adminAuth } from "../middleware/auth";
import {
  getPhoneNumbersForCustomer,
  createPhoneNumber,
  updatePhoneNumber,
  setPrimaryPhoneNumber,
  deletePhoneNumber,
} from "../services/company-phone-numbers";
import { columnExists, MIGRATION_028_MISSING } from "../services/schema-features";

/** Number type (migration 028): "did" | "virtual"; null = not set. */
const numberType = z.enum(["did", "virtual"]).nullable().optional();

/** Adds `type` (company_phone_numbers.number_type) to a number row; null before migration 028. */
function withType<T extends Record<string, any>>(row: T): T & { type: string | null } {
  const { number_type, ...rest } = row as Record<string, any>;
  return { ...(rest as T), type: number_type ?? null };
}

async function saveType(customerId: string, id: string, type: string | null): Promise<Record<string, any> | null> {
  const r = await pool.query(
    `UPDATE company_phone_numbers SET number_type = $1 WHERE id = $2 AND customer_id = $3 RETURNING *`,
    [type, id, customerId]
  );
  return r.rows[0] ?? null;
}

const createPhoneNumberSchema = z.object({
  phone_number: z.string().min(3),
  label: z.string().min(1).optional(),
  default_agent_id: z.string().uuid().optional(),
  is_primary: z.boolean().optional(),
  is_enabled: z.boolean().optional(),
  type: numberType,
});

const updatePhoneNumberSchema = z.object({
  label: z.string().min(1).nullable().optional(),
  default_agent_id: z.string().uuid().nullable().optional(),
  is_enabled: z.boolean().optional(),
  is_primary: z.boolean().optional(),
  type: numberType,
});

export async function companyPhoneNumbersRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/phone-numbers",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const numbers = await getPhoneNumbersForCustomer(customerId);
      return reply.send(numbers.map((n) => withType(n as unknown as Record<string, any>)));
    }
  );

  app.post<{ Params: { customerId: string } }>(
    "/customers/:customerId/phone-numbers",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const body = createPhoneNumberSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customer = await pool.query("SELECT id FROM customers WHERE id = $1", [customerId]);
      if (customer.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      if (body.data.default_agent_id) {
        const agent = await pool.query(
          "SELECT id FROM agents WHERE id = $1 AND customer_id = $2",
          [body.data.default_agent_id, customerId]
        );
        if (agent.rows.length === 0) {
          return reply.status(400).send({ error: "default_agent_id does not belong to this customer" });
        }
      }
      if (body.data.type != null && !(await columnExists("company_phone_numbers", "number_type"))) {
        return reply.status(503).send(MIGRATION_028_MISSING);
      }

      // UNIQUE(phone_number) only compares exact strings, so "+918898442005" and
      // "8898442005" could both be saved. Calls are routed by the dialed number
      // (VI's dni / Exotel's To) matched on its last 10 digits, so the same
      // number twice would make routing ambiguous: reject it up front.
      const last10 = body.data.phone_number.replace(/\D/g, "").slice(-10);
      if (last10.length < 10) {
        return reply.status(400).send({ error: "phone_number must contain at least 10 digits" });
      }
      const dup = await pool.query(
        `SELECT customer_id FROM company_phone_numbers
          WHERE RIGHT(regexp_replace(phone_number, '\\D', '', 'g'), 10) = $1 LIMIT 1`,
        [last10]
      );
      if (dup.rows.length > 0) {
        return reply.status(409).send({
          error:
            dup.rows[0].customer_id === customerId
              ? "This number is already added to this company (in another format)"
              : "This phone number is already assigned to a company",
        });
      }

      try {
        const created = await createPhoneNumber({
          customerId,
          phoneNumber: body.data.phone_number,
          label: body.data.label ?? null,
          defaultAgentId: body.data.default_agent_id ?? null,
          isPrimary: body.data.is_primary,
          isEnabled: body.data.is_enabled,
        });
        const row = body.data.type != null ? (await saveType(customerId, created.id, body.data.type)) ?? created : created;
        return reply.status(201).send(withType(row as unknown as Record<string, any>));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to create phone number";
        if (msg.includes("duplicate key") || msg.includes("unique")) {
          return reply.status(409).send({ error: "This phone number is already assigned to a company" });
        }
        request.log.error({ err }, "company-phone-numbers: create failed");
        return reply.status(500).send({ error: msg });
      }
    }
  );

  app.put<{ Params: { customerId: string; id: string } }>(
    "/customers/:customerId/phone-numbers/:id",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId, id } = request.params;
      const body = updatePhoneNumberSchema.safeParse(request.body ?? {});
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      if (body.data.default_agent_id) {
        const agent = await pool.query(
          "SELECT id FROM agents WHERE id = $1 AND customer_id = $2",
          [body.data.default_agent_id, customerId]
        );
        if (agent.rows.length === 0) {
          return reply.status(400).send({ error: "default_agent_id does not belong to this customer" });
        }
      }

      if (body.data.type !== undefined && !(await columnExists("company_phone_numbers", "number_type"))) {
        return reply.status(503).send(MIGRATION_028_MISSING);
      }

      if (body.data.is_primary === true) {
        const ok = await setPrimaryPhoneNumber(customerId, id);
        if (!ok) return reply.status(404).send({ error: "Phone number not found for this customer" });
      }

      const updated = await updatePhoneNumber(customerId, id, {
        label: body.data.label,
        defaultAgentId: body.data.default_agent_id,
        isEnabled: body.data.is_enabled,
      });
      if (!updated) return reply.status(404).send({ error: "Phone number not found for this customer" });
      const row = body.data.type !== undefined ? (await saveType(customerId, id, body.data.type ?? null)) ?? updated : updated;
      return reply.send(withType(row as unknown as Record<string, any>));
    }
  );

  app.delete<{ Params: { customerId: string; id: string } }>(
    "/customers/:customerId/phone-numbers/:id",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId, id } = request.params;

      const existing = await getPhoneNumbersForCustomer(customerId);
      const target = existing.find((n) => n.id === id);
      if (!target) return reply.status(404).send({ error: "Phone number not found for this customer" });
      if (target.is_primary && existing.length > 1) {
        return reply.status(409).send({
          error: "Cannot delete the primary number while other numbers exist — set another number as primary first",
        });
      }

      const deleted = await deletePhoneNumber(customerId, id);
      if (!deleted) return reply.status(404).send({ error: "Phone number not found for this customer" });
      return reply.send({ message: "Phone number deleted" });
    }
  );
}
