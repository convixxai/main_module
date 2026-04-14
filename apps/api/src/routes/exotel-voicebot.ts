// ============================================================
// Exotel Voicebot WebSocket Route — Multi-tenant
// This is the per-tenant WSS endpoint that Exotel connects to.
//
// Route:    GET /exotel/voicebot/:customerId    (WebSocket upgrade)
// Route:    GET /exotel/voicebot/bootstrap/:customerId  (HTTPS bootstrap)
//
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §14 Phase C+D
// ============================================================

import type { FastifyInstance, FastifyRequest } from "fastify";
import { WebSocket } from "ws";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  parseExotelMessage,
  type ExotelInboundMessage,
  type ExotelStartMessage,
  type ExotelMediaMessage,
  type ExotelOutboundMedia,
  type ExotelOutboundMark,
  type ExotelOutboundClear,
} from "../types/exotel-ws";
import {
  getExotelSettings,
  createCallSession,
  endCallSession,
  linkChatSessionToCall,
  type ExotelSettings,
} from "../services/exotel-settings";
import { voicebotUrlsForCustomer } from "../services/exotel-voice-urls";
import {
  createSession,
  removeSession,
  nextMarkName,
  getActiveSessionCount,
  type VoicebotSession,
} from "../services/voicebot-session";
import {
  decodeBase64Pcm,
  encodeBase64Pcm,
  PcmChunkBuffer,
  resamplePcm16,
} from "../services/pcm-audio";
import {
  sarvamSpeechToText,
  sarvamTextToSpeech,
} from "../services/sarvam";

// ============================================================
// Constants
// ============================================================

/** Silence detection: if no media for this many ms, treat as end of utterance. */
const VAD_SILENCE_TIMEOUT_MS = 1500;

/** Maximum inbound PCM buffer before force-processing (avoid OOM). */
const MAX_INBOUND_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB ≈ ~160s at 16kHz

/** Fallback error audio text when STT/LLM/TTS fails. */
const ERROR_AUDIO_TEXT = "Sorry, I was unable to process that. Please try again.";

/** Greeting text for new calls. */
const GREETING_TEXT = "Hello! How can I help you today?";

// ============================================================
// Helpers
// ============================================================

/**
 * Send a JSON message to Exotel on the WebSocket.
 */
function sendToExotel(ws: WebSocket, message: object): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

/**
 * Send PCM audio back to Exotel as base64 media frames.
 * Respects chunk sizing rules (320-byte multiples, 3.2KB–100KB).
 */
function sendAudioToExotel(
  ws: WebSocket,
  session: VoicebotSession,
  pcmBuffer: Buffer
): void {
  const chunkBuffer = new PcmChunkBuffer();
  const chunks = chunkBuffer.push(pcmBuffer);
  const remaining = chunkBuffer.flush();

  const allChunks = remaining ? [...chunks, remaining] : chunks;

  for (const chunk of allChunks) {
    const media: ExotelOutboundMedia = {
      event: "media",
      stream_sid: session.streamSid,
      media: {
        payload: encodeBase64Pcm(chunk),
      },
    };
    sendToExotel(ws, media);
  }

  // Send a mark after the last chunk so we know when playback completes
  if (allChunks.length > 0) {
    const markName = nextMarkName(session);
    session.pendingMarks.add(markName);
    session.isSpeaking = true;
    const mark: ExotelOutboundMark = {
      event: "mark",
      stream_sid: session.streamSid,
      mark: { name: markName },
    };
    sendToExotel(ws, mark);
  }
}

/**
 * Send a clear message to cancel pending audio (barge-in).
 */
function sendClearToExotel(ws: WebSocket, session: VoicebotSession): void {
  const clear: ExotelOutboundClear = {
    event: "clear",
    stream_sid: session.streamSid,
  };
  sendToExotel(ws, clear);
  session.pendingMarks.clear();
  session.isSpeaking = false;
}

