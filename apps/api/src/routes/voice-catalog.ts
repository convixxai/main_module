// ============================================================
// Unified cross-provider voice catalog routes.
// GET  /voices        - browse all Sarvam + ElevenLabs + Cartesia voices
//                        in one list (name, language, gender, sample_url, id).
// GET  /voices/sample  - play/synthesize a short sample for one catalog voice.
// Feeds routes/agents.ts's `tts_provider` + `tts_speaker` (+ `tts_model`)
// fields: pick an entry here, send its `provider`/`voice_id`/`model` as-is
// when creating or updating an agent.
// ============================================================

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { listVoiceCatalog, synthesizeVoiceSample, type CatalogProvider } from "../services/voice-catalog";

const sampleQuerySchema = z.object({
  provider: z.enum(["sarvam", "elevenlabs", "cartesia"]),
  voice_id: z.string().min(1).max(128),
  model: z.string().max(128).optional(),
  language: z.string().max(16).optional(),
  text: z.string().max(500).optional(),
});

export async function voiceCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/voices",
    { preHandler: apiKeyAuth },
    async (_request: AuthenticatedRequest, reply) => {
      try {
        const voices = await listVoiceCatalog();
        return reply.send({ voices });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load voice catalog";
        _request.log.error({ err }, "voice-catalog: list failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );

  app.get(
    "/voices/sample",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const parsed = sampleQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { provider, voice_id, model, language, text } = parsed.data;
      try {
        const sample = await synthesizeVoiceSample({
          provider: provider as CatalogProvider,
          voiceId: voice_id,
          model: model ?? null,
          language: language ?? null,
          text: text ?? null,
        });
        reply.header("Content-Type", sample.contentType);
        return reply.send(sample.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Voice sample failed";
        request.log.error({ err, provider, voice_id }, "voice-catalog: sample synthesis failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );
}
