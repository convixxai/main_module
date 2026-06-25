import { env } from "../config/env";

const CARTESIA_BASE = "https://api.cartesia.ai";
export const CARTESIA_VERSION = "2026-03-01";

/** ~1 credit per input character for standard Sonic TTS (see docs.cartesia.ai/pricing). */
const DEFAULT_CREDITS_PER_CHAR = 1;
const PVC_CREDITS_PER_CHAR = 1.5;

export const CARTESIA_MODELS = [
  { id: "sonic-3.5", label: "Sonic 3.5 (latest stable)", recommended: true },
  { id: "sonic-3.5-2026-05-04", label: "Sonic 3.5 snapshot (2026-05-04)", pinned: true },
  { id: "sonic-3", label: "Sonic 3 (legacy)" },
  { id: "sonic-latest", label: "sonic-latest (beta — not for production)" },
] as const;

export const CARTESIA_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "Hindi" },
  { code: "mr", label: "Marathi" },
  { code: "ta", label: "Tamil" },
  { code: "te", label: "Telugu" },
  { code: "bn", label: "Bengali" },
  { code: "gu", label: "Gujarati" },
  { code: "kn", label: "Kannada" },
  { code: "ml", label: "Malayalam" },
  { code: "pa", label: "Punjabi" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "pt", label: "Portuguese" },
  { code: "zh", label: "Chinese" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "it", label: "Italian" },
  { code: "nl", label: "Dutch" },
  { code: "pl", label: "Polish" },
  { code: "ru", label: "Russian" },
  { code: "sv", label: "Swedish" },
  { code: "tr", label: "Turkish" },
  { code: "tl", label: "Tagalog" },
  { code: "bg", label: "Bulgarian" },
  { code: "ro", label: "Romanian" },
  { code: "ar", label: "Arabic" },
  { code: "cs", label: "Czech" },
  { code: "el", label: "Greek" },
  { code: "fi", label: "Finnish" },
  { code: "hr", label: "Croatian" },
  { code: "ms", label: "Malay" },
  { code: "sk", label: "Slovak" },
  { code: "da", label: "Danish" },
  { code: "uk", label: "Ukrainian" },
  { code: "hu", label: "Hungarian" },
  { code: "no", label: "Norwegian" },
  { code: "vi", label: "Vietnamese" },
  { code: "th", label: "Thai" },
  { code: "he", label: "Hebrew" },
  { code: "ka", label: "Georgian" },
  { code: "id", label: "Indonesian" },
] as const;

/** Sonic 3.5 recommended agent voices (docs.cartesia.ai/build-with-cartesia/tts-models/latest). */
export const CARTESIA_FEATURED_VOICES = [
  {
    id: "f786b574-daa5-4673-aa0c-cbe3e8534c02",
    name: "Katie",
    language: "en",
    gender: "female",
    accent: "en-US",
    note: "Recommended for voice agents",
  },
  {
    id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4",
    name: "Skylar",
    language: "en",
    gender: "female",
    accent: "en-US",
    note: "Recommended for voice agents",
  },
  {
    id: "a5136bf9-224c-4d76-b823-52bd5efcffcc",
    name: "Jameson",
    language: "en",
    gender: "male",
    accent: "en-US",
    note: "Recommended for voice agents",
  },
  {
    id: "62ae83ad-4f6a-430b-af41-a9bede9286ca",
    name: "Gemma",
    language: "en",
    gender: "female",
    accent: "en-GB",
    note: "Recommended for voice agents",
  },
  {
    id: "ef191366-f52f-447a-a398-ed8c0f2943a1",
    name: "Archie",
    language: "en",
    gender: "male",
    accent: "en-GB",
    note: "Recommended for voice agents",
  },
] as const;