/**
 * Convert text to PCM audio via Sarvam TTS, then send to Exotel.
 * Returns true if audio was successfully sent.
 */
async function speakToExotel(
  ws: WebSocket,
  session: VoicebotSession,
  text: string,
  languageCode: string = "en-IN",
  log?: FastifyRequest["log"]
): Promise<boolean> {
  try {
    // Get TTS audio from Sarvam
    const tts = await sarvamTextToSpeech({
      text: text.slice(0, 2500), // TTS character limit
      target_language_code: languageCode,
      model: "bulbul:v3",
      speech_sample_rate: `${session.mediaFormat.sample_rate}`,
      output_audio_codec: "wav",
    });

    if (tts.status !== 200) {
      log?.error({ status: tts.status, body: tts.body }, "voicebot TTS failed");
      return false;
    }

    const ttsData = tts.body as { audios?: string[] };
    const b64Audio = ttsData.audios?.[0];
    if (!b64Audio) {
      log?.error("voicebot TTS returned no audio");
      return false;
    }

    // Decode the WAV file — skip the 44-byte WAV header to get raw PCM
    const wavBuffer = Buffer.from(b64Audio, "base64");
    let pcmData: Buffer;

    // Check for WAV header (RIFF...WAVE)
    if (
      wavBuffer.length > 44 &&
      wavBuffer.toString("ascii", 0, 4) === "RIFF" &&
      wavBuffer.toString("ascii", 8, 12) === "WAVE"
    ) {
      // Find the 'data' chunk
      let dataOffset = 12;
      while (dataOffset < wavBuffer.length - 8) {
        const chunkId = wavBuffer.toString("ascii", dataOffset, dataOffset + 4);
        const chunkSize = wavBuffer.readUInt32LE(dataOffset + 4);
        if (chunkId === "data") {
          pcmData = wavBuffer.subarray(dataOffset + 8, dataOffset + 8 + chunkSize);
          break;
        }
        dataOffset += 8 + chunkSize;
      }
      pcmData = pcmData! || wavBuffer.subarray(44);
    } else {
      // Assume raw PCM or non-standard format
      pcmData = wavBuffer;
    }

    // Resample if Sarvam's output rate differs from Exotel's negotiated rate
    // (Sarvam default for TTS with wav codec may produce at the requested rate)
    sendAudioToExotel(ws, session, pcmData);
    return true;
  } catch (err) {
    log?.error({ err }, "voicebot speakToExotel failed");
    return false;
  }
}

/**
 * Process accumulated inbound audio: STT → Pipeline → TTS → Send to Exotel.
 * This is the core voice agent pipeline for a single utterance.
 */
