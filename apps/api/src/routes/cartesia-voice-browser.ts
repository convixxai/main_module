import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { env } from "../config/env";
import {
  cartesiaConfigured,
  cartesiaFetchPreviewFile,
  cartesiaListVoices,
  cartesiaTextToSpeech,
  CARTESIA_GENDERS,
  CARTESIA_LANGUAGES,
  resolveCartesiaModel,
} from "../services/cartesia";
import { CARTESIA_VOICE_BROWSER_PAGE_HTML } from "./cartesia-voice-browser-page";

const previewSchema = z.object({
  voice_id: z.string().min(1).max(128),
  model_id: z.string().max(128).optional(),
  text: z.string().min(1).max(500).optional(),
  language: z.string().max(16).optional(),
  emotion: z.string().max(64).optional(),
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
  fr: "Bonjour! Comment puis-je vous aider aujourd'hui?",
  de: "Hallo! Wie kann ich Ihnen helfen?",
  es: "¡Hola! ¿Cómo puedo ayudarte hoy?",
  ja: "こんにちは。どのようにお手伝いできますか？",
};

function sampleTextForLanguage(lang: string | undefined): string {
  const primary = (lang || "en").split(/[-_]/)[0]?.toLowerCase() || "en";
  return SAMPLE_BY_LANG[primary] ?? SAMPLE_BY_LANG.en;
}

function parseBoolQuery(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const v = String(raw).trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

function isAllowedCartesiaPreviewUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      (u.hostname.endsWith(".cartesia.ai") || u.hostname === "cartesia.ai")
    );
  } catch {
    return false;
  }
}

export async function cartesiaVoiceBrowserRoutes(
  app: FastifyInstance
): Promise<void> {
  app.get("/voice/cartesia/browser", async (_request, reply) => {
    const configJson = JSON.stringify({
      languages: CARTESIA_LANGUAGES,
      genders: CARTESIA_GENDERS,
      cartesia_configured: cartesiaConfigured(),
    }).replace(/</g, "\\u003c");
    const html = CARTESIA_VOICE_BROWSER_PAGE_HTML.replace(
      "__BROWSER_CONFIG__",
      configJson
    );
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get(
    "/voice/cartesia/voices",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({
          error: "CARTESIA_API_KEY is not configured on this server",
        });
      }

      const q = request.query as Record<string, unknown>;
      const limitRaw = q.limit;
      let limit = 50;
      if (limitRaw !== undefined && limitRaw !== "") {
        const n =
          typeof limitRaw === "number" ? limitRaw : parseInt(String(limitRaw), 10);
        if (!Number.isFinite(n) || n < 1 || n > 100) {
          return reply.status(400).send({ error: "limit must be 1–100" });
        }
        limit = Math.floor(n);
      }

      const gender =
        typeof q.gender === "string" ? q.gender.trim() : undefined;
      if (
        gender &&
        !(CARTESIA_GENDERS as readonly string[]).includes(gender)
      ) {
        return reply.status(400).send({
          error: `gender must be one of: ${CARTESIA_GENDERS.join(", ")}`,
        });
      }

      try {
        const result = await cartesiaListVoices({
          q: typeof q.q === "string" ? q.q : undefined,
          language: typeof q.language === "string" ? q.language : undefined,
          gender,
          is_owner: parseBoolQuery(q.is_owner),
          limit,
          startingAfter:
            typeof q.starting_after === "string" ? q.starting_after : undefined,
          endingBefore:
            typeof q.ending_before === "string" ? q.ending_before : undefined,
          expandPreview: parseBoolQuery(q.expand_preview) !== false,
        });
        return reply.send({
          voices: result.voices,
          has_more: result.has_more,
          next_page: result.next_page,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cartesia voices failed";
        request.log.error({ err }, "Cartesia list voices failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );

  app.get(
    "/voice/cartesia/preview-file",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({
          error: "CARTESIA_API_KEY is not configured on this server",
        });
      }
      const q = request.query as { url?: string };
      const url = (q.url ?? "").trim();
      if (!url) {
        return reply.status(400).send({ error: "url query parameter is required" });
      }
      if (!isAllowedCartesiaPreviewUrl(url)) {
        return reply.status(400).send({ error: "url must be a Cartesia preview URL" });
      }
      try {
        const preview = await cartesiaFetchPreviewFile(url);
        reply.header("Content-Type", preview.contentType);
        return reply.send(preview.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Preview download failed";
        request.log.error({ err }, "Cartesia preview file proxy failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );

  app.post(
    "/voice/cartesia/preview",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({
          error: "CARTESIA_API_KEY is not configured on this server",
        });
      }
      const parsed = previewSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const { voice_id, model_id, text, language, emotion } = parsed.data;
      const modelId = resolveCartesiaModel(model_id ?? "sonic-3.5");
      const transcript = (text?.trim() || sampleTextForLanguage(language)).slice(
        0,
        500
      );

      try {
        const tts = await cartesiaTextToSpeech({
          transcript,
          modelId,
          voiceId: voice_id,
          language: language?.trim() || "en",
          generationConfig: emotion?.trim()
            ? { emotion: emotion.trim() }
            : { emotion: "neutral" },
          outputFormat: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
        });
        reply.header("Content-Type", tts.contentType);
        reply.header("X-Voice-Id", voice_id);
        reply.header("X-Model-Id", modelId);
        reply.header("X-Credits-Estimated", String(tts.usage.credits_estimated));
        return reply.send(tts.body);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Preview failed";
        request.log.error({ err }, "Cartesia voice preview failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );
}
