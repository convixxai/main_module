import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  generateEmbedding,
  chatSelfHosted,
  chatOpenAI,
} from "../services/llm";
import {
  sarvamSpeechToText,
  sarvamTextToSpeech,
} from "../services/sarvam";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { encrypt, decrypt } from "../services/crypto";

const askSchema = z.object({
  question: z.string().min(1),
  session_id: z.string().uuid().optional().nullable().default(null),
  agent_id: z.string().uuid().optional().nullable().default(null),
});

interface ResolvedAgent {
  id: string;
  name: string;
  systemPrompt: string;
}

interface KBMatch {
  question: string;
  answer: string;
  distance: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const DIRECT_MATCH_THRESHOLD = 0.3;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    promise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]);
}

async function resolveAgent(
  customerId: string,
  agentId: string | null,
  question: string
): Promise<ResolvedAgent | null> {
  if (agentId) {
    const result = await pool.query(
      `SELECT id, name, system_prompt FROM agents
       WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`,
      [agentId, customerId]
    );
    if (result.rows.length === 0) return null;
    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      systemPrompt: result.rows[0].system_prompt,
    };
  }

  const agents = await pool.query(
    `SELECT id, name, description, system_prompt FROM agents
     WHERE customer_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC`,
    [customerId]
  );

  if (agents.rows.length === 0) return null;
  if (agents.rows.length === 1) {
    const a = agents.rows[0];
    return { id: a.id, name: a.name, systemPrompt: a.system_prompt };
  }

  const agentList = agents.rows
    .map(
      (a: any, i: number) =>
        `${i + 1}. ID: ${a.id} | Name: ${a.name} | Description: ${a.description || "No description"}`
    )
    .join("\n");

  const routerMessages: { role: "system" | "user"; content: string }[] = [
    {
      role: "system",
      content: `You are an agent router. Given a user query and a list of available agents, respond with ONLY the UUID of the best agent to handle the query. Do not explain.\n\nAvailable agents:\n${agentList}`,
    },
    { role: "user", content: question },
  ];

  try {
    const chosen = await withTimeout(chatSelfHosted(routerMessages, 60), 3000);
    if (chosen) {
      const trimmed = chosen.trim();
      const matched = agents.rows.find(
        (a: any) => trimmed.includes(a.id) || trimmed.toLowerCase().includes(a.name.toLowerCase())
      );
      if (matched) {
        return {
          id: matched.id,
          name: matched.name,
          systemPrompt: matched.system_prompt,
        };
      }
    }
  } catch {}

  const fallback = agents.rows[0];
  return {
    id: fallback.id,
    name: fallback.name,
    systemPrompt: fallback.system_prompt,
  };
}

async function resolveAgentFromSession(
  sessionId: string | null
): Promise<ResolvedAgent | null> {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT a.id, a.name, a.system_prompt FROM chat_sessions cs
     JOIN agents a ON a.id = cs.agent_id AND a.is_active = TRUE
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    systemPrompt: result.rows[0].system_prompt,
  };
}

async function vectorSearchWithDistance(
  customerId: string,
  embedding: number[],
  limit = 3
): Promise<KBMatch[]> {
  const embeddingStr = `[${embedding.join(",")}]`;
  const result = await pool.query(
    `SELECT question, answer, (embedding <=> $2) AS distance
     FROM kb_entries
     WHERE customer_id = $1
     ORDER BY embedding <=> $2
     LIMIT $3`,
    [customerId, embeddingStr, limit]
  );
  return result.rows;
}

function buildContext(matches: KBMatch[]): string {
  return matches
    .map((m, i) => `Q${i + 1}: ${m.question}\nA${i + 1}: ${m.answer}`)
    .join("\n\n");
}

async function getOrCreateSession(
  customerId: string,
  sessionId: string | null
): Promise<string> {
  if (sessionId) {
    const existing = await pool.query(
      "SELECT id FROM chat_sessions WHERE id = $1 AND customer_id = $2",
      [sessionId, customerId]
    );
    if (existing.rows.length > 0) {
      pool.query(
        "UPDATE chat_sessions SET updated_at = NOW() WHERE id = $1",
        [sessionId]
      ).catch(() => {});
      return sessionId;
    }
  }

  const result = await pool.query(
    "INSERT INTO chat_sessions (customer_id) VALUES ($1) RETURNING id",
    [customerId]
  );
  return result.rows[0].id;
}