async function processUtterance(
  ws: WebSocket,
  session: VoicebotSession,
  log?: FastifyRequest["log"]
): Promise<void> {
  if (session.inboundPcm.length === 0 || session.isClosing) return;

  // Grab all accumulated PCM and reset
  const pcmChunks = session.inboundPcm;
  session.inboundPcm = [];
  session.inboundBytes = 0;

  const combinedPcm = Buffer.concat(pcmChunks);
  if (combinedPcm.length < 1600) {
    // Too short to be meaningful speech (~50ms at 16kHz) — skip
    return;
  }

  log?.info({
    stream_sid: session.streamSid,
    pcm_bytes: combinedPcm.length,
    duration_ms: (combinedPcm.length / 2 / session.mediaFormat.sample_rate) * 1000,
  }, "voicebot processing utterance");

  try {
    // === Step 1: STT ===
    // Create a minimal WAV header for the raw PCM so Sarvam can process it
    const wavBuffer = createWavBuffer(combinedPcm, session.mediaFormat.sample_rate);

    const stt = await sarvamSpeechToText({
      fileBuffer: wavBuffer,
      filename: "utterance.wav",
      mimeType: "audio/wav",
      model: "saaras:v3",
      mode: "transcribe",
    });

    if (stt.status !== 200) {
      log?.error({ status: stt.status, body: stt.body }, "voicebot STT failed");
      await speakToExotel(ws, session, ERROR_AUDIO_TEXT, "en-IN", log);
      return;
    }

    const sttBody = stt.body as { transcript?: string; language_code?: string };
    const transcript = sttBody.transcript?.trim();
    const detectedLanguage = sttBody.language_code || "en-IN";

    if (!transcript) {
      log?.info({ stream_sid: session.streamSid }, "voicebot STT empty transcript");
      return; // Silence or noise — don't respond
    }

    log?.info({
      stream_sid: session.streamSid,
      transcript,
      language: detectedLanguage,
    }, "voicebot STT result");

    // === Step 2: Run RAG/Ask Pipeline ===
    // Reuse the existing ask pipeline via internal function call
    const askResult = await runVoicebotAskPipeline(
      session,
      transcript,
      log
    );

    if (!askResult || !askResult.answer) {
      await speakToExotel(ws, session, ERROR_AUDIO_TEXT, detectedLanguage, log);
      return;
    }

    log?.info({
      stream_sid: session.streamSid,
      answer: askResult.answer.slice(0, 200),
      source: askResult.source,
    }, "voicebot pipeline result");

    // === Step 3: TTS + Send ===
    const ttsLanguage = mapToTtsLanguage(detectedLanguage);
    await speakToExotel(ws, session, askResult.answer, ttsLanguage, log);
  } catch (err) {
    log?.error({ err, stream_sid: session.streamSid }, "voicebot utterance processing error");
    await speakToExotel(ws, session, ERROR_AUDIO_TEXT, "en-IN", log).catch(() => {});
  }
}

/**
 * Create a WAV file buffer from raw 16-bit LE mono PCM.
 */
function createWavBuffer(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 2; // 16-bit mono = 2 bytes/sample
  const dataSize = pcm.length;
  const fileSize = 36 + dataSize;

  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);       // fmt chunk size
  header.writeUInt16LE(1, 20);        // PCM format
  header.writeUInt16LE(1, 22);        // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32);        // block align
  header.writeUInt16LE(16, 34);       // bits per sample
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}

/**
 * Map Sarvam STT language code to a TTS-compatible code.
 */
function mapToTtsLanguage(lang: string): string {
  const supported = [
    "bn-IN", "en-IN", "gu-IN", "hi-IN", "kn-IN",
    "ml-IN", "mr-IN", "od-IN", "pa-IN", "ta-IN", "te-IN",
  ];
  if (supported.includes(lang)) return lang;
  // Fallback: try matching the primary language
  const primary = lang.split("-")[0];
  const match = supported.find((s) => s.startsWith(primary + "-"));
  return match || "en-IN";
}

/**
 * Minimal ask pipeline call for voicebot — reuses the DB-based pipeline
 * (agents, KB, sessions) without going through HTTP.
 */
