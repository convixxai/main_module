import OpenAI from "openai";
import { env } from "../config/env";
import { getCachedEmbedding, setCachedEmbedding } from "./cache";
import type { RagTraceFn } from "./rag-trace";
import { sarvamTranslateToEnglishForSearch } from "./sarvam";

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
  trace?: RagTraceFn,
  opts?: { model?: string | null }
): Promise<string> {
  const model = (opts?.model?.trim() || env.llm.model).trim();
  trace?.("self_hosted_llm_request", {
    provider: "self_hosted",
    base_url: env.llm.baseUrl,
    model,
    max_tokens: maxTokens,
    messages,
  });
  const res = await selfHostedLLM.chat.completions.create({
    model,
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
  /** Per-tenant override from `customer_settings.openai_model` / `llm_model_override`. */
  model?: string | null;
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
  const model = (ragOptions?.model?.trim() || env.openai.model).trim();

  trace?.("openai_chat_request", {
    provider: "openai",
    model,
    max_tokens: maxTokens,
    temperature,
    top_p: top_p ?? null,
    messages,
  });
  const res = await openaiClient.chat.completions.create({
    model,
    messages,
    temperature,
    ...(top_p != null && top_p !== 1 ? { top_p } : {}),
    max_tokens: maxTokens,
  });

  const promptTokens = res.usage?.prompt_tokens || 0;
  const completionTokens = res.usage?.completion_tokens || 0;
  const totalTokens = res.usage?.total_tokens || 0;
  const modelUsed = res.model || model;
  const raw = res.choices[0]?.message?.content?.trim() || "";

  trace?.("openai_chat_response", {
    model: modelUsed,
    usage: res.usage,
    raw_reply: raw,
    finish_reason: res.choices[0]?.finish_reason,
  });

  return {
    answer: raw,
    promptTokens,
    completionTokens,
    totalTokens,
    model: modelUsed,
    costUsd: estimateCost(modelUsed, promptTokens, completionTokens),
  };
}

/**
 * OpenAI chat with `stream: true`. Invokes `onTextDelta` for each content delta (for incremental TTS).
 * Aggregated full text is returned; usage is included when the API sends it (stream_options).
 */
export async function streamChatOpenAI(
  messages: OpenAI.Chat.ChatCompletionMessageParam[],
  maxTokens: number,
  onTextDelta: (token: string) => void | Promise<void>,
  trace?: RagTraceFn,
  ragOptions?: ChatOpenAIRagOptions
): Promise<OpenAIUsageResult> {
  const temperature =
    ragOptions?.temperature ?? env.openai.ragTemperature;
  const top_p = ragOptions?.top_p ?? env.openai.ragTopP;
  const model = (ragOptions?.model?.trim() || env.openai.model).trim();

  trace?.("openai_chat_stream_request", {
    provider: "openai",
    model,
    max_tokens: maxTokens,
    temperature,
    top_p: top_p ?? null,
    messages,
  });

  const stream = await openaiClient.chat.completions.create({
    model,
    messages,
    temperature,
    ...(top_p != null && top_p !== 1 ? { top_p } : {}),
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
  });

  let raw = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let modelUsed = model;

  for await (const part of stream) {
    if (part.usage) {
      const u = part.usage;
      promptTokens = u.prompt_tokens ?? 0;
      completionTokens = u.completion_tokens ?? 0;
      totalTokens = u.total_tokens ?? 0;
    }
    if (part.model) modelUsed = part.model;
    const t = part.choices[0]?.delta?.content ?? "";
    if (t) {
      raw += t;
      await onTextDelta(t);
    }
  }

  const answer = raw.trim();
  if (promptTokens === 0 && completionTokens === 0) {
    completionTokens = Math.ceil(answer.length / 4);
  }

  trace?.("openai_chat_stream_response", {
    model: modelUsed,
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
    raw_reply: answer,
  });

  return {
    answer,
    promptTokens,
    completionTokens,
    totalTokens: totalTokens || promptTokens + completionTokens,
    model: modelUsed,
    costUsd: estimateCost(modelUsed, promptTokens, completionTokens),
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

/** True when tag is missing, empty, or primary language is English (en, en-IN, …). */
export function isEnglishLanguageTag(tag: string | undefined | null): boolean {
  if (tag == null) return true;
  const t = String(tag).trim().toLowerCase().replace(/_/g, "-");
  if (!t) return true;
  return t === "en" || t.startsWith("en-");
}

function inferNonEnglishLanguageHint(question: string): string | null {
  if (/\p{Script=Devanagari}/u.test(question)) return "hi-IN";
  return null;
}

/**
 * For multilingual users, English-centric KB embeddings (nomic) match poorly against
 * Hindi (etc.) transcripts. Translate to concise English **only for vector search**;
 * callers should still pass the original `question` into chat/history.
 */
export async function prepareQuestionForKbEmbedding(
  question: string,
  opts: {
    multilingual: boolean;
    languageTag?: string | null;
    trace?: RagTraceFn;
    /**
     * Voicebot: for Hindi/Marathi, Sarvam EN glosses for search can be wrong ("cantonment kitchen")
     * and steer RAG to unrelated KB rows. Nomic cross-lingual match on the raw transcript is safer.
     */
    voicePreferNativeEmbeddingForIndic?: boolean;
  }
): Promise<{ textForEmbedding: string; translatedForSearch: boolean }> {
  const q = question.trim();
  if (!q) return { textForEmbedding: q, translatedForSearch: false };

  if (!opts.multilingual) {
    return { textForEmbedding: q, translatedForSearch: false };
  }

  const explicit = opts.languageTag?.trim() || null;
  const inferred = explicit == null ? inferNonEnglishLanguageHint(q) : null;
  const effectiveTag = explicit ?? inferred;

  if (isEnglishLanguageTag(effectiveTag)) {
    return { textForEmbedding: q, translatedForSearch: false };
  }

  if (opts.voicePreferNativeEmbeddingForIndic && effectiveTag) {
    const low = String(effectiveTag).trim().toLowerCase().replace(/_/g, "-");
    if (low === "hi-in" || low === "mr-in") {
      opts.trace?.("kb_search_translate_skipped", {
        reason: "voice_native_indic_embedding",
        language: low,
        question_preview: q.slice(0, 500),
      });
      return { textForEmbedding: q, translatedForSearch: false };
    }
  }

  try {
    opts.trace?.("kb_search_translate_request", {
      provider: "sarvam",
      language: effectiveTag,
      question_preview: q.slice(0, 500),
    });
    const { ok, text } = await sarvamTranslateToEnglishForSearch(q, effectiveTag);
    if (!ok || !text) {
      opts.trace?.("kb_search_translate_response", {
        used_fallback: true,
        reason: "sarvam_translate_failed_or_empty",
      });
      return { textForEmbedding: q, translatedForSearch: false };
    }
    opts.trace?.("kb_search_translate_response", {
      translated_preview: text.slice(0, 500),
      used_fallback: false,
    });
    // Keep English (for nomic alignment with KB) plus the raw user wording so
    // transliterations / proper nouns (e.g. "Chhavani") stay in the embedding.
    const t = text.trim();
    const combined =
      t.toLowerCase() === q.trim().toLowerCase() ? t : `${t}\n${q.trim()}`;
    const capped =
      combined.length > 3500 ? `${combined.slice(0, 3500)}…` : combined;
    return { textForEmbedding: capped, translatedForSearch: true };
  } catch (err) {
    opts.trace?.("kb_search_translate_error", { err: String(err) });
    return { textForEmbedding: q, translatedForSearch: false };
  }
}

/** Same as `DEFAULT_ELEVENLABS_TTS_VOICE_ID` in config — default ElevenLabs voice when `tts_provider` is elevenlabs. */
export { DEFAULT_ELEVENLABS_TTS_VOICE_ID } from "../config/env";

/** Corrects a transcript using GPT-4o with multimodal audio input (safety net). */
export async function correctUtteranceWithOpenAI(
  audioBuffer: Buffer,
  sttTranscript: string,
  allowedLanguages: string[]
): Promise<string | null> {
  try {
    const base64Audio = audioBuffer.toString("base64");
    const allowedText = allowedLanguages.length > 0
      ? allowedLanguages.join(", ")
      : "English, Hindi, Marathi";

    const res = await openaiClient.chat.completions.create({
      model: env.openai.model || "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert audio correction assistant.
          The Speech-to-Text system transcribed the audio as: "${sttTranscript}".
          However, the user is repeating themselves and it's likely the transcription was incorrect.
          Listen to the actual audio provided and correct the transcript.
          Focus on proper nouns (such as 'Chhavani').
          Only return the corrected transcript text directly. Do not add any conversational filler.
          Allowed languages to transcribe are strictly: ${allowedText}.`
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: base64Audio,
                format: "wav"
              }
            }
          ]
        }
      ]
    });

    const outputText = res.choices[0]?.message?.content?.trim();
    return outputText || null;
  } catch (err) {
    return null;
  }
}

