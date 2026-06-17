import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { env } from "../config/env";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getCustomerSettings } from "../services/customer-settings";
import {
  humanizeTextForOpenAiTts,
  parseHumanizerStyleFields,
  DEFAULT_HUMANIZER_SYSTEM_PROMPT,
  DEFAULT_HUMANIZER_STYLE,
} from "../services/openai-tts-humanizer";
import {
  sarvamTextToSpeech,
  type SarvamSttMode,
} from "../services/sarvam";
import { createRagTrace } from "../services/rag-trace";
import { runSimulatorStt } from "./voice-simulator";
import { SARVAM_TTS_SIMULATOR_PAGE_HTML } from "./sarvam-tts-simulator-page";

const STT_MODES: SarvamSttMode[] = [
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
];

const TTS_LANGUAGE_CODES = [
  "bn-IN",
  "en-IN",
  "gu-IN",
  "hi-IN",
  "kn-IN",
  "ml-IN",
  "mr-IN",
  "od-IN",
  "pa-IN",
  "ta-IN",
  "te-IN",
] as const;

const SAMPLE_RATES = [
  "8000",
  "16000",
  "22050",
  "24000",
  "32000",
  "44100",
  "48000",
] as const;

const AUDIO_CODECS = [
  "wav",
  "mp3",
  "linear16",
  "mulaw",
  "alaw",
  "opus",
  "flac",
  "aac",
] as const;

const BULBUL_V3_SPEAKERS = {
  male: [
    "shubh", "aditya", "rahul", "rohan", "amit", "dev", "ratan", "varun",
    "manan", "sumit", "kabir", "aayan", "ashutosh", "advait", "anand",
    "tarun", "sunny", "mani", "gokul", "vijay", "mohit", "rehan", "soham",
  ],
  female: [
    "ritu", "priya", "neha", "pooja", "simran", "kavya", "ishita", "shreya",
    "roopa", "amelia", "sophia", "tanya", "shruti", "suhani", "kavitha", "rupali",
  ],
};

const BULBUL_V2_SPEAKERS = {
  female: ["anushka", "manisha", "vidya", "arya"],
  male: ["abhilash", "karun", "hitesh"],
};

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

function estimateSarvamTtsCost(
  characters: number,
  model: string
): number {
  const ratePer10k = model === "bulbul:v2" ? 15 : 30; // INR per 10,000 chars
  const costInInr = (characters / 10000) * ratePer10k;
  const exchangeRate = 83; // approx 83 INR per USD
  return costInInr / exchangeRate;
}

export function sarvamTtsSimulatorDefaults() {
  return {
    sarvam_configured: Boolean(env.sarvam.apiKey?.trim()),
    model_id: "bulbul:v3",
    default_language: "hi-IN",
    default_codec: "wav",
    default_sample_rate: "24000",
    languages: TTS_LANGUAGE_CODES.map((code) => ({
      code,
      label: {
        "bn-IN": "Bengali",
        "en-IN": "English (India)",
        "gu-IN": "Gujarati",
        "hi-IN": "Hindi",
        "kn-IN": "Kannada",
        "ml-IN": "Malayalam",
        "mr-IN": "Marathi",
        "od-IN": "Odia",
        "pa-IN": "Punjabi",
        "ta-IN": "Tamil",
        "te-IN": "Telugu",
      }[code],
    })),
    codecs: [...AUDIO_CODECS],
    sample_rates: [...SAMPLE_RATES],
    speakers_v3: BULBUL_V3_SPEAKERS,
    speakers_v2: BULBUL_V2_SPEAKERS,
    skip_humanizer: true,
    default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
    default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    pricing: {
      bulbul_v3_inr_per_10k: 30,
      bulbul_v2_inr_per_10k: 15,
      note: "Universal credits pay-per-use character billing.",
    },
  };
}

