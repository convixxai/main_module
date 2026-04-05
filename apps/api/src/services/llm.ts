import OpenAI from "openai";
import { env } from "../config/env";
import { getCachedEmbedding, setCachedEmbedding } from "./cache";
import type { RagTraceFn } from "./rag-trace";

export const selfHostedLLM = new OpenAI({
  baseURL: env.llm.baseUrl,
  apiKey: env.llm.apiKey,
  timeout: 10000,
});

export const openaiClient = new OpenAI({
  apiKey: env.openai.apiKey,
  timeout: 8000,
});

/** Best-effort message for API clients when the OpenAI SDK throws (HTTP errors, auth, rate limits). */
export function formatOpenAIClientError(err: unknown): string {
  if (err && typeof err === "object") {
    const o = err as Record<string, unknown>;
    const status = o.status;
    const code = o.code;
    const msg =
      typeof o.message === "string"
        ? o.message
        : err instanceof Error
          ? err.message
          : String(err);
    const parts: string[] = [];
    if (typeof status === "number") parts.push(String(status));
    if (typeof code === "string" && code) parts.push(code);
    parts.push(msg);
    return parts.filter(Boolean).join(" — ");
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function chatSelfHosted(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens = 150,
  trace?: RagTraceFn
): Promise<string> {
  trace?.("self_hosted_llm_request", {
    provider: "self_hosted",
    base_url: env.llm.baseUrl,
    model: env.llm.model,
    max_tokens: maxTokens,
    messages,
  });
  const res = await selfHostedLLM.chat.completions.create({
    model: env.llm.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
  });
  const raw = res.choices[0]?.message?.content?.trim() || "";
  trace?.("self_hosted_llm_response", {
    model: res.model,
    usage: res.usage,
    raw_reply: raw,
    finish_reason: res.choices[0]?.finish_reason,
  });
  return raw;
}

export interface OpenAIUsageResult {
  answer: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model: string;
  costUsd: number;
}

const PRICING: Record<string, { input: number; output: number }> = {
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4o": { input: 2.5, output: 10 },
};

function estimateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): number {
  const price = PRICING[model] || PRICING["gpt-4o-mini"];
  return (
    (promptTokens / 1_000_000) * price.input +
    (completionTokens / 1_000_000) * price.output
  );
}

export type ChatOpenAIRagOptions = {
  temperature?: number;
  top_p?: number;
};

export async function chatOpenAI(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens = 150,
  trace?: RagTraceFn,
  ragOptions?: ChatOpenAIRagOptions
): Promise<OpenAIUsageResult> {
  const temperature =
    ragOptions?.temperature ?? env.openai.ragTemperature;
  const top_p = ragOptions?.top_p ?? env.openai.ragTopP;

  trace?.("openai_chat_request", {
    provider: "openai",
    model: env.openai.model,
    max_tokens: maxTokens,
    temperature,
    top_p: top_p ?? null,
    messages,
  });
  const res = await openaiClient.chat.completions.create({
    model: env.openai.model,
    messages,
    temperature,
    ...(top_p != null && top_p !== 1 ? { top_p } : {}),
    max_tokens: maxTokens,
  });

  const promptTokens = res.usage?.prompt_tokens || 0;
  const completionTokens = res.usage?.completion_tokens || 0;
  const totalTokens = res.usage?.total_tokens || 0;
  const model = res.model || env.openai.model;
  const raw = res.choices[0]?.message?.content?.trim() || "";

  trace?.("openai_chat_response", {
    model,
    usage: res.usage,
    raw_reply: raw,
    finish_reason: res.choices[0]?.finish_reason,
  });

  return {
    answer: raw,
    promptTokens,
    completionTokens,
    totalTokens,
    model,
    costUsd: estimateCost(model, promptTokens, completionTokens),
  };
}

export async function generateEmbedding(
  text: string,
  trace?: RagTraceFn
): Promise<number[]> {
  const cached = getCachedEmbedding(text);
  if (cached) {
    trace?.("embedding_cache_hit", {
      model: "nomic-embed-text",
      dim: cached.length,
      input_text: text,
      input_len: text.length,
    });
    return cached;
  }

  trace?.("embedding_request", {
    provider: "self_hosted_embeddings",
    base_url: env.llm.baseUrl,
    model: "nomic-embed-text",
    input_text: text,
    input_len: text.length,
  });

  const res = await selfHostedLLM.embeddings.create({
    model: "nomic-embed-text",
    input: text,
    encoding_format: "float",
  });

  const embedding = res.data[0].embedding;
  trace?.("embedding_response", {
    dim: embedding.length,
    usage: res.usage,
    // First floats only; full vector is not logged.
    embedding_preview: embedding.slice(0, 8),
  });
  setCachedEmbedding(text, embedding);
  return embedding;
}
