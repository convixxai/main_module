import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { env } from "../config/env";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getCustomerSettings } from "../services/customer-settings";
import {
  humanizeTextForOpenAiTts,
  parseHumanizerStyleFields,
  parseHumanizeDepth,
  buildOpenAiTtsDeliveryInstructions,
  DEFAULT_HUMANIZER_SYSTEM_PROMPT,
  DEFAULT_HUMANIZER_STYLE,
  HUMANIZER_PROMPT_VERSION,
} from "../services/openai-tts-humanizer";
import {
  openaiTextToSpeech,
  openAiTtsSimulatorDefaults,
  resolveOpenAiTtsModel,
  type OpenAiTtsResponseFormat,
} from "../services/openai-tts";
import { createRagTrace } from "../services/rag-trace";
import type { SarvamSttMode } from "../services/sarvam";
import { runSimulatorStt } from "./voice-simulator";
import { OPENAI_TTS_SIMULATOR_PAGE_HTML } from "./openai-tts-simulator-page";

const STT_MODES: SarvamSttMode[] = [
  "transcribe",
  "translate",
  "verbatim",
  "translit",
  "codemix",
];

const uuidSchema = z.string().uuid();

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

export async function openaiTtsSimulatorRoutes(app: FastifyInstance): Promise<void> {
  app.get("/voice/openai-tts/simulator", async (request, reply) => {
    const q = request.query as { customer_id?: string };
    const customerId = (q.customer_id ?? "").trim();
    const configJson = JSON.stringify({
      ...openAiTtsSimulatorDefaults(),
      prompt_version: HUMANIZER_PROMPT_VERSION,
      default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
      default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    }).replace(/</g, "\\u003c");
    const html = OPENAI_TTS_SIMULATOR_PAGE_HTML.replace(
      "__CUSTOMER_ID__",
      customerId.replace(/[<>&"']/g, "")
    ).replace("__SIMULATOR_CONFIG__", configJson);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/voice/openai-tts/simulator/config", async (_request, reply) => {
    return reply.send({
      ...openAiTtsSimulatorDefaults(),
      prompt_version: HUMANIZER_PROMPT_VERSION,
      default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
      default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    });
  });

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/openai-tts/simulator/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        if (!env.openai.apiKey?.trim()) {
          return reply.status(503).send({
            error: "OPENAI_API_KEY is not configured on this server",
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
            if (k === "text" || k === "question") continue;
            fields[k] = v == null ? undefined : String(v);
          }
          fields.text =
            typeof body.text === "string"
              ? body.text
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
        const defaults = openAiTtsSimulatorDefaults();
        const skipHumanizer = parseBool(fields.skip_humanizer, false);
        const styleSettings = parseHumanizerStyleFields(fields);
        const humanizerSystemPrompt =
          fields.humanizer_system_prompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT;
        const llmTemperature = parseNum(
          fields.llm_temperature,
          defaults.llm_temperature,
          0,
          1.5
        );
        const llmMaxTokens = Math.floor(
          parseNum(fields.llm_max_tokens, defaults.llm_max_tokens, 80, 2000)
        );
        const llmModel = fields.llm_model?.trim() || cust?.openai_model?.trim() || null;

        const ttsModel = resolveOpenAiTtsModel(
          fields.tts_model?.trim() || defaults.tts_model
        );
        const ttsVoice = (fields.voice?.trim() || defaults.voice).slice(0, 32);
        const ttsSpeed = parseNum(fields.speed, defaults.speed, 0.25, 4);
        const ttsInstructionsAuto = parseBool(
          fields.tts_instructions_auto,
          defaults.tts_instructions_auto !== false
        );
        const ttsInstructionsOverride = fields.tts_instructions?.trim() || "";
        const humanizeDepth = parseHumanizeDepth(
          fields.humanize_depth?.trim() || defaults.humanize_depth
        );
        const responseFormat = (fields.response_format?.trim() ||
          defaults.response_format) as OpenAiTtsResponseFormat;

        let sourceText = "";
        let sttLanguageCode: string | null = null;
        let sttMs = 0;

        if (mode === "speech") {
          if (!fileBuffer || fileBuffer.length === 0) {
            return reply.status(400).send({
              error: "Speech mode requires multipart field `file` with audio (WAV recommended).",
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
            languageHintBcp47: fields.target_language_code,
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
        let humanizedText = sourceText;
        let humanizerMs = 0;
        let humanizerResult: Awaited<ReturnType<typeof humanizeTextForOpenAiTts>> | null =
          null;

        if (!skipHumanizer) {
          const tHum0 = Date.now();
          try {
            humanizerResult = await humanizeTextForOpenAiTts({
              sourceText,
              systemPrompt: humanizerSystemPrompt,
              styleSettings,
              llmModel: llmModel,
              temperature: llmTemperature,
              maxTokens: llmMaxTokens,
              depth: humanizeDepth,
              trace,
            });
            humanizedText = humanizerResult.humanized_text;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Humanizer LLM failed";
            request.log.error({ err }, "OpenAI TTS simulator humanizer failed");
            return reply.status(502).send({ error: msg });
          }
          humanizerMs = Date.now() - tHum0;
        }

        if (!humanizedText.trim()) {
          return reply.status(500).send({ error: "Empty text for TTS" });
        }

        const ttsInstructionsSent = ttsInstructionsAuto
          ? buildOpenAiTtsDeliveryInstructions(
              styleSettings,
              ttsInstructionsOverride || null
            )
          : ttsInstructionsOverride || buildOpenAiTtsDeliveryInstructions(styleSettings);

        const tTts0 = Date.now();
        let ttsResult;
        try {
          ttsResult = await openaiTextToSpeech({
            text: humanizedText,
            model: ttsModel,
            voice: ttsVoice,
            instructions: ttsInstructionsSent,
            speed: ttsSpeed,
            responseFormat,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "OpenAI TTS failed";
          request.log.error({ err }, "OpenAI TTS simulator synthesis failed");
          return reply.status(502).send({ error: msg });
        }
        const ttsMs = Date.now() - tTts0;

        const llmUsage = humanizerResult?.llm;
        const humanizerCost = llmUsage?.costUsd ?? 0;
        const ttsCost = ttsResult.usage.cost_usd;
        const totalCost = humanizerCost + ttsCost;

        return reply.send({
          mode,
          customer_id: customerId,
          source_text: sourceText,
          humanized_text: humanizedText,
          skip_humanizer: skipHumanizer,
          humanize_depth: humanizerResult?.humanize_depth ?? humanizeDepth,
          stt_language_code: sttLanguageCode,
          humanizer: humanizerResult
            ? {
                model: llmUsage?.model,
                prompt_tokens: llmUsage?.promptTokens ?? 0,
                completion_tokens: llmUsage?.completionTokens ?? 0,
                total_tokens: llmUsage?.totalTokens ?? 0,
                cost_usd: humanizerCost,
                style_settings: humanizerResult.style_settings,
                oral_plan: humanizerResult.llm_analysis?.answer ?? null,
              }
            : null,
          tts_instructions_sent: ttsInstructionsSent,
          tts_instructions_auto: ttsInstructionsAuto,
          tts: {
            model: ttsResult.usage.model,
            voice: ttsResult.usage.voice,
            input_characters: ttsResult.usage.input_characters,
            instructions_chars: ttsResult.usage.instructions_chars,
            response_format: ttsResult.usage.response_format,
            cost_usd: ttsCost,
          },
          api_usage: {
            humanizer_cost_usd: humanizerCost,
            tts_cost_usd: ttsCost,
            total_cost_usd: totalCost,
            humanizer_tokens: llmUsage?.totalTokens ?? 0,
            tts_characters: ttsResult.usage.input_characters,
          },
          audio: {
            format: responseFormat,
            content_type: ttsResult.contentType,
            base64: ttsResult.body.toString("base64"),
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