export async function sarvamTtsSimulatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/voice/sarvam-tts/simulator", async (request, reply) => {
    const q = request.query as { customer_id?: string };
    const customerId = (q.customer_id ?? "").trim();
    const configJson = JSON.stringify(sarvamTtsSimulatorDefaults()).replace(/</g, "\\u003c");
    const html = SARVAM_TTS_SIMULATOR_PAGE_HTML.replace(
      "__CUSTOMER_ID__",
      customerId.replace(/[<>&"']/g, "")
    ).replace("__SIMULATOR_CONFIG__", configJson);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/voice/sarvam-tts/simulator/config", async (_request, reply) => {
    return reply.send(sarvamTtsSimulatorDefaults());
  });

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/sarvam-tts/simulator/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        if (!env.sarvam.apiKey?.trim()) {
          return reply.status(503).send({
            error: "SARVAM_API_KEY is not configured on this server",
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
        const skipHumanizer = parseBool(fields.skip_humanizer, true);
        const styleSettings = parseHumanizerStyleFields(fields);
        const humanizerSystemPrompt =
          fields.humanizer_system_prompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT;
        const llmTemperature = parseNum(fields.llm_temperature, 0.85, 0, 1.5);
        const llmModel = fields.llm_model?.trim() || cust?.openai_model?.trim() || null;

        const ttsModel = fields.model?.trim() === "bulbul:v2" ? "bulbul:v2" : "bulbul:v3";
        const targetLanguageCode = fields.target_language_code?.trim() || "hi-IN";
        const speaker = fields.speaker?.trim() || "ritu";
        const pace = parseNum(fields.pace, 1.0, ttsModel === "bulbul:v2" ? 0.3 : 0.5, ttsModel === "bulbul:v2" ? 3.0 : 2.0);
        const outputCodec = fields.output_audio_codec?.trim() || "wav";
        const sampleRate = fields.speech_sample_rate?.trim() || "24000";
        const dictId = fields.dict_id?.trim() || null;

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
            languageHintBcp47: fields.target_language_hint || targetLanguageCode,
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
        let humanizerResult: Awaited<ReturnType<typeof humanizeTextForOpenAiTts>> | null = null;

        if (!skipHumanizer) {
          if (!env.openai.apiKey?.trim()) {
            return reply.status(503).send({
              error: "OPENAI_API_KEY is required when humanizer is enabled.",
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
              maxTokens: 350,
              trace,
            });
            transcriptText = humanizerResult.humanized_text;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Humanizer LLM failed";
            request.log.error({ err }, "Sarvam simulator humanizer failed");
            return reply.status(502).send({ error: msg });
          }
          humanizerMs = Date.now() - tHum0;
        }

        if (!transcriptText.trim()) {
          return reply.status(500).send({ error: "Empty transcript for TTS" });
        }

        // Build Sarvam TTS API payload
        const ttsPayload: any = {
          text: transcriptText.slice(0, ttsModel === "bulbul:v2" ? 1500 : 2500),
          target_language_code: targetLanguageCode,
          model: ttsModel,
          speaker: speaker,
          pace: pace,
          output_audio_codec: outputCodec,
          speech_sample_rate: sampleRate,
        };

        if (ttsModel === "bulbul:v3") {
          const temp = fields.temperature ? Number(fields.temperature) : undefined;
          if (temp !== undefined && !Number.isNaN(temp)) {
            ttsPayload.temperature = temp;
          }
          ttsPayload.enable_preprocessing = parseBool(fields.enable_preprocessing, true);
        } else {
          const pitch = fields.pitch ? Number(fields.pitch) : undefined;
          if (pitch !== undefined && !Number.isNaN(pitch)) {
            ttsPayload.pitch = pitch;
          }
          const loudness = fields.loudness ? Number(fields.loudness) : undefined;
          if (loudness !== undefined && !Number.isNaN(loudness)) {
            ttsPayload.loudness = loudness;
          }
        }

        if (dictId) {
          ttsPayload.dict_id = dictId;
        }

        const tTts0 = Date.now();
        let ttsResult;
        try {
          ttsResult = await sarvamTextToSpeech(ttsPayload);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Sarvam TTS failed";
          request.log.error({ err }, "Sarvam simulator synthesis failed");
          return reply.status(502).send({ error: msg });
        }
        const ttsMs = Date.now() - tTts0;

        if (ttsResult.status !== 200 || !ttsResult.body || typeof ttsResult.body !== "object") {
          return reply.status(ttsResult.status).send(ttsResult.body);
        }

        const resBody = ttsResult.body as any;
        const b64Audio = resBody.audios?.[0];
        if (!b64Audio) {
          return reply.status(502).send({ error: "No audio returned from Sarvam" });
        }

        const humanizerCost = humanizerResult?.llm?.costUsd ?? 0;
        const ttsCostEstimated = estimateSarvamTtsCost(transcriptText.length, ttsModel);
        const totalCost = humanizerCost + ttsCostEstimated;

        // Content-Type mapping
        const contentTypes: Record<string, string> = {
          wav: "audio/wav",
          mp3: "audio/mpeg",
          flac: "audio/flac",
          opus: "audio/opus",
          aac: "audio/aac",
          linear16: "audio/wav",
          mulaw: "audio/wav",
          alaw: "audio/wav",
        };

        return reply.send({
          mode,
          customer_id: customerId,
          source_text: sourceText,
          transcript_sent: transcriptText,
          skip_humanizer: skipHumanizer,
          stt_language_code: sttLanguageCode,
          humanizer: humanizerResult
            ? {
                model: humanizerResult.llm.model,
                prompt_tokens: humanizerResult.llm.promptTokens,
                completion_tokens: humanizerResult.llm.completionTokens,
                total_tokens: humanizerResult.llm.totalTokens,
                cost_usd: humanizerCost,
                style_settings: humanizerResult.style_settings,
              }
            : null,
          sarvam: {
            model: ttsModel,
            speaker: speaker,
            target_language_code: targetLanguageCode,
            pace: pace,
            output_audio_codec: outputCodec,
            speech_sample_rate: sampleRate,
            dict_id: dictId,
            temperature: ttsPayload.temperature,
            pitch: ttsPayload.pitch,
            loudness: ttsPayload.loudness,
            enable_preprocessing: ttsPayload.enable_preprocessing,
          },
          api_usage: {
            humanizer_cost_usd: humanizerCost,
            tts_characters: transcriptText.length,
            tts_cost_usd_estimated: ttsCostEstimated,
            total_cost_usd_estimated: totalCost,
          },
          audio: {
            content_type: contentTypes[outputCodec] || "application/octet-stream",
            base64: b64Audio,
          },
          timings: {
            stt_ms: sttMs,
            humanizer_ms: humanizerMs,
            tts_ms: ttsMs,
            total_ms: Date.now() - t0,
          },
        });
      }
    );
  });
}
