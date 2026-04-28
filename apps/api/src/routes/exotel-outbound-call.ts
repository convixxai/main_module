// ============================================================
// Trigger outbound PSTN call via Exotel Connect Two Numbers API
// POST /customers/:customerId/exotel/outbound-call (x-api-key)
// Reference: docs/EXOTEL_OUTBOUND_CALL_API_SPEC.md
// ============================================================

import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getExotelSettings, createCallSession } from "../services/exotel-settings";
import { getCustomerSettings } from "../services/customer-settings";
import {
  exotelConnectCall,
  ExotelUpstreamError,
  restApiBaseUrlFromSubdomain,
} from "../services/exotel-connect-call";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import { env } from "../config/env";

const outboundCallBodySchema = z.object({
  from: z.string().min(3),
  to: z.string().min(3),
  callerId: z.string().min(2).optional(),
  /** When true (default), attaches tenant Voicebot `wss://` URL if `streamUrl` is omitted. Set false for PSTN-only outbound (no streaming bot). */
  voicebot_stream: z.boolean().optional(),
  callType: z.string().optional(),
  timeLimit: z.number().int().positive().max(14400).optional(),
  timeOut: z.number().int().positive().optional(),
  record: z.boolean().optional(),
  recordingChannels: z.enum(["single", "dual"]).optional(),
  recordingFormat: z.enum(["mp3", "mp3-hq"]).optional(),
  waitUrl: z.string().optional(),
  streamUrl: z.string().optional(),
  /** Exotel wire values: `atLeg1connect` or `atLeg2connect` (spaces optional). Default with `streamUrl`: `atLeg2connect`. */
  streamBegin: z.string().optional(),
  statusCallback: z.string().optional(),
  statusCallbackEvents: z.array(z.enum(["terminal", "answered"])).optional(),
  statusCallbackContentType: z
    .enum(["multipart/form-data", "application/json"])
    .optional(),
  customField: z.string().max(128).optional(),
  startPlaybackToNew: z.enum(["Callee", "Both"]).optional(),
  startPlaybackValueNew: z.string().optional(),
});

