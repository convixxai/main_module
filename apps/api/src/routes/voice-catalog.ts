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
import { listVoiceCatalog, synthesizeVoiceSample, ignoredTuning, type CatalogProvider } from "../services/voice-catalog";

const sampleQuerySchema = z.object({
  provider: z.enum(["sarvam", "elevenlabs", "cartesia"]),
  voice_id: z.string().min(1).max(128),
  model: z.string().max(128).optional(),
  language: z.string().max(16).optional(),
  text: z.string().max(500).optional(),
  // Tuning (B3). Ignored by providers that do not support it: see the X-Voice-Options-Ignored header.
  speed: z.coerce.number().min(0.5).max(2).optional(),
  pitch: z.coerce.number().min(-1).max(1).optional(),
  emotion: z.string().max(32).regex(/^[a-z_:]+$/i).optional(),
  volume: z.coerce.number().min(0).max(3).optional(),
});

const listQuerySchema = z.object({
  /** BCP-47 or plain ISO-639-1, e.g. "hi-IN" or "hi". Current product focus is hi/en/mr, but any language is accepted. */
  language: z.string().max(16).optional(),
  gender: z.string().max(16).optional(),
  accent: z.string().max(32).optional(),
  tone: z.string().max(32).optional(),
});

export async function voiceCatalogRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/voices",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      try {
        const voices = await listVoiceCatalog({
          language: parsed.data.language ?? null,
          gender: parsed.data.gender ?? null,
          accent: parsed.data.accent ?? null,
          tone: parsed.data.tone ?? null,
        });
        return reply.send({ voices });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed to load voice catalog";
        request.log.error({ err }, "voice-catalog: list failed");
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
      const { provider, voice_id, model, language, text, speed, pitch, emotion, volume } = parsed.data;
      const tuning = { speed: speed ?? null, pitch: pitch ?? null, emotion: emotion ?? null, volume: volume ?? null };
      try {
        const sample = await synthesizeVoiceSample({
          provider: provider as CatalogProvider,
          voiceId: voice_id,
          model: model ?? null,
          language: language ?? null,
          text: text ?? null,
          tuning,
        });
        reply.header("Content-Type", sample.contentType);
        const ignored = ignoredTuning(provider as CatalogProvider, tuning);
        if (ignored.length) reply.header("X-Voice-Options-Ignored", ignored.join(","));
        return reply.send(sample.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Voice sample failed";
        request.log.error({ err, provider, voice_id }, "voice-catalog: sample synthesis failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );
}
