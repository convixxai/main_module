// ============================================================
// Temporary Cartesia voice test console — browser mic in, Cartesia TTS
// audio out, running the SAME RAG/LLM pipeline as the real voice product
// (runAskPipeline, shared with /ask and the live voicebot), just over plain
// HTTP instead of a telephony WebSocket. Built to let latency be measured
// stage-by-stage (STT / RAG-LLM / TTS) without needing a real phone call.
//
// Not part of the live call pipeline — reuses runSimulatorStt/runAskPipeline
// exactly as apps/api/src/routes/voice-simulator.ts does, and adds a
// Cartesia TTS leg with the voice_id resolved from the DB (agent's
// cartesia_avatar_id -> cartesia_avatars.voice_id), per instruction.
//
// Backed by a temporary customer created by
// apps/api/scripts/create-temp-voice-test-customer.ts (marker name
// __TEMP_CARTESIA_VOICE_TEST_CONSOLE__). This whole file is meant to be
// deleted, along with that temp customer, once testing is done.
// ============================================================

import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import fs from "fs";
import path from "path";
import { pool } from "../config/db";
import { getCustomerSettings } from "../services/customer-settings";
import { createRagTrace } from "../services/rag-trace";
import { cartesiaConfigured, cartesiaTextToSpeech } from "../services/cartesia";
import { generateEmbedding, streamChatOpenAI } from "../services/llm";
import { runSimulatorStt } from "./voice-simulator";
import { runAskPipeline } from "./ask";
import { VOICE_CARTESIA_TEST_CONSOLE_PAGE_HTML } from "./voice-cartesia-test-console-page";

interface KbMatch {
  question: string;
  answer: string;
  distance: number;
}

/**
 * Minimal KB retrieval for the streaming endpoint — same query shape as
 * ask.ts's (unexported) vectorSearchWithDistance, reimplemented here rather
 * than duplicated-and-exported since this is throwaway diagnostic tooling.
 * Deliberately simpler than ask.ts's full multi-tier prompt/fallback logic
 * (direct-match / related-answers / out-of-scope tiers) — this is a
 * single-tier "top-K KB context in the system prompt" RAG, good enough for
 * measuring streaming latency, not a replacement for ask.ts's accuracy tuning.
 */
async function retrieveKbContext(customerId: string, question: string, limit = 3): Promise<KbMatch[]> {
  const embedding = await generateEmbedding(question);
  const embeddingStr = `[${embedding.join(",")}]`;
  const result = await pool.query(
    `SELECT question, answer, (embedding <=> $2) AS distance
       FROM kb_entries
      WHERE customer_id = $1
      ORDER BY embedding <=> $2
      LIMIT $3`,
    [customerId, embeddingStr, limit]
  );
  return result.rows as KbMatch[];
}

/**
 * Caps concurrent async operations. Added after real testing surfaced a
 * genuine bug: firing every sentence chunk's Cartesia TTS call at once hit
 * this Cartesia account's real concurrency limit (429 "Too many concurrent
 * requests... Current limit: 2"), and because the rejected promise had no
 * handler attached before the flush loop reached it, Node's default
 * unhandled-rejection behavior (throw, since Node 15) crashed the whole
 * server process. This fixes both: bounds concurrency to stay under
 * Cartesia's limit, and every queued promise gets a no-op .catch() the
 * instant it's created so a rejection is never "unhandled" even before
 * it's actually awaited.
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

// Cartesia's own error message reported this account's limit as 2 — stay under it.
const CARTESIA_TTS_CONCURRENCY_LIMIT = 2;

const MIN_CHUNK_CHARS = 20;
const MAX_CHUNK_CHARS = 200;

/**
 * Pulls the next speakable chunk (sentence, or a forced word-boundary cut if
 * the buffer grows too long) off the front of `buffer`. Returns null when
 * there's nothing speakable yet (still accumulating) unless `isFinal`, in
 * which case whatever remains is flushed as the last chunk.
 */
