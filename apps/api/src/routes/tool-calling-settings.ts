// ============================================================
// Tool-calling prompt API (mid-call CRM data fetch, goal 2 of
// docs/CRM_TOOL_CALLING_PLAN_2026-11-05.md).
//
// One optional prompt per customer (customer_settings.tool_calling_prompt)
// telling the model WHEN to call tools, for native CRM and custom CRM API
// tools alike, plus a kill switch (tool_calling_enabled). Same data, two auth
// styles: admin token for /customers/:customerId/..., the customer's own
// x-api-key for /tool-calling.
// ============================================================

import { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { adminAuth, apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { invalidateCustomerSettingsCache } from "../services/customer-settings";
import { invalidateToolsetCache, loadCallToolset } from "../services/crm-tools/toolset";
import { hasSaasAppKey } from "../services/crm-tools/laravel-crypt";

const MAX_PROMPT_CHARS = 4000;

const putSchema = z
  .object({
    tool_calling_prompt: z.string().max(MAX_PROMPT_CHARS).nullable().optional(),
    tool_calling_enabled: z.boolean().optional(),
  })
  .refine((b) => b.tool_calling_prompt !== undefined || b.tool_calling_enabled !== undefined, {
    message: "Provide tool_calling_prompt and/or tool_calling_enabled",
  });

async function readState(customerId: string) {
  const row = (
    await pool.query(
      `SELECT tool_calling_enabled, tool_calling_prompt, updated_at FROM customer_settings WHERE customer_id = $1`,
      [customerId]
    )
  ).rows[0];
  if (!row) return null;
  invalidateToolsetCache(customerId);
  const toolset = await loadCallToolset(customerId);
  const company = (
    await pool.query(`SELECT id::text, name FROM companies WHERE engine_customer_id = $1 LIMIT 1`, [customerId]).catch(
      () => ({ rows: [] as { id: string; name: string }[] })
    )
  ).rows[0];
  return {
    customer_id: customerId,
    tool_calling_enabled: row.tool_calling_enabled !== false,
    tool_calling_prompt: row.tool_calling_prompt ?? null,
    updated_at: row.updated_at,
    // What a live call would get right now (null = no tools, calls behave as before).
    active_tools: toolset
      ? {
          native_crm_lookup: toolset.summary.native,
          custom_tools: toolset.summary.custom,
          read_tools: toolset.tools.map((t) => (t.type === "function" ? t.function.name : "")).filter((n) => n && toolset.isReadTool(n)),
        }
      : null,
    saas_company: company ? { id: company.id, name: company.name } : null,
    custom_tool_secrets_readable: hasSaasAppKey(),
  };
}

async function writeState(customerId: string, body: unknown, reply: FastifyReply) {
  const parsed = putSchema.safeParse(body ?? {});
  if (!parsed.success) return reply.status(400).send({ error: parsed.error.flatten() });
  const d = parsed.data;
  const exists = await pool.query(`SELECT 1 FROM customer_settings WHERE customer_id = $1`, [customerId]);
  if (exists.rows.length === 0) return reply.status(404).send({ error: "Customer settings not found" });

  const prompt = d.tool_calling_prompt === undefined ? undefined : d.tool_calling_prompt?.trim() || null;
  await pool.query(
    `UPDATE customer_settings
        SET tool_calling_prompt = CASE WHEN $2 THEN $3 ELSE tool_calling_prompt END,
            tool_calling_enabled = COALESCE($4, tool_calling_enabled),
            updated_at = NOW()
      WHERE customer_id = $1`,
    [customerId, prompt !== undefined, prompt ?? null, d.tool_calling_enabled ?? null]
  );
  invalidateCustomerSettingsCache(customerId);
  invalidateToolsetCache(customerId);
  return reply.send(await readState(customerId));
}

async function clearPrompt(customerId: string, reply: FastifyReply) {
  const r = await pool.query(
    `UPDATE customer_settings SET tool_calling_prompt = NULL, updated_at = NOW() WHERE customer_id = $1 RETURNING 1`,
    [customerId]
  );
  if (r.rows.length === 0) return reply.status(404).send({ error: "Customer settings not found" });
  invalidateCustomerSettingsCache(customerId);
  invalidateToolsetCache(customerId);
  return reply.send(await readState(customerId));
}

export async function toolCallingSettingsRoutes(app: FastifyInstance): Promise<void> {
  // ---- Admin (x-admin-token), any customer ----
  app.get<{ Params: { customerId: string } }>(
    "/customers/:customerId/tool-calling",
    { preHandler: adminAuth },
    async (request, reply) => {
      const state = await readState(request.params.customerId);
      return state ? reply.send(state) : reply.status(404).send({ error: "Customer settings not found" });
    }
  );
  app.put<{ Params: { customerId: string } }>(
    "/customers/:customerId/tool-calling",
    { preHandler: adminAuth },
    async (request, reply) => writeState(request.params.customerId, request.body, reply)
  );
  app.delete<{ Params: { customerId: string } }>(
    "/customers/:customerId/tool-calling",
    { preHandler: adminAuth },
    async (request, reply) => clearPrompt(request.params.customerId, reply)
  );

  // ---- Customer's own key (x-api-key) ----
  app.get("/tool-calling", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) => {
    const state = await readState(request.customerId!);
    return state ? reply.send(state) : reply.status(404).send({ error: "Customer settings not found" });
  });
  app.put("/tool-calling", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) =>
    writeState(request.customerId!, request.body, reply)
  );
  app.delete("/tool-calling", { preHandler: apiKeyAuth }, async (request: AuthenticatedRequest, reply) =>
    clearPrompt(request.customerId!, reply)
  );
}
