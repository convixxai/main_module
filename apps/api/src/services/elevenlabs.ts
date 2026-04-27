import { env } from "../config/env";

const ELEVEN_BASE = "https://api.elevenlabs.io";

/**
 * Premade voice available on **all** API keys (including free tier). Voice Library IDs return 402
 * (`paid_plan_required`) for free accounts.
 *
 * **Rachel** — works with multilingual models for en/hi/mr text; accent is not Indian. For Indian
 * library voices, set `ELEVENLABS_DEFAULT_INDIAN_MULTILINGUAL_VOICE_ID` or an `elevenlabs_avatars`
 * row on a paid plan.
 */
export const ELEVENLABS_PREMADE_API_SAFE_VOICE_ID = "21m00Tcm4TlvDq8ikWAM";

/** @alias {@link ELEVENLABS_PREMADE_API_SAFE_VOICE_ID} — default when no other voice is configured */
export const ELEVENLABS_BUILTIN_INDIAN_MULTILINGUAL_VOICE_ID =
  ELEVENLABS_PREMADE_API_SAFE_VOICE_ID;

/** True when TTS failed because the voice requires a paid plan / Voice Library access. */
export function elevenLabsTtsIsLibraryOrPaymentError(
  status: number,
  body: unknown
): boolean {
  if (status !== 402 && status !== 403) return false;
  const s = JSON.stringify(body ?? "").toLowerCase();
  return (
    s.includes("paid_plan") ||
    s.includes("payment_required") ||
    s.includes("library voice") ||
    s.includes("library voices") ||
    s.includes("free users cannot") ||
    s.includes("upgrade your subscription")
  );
}

function requireElevenLabsKey(): string {
  const key = (env.elevenlabs.apiKey || "").trim();
  if (!key) {
    throw new Error("ELEVENLABS_API_KEY is not configured");
  }
  return key;
}

/** Use DB `stt_model` when it looks like an ElevenLabs Scribe id; else default. */
export function resolveElevenLabsSttModelId(sttModel: string | null | undefined): string {
  const m = (sttModel || "").trim().toLowerCase();
  if (!m || m.includes("saaras") || m.includes("sarvam")) {
    return "scribe_v2";
  }
  return sttModel!.trim();
}

/** Use DB `tts_model` when it looks like an ElevenLabs voice model; else env default. */
export function resolveElevenLabsTtsModelId(ttsModel: string | null | undefined): string {
  const m = (ttsModel || "").trim().toLowerCase();
  if (!m || m.includes("bulbul") || m.includes("sarvam") || m.includes("saaras")) {
    return env.elevenlabs.defaultTtsModelId;
  }
  return (ttsModel || "").trim();
}

/** Map BCP-47 to ISO-639-1 / ISO-639-3 for ElevenLabs `language_code`; omit for auto-detect. */
export function bcp47ToElevenLabsLanguage(
  tag: string | null | undefined,
  options: { multilingual: boolean; forceEnglish?: boolean }
): string | undefined {
  if (!tag?.trim()) {
    return undefined;
  }
  const t = tag.trim().toLowerCase().replace(/_/g, "-");
  if (options.forceEnglish || t === "en" || t.startsWith("en-")) {
    return "en";
  }
  if (!options.multilingual) {
    return "en";
  }
  const primary = t.split("-")[0] || "";
  const map: Record<string, string> = {
    hi: "hi",
    mr: "mr",
    bn: "bn",
    ta: "ta",
    te: "te",
    kn: "kn",
    ml: "ml",
    gu: "gu",
    pa: "pa",
    ur: "ur",
    od: "or",
    or: "or",
    en: "en",
  };
  return map[primary] || undefined;
}

/** Map ElevenLabs `language_code` (e.g. eng, hin) to BCP-47 for downstream clamps. */
export function elevenLabsLanguageToBcp47(code: string | null | undefined): string {
  if (!code?.trim()) return "en-IN";
  const c = code.trim().toLowerCase();
  const map: Record<string, string> = {
    eng: "en-IN",
    en: "en-IN",
    hin: "hi-IN",
    hi: "hi-IN",
    mar: "mr-IN",
    mr: "mr-IN",
    ben: "bn-IN",
    bn: "bn-IN",
    tam: "ta-IN",
    ta: "ta-IN",
    tel: "te-IN",
    te: "te-IN",
    kan: "kn-IN",
    kn: "kn-IN",
    mal: "ml-IN",
    ml: "ml-IN",
    guj: "gu-IN",
    gu: "gu-IN",
    pan: "pa-IN",
    pa: "pa-IN",
  };
  return map[c] || "en-IN";
}