export const CARTESIA_EMOTIONS = [
  "neutral",
  "happy",
  "excited",
  "enthusiastic",
  "elated",
  "euphoric",
  "triumphant",
  "amazed",
  "surprised",
  "flirtatious",
  "curious",
  "content",
  "peaceful",
  "serene",
  "calm",
  "grateful",
  "affectionate",
  "trust",
  "sympathetic",
  "anticipation",
  "mysterious",
  "angry",
  "mad",
  "outraged",
  "frustrated",
  "agitated",
  "threatened",
  "disgusted",
  "contempt",
  "sad",
  "dejected",
  "melancholic",
  "disappointed",
  "hurt",
  "guilty",
  "bored",
  "tired",
  "rejected",
  "nostalgic",
  "wistful",
  "apologetic",
  "hesitant",
  "insecure",
  "confused",
  "skeptical",
  "contemplative",
  "determined",
  "proud",
  "competitive",
  "commanding",
] as const;

export type CartesiaEmotion = (typeof CARTESIA_EMOTIONS)[number];

export type CartesiaEmotionMode = "static" | "llm_per_turn" | "llm_per_sentence";

export const CARTESIA_LEGACY_SPEEDS = ["slow", "normal", "fast"] as const;

export const CARTESIA_OUTPUT_PRESETS = [
  {
    id: "mp3_44100",
    label: "MP3 · 44.1 kHz",
    container: "mp3",
    sample_rate: 44100,
    encoding: undefined as string | undefined,
    bit_rate: 128000,
  },
  {
    id: "wav_44100",
    label: "WAV · 44.1 kHz",
    container: "wav",
    sample_rate: 44100,
    encoding: undefined,
    bit_rate: undefined,
  },
  {
    id: "wav_24000",
    label: "WAV · 24 kHz",
    container: "wav",
    sample_rate: 24000,
    encoding: undefined,
    bit_rate: undefined,
  },
  {
    id: "raw_pcm_44100",
    label: "Raw PCM s16le · 44.1 kHz",
    container: "raw",
    sample_rate: 44100,
    encoding: "pcm_s16le",
    bit_rate: undefined,
  },
] as const;

export type CartesiaVoiceSummary = {
  id: string;
  name: string;
  description?: string;
  language?: string;
  country?: string | null;
  gender?: string | null;
  is_owner?: boolean;
  is_public?: boolean;
  created_at?: string;
  preview_file_url?: string | null;
};

export const CARTESIA_GENDERS = [
  "masculine",
  "feminine",
  "gender_neutral",
] as const;

export type CartesiaGenerationConfig = {
  speed?: number;
  volume?: number;
  emotion?: CartesiaEmotion | string;
};

export type CartesiaOutputFormat = {
  container: string;
  sample_rate: number;
  encoding?: string;
  bit_rate?: number;
};

export type CartesiaTtsUsage = {
  model_id: string;
  voice_id: string;
  transcript_characters: number;
  credits_per_character: number;
  credits_estimated: number;
  cost_usd_estimated: number;
  usd_per_million_credits: number;
  is_pvc_voice: boolean;
  audio_bytes: number;
  output_container: string;
  output_sample_rate: number;
};

export type CartesiaTtsTimings = {
  ttfb_ms: number;
  tts_ms: number;
  audio_duration_estimate_sec: number;
};

export type CartesiaTtsParams = {
  transcript: string;
  modelId?: string;
  voiceId: string;
  language?: string | null;
  generationConfig?: CartesiaGenerationConfig | null;
  outputFormat?: CartesiaOutputFormat;
  pronunciationDictId?: string | null;
  legacySpeed?: (typeof CARTESIA_LEGACY_SPEEDS)[number] | null;
  isPvcVoice?: boolean;
};

export function cartesiaConfigured(): boolean {
  return Boolean(env.cartesia.apiKey?.trim());
}

function cartesiaHeaders(): Record<string, string> {
  const key = env.cartesia.apiKey?.trim();
  if (!key) {
    throw new Error("CARTESIA_API_KEY is not configured on this server");
  }
  return {
    Authorization: `Bearer ${key}`,
    "Cartesia-Version": CARTESIA_VERSION,
    "Content-Type": "application/json",
  };
}