async function getChatHistory(
  sessionId: string
): Promise<ChatMessage[]> {
  const result = await pool.query(
    `SELECT role, content FROM chat_messages
     WHERE session_id = $1
     ORDER BY created_at ASC`,
    [sessionId]
  );
  return result.rows.map((row) => ({
    role: row.role,
    content: decrypt(row.content),
  }));
}

function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  source?: string,
  costUsd?: number
) {
  const encrypted = encrypt(content);
  pool.query(
    `INSERT INTO chat_messages (session_id, role, content, source, openai_cost_usd)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, role, encrypted, source || null, costUsd || null]
  ).catch(() => {});
}

function buildRAGMessages(
  systemPrompt: string,
  context: string,
  history: ChatMessage[],
  question: string
) {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] =
    [
      {
        role: "system",
        content: `${systemPrompt}\n\nRules:\n- Answer ONLY using the knowledgebase provided.\n- Keep answers short (1-3 sentences).\n- If the knowledgebase does NOT contain the answer, respond EXACTLY with: ANSWER_NOT_FOUND\n\n--- KNOWLEDGEBASE ---\n${context}\n--- END ---`,
      },
    ];

  for (const msg of history) {
    messages.push({ role: msg.role, content: msg.content });
  }

  messages.push({ role: "user", content: question });
  return messages;
}

const NOT_FOUND_MARKERS = [
  "answer_not_found",
  "i don't have enough information",
  "not in the knowledgebase",
  "i cannot find",
  "i couldn't find",
  "no information available",
  "don't have information",
];

function isNotFound(answer: string): boolean {
  const lower = answer.toLowerCase();
  return NOT_FOUND_MARKERS.some((m) => lower.includes(m));
}

function logOpenAIUsage(
  customerId: string,
  question: string,
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    model: string;
    costUsd: number;
  }
) {
  pool.query(
    `INSERT INTO openai_usage
       (customer_id, question, prompt_tokens, completion_tokens, total_tokens, model, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      customerId,
      question,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.model,
      usage.costUsd,
    ]
  ).catch(() => {});
}

export type AskPipelineResult = {
  session_id: string;
  agent_id: string | null;
  agent_name: string | null;
  answer: string;
  source: string;
  openai_cost_usd: number | null;
  response_time_ms: number;
  self_hosted_answer?: string | null;
  fallback_reason?: string;
  /** Present when `runAskPipeline` was called with `includeTimings: true` */
  pipeline_timings?: AskPipelineTimings;
};

/** Per-step latency inside the RAG pipeline (voice/debug). */
export type AskPipelineTimings = {
  parallel_init_ms: number;
  resolve_agent_ms: number;
  vector_history_ms: number;
  rag_llm_parallel_ms: number;
  branch:
    | "no_kb"
    | "kb_direct"
    | "rag_self_hosted"
    | "rag_openai"
    | "rag_last_resort";
};

