import OpenAI from "openai";
import { env } from "../config/env";
import { getCachedEmbedding, setCachedEmbedding } from "./cache";

export const selfHostedLLM = new OpenAI({
  baseURL: env.llm.baseUrl,
  apiKey: env.llm.apiKey,
  timeout: 10000,
});

export const openaiClient = new OpenAI({
  apiKey: env.openai.apiKey,
  timeout: 8000,
});

export async function chatSelfHosted(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens = 150
): Promise<string> {
  const res = await selfHostedLLM.chat.completions.create({
    model: env.llm.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
  });
  return res.choices[0]?.message?.content?.trim() || "";
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

export async function chatOpenAI(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens = 150
): Promise<OpenAIUsageResult> {
  const res = await openaiClient.chat.completions.create({
    model: env.openai.model,
    messages,
    temperature: 0,
    max_tokens: maxTokens,
  });

  const promptTokens = res.usage?.prompt_tokens || 0;
  const completionTokens = res.usage?.completion_tokens || 0;
  const totalTokens = res.usage?.total_tokens || 0;
  const model = res.model || env.openai.model;

  return {
    answer: res.choices[0]?.message?.content?.trim() || "",
    promptTokens,
    completionTokens,
    totalTokens,
    model,
    costUsd: estimateCost(model, promptTokens, completionTokens),
  };
}

export async function generateEmbedding(text: string): Promise<number[]> {
  const cached = getCachedEmbedding(text);
  if (cached) return cached;

  const res = await selfHostedLLM.embeddings.create({
    model: "nomic-embed-text",
    input: text,
    encoding_format: "float",
  });

  const embedding = res.data[0].embedding;
  setCachedEmbedding(text, embedding);
  return embedding;
}
