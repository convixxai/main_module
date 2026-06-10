import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { env } from "../config/env";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { getCustomerSettings } from "../services/customer-settings";
import {
  bcp47ToElevenLabsLanguage,
  elevenLabsSimulatorTtsDefaults,
  elevenLabsSpeechToText,
  elevenLabsSttToSarvamShape,
  elevenLabsTtsLanguageCodeSupportedOnModel,
  resolveElevenLabsSttModelId,
  resolveElevenLabsTtsModelId,
} from "../services/elevenlabs";
import {
  parseSimulatorTtsSettings,
  synthesizeSimulatorPcm8k,
} from "../services/voice-simulator";
import {
  sarvamSpeechToText,
  type SarvamSttMode,
} from "../services/sarvam";
import { createRagTrace } from "../services/rag-trace";
import { pool } from "../config/db";
import { runAskPipeline } from "./ask";
import { VOICE_SIMULATOR_PAGE_HTML } from "./voice-simulator-page";

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

export async function runSimulatorStt(params: {
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
  customerId: string;
  languageHintBcp47?: string;
  sttMode?: SarvamSttMode;
}): Promise<{ status: number; transcript: string; language_code: string | null }> {
  const cust = await getCustomerSettings(params.customerId);
  const sttProv = cust?.stt_provider ?? "sarvam";
  const multilingual = cust?.voicebot_multilingual === true;
  const hint =
    params.languageHintBcp47?.trim() ||
    cust?.default_language_code?.trim() ||
    "en-IN";

  if (sttProv === "elevenlabs") {
    if (!env.elevenlabs.apiKey) {
      return { status: 503, transcript: "", language_code: null };
    }
    const elModel = resolveElevenLabsSttModelId(cust?.stt_model);
    const elLang = bcp47ToElevenLabsLanguage(hint, {
      multilingual,
      forceEnglish: !multilingual,
    });
    const stt = await elevenLabsSpeechToText({
      fileBuffer: params.fileBuffer,
      filename: params.filename,
      modelId: elModel,
      languageCode: elLang,
    });
    if (stt.status !== 200) {
      return { status: stt.status, transcript: "", language_code: null };
    }
    const shaped = elevenLabsSttToSarvamShape(stt.body);
    return {
      status: 200,
      transcript: shaped.transcript,
      language_code: shaped.language_code,
    };
  }

  if (!env.sarvam.apiKey.trim()) {
    return { status: 503, transcript: "", language_code: null };
  }
  const mode = params.sttMode ?? "transcribe";
  const stt = await sarvamSpeechToText({
    fileBuffer: params.fileBuffer,
    filename: params.filename,
    mimeType: params.mimeType,
    model: cust?.stt_model?.trim() || "saaras:v3",
    mode,
    language_code: multilingual ? hint : undefined,
  });
  if (stt.status !== 200) {
    return { status: stt.status, transcript: "", language_code: null };
  }
  const body = stt.body as Record<string, unknown>;
  const transcript =
    typeof body.transcript === "string" ? body.transcript.trim() : "";
  const language_code =
    typeof body.language_code === "string" ? body.language_code : null;
  return { status: 200, transcript, language_code };
}