export async function exotelOutboundCallRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/customers/:customerId/exotel/outbound-call",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const { customerId } = request.params as { customerId: string };
      if (
        request.customerId!.toLowerCase() !== customerId.toLowerCase()
      ) {
        return reply.status(403).send({
          error: "API key is not authorized for this customer",
        });
      }

      const parsedBody = outboundCallBodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.status(400).send({
          error: "Validation failed",
          details: parsedBody.error.flatten(),
        });
      }

      const customer = await pool.query("SELECT id FROM customers WHERE id = $1", [
        customerId,
      ]);
      if (customer.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }

      const settings = await getExotelSettings(customerId);
      if (!settings) {
        return reply
          .status(400)
          .send({ error: "Exotel is not configured for this customer" });
      }
      if (!settings.is_enabled) {
        return reply
          .status(400)
          .send({ error: "Exotel is disabled for this customer" });
      }

      const accountSid = settings.exotel_account_sid?.trim();
      const apiKey = settings.exotel_api_key?.trim();
      const apiToken = settings.exotel_api_token?.trim();
      if (!accountSid || !apiKey || !apiToken) {
        return reply.status(400).send({
          error:
            "Missing Exotel credentials (exotel_account_sid, exotel_api_key, exotel_api_token)",
        });
      }

      const body = parsedBody.data;
      const callerId =
        body.callerId?.trim() ||
        settings.default_outbound_caller_id?.trim() ||
        settings.inbound_phone_number?.trim();

      if (!callerId) {
        return reply.status(400).send({
          error:
            "callerId is required (or set default_outbound_caller_id / inbound_phone_number on Exotel settings)",
        });
      }

      const rawSubdomain = settings.exotel_subdomain?.trim();
      const restFromSubdomain = restApiBaseUrlFromSubdomain(settings.exotel_subdomain);
      if (rawSubdomain && !restFromSubdomain) {
        return reply.status(400).send({
          error:
            "exotel_subdomain must be your Exotel REST API hostname (e.g. api.exotel.com or api.in.exotel.com).",
        });
      }

      try {
        const csRow = await getCustomerSettings(customerId);
        const attachVoicebot = body.voicebot_stream !== false;
        let streamUrlResolved = body.streamUrl?.trim();
        if (!streamUrlResolved && attachVoicebot) {
          streamUrlResolved = voicebotUrlsForCustomer(customerId, request).voicebot_wss_url;
        }
        const streamBeginPassed =
          body.streamBegin ??
          (streamUrlResolved ? "atLeg2connect" : undefined);

        const hostForCb =
          (env.publicApiHost || request.hostname || "").trim() || "localhost";
        const defaultStatusCb = `https://${hostForCb}/exotel/status-callback/${customerId}${
          settings.webhook_secret?.trim()
            ? `?token=${encodeURIComponent(settings.webhook_secret.trim())}`
            : ""
        }`;

        let pendingSessionId: string | undefined;
        let customFieldMerged = body.customField?.trim();
        let statusCallbackUse = body.statusCallback?.trim();
        let statusEventsUse = body.statusCallbackEvents;
        let statusContentUse = body.statusCallbackContentType;

        if (attachVoicebot && streamUrlResolved) {
          pendingSessionId = await createCallSession({
            customerId,
            callSid: null,
            streamSid: null,
            direction: "outbound",
            fromNumber: body.from.trim(),
            toNumber: body.to.trim(),
            chatSessionId: null,
            metadata: {
              source: "outbound_connect_api",
              caller_id: callerId,
              outbound_pending: true,
            },
            voicebotMultilingual: csRow?.voicebot_multilingual ?? undefined,
            defaultLanguageCode: csRow?.default_language_code ?? null,
            currentLanguageCode: csRow?.default_language_code ?? null,
          });

          const linkCf = `ccs=${pendingSessionId}`;
          customFieldMerged = customFieldMerged
            ? `${customFieldMerged.slice(0, 120)}|${linkCf}`.slice(0, 128)
            : linkCf;
          statusCallbackUse = statusCallbackUse ?? defaultStatusCb;
          statusEventsUse = statusEventsUse ?? ["answered", "terminal"];
          statusContentUse = statusContentUse ?? "application/json";
        }

        try {
          const result = await exotelConnectCall({
            accountSid,
            apiKey,
            apiToken,
            ...(restFromSubdomain != null
              ? { restApiBaseUrl: restFromSubdomain }
              : {}),
            from: body.from.trim(),
            to: body.to.trim(),
            callerId,
            callType: body.callType?.trim(),
            timeLimit: body.timeLimit,
            timeOut: body.timeOut,
            waitUrl: body.waitUrl?.trim(),
            record: body.record,
            recordingChannels: body.recordingChannels,
            recordingFormat: body.recordingFormat,
            streamUrl: streamUrlResolved,
            streamBegin: streamBeginPassed,
            customField: customFieldMerged,
            startPlaybackToNew: body.startPlaybackToNew,
            startPlaybackValueNew: body.startPlaybackValueNew?.trim(),
            statusCallback: statusCallbackUse,
            statusCallbackEvents: statusEventsUse,
            statusCallbackContentType: statusContentUse,
          });

          const call = result.call;
          const sidOut =
            call && typeof call.Sid === "string" ? call.Sid : undefined;
          request.log.info(
            {
              customer_id: customerId,
              exotel_call_sid: sidOut,
              exotel_call_session_id: pendingSessionId,
            },
            "exotel outbound call initiated"
          );

          if (pendingSessionId && sidOut) {
            try {
              await pool.query(
                `UPDATE exotel_call_sessions
                 SET exotel_call_sid = $1,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $2::jsonb,
                     status = 'active'
                 WHERE id = $3::uuid AND customer_id = $4::uuid`,
                [
                  sidOut,
                  JSON.stringify({
                    outbound_pending: false,
                    connect_placed_at: new Date().toISOString(),
                  }),
                  pendingSessionId,
                  customerId,
                ]
              );
            } catch (err) {
              request.log.warn(
                { err, customerId, pendingSessionId, callSid: sidOut },
                "exotel outbound: failed to attach Exotel Call Sid to session row"
              );
            }
          }

          return reply.send({
            call: result.call ?? undefined,
            raw: result.raw,
            exotel_call_session_id: pendingSessionId,
          });
        } catch (connectErr) {
          if (pendingSessionId) {
            await pool
              .query(
                `DELETE FROM exotel_call_sessions WHERE id = $1::uuid AND exotel_call_sid IS NULL`,
                [pendingSessionId]
              )
              .catch(() => {});
          }
          throw connectErr;
        }
      } catch (err) {
        if (err instanceof ExotelUpstreamError) {
          const es = err.exotelStatus;
          const http = err.httpStatus;
          if (es === 429 || http === 429) {
            return reply.status(429).send({
              error: err.message,
              exotel_status: es ?? http,
            });
          }
          if (es === 400 || http === 400) {
            return reply.status(400).send({
              error: err.message,
              exotel_status: es,
            });
          }
          return reply.status(502).send({
            error: err.message,
            exotel_status: es,
          });
        }
        throw err;
      }
    }
  );
}