function extractNextChunk(buffer: string, isFinal: boolean): { chunk: string | null; rest: string } {
  if (buffer.length >= MAX_CHUNK_CHARS) {
    let cut = buffer.lastIndexOf(" ", MAX_CHUNK_CHARS);
    if (cut < MIN_CHUNK_CHARS) cut = MAX_CHUNK_CHARS;
    return { chunk: buffer.slice(0, cut).trim(), rest: buffer.slice(cut) };
  }
  if (buffer.length >= MIN_CHUNK_CHARS) {
    const m = /[.!?](\s|$)/.exec(buffer);
    if (m) {
      const endIdx = m.index + 1;
      return { chunk: buffer.slice(0, endIdx).trim(), rest: buffer.slice(endIdx) };
    }
  }
  if (isFinal && buffer.trim()) {
    return { chunk: buffer.trim(), rest: "" };
  }
  return { chunk: null, rest: buffer };
}

const MARKER_NAME = "__TEMP_CARTESIA_VOICE_TEST_CONSOLE__";

async function resolveTempCustomer(): Promise<{
  customerId: string;
  apiKey: string;
  agentId: string;
  systemPrompt: string;
} | null> {
  const row = await pool.query(
    `SELECT c.id AS customer_id, c.system_prompt, ak.key AS api_key, a.id AS agent_id
       FROM customers c
       JOIN api_keys ak ON ak.customer_id = c.id AND ak.is_active = TRUE
       JOIN agents a ON a.customer_id = c.id AND a.is_active = TRUE
      WHERE c.name = $1
      LIMIT 1`,
    [MARKER_NAME]
  );
  if (row.rows.length === 0) return null;
  const r = row.rows[0];
  return {
    customerId: r.customer_id as string,
    apiKey: r.api_key as string,
    agentId: r.agent_id as string,
    systemPrompt: r.system_prompt as string,
  };
}

/** Resolve the Cartesia voice_id to speak with: agent's cartesia_avatar_id -> cartesia_avatars.voice_id. */
async function resolveCartesiaVoice(
  agentId: string
): Promise<{ voiceId: string; modelId: string } | null> {
  const row = await pool.query(
    `SELECT ca.voice_id, ca.model_id
       FROM agents a
       JOIN cartesia_avatars ca ON ca.id = a.cartesia_avatar_id
      WHERE a.id = $1`,
    [agentId]
  );
  if (row.rows.length === 0) return null;
  return { voiceId: row.rows[0].voice_id as string, modelId: row.rows[0].model_id as string };
}

