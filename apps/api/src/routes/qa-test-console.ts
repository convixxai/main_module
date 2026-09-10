// ============================================================
// QA test console - a single page where anyone with a customer_id and
// x-api-key can exercise the SAME conversational pipeline used in production
// (runAskPipeline, shared with /ask, /ask/voice and the Vodafone voicebot's
// processUtterance in vodafone-voicebot.ts), in one of three modes:
// - chat: text in, text out.
// - audio: mic in (STT), speech out (Cartesia TTS).
// - chat_voice: text in, speech out (Cartesia TTS) - no STT step, useful for
//   testing/comparing TTS voices and models without needing a working mic.
// Per-turn, per-stage timings are surfaced live in all three.
//
// Streaming here means two things, both wired to real production code paths:
// - The RAG pipeline's own trace hook (the same RagTraceFn shape ask.ts and
//   vodafone-voicebot.ts already pass into runAskPipeline) is tapped and
//   forwarded to the browser over Server-Sent Events as each pipeline stage
//   completes, so the client sees live progress rather than a single blob
//   at the end.
// - In audio/chat_voice modes, once the full answer text is ready, it is
//   split into speakable chunks and each chunk's Cartesia TTS synthesis is
//   streamed to the client as an SSE event the moment it is ready, so
//   playback of chunk 1 can start while later chunks are still synthesizing.
//
// STT reuses runSimulatorStt (the exact function vodafone-voicebot.ts calls
// for each utterance), so provider selection matches the tenant's real
// settings. TTS in audio/chat_voice modes intentionally always uses Cartesia
// with a voice and model the user picks on the page, since that is this
// console's stated purpose (comparing/testing Cartesia voices and models)
// rather than replaying the tenant's configured TTS provider.
// ============================================================

import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { pool } from "../config/db";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { createRagTrace, type RagTraceFn } from "../services/rag-trace";
import {
  CARTESIA_MODELS,
  cartesiaConfigured,
  cartesiaTextToSpeech,
  resolveCartesiaModel,
} from "../services/cartesia";
import { getCustomerSettings } from "../services/customer-settings";
import { SentenceStreamBuffer, looksLikeRawRagMarker } from "../services/voice-reply-stream";
import { VOICE_SPOKEN_REPLY_STYLE_RULE } from "../services/rag-prompt-utils";
import { runSimulatorStt } from "./voice-simulator";
import { runAskPipeline } from "./ask";
import { QA_TEST_CONSOLE_PAGE_HTML } from "./qa-test-console-page";

/**
 * Caps concurrent Cartesia TTS calls (accounts can hit low concurrency
 * limits) while still letting every chunk start synthesizing without
 * waiting for the previous chunk's full playback.
 */
class ConcurrencyLimiter {
  private inFlight = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.inFlight >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.inFlight++;
    try {
      return await fn();
    } finally {
      this.inFlight--;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}

const CARTESIA_TTS_CONCURRENCY_LIMIT = 2;
const MIN_CHUNK_CHARS = 20;

/** Splits a complete answer into speakable chunks for concurrent, in-order TTS streaming. */
function splitIntoSpeechChunks(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const sentences = trimmed.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [trimmed];
  const chunks: string[] = [];
  let buf = "";
  for (const s of sentences) {
    buf += s;
    if (buf.trim().length >= MIN_CHUNK_CHARS) {
      chunks.push(buf.trim());
      buf = "";
    }
  }
  if (buf.trim()) chunks.push(buf.trim());
  return chunks.length ? chunks : [trimmed];
}

/** Keeps SSE trace payloads small - drops/truncates long strings, arrays and nested objects. */
function sanitizeTraceData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else if (typeof v === "string") {
      out[k] = v.length > 200 ? `${v.slice(0, 200)}...` : v;
    } else if (Array.isArray(v)) {
      out[k] = `[${v.length} item(s)]`;
    }
    // objects are skipped entirely - only primitives are worth showing live
  }
  return out;
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