export function resolveCartesiaModel(raw: string | null | undefined): string {
  const m = (raw || "sonic-3.5").trim();
  const known = CARTESIA_MODELS.map((x) => x.id);
  if (known.includes(m as (typeof known)[number])) return m;
  return "sonic-3.5";
}

export function resolveCartesiaEmotion(
  raw: string | null | undefined
): CartesiaEmotion {
  const e = (raw || "neutral").trim().toLowerCase();
  if ((CARTESIA_EMOTIONS as readonly string[]).includes(e)) {
    return e as CartesiaEmotion;
  }
  return "neutral";
}

/** Map BCP-47 (e.g. en-IN) → Cartesia ISO 639-1 language code. */
export function bcp47ToCartesiaLanguage(bcp47: string): string {
  const primary = (bcp47 || "en").split("-")[0]?.toLowerCase() || "en";
  const known = CARTESIA_LANGUAGES.map((l) => l.code);
  if (known.includes(primary as (typeof known)[number])) return primary;
  return "en";
}

/** Direct PCM output matching Exotel negotiated sample rate (no resample). */
export function cartesiaOutputFormatForExotel(
  exotelSampleRate: number
): CartesiaOutputFormat {
  const rate =
    exotelSampleRate === 8000 ||
    exotelSampleRate === 16000 ||
    exotelSampleRate === 24000
      ? exotelSampleRate
      : 16000;
  return {
    container: "raw",
    encoding: "pcm_s16le",
    sample_rate: rate,
  };
}

export function parseCartesiaGenerationConfig(
  raw: unknown
): CartesiaGenerationConfig {
  if (!raw || typeof raw !== "object") {
    return { speed: 1, volume: 1, emotion: "neutral" };
  }
  const o = raw as Record<string, unknown>;
  const speed =
    o.speed != null && Number.isFinite(Number(o.speed))
      ? Math.min(1.5, Math.max(0.6, Number(o.speed)))
      : 1;
  const volume =
    o.volume != null && Number.isFinite(Number(o.volume))
      ? Math.min(2, Math.max(0.5, Number(o.volume)))
      : 1;
  const emotion = resolveCartesiaEmotion(
    o.emotion != null ? String(o.emotion) : "neutral"
  );
  return { speed, volume, emotion };
}

export function resolveCartesiaGenerationConfigForUtterance(
  base: CartesiaGenerationConfig | null | undefined,
  options?: {
    llmEmotion?: string | null;
    emotionMode?: CartesiaEmotionMode | null;
    allowedEmotions?: readonly string[] | null;
  }
): CartesiaGenerationConfig {
  const b = base ?? { speed: 1, volume: 1, emotion: "neutral" as CartesiaEmotion };
  const mode = options?.emotionMode ?? "llm_per_sentence";
  let emotion = resolveCartesiaEmotion(b.emotion ?? "neutral");

  if (mode !== "static" && options?.llmEmotion?.trim()) {
    const candidate = resolveCartesiaEmotion(options.llmEmotion);
    const allowed = options.allowedEmotions;
    if (!allowed || allowed.length === 0 || allowed.includes(candidate)) {
      emotion = candidate;
    }
  }

  return {
    speed: b.speed ?? 1,
    volume: b.volume ?? 1,
    emotion,
  };
}

/** Parse LLM answer text/JSON and extract spoken text + optional emotion. */
export function parseCartesiaLlmAnswer(raw: string): {
  text: string;
  emotion: string | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", emotion: null };

  if (trimmed.startsWith("{")) {
    try {
      const j = JSON.parse(trimmed) as { answer?: unknown; emotion?: unknown };
      if (typeof j.answer === "string" && j.answer.trim()) {
        return {
          text: j.answer.trim(),
          emotion:
            typeof j.emotion === "string" && j.emotion.trim()
              ? j.emotion.trim().toLowerCase()
              : null,
        };
      }
    } catch {
      /* fall through */
    }
  }

  const emotionLineRe = /\nEMOTION:\s*([a-z_]+)\s*$/i;
  const m = trimmed.match(emotionLineRe);
  if (m) {
    return {
      text: trimmed.replace(emotionLineRe, "").trim(),
      emotion: m[1].toLowerCase(),
    };
  }

  return { text: trimmed, emotion: null };
}