export async function voiceCartesiaTestConsoleRoutes(app: FastifyInstance): Promise<void> {
  app.get("/voice/cartesia-test-console", async (_request, reply) => {
    return reply.type("text/html; charset=utf-8").send(VOICE_CARTESIA_TEST_CONSOLE_PAGE_HTML);
  });

  app.get("/voice/cartesia-test-console/config", async (_request, reply) => {
    const temp = await resolveTempCustomer();
    if (!temp) {
      return reply.status(404).send({
        error:
          "Temp test customer not found. Run: npx ts-node scripts/create-temp-voice-test-customer.ts (from apps/api)",
      });
    }
    const voice = await resolveCartesiaVoice(temp.agentId);
    return reply.send({
      cartesia_configured: cartesiaConfigured(),
      customer_id: temp.customerId,
      agent_id: temp.agentId,
      api_key: temp.apiKey,
      voice_id: voice?.voiceId ?? null,
      model_id: voice?.modelId ?? null,
    });
  });

  // DEBUG-ONLY: serves pre-recorded sample WAVs from the local scratch dir so
  // this console can be exercised end-to-end from an actual browser tab
  // without a physical microphone (used for automated testing of this temp
  // page only — not referenced by the page's own recording UI).
  const SAMPLE_AUDIO_DIR =
    "C:/Users/dhira/AppData/Local/Temp/claude/D--Sandesh-Private-Convixx-nodejs-main/1b3dcb8d-c42b-4fce-9961-cc62efa9fc9e/scratchpad";
  app.get("/voice/cartesia-test-console/sample-audio/:name", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    if (!/^[a-zA-Z0-9_-]+\.wav$/.test(name)) {
      return reply.status(400).send({ error: "invalid filename" });
    }
    const filePath = path.join(SAMPLE_AUDIO_DIR, name);
    if (!fs.existsSync(filePath)) {
      return reply.status(404).send({ error: "not found" });
    }
    return reply.type("audio/wav").send(fs.readFileSync(filePath));
  });

  await app.register(async (scoped) => {
    await scoped.register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });

    scoped.post("/voice/cartesia-test-console/turn", async (request, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({ error: "CARTESIA_API_KEY is not configured on this server" });
      }

      const temp = await resolveTempCustomer();
      if (!temp) {
        return reply.status(404).send({ error: "Temp test customer not found — run the seed script first." });
      }

      const t0 = Date.now();
      let fileBuffer: Buffer | null = null;
      let filename = "speech.wav";
      let mimeType = "audio/wav";

      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            fileBuffer = await part.toBuffer();
            filename = part.filename || filename;
            mimeType = part.mimetype || mimeType;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Invalid multipart body";
        return reply.status(400).send({ error: msg });
      }

      if (!fileBuffer || fileBuffer.length === 0) {
        return reply.status(400).send({ error: "Multipart field `file` with recorded audio is required." });
      }

      const voice = await resolveCartesiaVoice(temp.agentId);
      if (!voice) {
        return reply.status(500).send({ error: "Temp agent has no cartesia_avatar_id configured." });
      }

      // ---------- Stage 1: STT (same provider-selection logic the live voicebot uses) ----------
      const tStt0 = Date.now();
      const stt = await runSimulatorStt({
        fileBuffer,
        filename,
        mimeType,
        customerId: temp.customerId,
      });
      const sttMs = Date.now() - tStt0;
      if (stt.status !== 200) {
        return reply.status(stt.status === 503 ? 503 : 502).send({
          error: stt.status === 503 ? "STT provider is not configured" : "Speech-to-text failed",
          timings: { stt_ms: sttMs, total_ms: Date.now() - t0 },
        });
      }
      const transcript = stt.transcript.trim();
      if (!transcript) {
        return reply.status(400).send({
          error: "Empty transcript from speech-to-text — speak more clearly or closer to the mic.",
          timings: { stt_ms: sttMs, total_ms: Date.now() - t0 },
        });
      }

      // ---------- Stage 2: RAG/LLM — the SAME pipeline function used by /ask and the live voicebot ----------
      const trace = createRagTrace(request.log);
      const tAsk0 = Date.now();
      let askResult;
      try {
        askResult = await runAskPipeline({
          customerId: temp.customerId,
          customerPrompt: temp.systemPrompt,
          question: transcript,
          inputSessionId: null,
          inputAgentId: temp.agentId,
          includeTimings: true,
          sequentialLlm: true,
          embeddingLanguageHint: stt.language_code,
          trace,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "RAG pipeline failed";
        request.log.error({ err }, "voice-cartesia-test-console: RAG failed");
        return reply.status(500).send({ error: msg, timings: { stt_ms: sttMs, total_ms: Date.now() - t0 } });
      }
      const askMs = Date.now() - tAsk0;
      const answer = askResult.answer.trim();
      if (!answer) {
        return reply.status(500).send({
          error: "Empty answer from RAG pipeline",
          timings: { stt_ms: sttMs, ask_ms: askMs, total_ms: Date.now() - t0 },
        });
      }

      // ---------- Stage 3: Cartesia TTS ----------
      const cust = await getCustomerSettings(temp.customerId);
      const tTts0 = Date.now();
      let ttsResult;
      try {
        ttsResult = await cartesiaTextToSpeech({
          transcript: answer,
          modelId: voice.modelId,
          voiceId: voice.voiceId,
          language: "en",
          outputFormat: { container: "mp3", sample_rate: 44100 },
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Cartesia TTS failed";
        request.log.error({ err }, "voice-cartesia-test-console: TTS failed");
        return reply.status(502).send({
          error: msg,
          timings: { stt_ms: sttMs, ask_ms: askMs, total_ms: Date.now() - t0 },
        });
      }
      const ttsWallMs = Date.now() - tTts0;

      return reply.send({
        customer_id: temp.customerId,
        transcript,
        stt_language_code: stt.language_code,
        answer,
        source: askResult.source,
        agent_id: askResult.agent_id,
        agent_name: askResult.agent_name,
        rag_streaming_enabled: cust?.rag_streaming_enabled ?? null,
        cartesia: { voice_id: voice.voiceId, model_id: voice.modelId },
        audio: {
          content_type: ttsResult.contentType,
          bytes: ttsResult.usage.audio_bytes,
          base64: ttsResult.body.toString("base64"),
        },
        timings: {
          stt_ms: sttMs,
          ask_ms: askMs,
          rag_pipeline_timings: askResult.pipeline_timings ?? null,
          tts_ms: ttsResult.timings.tts_ms,
          tts_ttfb_ms: ttsResult.timings.ttfb_ms,
          tts_wall_ms: ttsWallMs,
          total_ms: Date.now() - t0,
        },
      });
    });

    // ============================================================
    // STREAMING variant — the page uses ONLY this endpoint.
    // STT is still one-shot (the whole utterance is already recorded before
    // upload — there's no partial audio to stream STT from in this
    // browser-record-then-upload design). RAG and TTS are real streaming:
    // - RAG: streamChatOpenAI() delivers token deltas as OpenAI generates them.
    // - TTS: as soon as a sentence-sized chunk of the answer is complete, its
    //   Cartesia synthesis is kicked off immediately (chunks synthesize
    //   concurrently with each other and with the rest of the LLM generation),
    //   and each chunk's audio is pushed to the client as an SSE event the
    //   moment it's ready — the client starts playing chunk 1 while chunk 2+
    //   are still being generated/synthesized.
    // ============================================================
    scoped.post("/voice/cartesia-test-console/turn-stream", async (request, reply) => {
      if (!cartesiaConfigured()) {
        return reply.status(503).send({ error: "CARTESIA_API_KEY is not configured on this server" });
      }
      const temp = await resolveTempCustomer();
      if (!temp) {
        return reply.status(404).send({ error: "Temp test customer not found — run the seed script first." });
      }
      const voice = await resolveCartesiaVoice(temp.agentId);
      if (!voice) {
        return reply.status(500).send({ error: "Temp agent has no cartesia_avatar_id configured." });
      }

      const t0 = Date.now();
      let fileBuffer: Buffer | null = null;
      let filename = "speech.wav";
      let mimeType = "audio/wav";
      try {
        for await (const part of request.parts()) {
          if (part.type === "file") {
            fileBuffer = await part.toBuffer();
            filename = part.filename || filename;
            mimeType = part.mimetype || mimeType;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Invalid multipart body";
        return reply.status(400).send({ error: msg });
      }
      if (!fileBuffer || fileBuffer.length === 0) {
        return reply.status(400).send({ error: "Multipart field `file` with recorded audio is required." });
      }

      // ---------- Stage 1: STT (still one-shot — see file header) ----------
      const tStt0 = Date.now();
      const stt = await runSimulatorStt({ fileBuffer, filename, mimeType, customerId: temp.customerId });
      const sttMs = Date.now() - tStt0;
      if (stt.status !== 200 || !stt.transcript.trim()) {
        return reply.status(stt.status === 503 ? 503 : 400).send({
          error: stt.status === 503 ? "STT provider is not configured" : "Speech-to-text failed or empty",
        });
      }
      const transcript = stt.transcript.trim();

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
      send("transcript", { transcript, stt_ms: sttMs, stt_language_code: stt.language_code });

      try {
        // ---------- Stage 2: KB retrieval (batch — fast, not the latency target here) ----------
        const tRetrieve0 = Date.now();
        const matches = await retrieveKbContext(temp.customerId, transcript, 3);
        const retrieveMs = Date.now() - tRetrieve0;
        const kbContext = matches.length
          ? matches.map((m, i) => `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}`).join("\n\n")
          : "(no relevant knowledge base entries found)";
        send("retrieval_done", { retrieve_ms: retrieveMs, top_distance: matches[0]?.distance ?? null });

        const cust = await getCustomerSettings(temp.customerId);
        const messages: { role: "system" | "user"; content: string }[] = [
          {
            role: "system",
            content: `${temp.systemPrompt}\n\nAnswer the caller's question using ONLY the knowledge base entries below. Be brief (1-2 sentences), speak naturally. If none are relevant, say you don't have that information.\n\n${kbContext}`,
          },
          { role: "user", content: transcript },
        ];

        // ---------- Stage 3: streaming RAG/LLM + concurrent, in-order streaming TTS ----------
        let sentenceBuffer = "";
        let fullAnswer = "";
        let chunkIndex = 0;
        let firstTokenAt: number | null = null;
        let firstAudioChunkAt: number | null = null;
        const ttsQueue: Promise<{ index: number; text: string; base64: string; contentType: string; bytes: number; synthMs: number }>[] = [];
        const ttsLimiter = new ConcurrencyLimiter(CARTESIA_TTS_CONCURRENCY_LIMIT);

        function enqueueChunk(text: string): void {
          const idx = chunkIndex++;
          const tChunk0 = Date.now();
          const p = ttsLimiter
            .run(() =>
              cartesiaTextToSpeech({
                transcript: text,
                modelId: voice!.modelId,
                voiceId: voice!.voiceId,
                language: "en",
                outputFormat: { container: "mp3", sample_rate: 44100 },
              })
            )
            .then((r) => ({
              index: idx,
              text,
              base64: r.body.toString("base64"),
              contentType: r.contentType,
              bytes: r.usage.audio_bytes,
              synthMs: Date.now() - tChunk0,
            }));
          // Prevent a rejection from being reported as "unhandled" (and, with
          // Node's default --unhandled-rejections=throw, crashing the whole
          // process) before the in-order flush loop below gets around to
          // awaiting it. The real rejection still surfaces there.
          p.catch(() => {});
          ttsQueue.push(p);
        }

        const tAsk0 = Date.now();
        await streamChatOpenAI(
          messages,
          cust?.llm_max_tokens ?? 300,
          (delta) => {
            if (firstTokenAt === null) {
              firstTokenAt = Date.now();
              send("first_token", { first_token_ms: firstTokenAt - tAsk0 });
            }
            fullAnswer += delta;
            sentenceBuffer += delta;
            send("text_delta", { delta });
            let extracted = extractNextChunk(sentenceBuffer, false);
            while (extracted.chunk) {
              enqueueChunk(extracted.chunk);
              sentenceBuffer = extracted.rest;
              extracted = extractNextChunk(sentenceBuffer, false);
            }
          },
          createRagTrace(request.log)
        );
        const askMs = Date.now() - tAsk0;

        const flushed = extractNextChunk(sentenceBuffer, true);
        if (flushed.chunk) enqueueChunk(flushed.chunk);

        send("answer_complete", { answer: fullAnswer.trim(), ask_ms: askMs, chunk_count: chunkIndex });

        // Flush queued TTS chunks to the client IN ORDER — chunks synthesize
        // concurrently above, but this preserves playback order.
        for (const p of ttsQueue) {
          const result = await p;
          if (firstAudioChunkAt === null) {
            firstAudioChunkAt = Date.now();
            send("first_audio", { first_audio_ms: firstAudioChunkAt - t0 });
          }
          send("audio_chunk", result);
        }

        send("done", {
          total_ms: Date.now() - t0,
          stt_ms: sttMs,
          retrieve_ms: retrieveMs,
          ask_ms: askMs,
          first_token_ms: firstTokenAt !== null ? firstTokenAt - tAsk0 : null,
          first_audio_ms: firstAudioChunkAt !== null ? firstAudioChunkAt - t0 : null,
          chunk_count: chunkIndex,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Streaming pipeline failed";
        request.log.error({ err }, "voice-cartesia-test-console: streaming turn failed");
        send("error", { error: msg });
      }
      reply.raw.end();
    });
  });
}
