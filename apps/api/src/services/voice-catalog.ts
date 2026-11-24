// ============================================================
// Unified cross-provider voice catalog — Sarvam + ElevenLabs + Cartesia
// in one list, so an agent can be created with a `tts_provider` +
// `tts_speaker` (voice_id) picked from a single browsable list instead of
// needing to already know a provider's raw voice id. Each entry already
// carries its own `provider`, so callers that DO want to filter/label by
// provider can, but nothing here requires it.
//
// Purely additive / read-only: does not touch `avatars`, `elevenlabs_avatars`,
// `cartesia_avatars`, or any existing per-customer persona table. Agents that
// want a saved multi-field persona (pace/pitch/language map, etc.) still use
// those; this catalog is only the picker that feeds agents.tts_provider /
// tts_speaker / tts_model directly (see routes/agents.ts).
// ============================================================

import {
  sarvamTextToSpeech,
} from "./sarvam";
import {
  elevenLabsListVoices,
  elevenLabsTextToSpeech,
  resolveElevenLabsTtsModelId,
} from "./elevenlabs";
import {
  cartesiaListVoices,
  cartesiaTextToSpeech,
  cartesiaConfigured,
  resolveCartesiaModel,
  normalizeCartesiaGenerationConfigForVoice,
} from "./cartesia";

export type CatalogProvider = "sarvam" | "elevenlabs" | "cartesia";

export interface VoiceCatalogEntry {
  provider: CatalogProvider;
  voice_id: string;
  name: string;
  language: string | null;
  gender: string | null;
  model: string | null;
  /** Always a same-origin path (`/voices/sample?...`) — proxies/synthesizes regardless of provider so the frontend has one playback code path. */
  sample_url: string;
  /** indian | us | uk | au | ... when known, else null (provider labels / country; see voiceTraits). */
  accent: string | null;
  /** warm | calm | energetic | professional when known, else null. */
  tone: string | null;
}

// ---------- Accent and tone (B2) ----------
// Sarvam voices are Indian voices. ElevenLabs gives labels (accent,
// descriptive / description). Cartesia gives a country and a free-text
// description. Anything else is null: nothing is guessed from the name.
// VOICE_TRAIT_OVERRIDES pins values for specific voices ("provider:voice_id").

export const VOICE_TONES = ["warm", "calm", "energetic", "professional"] as const;

const VOICE_TRAIT_OVERRIDES: Record<string, { accent?: string | null; tone?: string | null }> = {
  // "cartesia:<voice id>": { accent: "indian", tone: "warm" },
};

const ACCENT_WORDS: Array<[RegExp, string]> = [
  [/\b(indian|india|hindi|hinglish)\b/i, "indian"],
  [/\b(american|usa?|united states)\b/i, "us"],
  [/\b(british|english \(uk\)|uk|england|london)\b/i, "uk"],
  [/\baustralian\b/i, "au"],
  [/\b(irish)\b/i, "irish"],
  [/\b(scottish)\b/i, "scottish"],
];
const COUNTRY_ACCENT: Record<string, string> = { IN: "indian", US: "us", GB: "uk", UK: "uk", AU: "au", IE: "irish" };
const TONE_WORDS: Array<[RegExp, string]> = [
  [/\b(warm|friendly|kind|caring|gentle|sweet)\b/i, "warm"],
  [/\b(calm|soothing|relaxed|soft|peaceful|serene|smooth)\b/i, "calm"],
  [/\b(energetic|upbeat|excited|lively|cheerful|enthusiastic|bright)\b/i, "energetic"],
  [/\b(professional|confident|authoritative|formal|clear|corporate|newsreader|narrat\w*)\b/i, "professional"],
];

function firstMatch(text: string | null | undefined, table: Array<[RegExp, string]>): string | null {
  if (!text) return null;
  for (const [re, v] of table) if (re.test(text)) return v;
  return null;
}

function withOverrides(provider: CatalogProvider, voiceId: string, accent: string | null, tone: string | null) {
  const o = VOICE_TRAIT_OVERRIDES[`${provider}:${voiceId}`];
  return { accent: o && "accent" in o ? o.accent ?? null : accent, tone: o && "tone" in o ? o.tone ?? null : tone };
}

