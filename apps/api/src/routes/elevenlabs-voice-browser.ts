import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { env } from "../config/env";
import {
  elevenLabsListVoices,
  elevenLabsTextToSpeech,
  resolveElevenLabsTtsLanguageCodeForApi,
  resolveElevenLabsTtsModelId,
} from "../services/elevenlabs";
import { ELEVENLABS_VOICE_BROWSER_PAGE_HTML } from "./elevenlabs-voice-browser-page";

const previewSchema = z.object({
  voice_id: z.string().min(1).max(128),
  model_id: z.string().max(128).optional(),
  text: z.string().min(1).max(500).optional(),
  language_code: z.string().max(16).optional(),
});

const SAMPLE_BY_LANG: Record<string, string> = {
  en: "Hello! This is how I sound on a natural phone conversation.",
  hi: "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
  mr: "नमस्कार! आजचा दिवस कसा आहे?",
  ta: "வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?",
  te: "నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?",
  bn: "নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
  gu: "નમસ્તે! હું તમારી કેવી રીતે મદદ કરી શકું?",
  kn: "ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
  ml: "നമസ്കാരം! എനിക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാനാകും?",
  pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?",
};

function sampleTextForLanguage(langBcp47: string | undefined): string {
  const primary = (langBcp47 || "en").split("-")[0]?.toLowerCase() || "en";
  return SAMPLE_BY_LANG[primary] ?? SAMPLE_BY_LANG.en;
}

export async function elevenlabsVoiceBrowserRoutes(
  app: FastifyInstance
): Promise<void> {
  /** Standalone voice picker — no customer_id. API calls need any valid x-api-key. */
  app.get("/voice/elevenlabs/browser", async (_request, reply) => {
    return reply
      .type("text/html; charset=utf-8")
      .send(ELEVENLABS_VOICE_BROWSER_PAGE_HTML);
  });

  app.post(
    "/voice/elevenlabs/preview",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!env.elevenlabs.apiKey?.trim()) {
        return reply.status(503).send({
          error: "ELEVENLABS_API_KEY is not configured on this server",
        });
      }
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { voice_id, model_id, text, language_code } = parsed.data;
      const modelId = resolveElevenLabsTtsModelId(model_id ?? "eleven_turbo_v2_5");
      const langPref = language_code?.trim() || "auto";
      const ttsText = (text?.trim() || sampleTextForLanguage(language_code)).slice(
        0,
        500
      );

      try {
        const el = await elevenLabsTextToSpeech({
          voiceId: voice_id,
          text: ttsText,
          modelId,
          outputFormat: "mp3_44100_128",
          languageCode: langPref === "auto" ? undefined : langPref,
        });
        if (el.status !== 200 || !Buffer.isBuffer(el.body)) {
          return reply.status(el.status === 200 ? 502 : el.status).send({
            error: "ElevenLabs preview failed",
            detail: el.body,
          });
        }
        const sentLang = resolveElevenLabsTtsLanguageCodeForApi(modelId, langPref);
        reply.header("Content-Type", el.contentType || "audio/mpeg");
        reply.header("X-Voice-Id", voice_id);
        reply.header("X-Model-Id", modelId);
        reply.header(
          "X-Language-Code-Sent",
          sentLang ?? "(omitted)"
        );
        return reply.send(el.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Preview failed";
        request.log.error({ err }, "ElevenLabs voice preview failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );
}
