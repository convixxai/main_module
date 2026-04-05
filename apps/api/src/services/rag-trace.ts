import type { FastifyBaseLogger } from "fastify";
import { env } from "../config/env";

export type RagTraceFn = (step: string, data: Record<string, unknown>) => void;

/**
 * When LOG_RAG_TRACE is not `false`, logs structured `[rag:step]` lines for:
 * embeddings (self-hosted), vector hits, chat history, full LLM request/response.
 * Disable in production if logs must not contain prompts (set LOG_RAG_TRACE=false).
 */
export function createRagTrace(log?: FastifyBaseLogger): RagTraceFn | undefined {
  if (!env.logRagTrace || !log) return undefined;
  return (step, data) => {
    log.info({ rag_trace: step, ...data }, `[rag:${step}]`);
  };
}
