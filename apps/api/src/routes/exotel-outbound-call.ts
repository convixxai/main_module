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
        const attachVoicebot = body.voicebot_stream !== false;
        let streamUrlResolved = body.streamUrl?.trim();
        if (!streamUrlResolved && attachVoicebot) {
          streamUrlResolved = voicebotUrlsForCustomer(customerId, request).voicebot_wss_url;
        }
        const streamBeginPassed =
          body.streamBegin ??
          (streamUrlResolved ? "atLeg2connect" : undefined);

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
          customField: body.customField?.trim(),
          startPlaybackToNew: body.startPlaybackToNew,
          startPlaybackValueNew: body.startPlaybackValueNew?.trim(),
          statusCallback: body.statusCallback?.trim(),
          statusCallbackEvents: body.statusCallbackEvents,
          statusCallbackContentType: body.statusCallbackContentType,
        });

        const call = result.call;
        const sidOut =
          call && typeof call.Sid === "string" ? call.Sid : undefined;
        request.log.info(
          {
            customer_id: customerId,
            exotel_call_sid: sidOut,
          },
          "exotel outbound call initiated"
        );

        let exotelCallSessionId: string | undefined;
        if (sidOut) {
          try {
            const cs = await getCustomerSettings(customerId);
            exotelCallSessionId = await createCallSession({
              customerId,
              callSid: sidOut,
              streamSid: null,
              direction: "outbound",
              fromNumber: body.from.trim(),
              toNumber: body.to.trim(),
              chatSessionId: null,
              metadata: {
                source: "outbound_connect_api",
                caller_id: callerId,
              },
              voicebotMultilingual: cs?.voicebot_multilingual ?? undefined,
              defaultLanguageCode: cs?.default_language_code ?? null,
              currentLanguageCode: cs?.default_language_code ?? null,
            });
          } catch (err) {
            request.log.warn(
              { err, customerId, callSid: sidOut },
              "exotel outbound: exotel_call_sessions insert failed"
            );
          }
        }

        return reply.send({
          call: result.call ?? undefined,
          raw: result.raw,
          exotel_call_session_id: exotelCallSessionId,
        });
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