// ---------- Sarvam: fixed speaker roster (kept in sync with
// routes/sarvam-tts-simulator.ts's BULBUL_V3_SPEAKERS — Sarvam has no
// "list voices" API, these are the only valid `speaker` values for bulbul:v3). ----------

const SARVAM_BULBUL_V3_SPEAKERS = {
  male: [
    "shubh", "aditya", "rahul", "rohan", "amit", "dev", "ratan", "varun",
    "manan", "sumit", "kabir", "aayan", "ashutosh", "advait", "anand",
    "tarun", "sunny", "mani", "gokul", "vijay", "mohit", "rehan", "soham",
  ],
  female: [
    "ritu", "priya", "neha", "pooja", "simran", "kavya", "ishita", "shreya",
    "roopa", "amelia", "sophia", "tanya", "shruti", "suhani", "kavitha", "rupali",
  ],
};

const SAMPLE_BY_LANG: Record<string, string> = {
  en: "Hello! This is how I sound on a natural phone conversation.",
  hi: "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
  mr: "नमस्कार! आजचा दिवस कसा आहे?",
  ta: "வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?",
  te: "నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?",
  bn: "নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
  gu: "નમસ્તે! હું તમારી કેવી રીતે મદદ કરી શકું?",
  kn: "ನಮಸ್ಕಾರ! ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಬಹುದು?",
  ml: "നമസ്കാരം! എനിക്ക് നിങ്ങളെ എങ്ങനെ സഹായിക്കാനാകും?",
  pa: "ਸਤ ਸ੍ਰੀ ਅਕਾਲ! ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦਾ ਹਾਂ?",
};

function sampleTextForLanguage(lang: string | null | undefined): string {
  const primary = (lang || "en").split(/[-_]/)[0]?.toLowerCase() || "en";
  return SAMPLE_BY_LANG[primary] ?? SAMPLE_BY_LANG.en;
}

/** Sarvam's `target_language_code` wants a full locale (e.g. "hi-IN"), not just "hi". */
const SARVAM_LOCALE_BY_PRIMARY: Record<string, string> = {
  en: "en-IN", hi: "hi-IN", mr: "mr-IN", ta: "ta-IN", te: "te-IN",
  bn: "bn-IN", gu: "gu-IN", kn: "kn-IN", ml: "ml-IN", pa: "pa-IN", od: "od-IN",
};

function normalizeSarvamSampleLanguage(lang: string | null | undefined): string {
  if (lang?.includes("-")) return lang;
  const primary = (lang || "en").trim().toLowerCase();
  return SARVAM_LOCALE_BY_PRIMARY[primary] ?? "en-IN";
}

function sampleUrl(provider: CatalogProvider, voiceId: string, model: string | null): string {
  const qs = new URLSearchParams({ provider, voice_id: voiceId });
  if (model) qs.set("model", model);
  return `/voices/sample?${qs.toString()}`;
}

function listSarvamCatalog(): VoiceCatalogEntry[] {
  const entries: VoiceCatalogEntry[] = [];
  for (const [gender, names] of Object.entries(SARVAM_BULBUL_V3_SPEAKERS)) {
    for (const name of names) {
      entries.push({
        provider: "sarvam",
        voice_id: name,
        name: name.charAt(0).toUpperCase() + name.slice(1),
        language: null, // works across all Sarvam-supported Indian languages
        gender,
        model: "bulbul:v3",
        sample_url: sampleUrl("sarvam", name, "bulbul:v3"),
        ...withOverrides("sarvam", name, "indian", null),
      });
    }
  }
  return entries;
}

