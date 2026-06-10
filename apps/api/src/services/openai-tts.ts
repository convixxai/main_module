import type OpenAI from "openai";
import { openaiClient } from "./llm";

export const OPENAI_TTS_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "onyx",
  "nova",
  "sage",
  "shimmer",
  "verse",
] as const;

export type OpenAiTtsVoice = (typeof OPENAI_TTS_VOICES)[number];

export const OPENAI_TTS_MODELS = [
  "gpt-4o-mini-tts",
  "tts-1-hd",
  "tts-1",
] as const;

export type OpenAiTtsModel = (typeof OPENAI_TTS_MODELS)[number];

export const OPENAI_TTS_RESPONSE_FORMATS = [
  "mp3",
  "wav",
  "opus",
  "aac",
  "flac",
  "pcm",
] as const;

export type OpenAiTtsResponseFormat = (typeof OPENAI_TTS_RESPONSE_FORMATS)[number];

/** USD per 1M input characters (approximate; update when OpenAI pricing changes). */
const TTS_PRICE_PER_MILLION_CHARS: Record<string, number> = {
  "gpt-4o-mini-tts": 12,
  "tts-1": 15,
  "tts-1-hd": 30,
};

export type OpenAiTtsUsage = {
  model: string;
  voice: string;
  input_characters: number;
  cost_usd: number;
  response_format: string;
  instructions_chars: number;
};

export type OpenAiTtsParams = {
  text: string;
  model?: string;
  voice?: string;
  instructions?: string | null;
  speed?: number;
  responseFormat?: OpenAiTtsResponseFormat;
};

export function resolveOpenAiTtsModel(raw: string | null | undefined): OpenAiTtsModel {
  const m = (raw || "gpt-4o-mini-tts").trim();
  if ((OPENAI_TTS_MODELS as readonly string[]).includes(m)) {
    return m as OpenAiTtsModel;
  }
  return "gpt-4o-mini-tts";
}

export function resolveOpenAiTtsVoice(raw: string | null | undefined): OpenAiTtsVoice {
  const v = (raw || "nova").trim().toLowerCase();
  if ((OPENAI_TTS_VOICES as readonly string[]).includes(v)) {
    return v as OpenAiTtsVoice;
  }
  return "nova";
}

export function estimateOpenAiTtsCostUsd(
  model: string,
  inputCharacters: number
): number {
  const rate = TTS_PRICE_PER_MILLION_CHARS[model] ?? TTS_PRICE_PER_MILLION_CHARS["gpt-4o-mini-tts"];
  return (inputCharacters / 1_000_000) * rate;
}

export function openAiTtsModelSupportsInstructions(model: string): boolean {
  return model === "gpt-4o-mini-tts" || model.startsWith("gpt-4o-mini-tts-");
}

export function openAiTtsSimulatorDefaults() {
  return {
    tts_model: "gpt-4o-mini-tts" as OpenAiTtsModel,
    voice: "nova" as OpenAiTtsVoice,
    speed: 1,
    response_format: "mp3" as OpenAiTtsResponseFormat,
    tts_instructions:
      "Speak like a real human on a live phone call. Use natural intonation, subtle breath, and believable emotion. Never sound robotic or like you are reading a script.",
    llm_model: "",
    llm_temperature: 0.85,
    llm_max_tokens: 600,
    skip_humanizer: false,
    slider_bounds: {
      speed: { min: 0.25, max: 4, step: 0.05, default: 1 },
      llm_temperature: { min: 0, max: 1.5, step: 0.05, default: 0.85 },
      llm_max_tokens: { min: 80, max: 2000, step: 20, default: 600 },
    },
    voices: [...OPENAI_TTS_VOICES],
    models: [...OPENAI_TTS_MODELS],
    response_formats: [...OPENAI_TTS_RESPONSE_FORMATS],
  };
}

function contentTypeForFormat(fmt: OpenAiTtsResponseFormat): string {
  switch (fmt) {
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "aac":
      return "audio/aac";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/pcm";
    default:
      return "audio/mpeg";
  }
}

export async function openaiTextToSpeech(
  params: OpenAiTtsParams
): Promise<{
  status: number;
  body: Buffer;
  contentType: string;
  usage: OpenAiTtsUsage;
}> {
  const model = resolveOpenAiTtsModel(params.model);
  const voice = resolveOpenAiTtsVoice(params.voice);
  const responseFormat = params.responseFormat ?? "mp3";
  const input = params.text.slice(0, 4096);
  const instructions = (params.instructions || "").trim().slice(0, 4096);
  const speed =
    params.speed != null && Number.isFinite(params.speed)
      ? Math.min(4, Math.max(0.25, params.speed))
      : 1;

  const payload: OpenAI.Audio.SpeechCreateParams = {
    model,
    voice,
    input,
    response_format: responseFormat,
    ...(openAiTtsModelSupportsInstructions(model) && instructions
      ? { instructions }
      : {}),
    ...(model === "tts-1" || model === "tts-1-hd" ? { speed } : {}),
  };

  const res = await openaiClient.audio.speech.create(payload);

  const arrayBuf = await res.arrayBuffer();
  const body = Buffer.from(arrayBuf);
  const usage: OpenAiTtsUsage = {
    model,
    voice,
    input_characters: input.length,
    instructions_chars: instructions.length,
    response_format: responseFormat,
    cost_usd: estimateOpenAiTtsCostUsd(model, input.length),
  };

  return {
    status: 200,
    body,
    contentType: contentTypeForFormat(responseFormat),
    usage,
  };
}