/** RAG system-prompt addendum when tenant uses Cartesia TTS. */
export function buildCartesiaRagPromptHint(options?: {
  emotionMode?: CartesiaEmotionMode | null;
  allowedEmotions?: readonly string[] | null;
}): string {
  const mode = options?.emotionMode ?? "llm_per_sentence";
  const allowed =
    options?.allowedEmotions && options.allowedEmotions.length > 0
      ? options.allowedEmotions.join(", ")
      : "neutral, calm, sympathetic, content, grateful, apologetic, enthusiastic, curious";

  let emotionBlock = "";
  if (mode === "static") {
    emotionBlock =
      "\n- Use a consistent neutral tone; emotion is configured on the voice avatar.";
  } else {
    emotionBlock = `
EMOTION TAGS (required per sentence):
- Prefix EVERY sentence with [emotion] where emotion is one of: ${allowed}
- Example: [sympathetic] I understand. [calm] Let me check that for you.`;
  }

  return `
SPOKEN OUTPUT RULES (text goes to Cartesia Sonic TTS):
- Write natural, well-punctuated sentences. End every sentence with . ? or !
- Short sentences for phone calls — one idea each.
- No SSML, markdown, bullet lists, or URLs.${emotionBlock}`;
}

export function estimateCartesiaTtsCost(
  transcriptCharacters: number,
  options?: { isPvcVoice?: boolean; creditsPerCharOverride?: number }
): {
  credits_per_character: number;
  credits_estimated: number;
  cost_usd_estimated: number;
  usd_per_million_credits: number;
} {
  const usdPerMillion = env.cartesia.usdPerMillionCredits;
  const creditsPerChar =
    options?.creditsPerCharOverride ??
    (options?.isPvcVoice ? PVC_CREDITS_PER_CHAR : DEFAULT_CREDITS_PER_CHAR);
  const credits = Math.max(0, transcriptCharacters) * creditsPerChar;
  const costUsd = (credits / 1_000_000) * usdPerMillion;
  return {
    credits_per_character: creditsPerChar,
    credits_estimated: credits,
    cost_usd_estimated: costUsd,
    usd_per_million_credits: usdPerMillion,
  };
}

/** Rough speaking-rate estimate for UI (~150 wpm ≈ 13 chars/sec). */
export function estimateAudioDurationSec(
  transcriptCharacters: number,
  speedMultiplier = 1
): number {
  const baseCps = 13;
  const speed = Math.max(0.1, speedMultiplier);
  return transcriptCharacters / (baseCps * speed);
}

export function contentTypeForCartesiaOutput(container: string): string {
  switch (container) {
    case "wav":
      return "audio/wav";
    case "mp3":
      return "audio/mpeg";
    case "raw":
      return "application/octet-stream";
    default:
      return "application/octet-stream";
  }
}

export function cartesiaSimulatorDefaults() {
  return {
    model_id: "sonic-3.5",
    voice_id: "",
    language: "en",
    generation_config: {
      speed: 1,
      volume: 1,
      emotion: "neutral" as CartesiaEmotion,
    },
    output_preset: "mp3_44100",
    pronunciation_dict_id: "",
    legacy_speed: "" as string,
    is_pvc_voice: false,
    skip_humanizer: true,
    slider_bounds: {
      speed: { min: 0.6, max: 1.5, step: 0.05, default: 1 },
      volume: { min: 0.5, max: 2, step: 0.05, default: 1 },
    },
    models: CARTESIA_MODELS.map((m) => ({ id: m.id, label: m.label })),
    languages: [...CARTESIA_LANGUAGES],
    emotions: [...CARTESIA_EMOTIONS],
    output_presets: CARTESIA_OUTPUT_PRESETS.map((p) => ({
      id: p.id,
      label: p.label,
      container: p.container,
      sample_rate: p.sample_rate,
      encoding: p.encoding,
      bit_rate: p.bit_rate,
    })),
    legacy_speeds: [...CARTESIA_LEGACY_SPEEDS],
    pricing: {
      credits_per_character_standard: DEFAULT_CREDITS_PER_CHAR,
      credits_per_character_pvc: PVC_CREDITS_PER_CHAR,
      usd_per_million_credits: env.cartesia.usdPerMillionCredits,
      note: "Standard Sonic TTS bills ~1 credit per input character (spaces + punctuation). PVC voices ~1.5 credits/char.",
      docs_url: "https://docs.cartesia.ai/pricing",
    },
    docs: {
      sonic_35: "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest",
      tts_guide: "https://docs.cartesia.ai/build-with-cartesia/capability-guides/tts",
      voice_browser: "/voice/cartesia/browser",
    },
  };
}