export async function qaTestConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/qa/test-console", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(QA_TEST_CONSOLE_PAGE_HTML);
  });

  app.get(
    "/qa/test-console/verify",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const q = request.query as { customer_id?: string };
      const scope = assertCustomerScope(request, q.customer_id);
      if (typeof scope !== "string") {
        return reply.status(scope.status).send({ error: scope.error });
      }
      const customerId = scope;
      const row = await pool.query(
        `SELECT name FROM customers WHERE id = $1`,
        [customerId]
      );
      if (row.rows.length === 0) {
        return reply.status(404).send({ error: "Customer not found" });
      }
      return reply.send({
        customer_id: customerId,
        customer_name: row.rows[0].name,
        cartesia_configured: cartesiaConfigured(),
        cartesia_models: CARTESIA_MODELS,
      });
    }
  );

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/qa/test-console/turn",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        const t0 = Date.now();
        let fileBuffer: Buffer | null = null;
        let filename = "speech.wav";
        let mimeType = "audio/wav";
        const fields: Record<string, string> = {};

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
          const msg = err instanceof Error ? err.message : "Invalid multipart body";
          return reply.status(400).send({ error: msg });
        }

        const scope = assertCustomerScope(request, fields.customer_id);
        if (typeof scope !== "string") {
          return reply.status(scope.status).send({ error: scope.error });
        }
        const customerId = scope;
        const customerPrompt = request.customerPrompt!;
        const mode: "chat" | "audio" | "chat_voice" =
          fields.mode === "audio" ? "audio" : fields.mode === "chat_voice" ? "chat_voice" : "chat";
        /** Both audio (mic in, speech out) and chat_voice (text in, speech out) speak the answer back. */
        const wantsAudioOut = mode === "audio" || mode === "chat_voice";

        const sessionId = fields.session_id?.trim() || null;
        const agentId = fields.agent_id?.trim() || null;

        // ---------- SSE response starts here ----------
        reply.raw.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const send = (event: string, data: unknown) => {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        let question = "";
        let sttMs = 0;
        let sttLanguageCode: string | null = null;

        if (mode === "audio") {
          if (!fileBuffer || fileBuffer.length === 0) {
            send("error", { error: "Multipart field `file` with recorded audio is required for audio mode." });
            reply.raw.end();
            return;
          }
          const tStt0 = Date.now();
          let stt;
          try {
            stt = await runSimulatorStt({
              fileBuffer,
              filename,
              mimeType,
              customerId,
              languageHintBcp47: fields.language_code?.trim() || undefined,
            });
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Speech-to-text failed";
            send("error", { error: msg });
            reply.raw.end();
            return;
          }
          sttMs = Date.now() - tStt0;
          if (stt.status !== 200 || !stt.transcript.trim()) {
            send("error", {
              error: stt.status === 503 ? "STT provider is not configured for this tenant" : "Speech-to-text failed or empty",
              stt_ms: sttMs,
            });
            reply.raw.end();
            return;
          }
          question = stt.transcript.trim();
          sttLanguageCode = stt.language_code;
          send("stt_done", { transcript: question, stt_ms: sttMs, language_code: sttLanguageCode });
        } else {
          question = (fields.question ?? "").trim();
          if (!question) {
            send("error", { error: "Field `question` is required for chat and chat-to-voice mode." });
            reply.raw.end();
            return;
          }
          send("question_received", { question });
        }

        const stageStart = Date.now();
        const baseTrace = createRagTrace(request.log);
        const trace: RagTraceFn = (step, data) => {
          baseTrace?.(step, data);
          send("stage", { step, elapsed_ms: Date.now() - stageStart, ...sanitizeTraceData(data) });
        };

        const voiceId = fields.cartesia_voice_id?.trim();
        const modelId = resolveCartesiaModel(fields.cartesia_model_id);
        const language = fields.cartesia_language?.trim() || "en";
        // e.g. "en-IN" to make a Hindi/Marathi voice read digits the English way, or "off" -
        // see docs.cartesia.ai/build-with-cartesia/capability-guides/advanced-capabilities.
        // Requires sonic-3.6+. Empty/unset = Cartesia's own "auto" default, unchanged behavior.
        const normalization = fields.cartesia_normalization?.trim() || undefined;

        // Same DB-backed kill switch the Vodafone voicebot route reads
        // (customer_settings.rag_streaming_enabled) - flipping it off for a
        // tenant reverts this console's turns to the exact original
        // wait-for-full-answer-then-synthesize behavior immediately.
        const custSettings = wantsAudioOut ? await getCustomerSettings(customerId) : null;
        const streamingEnabled =
          wantsAudioOut &&
          custSettings?.rag_streaming_enabled === true &&
          cartesiaConfigured() &&
          !!voiceId;

        const limiter = new ConcurrencyLimiter(CARTESIA_TTS_CONCURRENCY_LIMIT);
        const tTts0 = Date.now();
        let firstAudioAt: number | null = null;
        let chunkIndex = 0;

        /** Emits one already-synthesized chunk's SSE events. Callers decide dispatch/ordering. */
        function emitAudioChunk(text: string, result: Awaited<ReturnType<typeof cartesiaTextToSpeech>>): void {
          if (firstAudioAt === null) {
            firstAudioAt = Date.now();
            send("first_audio", { first_audio_ms: firstAudioAt - tTts0 });
          }
          send("audio_chunk", {
            index: chunkIndex++,
            text,
            base64: result.body.toString("base64"),
            content_type: result.contentType,
            bytes: result.usage.audio_bytes,
          });
        }

        /** Streaming path: sentences arrive one at a time from the LLM, so synthesize+emit strictly in order. */
        async function speakChunk(text: string): Promise<void> {
          if (!voiceId) return;
          // Raw RAG sentinel token (ANSWER_NOT_FOUND/OUT_OF_SCOPE) - never speak it
          // verbatim; the "nothing spoken yet" fallback below uses the pipeline's
          // final, already-swapped `answer` instead.
          if (looksLikeRawRagMarker(text)) return;
          try {
            const result = await limiter.run(() =>
              cartesiaTextToSpeech({
                transcript: text,
                modelId,
                voiceId,
                language,
                normalization,
                outputFormat: { container: "mp3", sample_rate: 44100 },
              })
            );
            emitAudioChunk(text, result);
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Cartesia TTS failed";
            send("tts_error", { error: msg });
          }
        }

        /**
         * Non-streaming path: the full answer is already known, so fire all chunks'
         * synthesis concurrently (up to CARTESIA_TTS_CONCURRENCY_LIMIT at once) for
         * lower total TTS wall-clock time, but still emit their SSE events in the
         * original left-to-right order regardless of which finishes first.
         */
        async function speakChunksConcurrently(chunks: string[]): Promise<void> {
          if (!voiceId) return;
          const jobs = chunks.map((text) => {
            const p = limiter
              .run(() =>
                cartesiaTextToSpeech({
                  transcript: text,
                  modelId,
                  voiceId,
                  language,
                  normalization,
                  outputFormat: { container: "mp3", sample_rate: 44100 },
                })
              )
              .then((result) => ({ text, result }));
            p.catch(() => {});
            return p;
          });
          try {
            for (const job of jobs) {
              const { text, result } = await job;
              emitAudioChunk(text, result);
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : "Cartesia TTS failed";
            send("tts_error", { error: msg });
          }
        }

        const tAsk0 = Date.now();
        // Sentences are spoken as the LLM streams them (in order - see
        // SentenceStreamBuffer) rather than waiting for the full answer, when
        // streaming is enabled. Not used at all when it's off.
        const sentences = new SentenceStreamBuffer((sentence) => speakChunk(sentence));

        let askResult;
        try {
          askResult = await runAskPipeline({
            customerId,
            customerPrompt,
            question,
            inputSessionId: sessionId,
            inputAgentId: agentId,
            includeTimings: true,
            // This console always answers straight from OpenAI, skipping the
            // self-hosted LLM path entirely, regardless of the tenant's own
            // customer_settings.rag_use_openai_only value.
            ragOpenaiOnly: true,
            embeddingLanguageHint: sttLanguageCode,
            trace,
            // Only for audio/chat_voice - plain chat mode tests the text-only
            // path (mirrors production /ask), which should not get spoken-style
            // wording. See services/rag-prompt-utils.ts for why this matters.
            ...(wantsAudioOut ? { additionalSystemPrompt: VOICE_SPOKEN_REPLY_STYLE_RULE } : {}),
            ...(streamingEnabled ? { onLlmTextDelta: (delta: string) => sentences.push(delta) } : {}),
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "RAG pipeline failed";
          request.log.error({ err }, "qa-test-console: RAG pipeline failed");
          send("error", { error: msg, stt_ms: sttMs, total_ms: Date.now() - t0 });
          reply.raw.end();
          return;
        }
        const askMs = Date.now() - tAsk0;
        const answer = askResult.answer.trim();

        send("answer_ready", {
          answer,
          ask_ms: askMs,
          source: askResult.source,
          session_id: askResult.session_id,
          agent_id: askResult.agent_id,
          agent_name: askResult.agent_name,
          pipeline_timings: askResult.pipeline_timings ?? null,
          streaming_used: streamingEnabled,
        });

        if (streamingEnabled) {
          await sentences.flush();
        }

        if (wantsAudioOut && answer) {
          if (!cartesiaConfigured()) {
            send("tts_error", { error: "CARTESIA_API_KEY is not configured on this server" });
          } else if (!voiceId) {
            send("tts_error", { error: "No Cartesia voice selected" });
          } else if (!streamingEnabled) {
            // Original batch path: split the complete answer into chunks up front,
            // synthesize them concurrently, unchanged from before streaming existed.
            await speakChunksConcurrently(splitIntoSpeechChunks(answer));
          } else if (chunkIndex === 0) {
            // Covers two cases: the no_kb/kb_direct/out_of_scope-distance-gate
            // branches never call the LLM, and the raw-marker guard in speakChunk
            // can suppress the only sentence that was streamed. Either way, nothing
            // has actually produced audio yet - speak the resolved (already-swapped)
            // answer directly.
            await speakChunk(answer);
          }
        }
        const ttsMs = chunkIndex > 0 ? Date.now() - tTts0 : 0;

        send("done", {
          total_ms: Date.now() - t0,
          stt_ms: sttMs,
          ask_ms: askMs,
          tts_ms: ttsMs,
          pipeline_timings: askResult.pipeline_timings ?? null,
          session_id: askResult.session_id,
          agent_id: askResult.agent_id,
          agent_name: askResult.agent_name,
          source: askResult.source,
          streaming_used: streamingEnabled,
        });
        reply.raw.end();
      }
    );
  });
}