async function listElevenLabsCatalog(): Promise<VoiceCatalogEntry[]> {
  const res = await elevenLabsListVoices();
  if (res.status !== 200 || !res.body || typeof res.body !== "object") return [];
  const voices = (res.body as { voices?: unknown[] }).voices;
  if (!Array.isArray(voices)) return [];
  return voices.map((raw): VoiceCatalogEntry => {
    const v = raw as Record<string, unknown>;
    const labels = (v.labels as Record<string, unknown> | undefined) ?? {};
    const verifiedLangs = v.verified_languages as Array<Record<string, unknown>> | undefined;
    const language =
      (verifiedLangs?.[0]?.locale as string | undefined) ??
      (verifiedLangs?.[0]?.language as string | undefined) ??
      (labels.language as string | undefined) ??
      null;
    const voiceId = String(v.voice_id ?? "");
    const label = (k: string) => (typeof labels[k] === "string" ? (labels[k] as string) : null);
    const accent = firstMatch(label("accent"), ACCENT_WORDS) ?? (label("accent")?.trim().toLowerCase() || null);
    const tone = firstMatch([label("descriptive"), label("description"), label("use_case")].filter(Boolean).join(" "), TONE_WORDS);
    return {
      provider: "elevenlabs",
      voice_id: voiceId,
      name: String(v.name ?? voiceId),
      language,
      gender: (labels.gender as string | undefined) ?? null,
      model: null,
      sample_url: sampleUrl("elevenlabs", voiceId, null),
      ...withOverrides("elevenlabs", voiceId, accent, tone),
    };
  });
}

async function listCartesiaCatalog(language?: string | null): Promise<VoiceCatalogEntry[]> {
  if (!cartesiaConfigured()) return [];
  const result = await cartesiaListVoices({
    limit: 100,
    expandPreview: true,
    language: language ?? undefined,
  });
  return result.voices.map((v): VoiceCatalogEntry => ({
    provider: "cartesia",
    voice_id: v.id,
    name: v.name,
    language: v.language ?? null,
    gender: v.gender ?? null,
    model: "sonic-3.5",
    sample_url: sampleUrl("cartesia", v.id, "sonic-3.5"),
    ...withOverrides(
      "cartesia",
      v.id,
      (v.country ? COUNTRY_ACCENT[v.country.toUpperCase()] : null) ?? firstMatch(v.description, ACCENT_WORDS),
      firstMatch(v.description, TONE_WORDS)
    ),
  }));
}

export interface VoiceCatalogFilter {
  /** BCP-47 or plain ISO-639-1 (e.g. "hi-IN" or "hi"). Sarvam voices always match (they work across every Sarvam-supported language, incl. the current hi/en/mr focus); ElevenLabs/Cartesia voices are filtered to this language's primary subtag. */
  language?: string | null;
  gender?: string | null;
  /** Exact match on `accent` (e.g. indian, us, uk). */
  accent?: string | null;
  /** Exact match on `tone` (warm, calm, energetic, professional). */
  tone?: string | null;
}

/**
 * Full cross-provider catalog. A provider whose API key isn't configured
 * (or whose call fails) is silently omitted rather than failing the whole
 * request — this is a convenience picker, not a health check.
 */
export async function listVoiceCatalog(filter: VoiceCatalogFilter = {}): Promise<VoiceCatalogEntry[]> {
  const lang = filter.language?.trim().toLowerCase().split(/[-_]/)[0] || null;
  const gender = filter.gender?.trim().toLowerCase() || null;

  const [elevenlabs, cartesia] = await Promise.all([
    listElevenLabsCatalog().catch(() => []),
    listCartesiaCatalog(lang).catch(() => []),
  ]);

  let all = [...listSarvamCatalog(), ...elevenlabs, ...cartesia];
  if (lang) {
    all = all.filter(
      (v) => v.provider === "sarvam" || !v.language || v.language.toLowerCase().split(/[-_]/)[0] === lang
    );
  }
  if (gender) {
    all = all.filter((v) => !v.gender || v.gender.toLowerCase() === gender);
  }
  const accent = filter.accent?.trim().toLowerCase() || null;
  const tone = filter.tone?.trim().toLowerCase() || null;
  if (accent) all = all.filter((v) => v.accent === accent);
  if (tone) all = all.filter((v) => v.tone === tone);
  return all;
}

/**
 * Synthesize (or proxy) a short sample for one catalog voice, regardless of
 * provider — backs `GET /voices/sample`.
 */
