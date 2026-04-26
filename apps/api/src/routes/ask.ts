import { FastifyInstance } from "fastify";
import multipart from "@fastify/multipart";
import { z } from "zod";
import { pool } from "../config/db";
import { env } from "../config/env";
import {
  generateEmbedding,
  prepareQuestionForKbEmbedding,
  chatSelfHosted,
  chatOpenAI,
  formatOpenAIClientError,
} from "../services/llm";
import {
  getCustomerSettings,
  type CustomerSettings,
} from "../services/customer-settings";
import {
  createRagTrace,
  type RagTraceFn,
} from "../services/rag-trace";
import {
  sarvamSpeechToText,
  sarvamTextToSpeech,
} from "../services/sarvam";
import {
  elevenLabsSpeechToText,
  elevenLabsSttToSarvamShape,
  elevenLabsTextToSpeech,
  resolveElevenLabsSttModelId,
  resolveElevenLabsTtsModelId,
  bcp47ToElevenLabsLanguage,
  ELEVENLABS_RAG_AUDIO_TAGS_RULE,
} from "../services/elevenlabs";
import { apiKeyAuth, AuthenticatedRequest } from "../middleware/auth";
import { encrypt, decrypt } from "../services/crypto";

const askSchema = z.object({
  question: z.string().min(1),
  session_id: z.string().uuid().optional().nullable().default(null),
  agent_id: z.string().uuid().optional().nullable().default(null),
  /** BCP-47; when tenant is multilingual, non-English improves KB vector search vs English-only chunks. */
  question_language_code: z.string().optional().nullable().default(null),
});

interface ResolvedAgent {
  id: string;
  name: string;
  systemPrompt: string;
  noKbFallbackInstruction: string | null;
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

function ragTopKAsk(cs: CustomerSettings | null): number {
  const v = cs?.rag_top_k;
  if (v != null && Number.isFinite(v))
    return Math.min(20, Math.max(1, Math.floor(Number(v))));
  return 3;
}

function ragDirectThresholdAsk(cs: CustomerSettings | null): number {
  const v = cs?.rag_distance_threshold;
  if (v != null && Number.isFinite(v) && Number(v) > 0 && Number(v) < 2)
    return Number(v);
  return DIRECT_MATCH_THRESHOLD;
}

function trimAskHistoryForRag(
  cs: CustomerSettings | null,
  history: ChatMessage[]
): ChatMessage[] {
  if (!cs || !cs.rag_use_history) return [];
  const maxTurns = cs.rag_history_max_turns;
  const capPairs = maxTurns != null && maxTurns > 0 ? maxTurns : 50;
  return history.slice(-(capPairs * 2));
}

function llmMaxTokensAsk(cs: CustomerSettings | null): number {
  const v = cs?.llm_max_tokens;
  const n = v != null && Number.isFinite(v) ? Math.floor(Number(v)) : 150;
  return Math.min(4096, Math.max(8, n));
}

function openAiRagOptsFromCs(cs: CustomerSettings | null) {
  const temperature =
    cs?.llm_temperature != null && Number.isFinite(Number(cs.llm_temperature))
      ? Number(cs.llm_temperature)
      : 0.25;
  const topP =
    cs?.llm_top_p != null && Number.isFinite(Number(cs.llm_top_p))
      ? Number(cs.llm_top_p)
      : undefined;
  const model =
    cs?.llm_model_override?.trim() || cs?.openai_model?.trim() || undefined;
  return {
    temperature,
    ...(topP != null && topP < 1 ? { top_p: topP } : {}),
    ...(model ? { model } : {}),
  };
}

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
      `SELECT id, name, system_prompt, no_kb_fallback_instruction FROM agents
       WHERE id = $1 AND customer_id = $2 AND is_active = TRUE`,
      [agentId, customerId]
    );
    if (result.rows.length === 0) return null;
    return {
      id: result.rows[0].id,
      name: result.rows[0].name,
      systemPrompt: result.rows[0].system_prompt,
      noKbFallbackInstruction: result.rows[0].no_kb_fallback_instruction ?? null,
    };
  }

  const agents = await pool.query(
    `SELECT id, name, description, system_prompt, no_kb_fallback_instruction FROM agents
     WHERE customer_id = $1 AND is_active = TRUE
     ORDER BY created_at ASC`,
    [customerId]
  );

  if (agents.rows.length === 0) return null;
  if (agents.rows.length === 1) {
    const a = agents.rows[0];
    return {
      id: a.id,
      name: a.name,
      systemPrompt: a.system_prompt,
      noKbFallbackInstruction: a.no_kb_fallback_instruction ?? null,
    };
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
          noKbFallbackInstruction: matched.no_kb_fallback_instruction ?? null,
        };
      }
    }
  } catch {}

  const fallback = agents.rows[0];
  return {
    id: fallback.id,
    name: fallback.name,
    systemPrompt: fallback.system_prompt,
    noKbFallbackInstruction: fallback.no_kb_fallback_instruction ?? null,
  };
}

