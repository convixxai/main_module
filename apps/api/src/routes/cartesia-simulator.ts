import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { env } from "../config/env";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getCustomerSettings } from "../services/customer-settings";
import {
  humanizeTextForOpenAiTts,
  parseHumanizerStyleFields,
  DEFAULT_HUMANIZER_SYSTEM_PROMPT,
  DEFAULT_HUMANIZER_STYLE,
} from "../services/openai-tts-humanizer";
import { createRagTrace } from "../services/rag-trace";
import type { SarvamSttMode } from "../services/sarvam";
import {
  cartesiaConfigured,
  cartesiaListVoices,
  cartesiaSimulatorDefaults,
  cartesiaTextToSpeech,
  CARTESIA_OUTPUT_PRESETS,
  resolveCartesiaEmotion,
  resolveCartesiaModel,
} from "../services/cartesia";
import { runSimulatorStt } from "./voice-simulator";
import { CARTESIA_SIMULATOR_PAGE_HTML } from "./cartesia-simulator-page";

const STT_MODES: SarvamSttMode[] = [
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
];

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

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultVal;
  const v = raw.trim().toLowerCase();
  return v === "true" || v === "1" || v === "on" || v === "yes";
}

function parseNum(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function resolveOutputFormat(fields: Record<string, string | undefined>) {
  const presetId = fields.output_preset?.trim();
  const preset =
    CARTESIA_OUTPUT_PRESETS.find((p) => p.id === presetId) ??
    CARTESIA_OUTPUT_PRESETS[0];
  return {
    container: fields.output_container?.trim() || preset.container,
    sample_rate: parseNum(
      fields.output_sample_rate,
      preset.sample_rate,
      8000,
      48000
    ),
    encoding: fields.output_encoding?.trim() || preset.encoding,
    bit_rate: fields.output_bit_rate
      ? parseNum(fields.output_bit_rate, preset.bit_rate ?? 128000, 32000, 320000)
      : preset.bit_rate,
  };
}

export async function cartesiaSimulatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/voice/cartesia/simulator", async (request, reply) => {
    const q = request.query as { customer_id?: string };
    const customerId = (q.customer_id ?? "").trim();
    const configJson = JSON.stringify({
      ...cartesiaSimulatorDefaults(),
      cartesia_configured: cartesiaConfigured(),
      default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
      default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    }).replace(/</g, "\\u003c");
    const html = CARTESIA_SIMULATOR_PAGE_HTML.replace(
      "__CUSTOMER_ID__",
      customerId.replace(/[<>&"']/g, "")
    ).replace("__SIMULATOR_CONFIG__", configJson);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/voice/cartesia/simulator/config", async (_request, reply) => {
    return reply.send({
      ...cartesiaSimulatorDefaults(),
      cartesia_configured: cartesiaConfigured(),
      default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
      default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    });
  });

  app.get(
    "/voice/cartesia/simulator/voices",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({
          error: "CARTESIA_API_KEY is not configured on this server",
        });
      }
      const q = request.query as {
        q?: string;
        language?: string;
        limit?: string;
        starting_after?: string;
      };
      try {
        const result = await cartesiaListVoices({
          q: q.q,
          language: q.language,
          limit: q.limit ? parseInt(q.limit, 10) : 50,
          startingAfter: q.starting_after,
        });
        return reply.send(result);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cartesia voices failed";
        request.log.error({ err }, "Cartesia simulator voices list failed");
        return reply.status(502).send({ error: msg });
      }
    }
  );

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/cartesia/simulator/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        if (!cartesiaConfigured()) {
          return reply.status(503).send({
            error: "CARTESIA_API_KEY is not configured on this server",
          });
        }

        const t0 = Date.now();
        let mode: "speech" | "text" = "text";
        let fileBuffer: Buffer | null = null;
        let filename = "speech.wav";
        let mimeType = "audio/wav";
        const fields: Record<string, string | undefined> = {};

        const contentType = request.headers["content-type"] ?? "";
        if (contentType.includes("multipart/form-data")) {
          try {
            for await (const part of request.parts()) {
              if (part.type === "file") {
                fileBuffer = await part.toBuffer();
                filename = part.filename || filename;
                mimeType = part.mimetype || mimeType;
              } else {
                fields[part.fieldname] = String(part.value ?? "");
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Invalid multipart";
            return reply.status(400).send({ error: msg });
          }
          mode = fields.mode === "text" ? "text" : "speech";
        } else {
          const body = request.body as Record<string, unknown> | undefined;
          if (!body || typeof body !== "object") {
            return reply.status(400).send({ error: "Expected JSON or multipart body" });
          }
          mode = body.mode === "speech" ? "speech" : "text";
          for (const [k, v] of Object.entries(body)) {
            if (k === "text" || k === "transcript" || k === "question") continue;
            fields[k] = v == null ? undefined : String(v);
          }
          fields.text =
            typeof body.text === "string"
              ? body.text
              : typeof body.transcript === "string"
                ? body.transcript
                : typeof body.question === "string"
                  ? body.question
                  : undefined;
        }

        const scope = assertCustomerScope(request, fields.customer_id);
        if (typeof scope !== "string") {
          return reply.status(scope.status).send({ error: scope.error });
        }
        const customerId = scope;

        const cust = await getCustomerSettings(customerId);
        const defaults = cartesiaSimulatorDefaults();
        const skipHumanizer = parseBool(
          fields.skip_humanizer,
          defaults.skip_humanizer
        );
        const isPvcVoice = parseBool(fields.is_pvc_voice, false);

        const modelId = resolveCartesiaModel(
          fields.model_id?.trim() || defaults.model_id
        );
        const voiceId = fields.voice_id?.trim() || defaults.voice_id;
        const language = fields.language?.trim() || defaults.language;

        const genSpeed = parseNum(
          fields.gen_speed,
          defaults.generation_config.speed,
          0.6,
          1.5
        );
        const genVolume = parseNum(
          fields.gen_volume,
          defaults.generation_config.volume,
          0.5,
          2
        );
        const genEmotion = resolveCartesiaEmotion(
          fields.gen_emotion || defaults.generation_config.emotion
        );

        const outputFormat = resolveOutputFormat(fields);
        const pronunciationDictId = fields.pronunciation_dict_id?.trim() || null;
        const legacySpeed = fields.legacy_speed?.trim() || null;

        const llmTemperature = parseNum(fields.llm_temperature, 0.85, 0, 1.5);
        const llmMaxTokens = Math.floor(
          parseNum(fields.llm_max_tokens, 350, 80, 2000)
        );
        const llmModel = fields.llm_model?.trim() || cust?.openai_model?.trim() || null;
        const humanizerSystemPrompt =
          fields.humanizer_system_prompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT;
        const styleSettings = parseHumanizerStyleFields(fields);

        let sourceText = "";
        let sttLanguageCode: string | null = null;
        let sttMs = 0;

        if (mode === "speech") {
          if (!fileBuffer || fileBuffer.length === 0) {
            return reply.status(400).send({
              error: "Speech mode requires multipart field `file` with audio.",
            });
          }
          const tStt0 = Date.now();
          const sttModeRaw = (fields.stt_mode || "transcribe").toLowerCase();
          const sttMode = STT_MODES.includes(sttModeRaw as SarvamSttMode)
            ? (sttModeRaw as SarvamSttMode)
            : "transcribe";
          const stt = await runSimulatorStt({
            fileBuffer,
            filename,
            mimeType,
            customerId,
            languageHintBcp47: fields.target_language_code || language,
            sttMode,
          });
          sttMs = Date.now() - tStt0;
          if (stt.status !== 200) {
            return reply.status(stt.status === 503 ? 503 : 502).send({
              error:
                stt.status === 503
                  ? "STT provider is not configured for this tenant"
                  : "Speech-to-text failed",
              stt_status: stt.status,
            });
          }
          sourceText = stt.transcript.trim();
          sttLanguageCode = stt.language_code;
          if (!sourceText) {
            return reply.status(400).send({
              error: "Empty transcript from speech-to-text",
              stt_language_code: sttLanguageCode,
            });
          }
        } else {
          sourceText = (fields.text ?? "").trim();
          if (!sourceText) {
            return reply.status(400).send({ error: "Text mode requires `text`" });
          }
        }

        const trace = createRagTrace(request.log);
        let transcriptText = sourceText;
        let humanizerMs = 0;
        let humanizerResult: Awaited<ReturnType<typeof humanizeTextForOpenAiTts>> | null =
          null;

        if (!skipHumanizer) {
          if (!env.openai.apiKey?.trim()) {
            return reply.status(503).send({
              error:
                "OPENAI_API_KEY is required when humanizer is enabled (or check Skip humanizer).",
            });
          }
          const tHum0 = Date.now();
          try {
            humanizerResult = await humanizeTextForOpenAiTts({
              sourceText,
              systemPrompt: humanizerSystemPrompt,
              styleSettings,
              llmModel,
              temperature: llmTemperature,
              maxTokens: llmMaxTokens,
              trace,
            });
            transcriptText = humanizerResult.humanized_text;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Humanizer LLM failed";
            request.log.error({ err }, "Cartesia simulator humanizer failed");
            return reply.status(502).send({ error: msg });
          }
          humanizerMs = Date.now() - tHum0;
        }

        if (!transcriptText.trim()) {
          return reply.status(500).send({ error: "Empty transcript for TTS" });
        }

        const tTts0 = Date.now();
        let ttsResult;
        try {
          ttsResult = await cartesiaTextToSpeech({
            transcript: transcriptText,
            modelId,
            voiceId,
            language,
            generationConfig: {
              speed: genSpeed,
              volume: genVolume,
              emotion: genEmotion,
            },
            outputFormat,
            pronunciationDictId,
            legacySpeed:
              legacySpeed === "slow" ||
              legacySpeed === "normal" ||
              legacySpeed === "fast"
                ? legacySpeed
                : null,
            isPvcVoice,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Cartesia TTS failed";
          request.log.error({ err }, "Cartesia simulator synthesis failed");
          return reply.status(502).send({ error: msg });
        }
        const ttsWallMs = Date.now() - tTts0;

        const llmUsage = humanizerResult?.llm;
        const humanizerCost = llmUsage?.costUsd ?? 0;
        const ttsCost = ttsResult.usage.cost_usd_estimated;
        const totalCost = humanizerCost + ttsCost;

        return reply.send({
          mode,
          customer_id: customerId,
          source_text: sourceText,
          transcript_sent: transcriptText,
          skip_humanizer: skipHumanizer,
          stt_language_code: sttLanguageCode,
          humanizer: humanizerResult
            ? {
                model: llmUsage?.model,
                prompt_tokens: llmUsage?.promptTokens ?? 0,
                completion_tokens: llmUsage?.completionTokens ?? 0,
                total_tokens: llmUsage?.totalTokens ?? 0,
                cost_usd: humanizerCost,
                style_settings: humanizerResult.style_settings,
              }
            : null,
          cartesia: {
            model_id: ttsResult.usage.model_id,
            voice_id: ttsResult.usage.voice_id,
            language,
            generation_config: {
              speed: genSpeed,
              volume: genVolume,
              emotion: genEmotion,
            },
            output_format: outputFormat,
            pronunciation_dict_id: pronunciationDictId,
            legacy_speed: legacySpeed,
            is_pvc_voice: isPvcVoice,
          },
          api_usage: {
            humanizer_cost_usd: humanizerCost,
            tts_credits: ttsResult.usage.credits_estimated,
            tts_credits_per_character: ttsResult.usage.credits_per_character,
            tts_characters: ttsResult.usage.transcript_characters,
            tts_cost_usd_estimated: ttsCost,
            total_cost_usd_estimated: totalCost,
            humanizer_tokens: llmUsage?.totalTokens ?? 0,
            usd_per_million_credits: ttsResult.usage.usd_per_million_credits,
          },
          audio: {
            container: ttsResult.usage.output_container,
            content_type: ttsResult.contentType,
            bytes: ttsResult.usage.audio_bytes,
            base64: ttsResult.body.toString("base64"),
          },
          timings: {
            stt_ms: sttMs,
            humanizer_ms: humanizerMs,
            tts_ms: ttsResult.timings.tts_ms,
            tts_wall_ms: ttsWallMs,
            ttfb_ms: ttsResult.timings.ttfb_ms,
            audio_duration_estimate_sec:
              ttsResult.timings.audio_duration_estimate_sec,
            total_ms: Date.now() - t0,
          },
        });
      }
    );
  });
}
