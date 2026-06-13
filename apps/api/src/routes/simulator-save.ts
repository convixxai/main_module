import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import {
  sendSimulatorCharacterSaveEmail,
  sendSimulatorTestEmail,
  getSimulatorEmailStatus,
  simulatorSaveEmailConfigured,
  formatMailError,
} from "../services/simulator-save-email";

const saveSchema = z.object({
  character_name: z.string().min(1).max(120),
  simulator_type: z.enum(["elevenlabs", "openai_tts", "cartesia_tts"]),
  customer_id: z.string().uuid().optional(),
  settings: z.record(z.string(), z.unknown()),
  last_output: z.record(z.string(), z.unknown()).nullable().optional(),
  audio_base64: z.string().min(1),
  audio_content_type: z.string().max(128).optional(),
  audio_filename: z.string().max(200).optional(),
});

function assertCustomerScope(
  request: AuthenticatedRequest,
  customerIdFromClient: string | undefined
): string | { error: string; status: number } {
  const authCustomerId = request.customerId;
  if (!authCustomerId) {
    return { error: "Unauthorized", status: 401 };
  }
  const cid = customerIdFromClient?.trim();
  if (cid && cid !== authCustomerId) {
    return {
      error: "customer_id does not match the authenticated API key",
      status: 403,
    };
  }
  return authCustomerId;
}

async function handleSave(
  request: AuthenticatedRequest,
  reply: import("fastify").FastifyReply
) {
  if (!simulatorSaveEmailConfigured()) {
    return reply.status(503).send({
      error:
        "Email is not configured. Set SMTP_HOST=smtp.gmail.com, SMTP_USER, SMTP_PASS (Gmail App Password).",
    });
  }

  const parsed = saveSchema.safeParse(request.body);
  if (!parsed.success) {
    return reply.status(400).send({ error: parsed.error.flatten() });
  }

  const scope = assertCustomerScope(request, parsed.data.customer_id);
  if (typeof scope !== "string") {
    return reply.status(scope.status).send({ error: scope.error });
  }

  try {
    const result = await sendSimulatorCharacterSaveEmail({
      characterName: parsed.data.character_name.trim(),
      simulatorType: parsed.data.simulator_type,
      customerId: scope,
      settings: parsed.data.settings,
      lastOutput: parsed.data.last_output ?? null,
      audioBase64: parsed.data.audio_base64,
      audioContentType: parsed.data.audio_content_type,
      audioFilename: parsed.data.audio_filename,
    });
    return reply.send({
      ok: true,
      character_name: parsed.data.character_name.trim(),
      message_id: result.messageId,
      transport: result.transport,
      delivery_note: result.delivery_note,
      emailed_to: "convixx.ai@gmail.com",
      cc: "sandeshr.patil21@gmail.com",
    });
  } catch (err: unknown) {
    const msg = formatMailError(err);
    request.log.error({ err }, "simulator character save email failed");
    return reply.status(502).send({ error: msg });
  }
}

export async function simulatorSaveRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/voice/simulator/save-character",
    { preHandler: apiKeyAuth },
    handleSave
  );
  app.post(
    "/voice/openai-tts/simulator/save-character",
    { preHandler: apiKeyAuth },
    handleSave
  );
  app.post(
    "/voice/cartesia/simulator/save-character",
    { preHandler: apiKeyAuth },
    handleSave
  );

  app.get(
    "/voice/simulator/email-status",
    { preHandler: apiKeyAuth },
    async (_request: AuthenticatedRequest, reply) => {
      const status = await getSimulatorEmailStatus();
      return reply.send(status);
    }
  );

  app.post(
    "/voice/simulator/test-email",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!simulatorSaveEmailConfigured()) {
        return reply.status(503).send({
          error:
            "Email is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS (Gmail App Password).",
        });
      }
      try {
        const result = await sendSimulatorTestEmail();
        return reply.send({
          ok: true,
          ...result,
          emailed_to: "convixx.ai@gmail.com",
          cc: "sandeshr.patil21@gmail.com",
        });
      } catch (err: unknown) {
        const msg = formatMailError(err);
        request.log.error({ err }, "simulator test email failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );
}
