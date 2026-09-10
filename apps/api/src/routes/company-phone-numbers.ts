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

const createPhoneNumberSchema = z.object({
  phone_number: z.string().min(3),
  label: z.string().min(1).optional(),
  default_agent_id: z.string().uuid().optional(),
  is_primary: z.boolean().optional(),
  is_enabled: z.boolean().optional(),
});

const updatePhoneNumberSchema = z.object({
  label: z.string().min(1).nullable().optional(),
  default_agent_id: z.string().uuid().nullable().optional(),
  is_enabled: z.boolean().optional(),
  is_primary: z.boolean().optional(),
});

export async function companyPhoneNumbersRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/phone-numbers",
    { preHandler: adminAuth },
    async (request, reply) => {
      const { customerId } = request.params;
      const numbers = await getPhoneNumbersForCustomer(customerId);
      return reply.send(numbers);
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

      try {
        const created = await createPhoneNumber({
          customerId,
          phoneNumber: body.data.phone_number,
          label: body.data.label ?? null,
          defaultAgentId: body.data.default_agent_id ?? null,
          isPrimary: body.data.is_primary,
          isEnabled: body.data.is_enabled,
        });
        return reply.status(201).send(created);
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
      return reply.send(updated);
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