export async function voiceSimulatorRoutes(app: FastifyInstance) {
  app.get("/voice/simulator", async (request, reply) => {
    const q = request.query as { customer_id?: string };
    const customerId = (q.customer_id ?? "").trim();
    const configJson = JSON.stringify(elevenLabsSimulatorTtsDefaults()).replace(
      /</g,
      "\\u003c"
    );
    const html = VOICE_SIMULATOR_PAGE_HTML.replace(
      "__CUSTOMER_ID__",
      customerId.replace(/[<>&"']/g, "")
    ).replace("__SIMULATOR_CONFIG__", configJson);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  app.get("/voice/simulator/config", async (_request, reply) => {
    return reply.send(elevenLabsSimulatorTtsDefaults());
  });

  app.get(
    "/voice/simulator/tenant-defaults",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const customerId = request.customerId!;
      const cust = await getCustomerSettings(customerId);
      const modelRaw = cust?.tts_model ?? null;
      const modelId = resolveElevenLabsTtsModelId(modelRaw);
      const base = elevenLabsSimulatorTtsDefaults(modelRaw);
      const elLang = bcp47ToElevenLabsLanguage(cust?.default_language_code, {
        multilingual: cust?.voicebot_multilingual === true,
        forceEnglish: cust?.voicebot_multilingual !== true,
      });
      const langForUi =
        elLang && elevenLabsTtsLanguageCodeSupportedOnModel(modelId, elLang)
          ? elLang
          : "auto";
      return reply.send({
        ...base,
        model_id: modelId,
        language_code: langForUi,
        tts_provider: cust?.tts_provider ?? "sarvam",
        stt_provider: cust?.stt_provider ?? "sarvam",
        voicebot_multilingual: cust?.voicebot_multilingual === true,
        default_language_code: cust?.default_language_code ?? "en-IN",
      });
    }
  );

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/simulator/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        if (!env.elevenlabs.apiKey) {
          return reply.status(503).send({
            error: "ELEVENLABS_API_KEY is not configured on this server",
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
            if (k === "question") continue;
            fields[k] = v == null ? undefined : String(v);
          }
          fields.question =
            typeof body.question === "string" ? body.question : undefined;
        }

        const scope = assertCustomerScope(request, fields.customer_id);
        if (typeof scope !== "string") {
          return reply.status(scope.status).send({ error: scope.error });
        }
        const customerId = scope;

        const customerRow = await pool.query(
          `SELECT system_prompt FROM customers WHERE id = $1`,
          [customerId]
        );
        if (customerRow.rows.length === 0) {
          return reply.status(404).send({ error: "Customer not found" });
        }
        const customerPrompt = customerRow.rows[0].system_prompt as string;

        const cust = await getCustomerSettings(customerId);
        const simDefaults = elevenLabsSimulatorTtsDefaults(
          fields.model_id?.trim() || cust?.tts_model
        );
        const ttsSettings = parseSimulatorTtsSettings(fields, simDefaults);

        let sessionId: string | null = null;
        if (fields.session_id?.trim()) {
          const p = uuidSchema.safeParse(fields.session_id.trim());
          if (p.success) sessionId = p.data;
        }
        let agentId: string | null = null;
        if (fields.agent_id?.trim()) {
          const p = uuidSchema.safeParse(fields.agent_id.trim());
          if (p.success) agentId = p.data;
        }

        let transcript = "";
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
          transcript = stt.transcript.trim();
          sttLanguageCode = stt.language_code;
          if (!transcript) {
            return reply.status(400).send({
              error: "Empty transcript from speech-to-text",
              stt_language_code: sttLanguageCode,
            });
          }
        } else {
          transcript = (fields.question ?? "").trim();
          if (!transcript) {
            return reply.status(400).send({ error: "Text mode requires `question`" });
          }
        }

        const additionalSystemPrompt = fields.additional_system_prompt?.trim() || null;

        const trace = createRagTrace(request.log);
        const tAsk0 = Date.now();
        let askResult;
        try {
          askResult = await runAskPipeline({
            customerId,
            customerPrompt,
            question: transcript,
            inputSessionId: sessionId,
            inputAgentId: agentId,
            includeTimings: true,
            sequentialLlm: true,
            ragOpenaiOnly: request.ragUseOpenaiOnly === true,
            trace,
            embeddingLanguageHint: sttLanguageCode,
            additionalSystemPrompt,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "RAG pipeline failed";
          request.log.error({ err }, "voice simulator RAG failed");
          return reply.status(500).send({ error: msg });
        }
        const askMs = Date.now() - tAsk0;

        const answer = askResult.answer.trim();
        if (!answer) {
          return reply.status(500).send({ error: "Empty answer from RAG pipeline" });
        }

        const tTts0 = Date.now();
        let pcmResult;
        try {
          pcmResult = await synthesizeSimulatorPcm8k(answer, ttsSettings);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "TTS failed";
          request.log.error({ err }, "voice simulator TTS failed");
          return reply.status(502).send({ error: msg });
        }
        const ttsMs = Date.now() - tTts0;

        return reply.send({
          mode,
          customer_id: customerId,
          transcript,
          stt_language_code: sttLanguageCode,
          answer,
          source: askResult.source,
          session_id: askResult.session_id,
          agent_id: askResult.agent_id,
          agent_name: askResult.agent_name,
          tts_settings: ttsSettings,
          audio: {
            sample_rate: pcmResult.sampleRate,
            format: "pcm_s16le",
            channels: 1,
            base64: pcmResult.pcm.toString("base64"),
            duration_ms: Math.round(pcmResult.durationMs),
          },
          timings: {
            stt_ms: sttMs,
            ask_ms: askMs,
            tts_ms: ttsMs,
            total_ms: Date.now() - t0,
            pipeline_timings: askResult.pipeline_timings ?? null,
          },
        });
      }
    );
  });
}
