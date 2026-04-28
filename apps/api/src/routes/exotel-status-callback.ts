// ============================================================
// Exotel HTTP StatusCallback — Connect API (answered / terminal)
// POST /exotel/status-callback/:customerId
// ============================================================

import { FastifyInstance } from "fastify";
import { pool } from "../config/db";
import { getExotelSettings } from "../services/exotel-settings";
import {
  parseCcsSessionIdFromCustomField,
  statusPayloadIndicatesCalleeLegAnswered,
} from "../services/exotel-outbound-flow";

export async function exotelStatusCallbackRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Params: { customerId: string }; Body: unknown }>(
    "/exotel/status-callback/:customerId",
    async (request, reply) => {
      const { customerId } = request.params;
      const settings = await getExotelSettings(customerId);
      const secret = settings?.webhook_secret?.trim();
      const qToken =
        typeof request.query === "object" && request.query !== null && "token" in request.query
          ? String((request.query as { token?: string }).token ?? "")
          : "";
      if (secret && qToken !== secret) {
        return reply.status(401).send({ error: "Unauthorized" });
      }

      let payload: Record<string, unknown>;
      if (typeof request.body === "object" && request.body !== null && !Array.isArray(request.body)) {
        payload = request.body as Record<string, unknown>;
      } else if (typeof request.body === "string" && request.body.trim()) {
        try {
          payload = JSON.parse(request.body) as Record<string, unknown>;
        } catch {
          return reply.status(400).send({ error: "Invalid JSON body" });
        }
      } else {
        payload = {};
      }

      const customFieldStr = (() => {
        const cf = payload.CustomField ?? payload.customField;
        return typeof cf === "string" ? cf : "";
      })();

      const sessionFromCf = parseCcsSessionIdFromCustomField(customFieldStr);
      const callSid =
        typeof payload.CallSid === "string" && payload.CallSid.trim()
          ? payload.CallSid.trim()
          : "";

      const calleeOk = statusPayloadIndicatesCalleeLegAnswered(payload);

      request.log.info(
        {
          customerId,
          event_type: payload.EventType ?? payload.eventType,
          call_sid: callSid || null,
          session_from_cf: sessionFromCf ?? null,
          callee_mark: calleeOk,
        },
        "exotel status callback received"
      );

      if (calleeOk) {
        const patch = JSON.stringify({
          callee_answered: true,
          callee_answered_at: new Date().toISOString(),
        });
        if (sessionFromCf) {
          await pool
            .query(
              `UPDATE exotel_call_sessions
               SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
               WHERE id = $2::uuid AND customer_id = $3::uuid AND direction = 'outbound'`,
              [patch, sessionFromCf, customerId]
            )
            .catch((err) => {
              request.log.warn(
                { err, sessionFromCf, customerId },
                "exotel status callback: callee_answered update failed (ccs id)"
              );
            });
        } else if (callSid) {
          try {
            const upd = await pool.query(
              `UPDATE exotel_call_sessions
               SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb
               WHERE customer_id = $2::uuid AND direction = 'outbound'
                 AND exotel_call_sid = $3`,
              [patch, customerId, callSid]
            );
            if (!upd.rowCount) {
              request.log.warn(
                { callSid, customerId },
                "exotel status callback: callee leg answered but no outbound session row matched (ccs missing and CallSid not linked yet?)"
              );
            }
          } catch (err) {
            request.log.warn(
              { err, callSid, customerId },
              "exotel status callback: callee_answered update failed (CallSid)"
            );
          }
        }
      }

      return reply.send({ ok: true });
    }
  );
}