export async function elevenLabsSpeechToText(params: {
  fileBuffer: Buffer;
  filename?: string;
  modelId: string;
  /** ISO-639-1/3; omit for automatic language detection. */
  languageCode?: string;
}): Promise<{ status: number; body: unknown }> {
  const key = requireElevenLabsKey();
  const form = new FormData();
  form.append("model_id", params.modelId);
  form.append(
    "file",
    new Blob([new Uint8Array(params.fileBuffer)], { type: "audio/wav" }),
    params.filename || "audio.wav"
  );
  form.append("tag_audio_events", "false");
  form.append("diarize", "false");
  if (params.languageCode) {
    form.append("language_code", params.languageCode);
  }

  const res = await fetch(`${ELEVEN_BASE}/v1/speech-to-text`, {
    method: "POST",
    headers: {
      "xi-api-key": key,
    },
    body: form,
    signal: AbortSignal.timeout(60_000),
  });

  const body = await readJsonBody(res);
  return { status: res.status, body };
}

/** Normalize ElevenLabs STT JSON to Sarvam-shaped fields for shared callers. */
export function elevenLabsSttToSarvamShape(body: unknown): {
  transcript: string;
  language_code: string;
} {
  if (!body || typeof body !== "object") {
    return { transcript: "", language_code: "en-IN" };
  }
  const o = body as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text : "";
  const rawLang =
    typeof o.language_code === "string" ? o.language_code : "eng";
  return {
    transcript: text.trim(),
    language_code: elevenLabsLanguageToBcp47(rawLang),
  };
}

/** Subset of ElevenLabs `voice_settings` JSON (snake_case per API). */
export type ElevenLabsVoiceSettingsPayload = {
  stability?: number;
  similarity_boost?: number;
  style?: number;
  use_speaker_boost?: boolean;
  speed?: number;
};

export type ElevenLabsTtsParams = {
  voiceId: string;
  text: string;
  modelId: string;
  /** e.g. wav_8000, pcm_16000 — see ElevenLabs docs */
  outputFormat: string;
  voiceSettings?: ElevenLabsVoiceSettingsPayload | null;
};

/** Append to RAG system prompts when tenant TTS is ElevenLabs (v3-style audio tags). */
export const ELEVENLABS_RAG_AUDIO_TAGS_RULE = `--- ElevenLabs TTS delivery ---
Your reply will be read by ElevenLabs text-to-speech. For models that support delivery cues, you may insert short audio tags in square brackets before a phrase, e.g. [warmly], [thoughtful], [excited], [sighs], [whispers], [laughs]. Use sparingly (at most one tag every few sentences), only where it helps empathy or clarity on a phone call. Do not chain many tags. Keep tags in English.`;

/** True when the resolved TTS model id is ElevenLabs v3 (expressive / audio-tag oriented). */
export function elevenLabsTtsModelIsV3(modelId: string | null | undefined): boolean {
  const id = (modelId || "").trim().toLowerCase();
  return id === "eleven_v3";
}

/**
 * Extra RAG instructions when TTS uses `eleven_v3`: model should pick tags from user turn + history.
 */
export const ELEVENLABS_V3_AUDIO_DELIVERY_RULE = `--- ElevenLabs v3 expressive delivery ---
Your answer will be spoken with ElevenLabs **v3**, which uses bracketed **audio tags** before a phrase to set tone (e.g. [happy], [sympathetic], [excited], [calm], [warmly], [thoughtful], [curious], [whispers], [laughs], [sighs]).

You must choose tags **yourself** from: (1) the user's latest message, (2) prior turns in this conversation, and (3) the situation implied by the knowledgebase answer — so the voice matches empathy, energy, and clarity.

Rules:
- Put **one** tag immediately before the sentence or clause it colours, e.g. [happy] That's wonderful to hear. / [sympathetic] I'm sorry you're going through that.
- **Sparingly**: roughly one tag per one or two short sentences — never a stack of tags or a tag on every clause.
- **Vary** tags across turns when mood changes; do not repeat the same tag every reply.
- Tag names in **English** only. Tags are additive: they must not replace accurate RAG content or language rules.`;

/**
 * Fragment to append under RAG rules when tenant uses ElevenLabs TTS.
 * Adds v3-specific guidance when the resolved model is `eleven_v3` (from customer/agent \`tts_model\` after {@link resolveElevenLabsTtsModelId}).
 */
export function buildElevenLabsRagAudioTagHintForProvider(
  ttsProvider: string | null | undefined,
  ttsModelRaw: string | null | undefined
): string {
  if (ttsProvider !== "elevenlabs") return "";
  const resolved = resolveElevenLabsTtsModelId(ttsModelRaw);
  let s = `\n${ELEVENLABS_RAG_AUDIO_TAGS_RULE}\n`;
  if (elevenLabsTtsModelIsV3(resolved)) {
    s += `\n${ELEVENLABS_V3_AUDIO_DELIVERY_RULE}\n`;
  }
  return s;
}