function mapCartesiaVoice(v: Record<string, unknown>): CartesiaVoiceSummary {
  return {
    id: String(v.id ?? ""),
    name: String(v.name ?? v.id ?? "voice"),
    description: v.description != null ? String(v.description) : undefined,
    language: v.language != null ? String(v.language) : undefined,
    country: v.country != null ? String(v.country) : null,
    gender: v.gender != null ? String(v.gender) : null,
    is_owner: v.is_owner === true,
    is_public: v.is_public === true,
    created_at: v.created_at != null ? String(v.created_at) : undefined,
    preview_file_url:
      v.preview_file_url != null ? String(v.preview_file_url) : null,
  };
}

export async function cartesiaListVoices(params?: {
  q?: string;
  language?: string;
  gender?: string;
  is_owner?: boolean;
  limit?: number;
  startingAfter?: string;
  endingBefore?: string;
  expandPreview?: boolean;
}): Promise<{
  voices: CartesiaVoiceSummary[];
  has_more: boolean;
  next_page: string | null;
}> {
  const limit = Math.min(Math.max(params?.limit ?? 50, 1), 100);
  const search = new URLSearchParams();
  search.set("limit", String(limit));
  if (params?.q?.trim()) search.set("q", params.q.trim());
  if (params?.language?.trim()) search.set("language", params.language.trim());
  if (params?.gender?.trim()) search.set("gender", params.gender.trim());
  if (params?.is_owner === true) search.set("is_owner", "true");
  if (params?.is_owner === false) search.set("is_owner", "false");
  if (params?.startingAfter?.trim()) {
    search.set("starting_after", params.startingAfter.trim());
  }
  if (params?.endingBefore?.trim()) {
    search.set("ending_before", params.endingBefore.trim());
  }
  if (params?.expandPreview !== false) {
    search.append("expand[]", "preview_file_url");
  }

  const res = await fetch(`${CARTESIA_BASE}/voices?${search.toString()}`, {
    method: "GET",
    headers: cartesiaHeaders(),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Cartesia voices API failed (${res.status}): ${errText.slice(0, 400)}`
    );
  }

  const json = (await res.json()) as {
    data?: Array<Record<string, unknown>>;
    has_more?: boolean;
    next_page?: string | null;
  };

  return {
    voices: (json.data ?? []).map(mapCartesiaVoice),
    has_more: json.has_more === true,
    next_page: json.next_page != null ? String(json.next_page) : null,
  };
}

export async function cartesiaFetchPreviewFile(
  previewUrl: string
): Promise<{ body: Buffer; contentType: string }> {
  const url = previewUrl.trim();
  if (!url) {
    throw new Error("preview URL is empty");
  }
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: cartesiaHeaders().Authorization,
      "Cartesia-Version": CARTESIA_VERSION,
    },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Cartesia preview download failed (${res.status}): ${errText.slice(0, 300)}`
    );
  }
  return {
    body: Buffer.from(await res.arrayBuffer()),
    contentType: res.headers.get("content-type") || "audio/mpeg",
  };
}