async function runAskPipeline(params: {
  customerId: string;
  customerPrompt: string;
  question: string;
  inputSessionId: string | null;
  inputAgentId: string | null;
  includeTimings?: boolean;
  /**
   * When true (e.g. voice): run self-hosted first; call OpenAI only if self-hosted fails.
   * When false (default): run both in parallel — lower latency if OpenAI is faster fallback.
   */
  sequentialLlm?: boolean;
}): Promise<AskPipelineResult> {
  const {
    customerId,
    customerPrompt,
    question,
    inputSessionId,
    inputAgentId,
    includeTimings,
    sequentialLlm,
  } = params;
  const start = Date.now();

  const tParallel0 = Date.now();
  const [sessionId, embedding, sessionAgent] = await Promise.all([
    getOrCreateSession(customerId, inputSessionId),
    generateEmbedding(question),
    resolveAgentFromSession(inputSessionId),
  ]);
  const parallelInitMs = Date.now() - tParallel0;

  const tAgent0 = Date.now();
  let agent: ResolvedAgent | null = null;
  if (inputAgentId) {
    agent = await resolveAgent(customerId, inputAgentId, question);
  } else if (sessionAgent) {
    agent = sessionAgent;
  } else {
    agent = await resolveAgent(customerId, null, question);
  }
  const resolveAgentMs = Date.now() - tAgent0;

  const systemPrompt = agent?.systemPrompt || customerPrompt;
  const agentId = agent?.id || null;
  const agentName = agent?.name || null;

  if (agentId) {
    pool.query(
      "UPDATE chat_sessions SET agent_id = COALESCE(agent_id, $1) WHERE id = $2",
      [agentId, sessionId]
    ).catch(() => {});
  }

  const tVec0 = Date.now();
  const [matches, history] = await Promise.all([
    vectorSearchWithDistance(customerId, embedding),
    getChatHistory(sessionId),
  ]);
  const vectorHistoryMs = Date.now() - tVec0;

  saveMessage(sessionId, "user", question);

  const baseTimings = (): AskPipelineTimings => ({
    parallel_init_ms: parallelInitMs,
    resolve_agent_ms: resolveAgentMs,
    vector_history_ms: vectorHistoryMs,
    rag_llm_parallel_ms: 0,
    branch: "no_kb",
  });

  if (matches.length === 0) {
    const noKbAnswer = "No knowledgebase entries found for this customer.";
    saveMessage(sessionId, "assistant", noKbAnswer, "none");
    const timings = baseTimings();
    timings.branch = "no_kb";
    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_name: agentName,
      answer: noKbAnswer,
      source: "none",
      openai_cost_usd: null,
      response_time_ms: Date.now() - start,
      ...(includeTimings ? { pipeline_timings: timings } : {}),
    };
  }

  const topMatch = matches[0];

  if (topMatch.distance < DIRECT_MATCH_THRESHOLD && history.length === 0) {
    saveMessage(sessionId, "assistant", topMatch.answer, "kb-direct");
    const timings = baseTimings();
    timings.branch = "kb_direct";
    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_name: agentName,
      answer: topMatch.answer,
      source: "kb-direct",
      openai_cost_usd: null,
      response_time_ms: Date.now() - start,
      ...(includeTimings ? { pipeline_timings: timings } : {}),
    };
  }

  const context = buildContext(matches);
  const ragMessages = buildRAGMessages(
    systemPrompt,
    context,
    history,
    question
  );

  const tRag0 = Date.now();
  let selfHostedAnswer = "";
  let openaiResult: Awaited<ReturnType<typeof chatOpenAI>> | null = null;

  if (sequentialLlm) {
    selfHostedAnswer = await chatSelfHosted(ragMessages, 150).catch(() => "");
    const shFailed = !selfHostedAnswer || isNotFound(selfHostedAnswer);
    if (shFailed) {
      openaiResult = await chatOpenAI(ragMessages, 150).catch(() => null);
    }
  } else {
    const pair = await Promise.all([
      chatSelfHosted(ragMessages, 150).catch(() => ""),
      chatOpenAI(ragMessages, 150).catch(() => null),
    ]);
    selfHostedAnswer = pair[0];
    openaiResult = pair[1];
  }
  const ragLlmParallelMs = Date.now() - tRag0;

  const selfHostedFailed = !selfHostedAnswer || isNotFound(selfHostedAnswer);

  const ragTimings = (
    branch: AskPipelineTimings["branch"]
  ): AskPipelineTimings => ({
    parallel_init_ms: parallelInitMs,
    resolve_agent_ms: resolveAgentMs,
    vector_history_ms: vectorHistoryMs,
    rag_llm_parallel_ms: ragLlmParallelMs,
    branch,
  });

  if (!selfHostedFailed) {
    saveMessage(sessionId, "assistant", selfHostedAnswer, "self-hosted");
    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_name: agentName,
      answer: selfHostedAnswer,
      source: "self-hosted",
      openai_cost_usd: null,
      response_time_ms: Date.now() - start,
      ...(includeTimings ? { pipeline_timings: ragTimings("rag_self_hosted") } : {}),
    };
  }

  const fallbackResult = openaiResult;

  if (fallbackResult) {
    logOpenAIUsage(customerId, question, {
      promptTokens: fallbackResult.promptTokens,
      completionTokens: fallbackResult.completionTokens,
      totalTokens: fallbackResult.totalTokens,
      model: fallbackResult.model,
      costUsd: fallbackResult.costUsd,
    });

    saveMessage(
      sessionId,
      "assistant",
      fallbackResult.answer,
      "openai",
      fallbackResult.costUsd
    );

    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_name: agentName,
      answer: fallbackResult.answer,
      source: "openai",
      self_hosted_answer: selfHostedAnswer || null,
      fallback_reason: "Self-hosted LLM could not answer from knowledgebase",
      openai_cost_usd: fallbackResult.costUsd,
      response_time_ms: Date.now() - start,
      ...(includeTimings ? { pipeline_timings: ragTimings("rag_openai") } : {}),
    };
  }

  const lastResort =
    selfHostedAnswer || "Unable to generate an answer at this time.";
  saveMessage(sessionId, "assistant", lastResort, "self-hosted");

  return {
    session_id: sessionId,
    agent_id: agentId,
    agent_name: agentName,
    answer: lastResort,
    source: "self-hosted",
    openai_cost_usd: null,
    fallback_reason: "Both self-hosted and OpenAI failed",
    response_time_ms: Date.now() - start,
    ...(includeTimings ? { pipeline_timings: ragTimings("rag_last_resort") } : {}),
  };
}