export interface VoiceSampleTuning {
  /** Speaking rate, 1 = normal. */
  speed?: number | null;
  /** Sarvam only: -0.75..0.75. */
  pitch?: number | null;
  /** Cartesia only (e.g. neutral, happy, calm, excited, sad). */
  emotion?: string | null;
  /** 1 = normal. Sarvam (loudness) and Cartesia. */
  volume?: number | null;
}

/** Tuning options each provider applies to a sample; the rest are ignored (reported back). */
export const SAMPLE_TUNING_SUPPORT: Record<CatalogProvider, Array<keyof VoiceSampleTuning>> = {
  sarvam: ["speed", "pitch", "volume"],
  elevenlabs: ["speed"],
  cartesia: ["speed", "volume", "emotion"],
};

export function ignoredTuning(provider: CatalogProvider, t: VoiceSampleTuning): string[] {
  return (Object.keys(t) as Array<keyof VoiceSampleTuning>).filter(
    (k) => t[k] != null && !SAMPLE_TUNING_SUPPORT[provider].includes(k)
  );
}

export async function synthesizeVoiceSample(params: {
  provider: CatalogProvider;
  voiceId: string;
  model?: string | null;
  language?: string | null;
  text?: string | null;
  tuning?: VoiceSampleTuning;
}): Promise<{ body: Buffer; contentType: string }> {
  const text = (params.text?.trim() || sampleTextForLanguage(params.language)).slice(0, 500);
  const t = params.tuning ?? {};

  if (params.provider === "sarvam") {
    const result = await sarvamTextToSpeech({
      text,
      target_language_code: normalizeSarvamSampleLanguage(params.language),
      model: (params.model as "bulbul:v3" | "bulbul:v2" | undefined) ?? "bulbul:v3",
      speaker: params.voiceId,
      speech_sample_rate: "22050",
      output_audio_codec: "wav",
      // Same fields (and ranges) agents use on calls: tts_pace / tts_pitch / tts_loudness.
      ...(t.speed != null ? { pace: Math.min(2, Math.max(0.5, t.speed)) } : {}),
      ...(t.pitch != null ? { pitch: Math.min(0.75, Math.max(-0.75, t.pitch)) } : {}),
      ...(t.volume != null ? { loudness: Math.min(3, Math.max(0.3, t.volume)) } : {}),
    });
    if (result.status !== 200 || !result.body || typeof result.body !== "object") {
      throw new Error("Sarvam sample synthesis failed");
    }
    const b64Audio = (result.body as { audios?: string[] }).audios?.[0];
    if (!b64Audio) throw new Error("No audio returned from Sarvam");
    return { body: Buffer.from(b64Audio, "base64"), contentType: "audio/wav" };
  }

  if (params.provider === "elevenlabs") {
    const modelId = resolveElevenLabsTtsModelId(params.model ?? "eleven_turbo_v2_5");
    const el = await elevenLabsTextToSpeech({
      voiceId: params.voiceId,
      text,
      modelId,
      outputFormat: "mp3_44100_128",
      languageCode: params.language?.split(/[-_]/)[0] || undefined,
      ...(t.speed != null ? { voiceSettings: { speed: t.speed } } : {}),
    });
    if (el.status !== 200 || !Buffer.isBuffer(el.body)) {
      throw new Error("ElevenLabs sample synthesis failed");
    }
    return { body: el.body, contentType: el.contentType || "audio/mpeg" };
  }

  // cartesia
  const modelId = resolveCartesiaModel(params.model ?? "sonic-3.5");
  const tts = await cartesiaTextToSpeech({
    transcript: text,
    modelId,
    voiceId: params.voiceId,
    language: params.language?.split(/[-_]/)[0] || "en",
    // With tuning: the same clamp calls use (normalizeCartesiaGenerationConfigForVoice), so it sounds like the agent.
    generationConfig:
      t.speed != null || t.volume != null || t.emotion
        ? normalizeCartesiaGenerationConfigForVoice({
            speed: t.speed ?? 1,
            volume: t.volume ?? 1,
            emotion: t.emotion ?? "neutral",
          })
        : { emotion: "neutral" },
    outputFormat: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
  });
  return { body: tts.body, contentType: tts.contentType };
}