async function runVoicebotAskPipeline(
  session: VoicebotSession,
  question: string,
  log?: FastifyRequest["log"]
): Promise<{ answer: string; source: string; session_id: string } | null> {
  try {
    // Import the pipeline function lazily to avoid circular deps
    const { generateEmbedding, chatOpenAI } = await import("../services/llm");

    // Get customer system prompt
    const customerResult = await pool.query(
      `SELECT system_prompt, rag_use_openai_only FROM customers WHERE id = $1`,
      [session.customerId]
    );
    if (customerResult.rows.length === 0) return null;

    const customerPrompt = customerResult.rows[0].system_prompt;

    // Get or create chat session for this call
    if (!session.chatSessionId) {
      const sessionResult = await pool.query(
        `INSERT INTO chat_sessions (customer_id) VALUES ($1) RETURNING id`,
        [session.customerId]
      );
      session.chatSessionId = sessionResult.rows[0].id;

      // Link to call session
      if (session.callSessionDbId && session.chatSessionId) {
        await linkChatSessionToCall(session.callSessionDbId, session.chatSessionId);
      }
    }

    // Resolve agent
    let agentPrompt = customerPrompt;
    if (!session.agentId) {
      const agentsResult = await pool.query(
        `SELECT id, name, system_prompt FROM agents
         WHERE customer_id = $1 AND is_active = TRUE
         ORDER BY created_at ASC LIMIT 1`,
        [session.customerId]
      );
      if (agentsResult.rows.length > 0) {
        session.agentId = agentsResult.rows[0].id;
        agentPrompt = agentsResult.rows[0].system_prompt;
        await pool.query(
          `UPDATE chat_sessions SET agent_id = $1 WHERE id = $2`,
          [session.agentId, session.chatSessionId]
        ).catch(() => {});
      }
    } else {
      const agentResult = await pool.query(
        `SELECT system_prompt FROM agents WHERE id = $1`,
        [session.agentId]
      );
      if (agentResult.rows.length > 0) {
        agentPrompt = agentResult.rows[0].system_prompt;
      }
    }

    // Generate embedding for the question
    const embedding = await generateEmbedding(question);

    // KB vector search
    const embeddingStr = `[${embedding.join(",")}]`;
    const kbResult = await pool.query(
      `SELECT question, answer, (embedding <=> $2) AS distance
       FROM kb_entries
       WHERE customer_id = $1
       ORDER BY embedding <=> $2
       LIMIT 3`,
      [session.customerId, embeddingStr]
    );

    if (kbResult.rows.length === 0) {
      return {
        answer: "I don't have enough information to answer that question.",
        source: "none",
        session_id: session.chatSessionId || "",
      };
    }

    // Build context
    const context = kbResult.rows
      .map((m: any, i: number) => `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}`)
      .join("\n\n");

    // Get chat history
    const { decrypt } = await import("../services/crypto");
    const historyResult = await pool.query(
      `SELECT role, content FROM chat_messages
       WHERE session_id = $1 ORDER BY created_at ASC`,
      [session.chatSessionId]
    );
    const history = historyResult.rows.map((r: any) => ({
      role: r.role,
      content: decrypt(r.content),
    }));

    // Build RAG prompt
    const ragRules = `--- RAG rules ---
- Answer using ONLY information from the KNOWLEDGEBASE below.
- Keep answers SHORT and conversational — suitable for voice/phone.
- Avoid bullet points and complex formatting; speak naturally.
- Use ANSWER_NOT_FOUND only when no passage answers the question.`;

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      {
        role: "system",
        content: `${agentPrompt}\n\n${ragRules}\n\n--- KNOWLEDGEBASE ---\n${context}\n--- END ---`,
      },
      ...history.map((h: any) => ({ role: h.role, content: h.content })),
      { role: "user", content: question },
    ];

    // Call OpenAI (faster for voice)
    const llmResult = await chatOpenAI(messages, 150);
    const answer = llmResult.answer.trim() || "I'm sorry, I couldn't find an answer.";

    // Save messages
    const { encrypt } = await import("../services/crypto");
    pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source) VALUES ($1, $2, $3, $4)`,
      [session.chatSessionId, "user", encrypt(question), null]
    ).catch(() => {});
    pool.query(
      `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd) VALUES ($1, $2, $3, $4, $5)`,
      [session.chatSessionId, "assistant", encrypt(answer), "openai", llmResult.costUsd]
    ).catch(() => {});

    return {
      answer,
      source: "openai",
      session_id: session.chatSessionId || "",
    };
  } catch (err) {
    log?.error({ err }, "voicebot ask pipeline error");
    return null;
  }
}

// ============================================================
// Route Registration
// ============================================================

export async function exotelVoicebotRoutes(app: FastifyInstance): Promise<void> {
  // ---- HTTPS Bootstrap route ----
  // Returns { url: "wss://..." } for Exotel to connect to.
  app.get<{ Params: { customerId: string } }>(
    "/exotel/voicebot/bootstrap/:customerId",
    async (request, reply) => {
      const { customerId } = request.params;

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(customerId)) {
        return reply.status(400).send({ error: "Invalid customer ID format" });
      }

      const settings = await getExotelSettings(customerId);
      if (!settings || !settings.is_enabled) {
        return reply.status(404).send({ error: "Voicebot not configured for this tenant" });
      }

      const { voicebot_wss_url: wssUrl } = voicebotUrlsForCustomer(customerId, request);

      return reply.send({ url: wssUrl });
    }
  );

  // ---- Health check for Voicebot WebSocket system ----
  app.get("/exotel/voicebot/status", async (_request, reply) => {
    return reply.send({
      status: "ok",
      active_sessions: getActiveSessionCount(),
      timestamp: new Date().toISOString(),
    });
  });

  // ---- WebSocket endpoint — per-tenant ----
  // Exotel connects here for each call (one WS connection per call).
  app.get<{ Params: { customerId: string } }>(
    "/exotel/voicebot/:customerId",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { customerId } = request.params;
      const log = request.log;

      log.info({ customerId }, "exotel voicebot connection attempt");

      // ---- Validate tenant ----
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(customerId)) {
        log.warn({ customerId }, "invalid customer ID in voicebot WSS URL");
        socket.close(4400, "Invalid customer ID format");
        return;
      }

      let settings: ExotelSettings | null;
      try {
        settings = await getExotelSettings(customerId);
      } catch (err) {
        log.error({ err }, "failed to load exotel settings");
        socket.close(4500, "Internal error");
        return;
      }

      if (!settings || !settings.is_enabled) {
        log.warn({ customerId }, "voicebot not enabled for tenant");
        socket.close(4404, "Voicebot not configured");
        return;
      }

      log.info({ customerId }, "exotel voicebot connection accepted");

      // ---- State for this connection ----
      let session: VoicebotSession | null = null;
      let vadTimer: ReturnType<typeof setTimeout> | null = null;
      let isProcessing = false;

      // ---- Message handler ----
      socket.on("message", async (rawData: Buffer | string) => {
        const raw = typeof rawData === "string" ? rawData : rawData.toString("utf-8");
        const msg = parseExotelMessage(raw);

        if (!msg) {
          log.warn({ raw: raw.slice(0, 200) }, "voicebot: unparseable message");
          return;
        }

        if (msg.event === "media") {
          const m = msg as ExotelMediaMessage;
          log.trace(
            {
              event: msg.event,
              payloadB64Len: m.media?.payload?.length ?? 0,
              stream_sid: session?.streamSid,
            },
            "voicebot: inbound message"
          );
        } else {
          log.debug({ event: msg.event, stream_sid: session?.streamSid }, "voicebot: inbound message");
        }

        try {
          switch (msg.event) {
            // ---- connected ----
            case "connected":
              log.info("voicebot: Exotel connected");
              break;

            // ---- start ----
            case "start": {
              const startMsg = msg as ExotelStartMessage;
              const details = startMsg.start;

              session = createSession({
                streamSid: details.stream_sid,
                callSid: details.call_sid,
                customerId,
                accountSid: details.account_sid,
                from: details.from,
                to: details.to,
                mediaFormat: details.media_format,
                customParameters: details.custom_parameters,
              });

              log.info({
                stream_sid: details.stream_sid,
                call_sid: details.call_sid,
                from: details.from,
                to: details.to,
                sample_rate: details.media_format.sample_rate,
                encoding: details.media_format.encoding,
              }, "voicebot: stream started");

              // Create DB row for this call
              try {
                session.callSessionDbId = await createCallSession({
                  customerId,
                  callSid: details.call_sid,
                  streamSid: details.stream_sid,
                  direction: "inbound",
                  fromNumber: details.from,
                  toNumber: details.to,
                  chatSessionId: null,
                  metadata: {
                    media_format: details.media_format,
                    custom_parameters: details.custom_parameters,
                  },
                });
              } catch (err) {
                log.error({ err }, "voicebot: failed to create call session row");
              }

              // Send greeting
              if (env.sarvam.apiKey) {
                await speakToExotel(socket, session, GREETING_TEXT, "en-IN", log);
              }
              break;
            }

            // ---- media (caller audio) ----
            case "media": {
              if (!session) break;

              const mediaMsg = msg as ExotelMediaMessage;
              const pcm = decodeBase64Pcm(mediaMsg.media.payload);

              // Barge-in: if bot is speaking and we get new caller audio, clear
              if (session.isSpeaking && pcm.length > 640) {
                sendClearToExotel(socket, session);
                session.isSpeaking = false;
                log.info({ stream_sid: session.streamSid }, "voicebot: barge-in detected");
              }

              // Accumulate inbound PCM
              session.inboundPcm.push(pcm);
              session.inboundBytes += pcm.length;

              // Reset VAD silence timer
              if (vadTimer) clearTimeout(vadTimer);

              // Safety: if buffer is too large, force-process
              if (session.inboundBytes >= MAX_INBOUND_BUFFER_BYTES) {
                if (!isProcessing) {
                  isProcessing = true;
                  await processUtterance(socket, session, log);
                  isProcessing = false;
                }
                break;
              }

              // Start silence timer — when silence detected, process utterance
              vadTimer = setTimeout(async () => {
                if (!session || session.isClosing || isProcessing) return;
                if (session.inboundPcm.length === 0) return;

                isProcessing = true;
                try {
                  await processUtterance(socket, session, log);
                } catch (err) {
                  log.error({ err }, "voicebot: utterance processing error");
                } finally {
                  isProcessing = false;
                }
              }, VAD_SILENCE_TIMEOUT_MS);
              break;
            }

            // ---- dtmf ----
            case "dtmf": {
              if (!session) break;
              const digit = (msg as any).dtmf?.digit;
              log.info({ stream_sid: session.streamSid, digit }, "voicebot: DTMF received");
              // Future: route to agent logic if product requires keypad input
              break;
            }

            // ---- mark ----
            case "mark": {
              if (!session) break;
              const markName = (msg as any).mark?.name;
              if (markName) {
                session.pendingMarks.delete(markName);
                if (session.pendingMarks.size === 0) {
                  session.isSpeaking = false;
                }
              }
              break;
            }

            // ---- stop ----
            case "stop": {
              const reason = (msg as any).stop?.reason || "unknown";
              log.info({
                stream_sid: session?.streamSid,
                reason,
              }, "voicebot: stream stopped");

              if (vadTimer) clearTimeout(vadTimer);

              if (session) {
                // Update DB row
                if (session.callSessionDbId) {
                  await endCallSession(session.callSessionDbId, `stopped:${reason}`);
                }
                removeSession(session.streamSid);
                session = null;
              }
              break;
            }
          }
        } catch (err) {
          log.error({ err, event: msg.event }, "voicebot: message handler error");
        }
      });

      // ---- Connection close ----
      socket.on("close", (code, reason) => {
        if (vadTimer) clearTimeout(vadTimer);

        log.info({
          stream_sid: session?.streamSid,
          code,
          reason: reason?.toString(),
        }, "voicebot: WebSocket closed");

        if (session) {
          if (session.callSessionDbId) {
            endCallSession(session.callSessionDbId, `ws_closed:${code}`).catch(() => {});
          }
          removeSession(session.streamSid);
        }
      });

      // ---- Error handler ----
      socket.on("error", (err) => {
        log.error({ err, stream_sid: session?.streamSid }, "voicebot: WebSocket error");
      });
    }
  );
}