const TTS_MAX_CHARS = 2500;

const ttsLanguageSchema = z.enum([
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
]);

function parseSttBody(body: unknown): { transcript: string; language_code: string | null } {
  if (!body || typeof body !== "object") {
    return { transcript: "", language_code: null };
  }
  const o = body as Record<string, unknown>;
  const t = o.transcript;
  return {
    transcript: typeof t === "string" ? t : "",
    language_code:
      typeof o.language_code === "string" ? o.language_code : null,
  };
}

export async function askRoutes(app: FastifyInstance) {
  app.post(
    "/ask",
    { preHandler: apiKeyAuth },
    async (request: AuthenticatedRequest, reply) => {
      const body = askSchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: body.error.flatten() });
      }

      const customerId = request.customerId!;
      const customerDefaultPrompt = request.customerPrompt!;
      const { question, session_id: inputSessionId, agent_id: inputAgentId } =
        body.data;

      return await runAskPipeline({
        customerId,
        customerPrompt: customerDefaultPrompt,
        question,
        inputSessionId: inputSessionId ?? null,
        inputAgentId: inputAgentId ?? null,
      });
    }
  );

  await app.register(async (scoped) => {
    await scoped.register(multipart, {
      limits: { fileSize: 15 * 1024 * 1024 },
    });

    scoped.post(
      "/ask/voice",
      { preHandler: apiKeyAuth },
      async (request: AuthenticatedRequest, reply) => {
        if (!env.sarvam.apiKey) {
          return reply.status(503).send({
            error: "Sarvam is not configured (SARVAM_API_KEY)",
          });
        }

        const voiceRequestStarted = Date.now();
        let fileBuffer: Buffer | null = null;
        let filename = "audio.wav";
        let mimeType = "audio/wav";
        const fields: Record<string, string> = {};

        const tMultipart0 = Date.now();
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
        const multipart_ms = Date.now() - tMultipart0;

        if (!fileBuffer || fileBuffer.length === 0) {
          return reply.status(400).send({
            error:
              "Missing audio file. Send multipart field `file` with WAV/MP3/AAC/FLAC/OGG.",
          });
        }

        const modeRaw = (fields.stt_mode || "transcribe").toLowerCase();
        const sttModes = [
          "transcribe",
          "translate",
          "verbatim",
          "translit",
          "codemix",
        ] as const;
        if (!sttModes.includes(modeRaw as (typeof sttModes)[number])) {
          return reply.status(400).send({
            error: `Invalid stt_mode. Use one of: ${sttModes.join(", ")}`,
          });
        }

        let inputSessionId: string | null = null;
        if (fields.session_id?.trim()) {
          const p = z.string().uuid().safeParse(fields.session_id.trim());
          if (!p.success) {
            return reply.status(400).send({ error: "Invalid session_id" });
          }
          inputSessionId = p.data;
        }

        let inputAgentId: string | null = null;
        if (fields.agent_id?.trim()) {
          const p = z.string().uuid().safeParse(fields.agent_id.trim());
          if (!p.success) {
            return reply.status(400).send({ error: "Invalid agent_id" });
          }
          inputAgentId = p.data;
        }

        const targetLangRaw =
          fields.target_language_code?.trim() || "en-IN";
        const targetLang = ttsLanguageSchema.safeParse(targetLangRaw);
        if (!targetLang.success) {
          return reply.status(400).send({
            error:
              "Invalid target_language_code. Use an Indian locale e.g. en-IN, hi-IN.",
          });
        }

        let stt: Awaited<ReturnType<typeof sarvamSpeechToText>>;
        const tStt0 = Date.now();
        try {
          stt = await sarvamSpeechToText({
            fileBuffer,
            filename,
            mimeType,
            model: fields.stt_model?.trim() || "saaras:v3",
            mode: modeRaw as (typeof sttModes)[number],
            language_code: fields.language_code?.trim() || undefined,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Sarvam STT failed";
          request.log.error({ err }, "ask/voice STT failed");
          return reply.status(502).send({
            error: msg,
            voice_timings: {
              multipart_ms,
              stt_ms: Date.now() - tStt0,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }
        const stt_ms = Date.now() - tStt0;

        if (stt.status !== 200) {
          const sttPayload =
            typeof stt.body === "object" && stt.body !== null
              ? { ...(stt.body as Record<string, unknown>) }
              : { error: stt.body };
          return reply.status(stt.status).send({
            ...sttPayload,
            voice_timings: {
              multipart_ms,
              stt_ms,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }

        const { transcript, language_code: sttLanguageCode } = parseSttBody(
          stt.body
        );
        const question = transcript.trim();
        if (!question) {
          return reply.status(400).send({
            error: "Could not transcribe speech (empty transcript).",
            stt: stt.body,
            voice_timings: {
              multipart_ms,
              stt_ms,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }

        const customerId = request.customerId!;
        const customerDefaultPrompt = request.customerPrompt!;

        const voiceFastLlm = /^(1|true|yes|on)$/i.test(
          (fields.voice_fast_llm || "").trim()
        );
        const voiceTtsMaxRaw = fields.voice_tts_max_chars?.trim();
        let voiceTtsCap: number | null = null;
        if (voiceTtsMaxRaw) {
          const n = parseInt(voiceTtsMaxRaw, 10);
          if (Number.isFinite(n)) {
            voiceTtsCap = Math.min(TTS_MAX_CHARS, Math.max(200, n));
          }
        }

        const askResult = await runAskPipeline({
          customerId,
          customerPrompt: customerDefaultPrompt,
          question,
          inputSessionId,
          inputAgentId,
          includeTimings: true,
          sequentialLlm: voiceFastLlm,
        });

        const ttsLimit = voiceTtsCap ?? TTS_MAX_CHARS;
        const ttsText =
          askResult.answer.length > ttsLimit
            ? askResult.answer.slice(0, ttsLimit)
            : askResult.answer;

        const codec =
          fields.output_audio_codec === "mp3" ? "mp3" : "wav";
        const sampleRate = fields.speech_sample_rate?.trim() || "24000";

        const sttRequestId =
          typeof (stt.body as { request_id?: unknown })?.request_id ===
          "string"
            ? (stt.body as { request_id: string }).request_id
            : null;

        const { pipeline_timings: pipeline_breakdown, ...askRest } = askResult;

        const voiceTimingsBase = {
          multipart_ms,
          stt_ms,
          ask_pipeline_ms: askResult.response_time_ms,
          pipeline_breakdown,
          server_total_ms: 0,
        };

        let tts: Awaited<ReturnType<typeof sarvamTextToSpeech>>;
        const tTts0 = Date.now();
        try {
          tts = await sarvamTextToSpeech({
            text: ttsText,
            target_language_code: targetLang.data,
            model: "bulbul:v3",
            speaker: fields.speaker?.trim() || undefined,
            speech_sample_rate: sampleRate,
            output_audio_codec: codec,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : "Sarvam TTS failed";
          const tts_ms = Date.now() - tTts0;
          request.log.error({ err }, "ask/voice TTS failed");
          return reply.status(200).send({
            ...askRest,
            transcript: question,
            stt_language_code: sttLanguageCode,
            stt_request_id: sttRequestId,
            audio: null,
            audio_error: msg,
            voice_timings: {
              ...voiceTimingsBase,
              tts_ms,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }
        const tts_ms = Date.now() - tTts0;

        if (tts.status !== 200) {
          return reply.status(200).send({
            ...askRest,
            transcript: question,
            stt_language_code: sttLanguageCode,
            stt_request_id: sttRequestId,
            audio: null,
            audio_error: tts.body,
            voice_timings: {
              ...voiceTimingsBase,
              tts_ms,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }

        const ttsData = tts.body as {
          request_id?: string | null;
          audios?: string[];
        };
        const b64 = ttsData.audios?.[0];
        if (typeof b64 !== "string" || !b64.length) {
          return reply.status(200).send({
            ...askRest,
            transcript: question,
            stt_language_code: sttLanguageCode,
            audio: null,
            audio_error: "TTS returned no audio",
            voice_timings: {
              ...voiceTimingsBase,
              tts_ms,
              server_total_ms: Date.now() - voiceRequestStarted,
            },
          });
        }

        return {
          ...askRest,
          transcript: question,
          stt_language_code: sttLanguageCode,
          stt_request_id: sttRequestId,
          audio: {
            format: codec,
            content_type: codec === "mp3" ? "audio/mpeg" : "audio/wav",
            base64: b64,
            request_id: ttsData.request_id ?? null,
          },
          voice_timings: {
            ...voiceTimingsBase,
            tts_ms,
            server_total_ms: Date.now() - voiceRequestStarted,
          },
        };
      }
    );
  });
}
