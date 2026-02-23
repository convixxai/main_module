import { FastifyInstance } from "fastify";
import { z } from "zod";
import { pool } from "../config/db";
import {
  generateEmbedding,
  chatSelfHosted,
  chatOpenAI,
} from "../services/llm";
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
      const { question, session_id: inputSessionId, agent_id: inputAgentId } = body.data;
      const start = Date.now();

      // Step 1: Session + embedding + session-agent lookup ALL in parallel
      const [sessionId, embedding, sessionAgent] = await Promise.all([
        getOrCreateSession(customerId, inputSessionId || null),
        generateEmbedding(question),
        resolveAgentFromSession(inputSessionId || null),
      ]);

      // Step 2: Resolve agent (fast paths first, LLM routing only if needed)
      let agent: ResolvedAgent | null = null;
      if (inputAgentId) {
        agent = await resolveAgent(customerId, inputAgentId, question);
      } else if (sessionAgent) {
        agent = sessionAgent;
      } else {
        agent = await resolveAgent(customerId, null, question);
      }

      const systemPrompt = agent?.systemPrompt || customerDefaultPrompt;
      const agentId = agent?.id || null;
      const agentName = agent?.name || null;

      if (agentId) {
        pool.query(
          "UPDATE chat_sessions SET agent_id = COALESCE(agent_id, $1) WHERE id = $2",
          [agentId, sessionId]
        ).catch(() => {});
      }

      // Step 3: Vector search with distance + chat history in parallel
      const [matches, history] = await Promise.all([
        vectorSearchWithDistance(customerId, embedding),
        getChatHistory(sessionId),
      ]);

      saveMessage(sessionId, "user", question);

      if (matches.length === 0) {
        const noKbAnswer =
          "No knowledgebase entries found for this customer.";
        saveMessage(sessionId, "assistant", noKbAnswer, "none");
        return {
          session_id: sessionId,
          agent_id: agentId,
          agent_name: agentName,
          answer: noKbAnswer,
          source: "none",
          openai_cost_usd: null,
          response_time_ms: Date.now() - start,
        };
      }

      const topMatch = matches[0];

      // FAST PATH: Direct KB match — skip LLM entirely
      // If the user's question is very close to a KB question, return the
      // KB answer directly. This handles ~70% of FAQ queries in <1 second.
      if (topMatch.distance < DIRECT_MATCH_THRESHOLD && history.length === 0) {
        saveMessage(sessionId, "assistant", topMatch.answer, "kb-direct");
        return {
          session_id: sessionId,
          agent_id: agentId,
          agent_name: agentName,
          answer: topMatch.answer,
          source: "kb-direct",
          openai_cost_usd: null,
          response_time_ms: Date.now() - start,
        };
      }

      // LLM PATH: Always fire both in parallel -- no extra wait on fallback
      const context = buildContext(matches);
      const ragMessages = buildRAGMessages(
        systemPrompt,
        context,
        history,
        question
      );

      const [selfHostedAnswer, openaiResult] = await Promise.all([
        chatSelfHosted(ragMessages, 150).catch(() => ""),
        chatOpenAI(ragMessages, 150).catch(() => null),
      ]);

      const selfHostedFailed =
        !selfHostedAnswer || isNotFound(selfHostedAnswer);

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
        };
      }

      // Fallback: self-hosted failed, OpenAI result already ready
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
          fallback_reason:
            "Self-hosted LLM could not answer from knowledgebase",
          openai_cost_usd: fallbackResult.costUsd,
          response_time_ms: Date.now() - start,
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
      };
    }
  );
}
