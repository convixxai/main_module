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
import { runSimulatorStt } from "./voice-simulator";
import { GOOGLE_TTS_SIMULATOR_PAGE_HTML } from "./google-tts-simulator-page";
import {
  googleTtsSimulatorDefaults,
  exchangeOAuthCode,
  refreshGoogleAccessToken,
  fetchGoogleTtsVoices,
  googleTextToSpeech,
  estimateGoogleTtsCostUsd
} from "../services/google-tts";

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

function getMimeTypeForEncoding(encoding: string): string {
  switch (encoding) {
    case "LINEAR16": return "audio/wav";
    case "OGG_OPUS": return "audio/ogg";
    case "MULAW": return "audio/basic";
    case "ALAW": return "audio/basic";
    default: return "audio/mpeg";
  }
}

export async function googleTtsSimulatorRoutes(app: FastifyInstance): Promise<void> {
  // 1. Serves the HTML page
  app.get("/voice/google-tts/simulator", async (request, reply) => {
    const q = request.query as { customer_id?: string };
    const customerId = (q.customer_id ?? "").trim();
    const configJson = JSON.stringify({
      ...googleTtsSimulatorDefaults(),
      default_humanizer_system_prompt: DEFAULT_HUMANIZER_SYSTEM_PROMPT,
      default_humanizer_style: DEFAULT_HUMANIZER_STYLE,
    }).replace(/</g, "\\u003c");
    const html = GOOGLE_TTS_SIMULATOR_PAGE_HTML.replace(
      "__CUSTOMER_ID__",
      customerId.replace(/[<>&"']/g, "")
    ).replace("__SIMULATOR_CONFIG__", configJson);
    return reply.type("text/html; charset=utf-8").send(html);
  });

  // 2. Serves the OAuth callback HTML (handles popup closing)
  app.get("/voice/google-tts/oauth/callback", async (request, reply) => {
    const html = `<!DOCTYPE html>
<html>
<head><title>Authorizing...</title></head>
<body>
  <p style="font-family: sans-serif; color: #e8eef6; background: #0b0f14; margin: 0; padding: 2rem; height: 100vh; display: flex; align-items: center; justify-content: center;">
    Authorization code received. Closing window...
  </p>
  <script>
    if (window.opener) {
      var code = new URLSearchParams(window.location.search).get('code');
      window.opener.postMessage({ type: 'google-oauth-code', code: code }, window.location.origin);
      window.close();
    }
  </script>
</body>
</html>`;
    return reply.type("text/html; charset=utf-8").send(html);
  });

  // 3. Exposes Token exchange API
  app.post(
    "/voice/google-tts/oauth/token",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = request.body as { code?: string; client_id?: string; client_secret?: string; redirect_uri?: string } | undefined;
      if (!body?.code || !body?.client_id || !body?.client_secret || !body?.redirect_uri) {
        return reply.status(400).send({ error: "Missing required parameters (code, client_id, client_secret, redirect_uri)" });
      }

      try {
        const tokens = await exchangeOAuthCode({
          code: body.code,
          clientId: body.client_id,
          clientSecret: body.client_secret,
          redirectUri: body.redirect_uri
        });
        return reply.send(tokens);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "OAuth code exchange failed";
        request.log.error({ err }, "Google OAuth exchange error");
        return reply.status(400).send({ error: msg });
      }
    }
  );

  // 4. Proxy to fetch voices list
  app.post(
    "/voice/google-tts/voices",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = request.body as { access_token?: string; refresh_token?: string; client_id?: string; client_secret?: string } | undefined;
      let accessToken = body?.access_token?.trim();
      const refreshToken = body?.refresh_token?.trim();
      const clientId = body?.client_id?.trim();
      const clientSecret = body?.client_secret?.trim();

      if (!accessToken) {
        return reply.status(400).send({ error: "access_token is required" });
      }

      let newAccessToken: string | null = null;

      try {
        try {
          const voices = await fetchGoogleTtsVoices(accessToken);
          return reply.send({ voices });
        } catch (err: any) {
          // If 401 Unauthorized and we have refresh capabilities, attempt to refresh and retry
          if (err.message?.includes("401") && refreshToken && clientId && clientSecret) {
            request.log.info("Access token expired while fetching voices. Attempting refresh...");
            const refreshResult = await refreshGoogleAccessToken({
              clientId,
              clientSecret,
              refreshToken
            });
            accessToken = refreshResult.access_token;
            newAccessToken = refreshResult.access_token;
            const voices = await fetchGoogleTtsVoices(accessToken);
            return reply.send({ voices, access_token: newAccessToken });
          }
          throw err;
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Failed fetching Google TTS voices";
        request.log.error({ err }, "Google voices fetch error");
        return reply.status(502).send({ error: msg });
      }
    }
  );

  // 5. Google TTS turn endpoint
  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/voice/google-tts/simulator/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
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
        const defaults = googleTtsSimulatorDefaults();
        const skipHumanizer = parseBool(fields.skip_humanizer, defaults.skip_humanizer);

        // Google Specific Credentials & Tokens
        let accessToken = fields.access_token?.trim();
        const refreshToken = fields.refresh_token?.trim();
        const clientId = fields.client_id?.trim();
        const clientSecret = fields.client_secret?.trim();

        if (!accessToken) {
          return reply.status(400).send({ error: "access_token is required" });
        }

        // Voice Settings
        const voiceName = fields.voice_name?.trim() || defaults.voice_name;
        const languageCode = fields.language_code?.trim() || defaults.language_code;
        const ssmlMode = parseBool(fields.ssml_mode, defaults.ssml_mode);

        const speakingRate = parseNum(fields.speaking_rate, defaults.speaking_rate, 0.25, 4.0);
        const pitch = parseNum(fields.pitch, defaults.pitch, -20.0, 20.0);
        const volumeGainDb = parseNum(fields.volume_gain_db, defaults.volume_gain_db, -96.0, 16.0);
        const audioEncoding = (fields.audio_encoding || defaults.audio_encoding) as any;
        const sampleRateHertz = fields.sample_rate_hertz ? Math.floor(parseNum(fields.sample_rate_hertz, defaults.sample_rate_hertz, 8000, 48000)) : undefined;

        // Parse effectsProfileId (can be array in JSON or split by comma)
        let effectsProfileId: string[] = [];
        if (fields.effects_profile_id) {
          effectsProfileId = fields.effects_profile_id.split(",").map(s => s.trim()).filter(Boolean);
        }

        // Humanizer LLM settings
        const llmTemperature = parseNum(fields.llm_temperature, defaults.llm_temperature, 0, 1.5);
        const llmMaxTokens = Math.floor(parseNum(fields.llm_max_tokens, defaults.llm_max_tokens, 80, 2000));
        const llmModel = fields.llm_model?.trim() || cust?.openai_model?.trim() || null;
        const humanizerSystemPrompt = fields.humanizer_system_prompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT;
        const styleSettings = parseHumanizerStyleFields(fields);

        let sourceText = "";
        let sttLanguageCode: string | null = null;
        let sttMs = 0;

        if (mode === "speech") {
          if (!fileBuffer || fileBuffer.length === 0) {
            return reply.status(400).send({ error: "Speech mode requires audio file." });
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
            languageHintBcp47: fields.target_language_code || languageCode,
            sttMode,
          });
          sttMs = Date.now() - tStt0;
          if (stt.status !== 200) {
            return reply.status(stt.status === 503 ? 503 : 502).send({
              error: stt.status === 503 ? "STT provider is not configured" : "STT failed",
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
        let humanizerResult = null;

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
              maxTokens: llmMaxTokens,
              trace,
            });
            transcriptText = humanizerResult.humanized_text;
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Humanizer LLM failed";
            request.log.error({ err }, "Google TTS simulator humanizer failed");
            return reply.status(502).send({ error: msg });
          }
          humanizerMs = Date.now() - tHum0;
        }

        if (!transcriptText.trim()) {
          return reply.status(500).send({ error: "Empty transcript for TTS" });
        }

        // If SSML mode is true, wrap in <speak> if not already wrapped
        let synthesisText = transcriptText;
        let synthesisSsml: string | undefined = undefined;
        
        if (ssmlMode) {
          synthesisSsml = transcriptText.trim().startsWith("<speak>") 
            ? transcriptText 
            : `<speak>${transcriptText}</speak>`;
        } else {
          synthesisText = transcriptText;
        }

        const tTts0 = Date.now();
        let ttsResult;
        let newAccessToken: string | null = null;

        try {
          try {
            ttsResult = await googleTextToSpeech({
              accessToken,
              synthesis: {
                text: synthesisText,
                ssml: synthesisSsml,
                voiceName,
                languageCode,
                speakingRate,
                pitch,
                volumeGainDb,
                audioEncoding,
                sampleRateHertz,
                effectsProfileId
              }
            });
          } catch (err: any) {
            // Attempt auto refresh if 401 Unauthorized
            if (err.message?.includes("401") && refreshToken && clientId && clientSecret) {
              request.log.info("Google access token expired during synthesis. Attempting auto refresh...");
              const refreshResult = await refreshGoogleAccessToken({
                clientId,
                clientSecret,
                refreshToken
              });
              accessToken = refreshResult.access_token;
              newAccessToken = refreshResult.access_token;
              
              // Retry synthesis
              ttsResult = await googleTextToSpeech({
                accessToken,
                synthesis: {
                  text: synthesisText,
                  ssml: synthesisSsml,
                  voiceName,
                  languageCode,
                  speakingRate,
                  pitch,
                  volumeGainDb,
                  audioEncoding,
                  sampleRateHertz,
                  effectsProfileId
                }
              });
            } else {
              throw err;
            }
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Google Cloud TTS synthesis failed";
          request.log.error({ err }, "Google simulator synthesis failed");
          return reply.status(502).send({ error: msg });
        }
        
        const ttsMs = Date.now() - tTts0;

        const llmUsage = humanizerResult?.llm;
        const humanizerCost = llmUsage?.costUsd ?? 0;
        const ttsCost = estimateGoogleTtsCostUsd(voiceName, ttsResult.charCount);
        const totalCost = humanizerCost + ttsCost;

        const outputMimeType = getMimeTypeForEncoding(audioEncoding);

        return reply.send({
          mode,
          customer_id: customerId,
          source_text: sourceText,
          transcript_sent: ssmlMode ? (synthesisSsml ?? "") : synthesisText,
          skip_humanizer: skipHumanizer,
          stt_language_code: sttLanguageCode,
          new_access_token: newAccessToken,
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
          google: {
            voice_name: voiceName,
            language_code: languageCode,
            speaking_rate: speakingRate,
            pitch,
            volume_gain_db: volumeGainDb,
            audio_encoding: audioEncoding,
            sample_rate_hertz: sampleRateHertz,
            effects_profile_id: effectsProfileId,
            ssml_mode: ssmlMode
          },
          api_usage: {
            humanizer_cost_usd: humanizerCost,
            tts_characters: ttsResult.charCount,
            tts_cost_usd_estimated: ttsCost,
            total_cost_usd_estimated: totalCost,
            humanizer_tokens: llmUsage?.totalTokens ?? 0,
          },
          audio: {
            content_type: outputMimeType,
            base64: ttsResult.audioContentBase64,
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
