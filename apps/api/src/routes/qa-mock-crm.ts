// ============================================================
// QA-only mock of a customer's own CRM API, used by the CRM tool-calling demo
// tenant (custom crm_tools pointing at https://<host>/qa/mock-crm/...).
// Fixed fake data, no database access, bearer token required.
//   GET  /qa/mock-crm/orders?phone=..&order_id=..   (read tool -> "please hold")
//   POST /qa/mock-crm/callbacks                     (write tool -> no hold)
// ============================================================

import { FastifyInstance } from "fastify";

const TOKEN = "convixx-demo-crm-token";

const ORDERS: Record<string, { order_id: string; item: string; status: string; eta: string; amount: number }[]> = {
  "9876500001": [
    { order_id: "ORD-1042", item: "Air purifier AP-200", status: "Out for delivery", eta: "today by 7 PM", amount: 12499 },
    { order_id: "ORD-0988", item: "Filter pack", status: "Delivered", eta: "delivered on 2 Nov", amount: 1899 },
  ],
  "9876500002": [{ order_id: "ORD-1107", item: "Water heater WH-15", status: "Packed", eta: "8 Nov", amount: 8999 }],
};

function authed(header: unknown): boolean {
  return header === `Bearer ${TOKEN}`;
}

function authedReq(h: Record<string, unknown>): boolean {
  return authed(h.authorization) || h["x-demo-token"] === TOKEN;
}

export async function qaMockCrmRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { phone?: string; order_id?: string } }>("/qa/mock-crm/orders", async (request, reply) => {
    if (!authedReq(request.headers as Record<string, unknown>)) return reply.status(401).send({ error: "unauthorized" });
    const key = String(request.query.phone ?? "").replace(/\D/g, "").slice(-10);
    const want = String(request.query.order_id ?? "").trim().toUpperCase();
    const list = ORDERS[key] ?? [];
    const order = (want ? list.find((o) => o.order_id === want) : null) ?? list[0] ?? null;
    return reply.send({
      status: order ? "found" : "not_found",
      customer: { phone_last4: key.slice(-4) },
      order,
      open_orders: list.filter((o) => o.status !== "Delivered").length,
    });
  });

  app.post<{ Body: { phone?: string; when?: string; reason?: string } }>("/qa/mock-crm/callbacks", async (request, reply) => {
    if (!authedReq(request.headers as Record<string, unknown>)) return reply.status(401).send({ error: "unauthorized" });
    const b = request.body ?? {};
    return reply.send({ status: "scheduled", callback_id: `CB-${Date.now() % 100000}`, when: b.when ?? "", reason: b.reason ?? "" });
  });
}
