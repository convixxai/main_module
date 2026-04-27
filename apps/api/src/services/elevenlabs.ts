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

const ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS: Required<ElevenLabsVoiceSettingsPayload> = {
  stability: 0.35,
  similarity_boost: 0.9,
  style: 0.2,
  use_speaker_boost: true,
  speed: 1.0,
};

/**
 * ElevenLabs can pronounce bracket delivery tags literally depending on voice/model/account.
 * Keep LLM-facing text natural, and strip old/generated [warmly]-style prefixes before TTS.
 */
export function sanitizeTextForElevenLabsTts(text: string): string {
  return text
    .replace(/(^|[\s.!?।…])\[[A-Za-z][A-Za-z\s_-]{0,32}\]\s*/g, "$1")
    .replace(/\s+([,.!?।…])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Append to RAG system prompts when tenant TTS is ElevenLabs. */
export const ELEVENLABS_RAG_AUDIO_TAGS_RULE = `--- ElevenLabs TTS delivery ---
Your reply will be read by ElevenLabs text-to-speech. Do NOT write bracketed emotion or delivery tags like [warmly], [happy], [sighs], or [laughs], because they may be spoken aloud. Make the voice sound human using natural wording, contractions where appropriate, and short sentences with commas and periods for pauses.`;

/** True when the resolved TTS model id is ElevenLabs v3 (expressive / audio-tag oriented). */
export function elevenLabsTtsModelIsV3(modelId: string | null | undefined): boolean {
  const id = (modelId || "").trim().toLowerCase();
  return id === "eleven_v3";
}

/**
 * Extra RAG instructions when TTS uses `eleven_v3`: model should pick tags from user turn + history.
 */
export const ELEVENLABS_V3_AUDIO_DELIVERY_RULE = `--- ElevenLabs v3 expressive delivery ---
Your answer will be spoken with ElevenLabs **v3**. Do NOT output bracketed audio/emotion tags; in this deployment they are read as words. Express tone through natural phrasing and punctuation only.

Choose the tone yourself from: (1) the user's latest message, (2) prior turns in this conversation, and (3) the situation implied by the knowledgebase answer — so the voice matches empathy, energy, and clarity.

Rules:
- Never include square-bracket stage directions or emotion labels in the final answer.
- Use conversational pauses with commas and periods.
- Vary wording across turns when mood changes; do not repeat the same canned phrase.
- Tone must not replace accurate RAG content or language rules.`;

/**
 * When `customer_settings.tts_model` is `eleven_v3`: required bracketed emotion/delivery prefix per sentence for LLM output.
 */
export const ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE = `--- ElevenLabs eleven_v3 — required [emotion] prefixes ---
Your reply will be read by ElevenLabs **eleven_v3**. Do NOT write square-bracket emotion or delivery prefixes. In this deployment, bracket text is spoken aloud, so it must not appear in the final answer.

Use natural, human delivery instead: short sentences, contractions where appropriate, commas for small pauses, and warm conversational phrasing.

Requirements:
- Never include text like [happy], [calm], [warmly], [laughs], [sighs], or any other bracketed stage direction.
- Keep the answer suitable for phone audio: brief, natural, and easy to speak.
- Keep facts accurate per the KNOWLEDGEBASE and obey all language/locale rules.`;

/**
 * Fragment to append under RAG rules when tenant uses ElevenLabs TTS.
 * When `customer_settings.tts_model` is `eleven_v3`, adds strict per-sentence tag rules (LLM).
 * Otherwise, if the resolved model is `eleven_v3` (agent/customer after {@link resolveElevenLabsTtsModelId}), adds the lighter v3 hint.
 */
export function buildElevenLabsRagAudioTagHintForProvider(
  ttsProvider: string | null | undefined,
  ttsModelRaw: string | null | undefined,
  opts?: { customerTtsModelRaw?: string | null }
): string {
  if (ttsProvider !== "elevenlabs") return "";
  const customerV3 = elevenLabsTtsModelIsV3(opts?.customerTtsModelRaw);
  if (customerV3) {
    return `\n${ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE}\n`;
  }
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
  const cleanText = sanitizeTextForElevenLabsTts(params.text).slice(0, 2500);
  const bodyObj: Record<string, unknown> = {
    text: cleanText,
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

export async function elevenLabsTextToSpeechStream(
  params: ElevenLabsTtsParams
): Promise<{ status: number; body: Buffer | unknown; contentType?: string }> {
  const key = requireElevenLabsKey();
  const q = new URLSearchParams({ output_format: params.outputFormat });
  const cleanText = sanitizeTextForElevenLabsTts(params.text).slice(0, 2500);
  const bodyObj: Record<string, unknown> = {
    text: cleanText,
    model_id: params.modelId,
  };
  const vs = normalizeVoiceSettingsForApi(params.voiceSettings);
  if (vs) bodyObj.voice_settings = vs;

  const res = await fetch(
    `${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}/stream?${q}`,
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

  const chunks: Buffer[] = [];
  if (res.body) {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (chunk && chunk.length > 0) chunks.push(Buffer.from(chunk));
    }
  } else {
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  return { status: res.status, body: Buffer.concat(chunks), contentType: ct };
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
  const o: ElevenLabsVoiceSettingsPayload = { ...ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS };
  if (!raw || typeof raw !== "object") return o;
  const r = raw as Record<string, unknown>;
  const num = (k: string, min: number, max: number) => {
    const v = r[k];
    if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
    return Math.min(max, Math.max(min, v));
  };
  const bool = (k: string) => {
    const v = r[k];
    return typeof v === "boolean" ? v : undefined;
  };
  const stability = num("stability", 0, 1);
  const similarity_boost = num("similarity_boost", 0, 1);
  const style = num("style", 0, 1);
  const speed = num("speed", 0.7, 1.0);
  const use_speaker_boost = bool("use_speaker_boost");
  if (stability !== undefined) o.stability = stability;
  if (similarity_boost !== undefined) o.similarity_boost = similarity_boost;
  if (style !== undefined) o.style = style;
  if (speed !== undefined) o.speed = speed;
  if (use_speaker_boost !== undefined) o.use_speaker_boost = use_speaker_boost;
  return o;
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