export async function elevenLabsTextToSpeech(
  params: ElevenLabsTtsParams
): Promise<{ status: number; body: Buffer | unknown; contentType?: string }> {
  const key = requireElevenLabsKey();
  const q = new URLSearchParams({ output_format: params.outputFormat });
  const bodyObj: Record<string, unknown> = {
    text: params.text.slice(0, 2500),
    model_id: params.modelId,
  };
  const vs = normalizeVoiceSettingsForApi(params.voiceSettings);
  if (vs) bodyObj.voice_settings = vs;

  const res = await fetch(
    `${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}?${q}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(60_000),
    }
  );

  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const errBody = ct.includes("json") ? await readJsonBody(res) : await res.text();
    return { status: res.status, body: errBody, contentType: ct };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf, contentType: ct };
}

/** Prefer WAV for telephony: same PCM payload as `pcm_*` but with a RIFF header (matches Sarvam path). */
export function elevenLabsWavOutputFormat(sampleRate: number): string {
  if (sampleRate <= 8000) return "wav_8000";
  if (sampleRate <= 16000) return "wav_16000";
  if (sampleRate <= 22050) return "wav_22050";
  if (sampleRate <= 24000) return "wav_24000";
  if (sampleRate <= 32000) return "wav_32000";
  if (sampleRate <= 48000) return "wav_48000";
  return "wav_44100";
}

/**
 * ElevenLabs `output_format` for Exotel-style streams. `eleven_v3` often rejects or mishandles
 * `wav_8000` / low-rate WAV; synthesize at 22.05 kHz linear PCM and let the caller resample to
 * the trunk sample rate (e.g. 8000 Hz).
 */
export function elevenLabsTtsOutputFormatForTelephony(
  modelId: string,
  exotelSampleRate: number
): string {
  if (elevenLabsTtsModelIsV3(modelId)) {
    return "pcm_22050";
  }
  return elevenLabsWavOutputFormat(exotelSampleRate);
}

/** Pick ElevenLabs `output_format` from desired PCM sample rate (telephony). */
export function elevenLabsPcmOutputFormat(sampleRate: number): string {
  if (sampleRate <= 8000) return "pcm_8000";
  if (sampleRate <= 16000) return "pcm_16000";
  if (sampleRate <= 22050) return "pcm_22050";
  if (sampleRate <= 24000) return "pcm_24000";
  return "pcm_44100";
}

/**
 * Sample rate of decoded PCM after stripping WAV header, or of raw `pcm_*` / `ulaw_*` payloads.
 * Uses the numeric suffix from formats like `wav_16000`, `pcm_24000`, `ulaw_8000`.
 */
export function pcmSampleRateFromElevenOutputFormat(outputFormat: string): number {
  const f = outputFormat.toLowerCase();
  const m = f.match(/_(\d+)$/);
  if (m) return parseInt(m[1]!, 10);
  return 8000;
}

/** Allowed query keys forwarded to ElevenLabs `GET /v1/voices` (see OpenAPI /docs). */
const ELEVENLABS_LIST_VOICES_QUERY_KEYS = new Set([
  "show_legacy",
  "page_size",
  "next_page_token",
]);

/** `GET /v1/voices` — list workspace voices (for UI / speaker picker). */
export async function elevenLabsListVoices(
  query?: Record<string, string | undefined> | null
): Promise<{
  status: number;
  body: unknown;
}> {
  const key = requireElevenLabsKey();
  const params = new URLSearchParams();
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === "") continue;
      if (!ELEVENLABS_LIST_VOICES_QUERY_KEYS.has(k)) continue;
      params.set(k, v);
    }
  }
  const qs = params.toString();
  const url =
    qs.length > 0
      ? `${ELEVEN_BASE}/v1/voices?${qs}`
      : `${ELEVEN_BASE}/v1/voices`;
  const res = await fetch(url, {
    method: "GET",
    headers: { "xi-api-key": key },
    signal: AbortSignal.timeout(60_000),
  });
  const body = await readJsonBody(res);
  return { status: res.status, body };
}

function normalizeVoiceSettingsForApi(
  raw: ElevenLabsVoiceSettingsPayload | null | undefined
): ElevenLabsVoiceSettingsPayload | null {
  if (!raw || typeof raw !== "object") return null;
  const o: ElevenLabsVoiceSettingsPayload = {};
  const r = raw as Record<string, unknown>;
  const num = (k: string) => {
    const v = r[k];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const bool = (k: string) => {
    const v = r[k];
    return typeof v === "boolean" ? v : undefined;
  };
  const stability = num("stability");
  const similarity_boost = num("similarity_boost");
  const style = num("style");
  const speed = num("speed");
  const use_speaker_boost = bool("use_speaker_boost");
  if (stability !== undefined) o.stability = stability;
  if (similarity_boost !== undefined) o.similarity_boost = similarity_boost;
  if (style !== undefined) o.style = style;
  if (speed !== undefined) o.speed = speed;
  if (use_speaker_boost !== undefined) o.use_speaker_boost = use_speaker_boost;
  return Object.keys(o).length ? o : null;
}

async function readJsonBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 2000) };
  }
}