export async function cartesiaTextToSpeech(
  params: CartesiaTtsParams
): Promise<{
  body: Buffer;
  contentType: string;
  usage: CartesiaTtsUsage;
  timings: CartesiaTtsTimings;
}> {
  const modelId = resolveCartesiaModel(params.modelId);
  const transcript = params.transcript.trim();
  if (!transcript) {
    throw new Error("Transcript is empty");
  }
  if (!params.voiceId?.trim()) {
    throw new Error("voice_id is required");
  }

  const preset =
    CARTESIA_OUTPUT_PRESETS.find(
      (p) =>
        p.container === params.outputFormat?.container &&
        p.sample_rate === params.outputFormat?.sample_rate
    ) ?? CARTESIA_OUTPUT_PRESETS[0];

  const outputFormat: Record<string, unknown> = {
    container: params.outputFormat?.container ?? preset.container,
    sample_rate: params.outputFormat?.sample_rate ?? preset.sample_rate,
  };
  const encoding = params.outputFormat?.encoding ?? preset.encoding;
  const bitRate = params.outputFormat?.bit_rate ?? preset.bit_rate;
  if (encoding) outputFormat.encoding = encoding;
  if (bitRate) outputFormat.bit_rate = bitRate;

  const body: Record<string, unknown> = {
    model_id: modelId,
    transcript,
    voice: { mode: "id", id: params.voiceId.trim() },
    output_format: outputFormat,
  };

  if (params.language?.trim()) {
    body.language = params.language.trim();
  }

  const gen: Record<string, unknown> = {};
  const gc = params.generationConfig;
  if (gc?.speed != null && Number.isFinite(gc.speed)) {
    gen.speed = Math.min(1.5, Math.max(0.6, gc.speed));
  }
  if (gc?.volume != null && Number.isFinite(gc.volume)) {
    gen.volume = Math.min(2, Math.max(0.5, gc.volume));
  }
  if (gc?.emotion) {
    gen.emotion = resolveCartesiaEmotion(gc.emotion);
  }
  if (Object.keys(gen).length > 0) {
    body.generation_config = gen;
  }

  if (params.pronunciationDictId?.trim()) {
    body.pronunciation_dict_id = params.pronunciationDictId.trim();
  }

  if (
    params.legacySpeed &&
    (CARTESIA_LEGACY_SPEEDS as readonly string[]).includes(params.legacySpeed)
  ) {
    body.speed = params.legacySpeed;
  }

  const t0 = Date.now();
  const res = await fetch(`${CARTESIA_BASE}/tts/bytes`, {
    method: "POST",
    headers: cartesiaHeaders(),
    body: JSON.stringify(body),
  });
  const ttfbMs = Date.now() - t0;

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(
      `Cartesia TTS failed (${res.status}): ${errText.slice(0, 500)}`
    );
  }

  const arrayBuf = await res.arrayBuffer();
  const ttsMs = Date.now() - t0;
  const audioBuf = Buffer.from(arrayBuf);
  const container = String(outputFormat.container);
  const sampleRate = Number(outputFormat.sample_rate);

  const cost = estimateCartesiaTtsCost(transcript.length, {
    isPvcVoice: params.isPvcVoice,
  });
  const speedMult = gc?.speed ?? 1;

  return {
    body: audioBuf,
    contentType:
      res.headers.get("content-type") ||
      contentTypeForCartesiaOutput(container),
    usage: {
      model_id: modelId,
      voice_id: params.voiceId.trim(),
      transcript_characters: transcript.length,
      credits_per_character: cost.credits_per_character,
      credits_estimated: cost.credits_estimated,
      cost_usd_estimated: cost.cost_usd_estimated,
      usd_per_million_credits: cost.usd_per_million_credits,
      is_pvc_voice: Boolean(params.isPvcVoice),
      audio_bytes: audioBuf.length,
      output_container: container,
      output_sample_rate: sampleRate,
    },
    timings: {
      ttfb_ms: ttfbMs,
      tts_ms: ttsMs,
      audio_duration_estimate_sec: estimateAudioDurationSec(
        transcript.length,
        speedMult
      ),
    },
  };
}
