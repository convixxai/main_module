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
  /** Higher than legacy 0.35 — smoother prosody across clauses, fewer audible “resets” on telephony. */
  stability: 0.48,
  similarity_boost: 0.88,
  /** Lower than legacy 0.2 — less theatrical drift on short sentences. */
  style: 0.12,
  use_speaker_boost: true,
  speed: 1.0,
};

/** Light cleanup before TTS: spacing and newlines; shared by voicebot and HTTP `/ask` paths. */
export function polishElevenLabsVoicebotText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\.{2,}/g, ".")
    .trim();
}

/**
 * Strip bracket tags for ElevenLabs models that are **not** `eleven_v3` (they often read tags as words).
 */
export function sanitizeTextForElevenLabsTts(text: string): string {
  return text
    .replace(/(^|[\s.!?।…])\[[^\]]{1,48}\]\s*/g, "$1")
    .replace(/\s+([,.!?।…])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Trim inside `[ ... ]` so `[sad ]` and `[ happy]` work reliably for Eleven v3 audio tags. */
export function normalizeElevenV3AudioTagsInText(text: string): string {
  return text
    .replace(/\[([^\]]*?)\]/g, (_, inner: string) => {
      const t = inner.trim().replace(/\s+/g, " ");
      return t.length > 0 ? `[${t}]` : "";
    })
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Text sent to ElevenLabs: v3 keeps (normalized) audio tags unless `env.elevenlabs.v3StripAudioTags`. */
export function prepareTextForElevenLabsTts(text: string, modelId: string): string {
  const polished = polishElevenLabsVoicebotText(text);
  const capped = polished.slice(0, 2500);
  if (env.elevenlabs.v3StripAudioTags || !elevenLabsTtsModelIsV3(modelId)) {
    return sanitizeTextForElevenLabsTts(capped);
  }
  return normalizeElevenV3AudioTagsInText(capped);
}

/** Append to RAG system prompts when tenant TTS is ElevenLabs (non–v3 models). */
export const ELEVENLABS_RAG_AUDIO_TAGS_RULE = `--- ElevenLabs TTS delivery ---
Your reply will be read by ElevenLabs text-to-speech. Do NOT use square-bracket tags like [happy] or [sighs] unless the tenant uses model **eleven_v3** (this rule applies to other ElevenLabs models). For natural speech here, use wording, commas, and periods only.`;

/** True when the resolved TTS model id is ElevenLabs v3 (expressive / audio-tag oriented). */
export function elevenLabsTtsModelIsV3(modelId: string | null | undefined): boolean {
  const id = (modelId || "").trim().toLowerCase();
  return id === "eleven_v3";
}

/**
 * Extra RAG instructions when TTS uses `eleven_v3`: model should pick tags from user turn + history.
 */
export const ELEVENLABS_V3_AUDIO_DELIVERY_RULE = `--- ElevenLabs v3 audio tags ---
Your answer will be spoken with ElevenLabs **eleven_v3**, which supports **audio tags**: short cues in square brackets placed **immediately before** the phrase they colour (e.g. [warmly] Thanks for calling. [curious] What dates work for you?).

Use tags from: (1) the user's latest message, (2) prior turns, (3) the situation implied by the knowledgebase — empathy, energy, and clarity on a phone call.

Rules:
- Prefer **one** tag per sentence or main clause; do not stack many tags in a row.
- Use tags Eleven v3 understands: emotions like [happy], [sad], [excited], [calm], [sympathetic]; delivery like [whispers], [laughs], [sighs], [thoughtful], [curious]. Keep tag text **English** and **no extra spaces inside brackets** (write [sad] not [sad ]).
- Tags must not replace facts: still obey the KNOWLEDGEBASE and language/locale rules.
- Also use natural punctuation (commas, periods) for pauses; v3 does not use SSML breaks.`;

/**
 * When `customer_settings.tts_model` is `eleven_v3`: stronger tag usage for expressiveness.
 */
export const ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE = `--- ElevenLabs eleven_v3 — audio tags required ---
Your reply will be read with **eleven_v3**. You MUST use ElevenLabs **audio tags** in square brackets so the voice sounds human and expressive.

Requirements:
- **Every sentence** you output should start with **exactly one** audio tag right before the words, e.g. [happy] Great question. [calm] Here is what we offer.
- The full reply MUST include **at least one** tag (single-sentence answers still start with a tag).
- Use concise English tags: [happy], [sad], [excited], [warmly], [sympathetic], [curious], [reassuring], [thoughtful], [whispers], [laughs], [sighs], etc. No spaces inside brackets.
- Do not put the whole sentence inside brackets — only the short tag in brackets, then normal spoken text.
- Keep content accurate per the KNOWLEDGEBASE and obey all language/locale rules.`;

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
  const cleanText = prepareTextForElevenLabsTts(params.text, params.modelId);
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
  const cleanText = prepareTextForElevenLabsTts(params.text, params.modelId);
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
 *
 * **Streaming** (`/v1/text-to-speech/.../stream`): API returns 400 for `wav_*` — use `pcm_*` only.
 */
export function elevenLabsTtsOutputFormatForTelephony(
  modelId: string,
  exotelSampleRate: number,
  opts?: { streaming?: boolean }
): string {
  if (elevenLabsTtsModelIsV3(modelId)) {
    return "pcm_22050";
  }
  if (opts?.streaming === true) {
    return elevenLabsPcmOutputFormat(exotelSampleRate);
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
