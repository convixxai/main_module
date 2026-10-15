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
    return {
      provider: "elevenlabs",
      voice_id: voiceId,
      name: String(v.name ?? voiceId),
      language,
      gender: (labels.gender as string | undefined) ?? null,
      model: null,
      sample_url: sampleUrl("elevenlabs", voiceId, null),
    };
  });
}

async function listCartesiaCatalog(): Promise<VoiceCatalogEntry[]> {
  if (!cartesiaConfigured()) return [];
  const result = await cartesiaListVoices({ limit: 100, expandPreview: true });
  return result.voices.map((v): VoiceCatalogEntry => ({
    provider: "cartesia",
    voice_id: v.id,
    name: v.name,
    language: v.language ?? null,
    gender: v.gender ?? null,
    model: "sonic-3.5",
    sample_url: sampleUrl("cartesia", v.id, "sonic-3.5"),
  }));
}

/**
 * Full cross-provider catalog. A provider whose API key isn't configured
 * (or whose call fails) is silently omitted rather than failing the whole
 * request — this is a convenience picker, not a health check.
 */
export async function listVoiceCatalog(): Promise<VoiceCatalogEntry[]> {
  const [elevenlabs, cartesia] = await Promise.all([
    listElevenLabsCatalog().catch(() => []),
    listCartesiaCatalog().catch(() => []),
  ]);
  return [...listSarvamCatalog(), ...elevenlabs, ...cartesia];
}

/**
 * Synthesize (or proxy) a short sample for one catalog voice, regardless of
 * provider — backs `GET /voices/sample`.
 */
export async function synthesizeVoiceSample(params: {
  provider: CatalogProvider;
  voiceId: string;
  model?: string | null;
  language?: string | null;
  text?: string | null;
}): Promise<{ body: Buffer; contentType: string }> {
  const text = (params.text?.trim() || sampleTextForLanguage(params.language)).slice(0, 500);

  if (params.provider === "sarvam") {
    const result = await sarvamTextToSpeech({
      text,
      target_language_code: "en-IN",
      model: (params.model as "bulbul:v3" | "bulbul:v2" | undefined) ?? "bulbul:v3",
      speaker: params.voiceId,
      speech_sample_rate: "22050",
      output_audio_codec: "wav",
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
    generationConfig: { emotion: "neutral" },
    outputFormat: { container: "mp3", sample_rate: 44100, bit_rate: 128000 },
  });
  return { body: tts.body, contentType: tts.contentType };
}