async function resolveAgentFromSession(
  sessionId: string | null
): Promise<ResolvedAgent | null> {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT a.id, a.name, a.system_prompt, a.no_kb_fallback_instruction FROM chat_sessions cs
     JOIN agents a ON a.id = cs.agent_id AND a.is_active = TRUE
     WHERE cs.id = $1`,
    [sessionId]
  );
  if (result.rows.length === 0) return null;
  return {
    id: result.rows[0].id,
    name: result.rows[0].name,
    systemPrompt: result.rows[0].system_prompt,
    noKbFallbackInstruction: result.rows[0].no_kb_fallback_instruction ?? null,
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

const RAG_RULES_SUFFIX = `--- RAG rules (apply on top of agent instructions above) ---
- The KNOWLEDGEBASE block below was retrieved for this question; treat it as authoritative when it applies.
- Map spelling variants, transliterations, and short forms to the same real-world entity (e.g. "Chhavani" vs "Chavni" vs "Chavni Lohagad" when the passages clearly refer to the same place or product).
- Answer using ONLY information supported by the KNOWLEDGEBASE below. You may paraphrase or combine Q/A pairs; do not invent facts.
- Use ANSWER_NOT_FOUND only when no passage reasonably answers the user's question (not merely because the user's wording differs from a KB heading).
- Keep answers short unless the agent instructions above specify a stricter length.`;

function buildRAGMessages(
  systemPrompt: string,
  context: string,
  history: ChatMessage[],
  question: string,
  noKbFallback?: string | null,
  opts?: { elevenlabsAudioTags?: boolean }
) {
  const noKbLine =
    noKbFallback && noKbFallback.trim().length > 0
      ? `\n- If no passage answers the question: ${noKbFallback.trim()}`
      : "";
  const elHint =
    opts?.elevenlabsAudioTags === true
      ? `\n${ELEVENLABS_RAG_AUDIO_TAGS_RULE}\n`
      : "";
  const messages: { role: "system" | "user" | "assistant"; content: string }[] =
    [
      {
        role: "system",
        content: `${systemPrompt}\n\n${RAG_RULES_SUFFIX}${noKbLine}${elHint}\n\n--- KNOWLEDGEBASE ---\n${context}\n--- END ---`,
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

/** Shown to users when the model signals no KB match (instead of raw ANSWER_NOT_FOUND). */
const RAG_NO_ANSWER_USER_MESSAGE =
  "I couldn't find an answer to that in the knowledgebase.";

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
  /** When the OpenAI API call failed or returned an unusable completion (SDK/HTTP error message). */
  openai_error?: string | null;
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
  /** When true (customer setting): RAG uses OpenAI only; self-hosted is skipped. */
  ragOpenaiOnly?: boolean;
  /** Pass `createRagTrace(request.log)` from `/ask` and `/ask/voice` for `[rag:*]` logs. */
  trace?: RagTraceFn;
  /** STT or client-supplied BCP-47 tag; used only to align KB embedding with English entries when multilingual. */
  embeddingLanguageHint?: string | null;
}): Promise<AskPipelineResult> {
  const {
    customerId,
    customerPrompt,
    question,
    inputSessionId,
    inputAgentId,
    includeTimings,
    sequentialLlm,
    ragOpenaiOnly,
    trace,
    embeddingLanguageHint,
  } = params;
  const start = Date.now();

  trace?.("pipeline_start", {
    customer_id: customerId,
    input_session_id: inputSessionId,
    input_agent_id: inputAgentId,
    question,
    sequential_llm: sequentialLlm === true,
    rag_openai_only: ragOpenaiOnly === true,
  });

  const tParallel0 = Date.now();
  const [sessionId, sessionAgent, custSettings] = await Promise.all([
    getOrCreateSession(customerId, inputSessionId),
    resolveAgentFromSession(inputSessionId),
    getCustomerSettings(customerId),
  ]);
  const multilingual = custSettings?.voicebot_multilingual === true;
  const tEmbedAgent0 = Date.now();
  let resolveAgentMs = 0;
  const [embedBundle, agent] = await Promise.all([
    (async () => {
      const { textForEmbedding, translatedForSearch } =
        await prepareQuestionForKbEmbedding(question, {
          multilingual,
          languageTag: embeddingLanguageHint ?? null,
          trace,
        });
      const embedding = await generateEmbedding(textForEmbedding, trace);
      return { textForEmbedding, translatedForSearch, embedding };
    })(),
    (async () => {
      const t0 = Date.now();
      if (inputAgentId) {
        const a = await resolveAgent(customerId, inputAgentId, question);
        resolveAgentMs = Date.now() - t0;
        return a;
      }
      if (sessionAgent) {
        resolveAgentMs = Date.now() - t0;
        return sessionAgent;
      }
      const a = await resolveAgent(customerId, null, question);
      resolveAgentMs = Date.now() - t0;
      return a;
    })(),
  ]);
  const { textForEmbedding, translatedForSearch, embedding } = embedBundle;
  const embedAgentWallMs = Date.now() - tEmbedAgent0;
  const parallelInitMs = Date.now() - tParallel0;

  trace?.("parallel_init_done", {
    session_id: sessionId,
    embedding_dim: embedding.length,
    parallel_init_ms: parallelInitMs,
    embed_and_agent_ms: embedAgentWallMs,
    has_session_agent_from_db: sessionAgent != null,
    kb_search_translated: translatedForSearch,
    embedding_search_preview: textForEmbedding.slice(0, 240),
  });

  const systemPrompt = agent?.systemPrompt || customerPrompt;
  const agentId = agent?.id || null;
  const agentName = agent?.name || null;

  trace?.("agent_resolved", {
    agent_id: agentId,
    agent_name: agentName,
    resolve_agent_ms: resolveAgentMs,
    system_prompt_len: systemPrompt.length,
  });

  if (agentId) {
    pool.query(
      "UPDATE chat_sessions SET agent_id = COALESCE(agent_id, $1) WHERE id = $2",
      [agentId, sessionId]
    ).catch(() => {});
  }

  const kbLimit = ragTopKAsk(custSettings ?? null);
  const directTh = ragDirectThresholdAsk(custSettings ?? null);

  const tVec0 = Date.now();
  const [matches, history] = await Promise.all([
    vectorSearchWithDistance(customerId, embedding, kbLimit),
    getChatHistory(sessionId),
  ]);
  const historyForRag = trimAskHistoryForRag(custSettings ?? null, history);
  const vectorHistoryMs = Date.now() - tVec0;

  trace?.("vector_search_and_history", {
    match_count: matches.length,
    matches: matches.map((m, i) => ({
      rank: i + 1,
      distance: m.distance,
      kb_question_preview: m.question.slice(0, 300),
      kb_answer_preview: m.answer.slice(0, 300),
    })),
    direct_match_threshold: directTh,
    rag_top_k: kbLimit,
    history_message_count: history.length,
    history_for_rag_count: historyForRag.length,
    history_preview: history.map((h) => ({
      role: h.role,
      content_preview: h.content.slice(0, 400),
    })),
    vector_history_ms: vectorHistoryMs,
  });

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
    trace?.("pipeline_exit", { branch: "no_kb", reason: "zero_kb_matches" });
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

  if (topMatch.distance < directTh && history.length === 0) {
    trace?.("pipeline_exit", {
      branch: "kb_direct",
      distance: topMatch.distance,
    });
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
  const mergedNoKbFallback =
    agent?.noKbFallbackInstruction?.trim() ||
    custSettings?.no_kb_fallback_instruction?.trim() ||
    null;
  const ragMessages = buildRAGMessages(
    systemPrompt,
    context,
    historyForRag,
    question,
    mergedNoKbFallback,
    { elevenlabsAudioTags: custSettings?.tts_provider === "elevenlabs" }
  );

  const maxTok = llmMaxTokensAsk(custSettings ?? null);
  const openaiOpts = openAiRagOptsFromCs(custSettings ?? null);
  const selfHostedModelOpts = {
    model: custSettings?.llm_model_override?.trim() || undefined,
  };
  const selfHostedOnly =
    custSettings?.llm_fallback_to_openai === false && ragOpenaiOnly !== true;

  trace?.("rag_prompt_built", {
    context_chars: context.length,
    context_full: context,
    rag_messages_full: ragMessages,
  });

  const tRag0 = Date.now();
  let selfHostedAnswer = "";
  let openaiResult: Awaited<ReturnType<typeof chatOpenAI>> | null = null;
  let openaiCallError: string | null = null;

  if (ragOpenaiOnly) {
    trace?.("rag_llm_mode", { mode: "openai_only" });
    try {
      openaiResult = await chatOpenAI(ragMessages, maxTok, trace, openaiOpts);
    } catch (e) {
      openaiCallError = formatOpenAIClientError(e);
      trace?.("openai_chat_exception", { error: openaiCallError });
      openaiResult = null;
    }
  } else if (selfHostedOnly) {
    trace?.("rag_llm_mode", { mode: "self_hosted_only_no_openai_fallback" });
    selfHostedAnswer = await chatSelfHosted(
      ragMessages,
      maxTok,
      trace,
      selfHostedModelOpts
    ).catch((e) => {
      trace?.("self_hosted_llm_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return "";
    });
  } else if (sequentialLlm) {
    trace?.("rag_llm_mode", { mode: "sequential_self_hosted_then_openai" });
    selfHostedAnswer = await chatSelfHosted(
      ragMessages,
      maxTok,
      trace,
      selfHostedModelOpts
    ).catch((e) => {
      trace?.("self_hosted_llm_failed", {
        error: e instanceof Error ? e.message : String(e),
      });
      return "";
    });
    const shFailed = !selfHostedAnswer || isNotFound(selfHostedAnswer);
    if (shFailed) {
      openaiResult = await chatOpenAI(ragMessages, maxTok, trace, openaiOpts).catch(
        (e) => {
          trace?.("openai_chat_failed", {
            error: formatOpenAIClientError(e),
          });
          return null;
        }
      );
    }
  } else {
    trace?.("rag_llm_mode", { mode: "parallel_self_hosted_and_openai" });
    const pair = await Promise.all([
      chatSelfHosted(ragMessages, maxTok, trace, selfHostedModelOpts).catch(
        (e) => {
          trace?.("self_hosted_llm_failed", {
            error: e instanceof Error ? e.message : String(e),
          });
          return "";
        }
      ),
      chatOpenAI(ragMessages, maxTok, trace, openaiOpts).catch((e) => {
        trace?.("openai_chat_failed", {
          error: formatOpenAIClientError(e),
        });
        return null;
      }),
    ]);
    selfHostedAnswer = pair[0];
    openaiResult = pair[1];
  }
  const ragLlmParallelMs = Date.now() - tRag0;

  const ragTimings = (
    branch: AskPipelineTimings["branch"]
  ): AskPipelineTimings => ({
    parallel_init_ms: parallelInitMs,
    resolve_agent_ms: resolveAgentMs,
    vector_history_ms: vectorHistoryMs,
    rag_llm_parallel_ms: ragLlmParallelMs,
    branch,
  });

  if (ragOpenaiOnly) {
    if (openaiCallError && !openaiResult) {
      trace?.("pipeline_exit", {
        branch: "rag_last_resort",
        answer_source: "openai_exception",
        openai_error: openaiCallError,
      });
      const short =
        "The OpenAI request failed. See openai_error for the provider message.";
      saveMessage(sessionId, "assistant", short, "openai");
      return {
        session_id: sessionId,
        agent_id: agentId,
        agent_name: agentName,
        answer: short,
        source: "openai",
        openai_cost_usd: null,
        openai_error: openaiCallError,
        response_time_ms: Date.now() - start,
        ...(includeTimings ? { pipeline_timings: ragTimings("rag_last_resort") } : {}),
      };
    }

    if (openaiResult) {
      logOpenAIUsage(customerId, question, {
        promptTokens: openaiResult.promptTokens,
        completionTokens: openaiResult.completionTokens,
        totalTokens: openaiResult.totalTokens,
        model: openaiResult.model,
        costUsd: openaiResult.costUsd,
      });
    }

    const oa = openaiResult?.answer?.trim() || "";

    if (openaiResult && oa && !isNotFound(oa)) {
      trace?.("pipeline_exit", {
        branch: "rag_openai",
        answer_source: "openai",
        raw_model_reply_preview: oa.slice(0, 500),
      });
      saveMessage(
        sessionId,
        "assistant",
        oa,
        "openai",
        openaiResult.costUsd
      );
      return {
        session_id: sessionId,
        agent_id: agentId,
        agent_name: agentName,
        answer: oa,
        source: "openai",
        openai_cost_usd: openaiResult.costUsd,
        response_time_ms: Date.now() - start,
        ...(includeTimings ? { pipeline_timings: ragTimings("rag_openai") } : {}),
      };
    }

    if (openaiResult && oa && isNotFound(oa)) {
      trace?.("openai_reply_kb_miss", {
        raw_model_reply: oa,
        user_facing_answer: RAG_NO_ANSWER_USER_MESSAGE,
        note:
          "Model followed RAG rules (e.g. ANSWER_NOT_FOUND); not an API error.",
      });
      trace?.("pipeline_exit", {
        branch: "rag_openai",
        answer_source: "openai_kb_miss",
      });
      saveMessage(
        sessionId,
        "assistant",
        RAG_NO_ANSWER_USER_MESSAGE,
        "openai",
        openaiResult.costUsd
      );
      return {
        session_id: sessionId,
        agent_id: agentId,
        agent_name: agentName,
        answer: RAG_NO_ANSWER_USER_MESSAGE,
        source: "openai",
        openai_cost_usd: openaiResult.costUsd,
        response_time_ms: Date.now() - start,
        ...(includeTimings ? { pipeline_timings: ragTimings("rag_openai") } : {}),
      };
    }

    if (openaiResult && !oa) {
      saveMessage(
        sessionId,
        "assistant",
        "OpenAI returned an empty reply.",
        "openai",
        openaiResult.costUsd
      );
      return {
        session_id: sessionId,
        agent_id: agentId,
        agent_name: agentName,
        answer: "OpenAI returned an empty reply.",
        source: "openai",
        openai_cost_usd: openaiResult.costUsd,
        openai_error: "empty_completion",
        response_time_ms: Date.now() - start,
        ...(includeTimings ? { pipeline_timings: ragTimings("rag_last_resort") } : {}),
      };
    }

    saveMessage(
      sessionId,
      "assistant",
      "Unable to complete the OpenAI request.",
      "openai"
    );
    return {
      session_id: sessionId,
      agent_id: agentId,
      agent_name: agentName,
      answer: "Unable to complete the OpenAI request.",
      source: "openai",
      openai_cost_usd: null,
      openai_error: openaiCallError || "unknown",
      response_time_ms: Date.now() - start,
      ...(includeTimings ? { pipeline_timings: ragTimings("rag_last_resort") } : {}),
    };
  }

  const selfHostedFailed = !selfHostedAnswer || isNotFound(selfHostedAnswer);

  if (!selfHostedFailed) {
    trace?.("pipeline_exit", {
      branch: "rag_self_hosted",
      answer_source: "self-hosted",
      raw_preview: selfHostedAnswer.slice(0, 500),
    });
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
    trace?.("pipeline_exit", {
      branch: "rag_openai",
      answer_source: "openai_fallback",
      self_hosted_had_preview: (selfHostedAnswer || "").slice(0, 200),
      openai_raw_preview: fallbackResult.answer.slice(0, 500),
    });
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
  trace?.("pipeline_exit", {
    branch: "rag_last_resort",
    self_hosted_preview: (selfHostedAnswer || "").slice(0, 300),
  });
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

/** ElevenLabs `output_format` for /ask/voice (WAV/MP3 file response). */
function elevenLabsAskTtsOutputFormat(
  codec: string,
  sampleRateStr: string
): string {
  const sr = parseInt(sampleRateStr, 10) || 24000;
  if (codec === "mp3") {
    if (sr <= 22050) return "mp3_22050_32";
    return "mp3_44100_128";
  }
  if (sr <= 8000) return "wav_8000";
  if (sr <= 16000) return "wav_16000";
  if (sr <= 22050) return "wav_22050";
  if (sr <= 24000) return "wav_24000";
  if (sr <= 32000) return "wav_32000";
  return "wav_44100";
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
      const {
        question,
        session_id: inputSessionId,
        agent_id: inputAgentId,
        question_language_code: questionLanguageCode,
      } = body.data;

      const trace = createRagTrace(request.log);
      return await runAskPipeline({
        customerId,
        customerPrompt: customerDefaultPrompt,
        question,
        inputSessionId: inputSessionId ?? null,
        inputAgentId: inputAgentId ?? null,
        embeddingLanguageHint: questionLanguageCode ?? null,
        ragOpenaiOnly: request.ragUseOpenaiOnly === true,
        trace,
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
        const voiceRequestStarted = Date.now();
        const customerIdEarly = request.customerId!;
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

        const cust = await getCustomerSettings(customerIdEarly);
        const sttProv = cust?.stt_provider ?? "sarvam";
        const ttsProv = cust?.tts_provider ?? "sarvam";
        const needSarvam = sttProv === "sarvam" || ttsProv === "sarvam";
        const needEleven = sttProv === "elevenlabs" || ttsProv === "elevenlabs";
        if (needSarvam && !env.sarvam.apiKey.trim()) {
          return reply.status(503).send({
            error:
              "Sarvam is not configured (SARVAM_API_KEY required for this tenant's provider settings).",
          });
        }
        if (needEleven && !env.elevenlabs.apiKey) {
          return reply.status(503).send({
            error:
              "ElevenLabs is not configured (ELEVENLABS_API_KEY required for this tenant's provider settings).",
          });
        }

        let stt: { status: number; body: unknown };
        const tStt0 = Date.now();
        try {
          if (sttProv === "elevenlabs") {
            const elModel = resolveElevenLabsSttModelId(
              fields.stt_model?.trim()
            );
            const hint = fields.language_code?.trim();
            const elLang = hint
              ? bcp47ToElevenLabsLanguage(hint, {
                  multilingual: true,
                  forceEnglish: false,
                })
              : undefined;
            stt = await elevenLabsSpeechToText({
              fileBuffer,
              filename,
              modelId: elModel,
              languageCode: elLang,
            });
          } else {
            stt = await sarvamSpeechToText({
              fileBuffer,
              filename,
              mimeType,
              model: fields.stt_model?.trim() || "saaras:v3",
              mode: modeRaw as (typeof sttModes)[number],
              language_code: fields.language_code?.trim() || undefined,
            });
          }
        } catch (err: unknown) {
          const msg =
            err instanceof Error ? err.message : "Speech-to-text request failed";
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

        const sttParsed =
          sttProv === "elevenlabs"
            ? elevenLabsSttToSarvamShape(stt.body)
            : parseSttBody(stt.body);
        const transcript = sttParsed.transcript;
        const sttLanguageCode = sttParsed.language_code;
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

        const customerId = customerIdEarly;
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

        const trace = createRagTrace(request.log);
        const askResult = await runAskPipeline({
          customerId,
          customerPrompt: customerDefaultPrompt,
          question,
          inputSessionId,
          inputAgentId,
          embeddingLanguageHint: sttLanguageCode,
          includeTimings: true,
          sequentialLlm: voiceFastLlm && !request.ragUseOpenaiOnly,
          ragOpenaiOnly: request.ragUseOpenaiOnly === true,
          trace,
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
          sttProv === "sarvam" &&
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

        let tts: { status: number; body: unknown };
        const tTts0 = Date.now();
        try {
          if (ttsProv === "elevenlabs") {
            const voiceId =
              fields.speaker?.trim() ||
              cust?.tts_default_speaker?.trim() ||
              env.elevenlabs.defaultVoiceId ||
              "";
            if (!voiceId) {
              throw new Error(
                "ElevenLabs TTS needs multipart `speaker` (voice_id), or customer_settings.tts_default_speaker, or ELEVENLABS_DEFAULT_VOICE_ID"
              );
            }
            const modelId = resolveElevenLabsTtsModelId(cust?.tts_model ?? null);
            const outFmt = elevenLabsAskTtsOutputFormat(codec, sampleRate);
            const el = await elevenLabsTextToSpeech({
              voiceId,
              text: ttsText,
              modelId,
              outputFormat: outFmt,
            });
            if (el.status === 200 && Buffer.isBuffer(el.body)) {
              tts = {
                status: 200,
                body: {
                  request_id: null,
                  audios: [el.body.toString("base64")],
                },
              };
            } else {
              tts = el;
            }
          } else {
            tts = await sarvamTextToSpeech({
              text: ttsText,
              target_language_code: targetLang.data,
              model: "bulbul:v3",
              speaker: fields.speaker?.trim() || undefined,
              speech_sample_rate: sampleRate,
              output_audio_codec: codec,
            });
          }
        } catch (err: unknown) {
          const msg =
            err instanceof Error ? err.message : "Text-to-speech failed";
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
