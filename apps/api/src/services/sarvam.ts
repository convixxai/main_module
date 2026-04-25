import { env } from "../config/env";

const SARVAM_BASE = "https://api.sarvam.ai";

export type SarvamSttMode =
  | "transcribe"
  | "translate"
  | "verbatim"
  | "translit"
  | "codemix";

export interface SarvamSttResult {
  request_id: string | null;
  transcript: string;
  language_code: string | null;
}

export interface SarvamTtsBody {
  text: string;
  target_language_code: string;
  speaker?: string | null;
  model?: "bulbul:v3" | "bulbul:v2" | string;
  pace?: number | null;
  speech_sample_rate?: string | null;
  output_audio_codec?: string | null;
  temperature?: number | null;
  pitch?: number | null;
  loudness?: number | null;
  enable_preprocessing?: boolean;
  dict_id?: string | null;
}

export interface SarvamTtsResult {
  request_id: string | null;
  audios: string[];
}

function requireSarvamKey(): string {
  const key = env.sarvam.apiKey;
  if (!key) {
    throw new Error("SARVAM_API_KEY is not configured");
  }
  return key;
}

export async function sarvamSpeechToText(params: {
  fileBuffer: Buffer;
  filename: string;
  mimeType: string;
  model?: string;
  mode?: SarvamSttMode;
  language_code?: string;
}): Promise<{ status: number; body: unknown }> {
  const key = requireSarvamKey();
  const model = params.model ?? "saaras:v3";
  const mode = params.mode ?? "transcribe";

  const form = new FormData();
  form.append("model", model);
  form.append("mode", mode);
  if (params.language_code) {
    form.append("language_code", params.language_code);
  }
  const bytes = new Uint8Array(params.fileBuffer);
  form.append(
    "file",
    new Blob([bytes], { type: params.mimeType }),
    params.filename
  );

  const res = await fetch(`${SARVAM_BASE}/speech-to-text`, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
    },
    body: form,
  });

  const body = await readJsonBody(res);
  return { status: res.status, body };
}

export async function sarvamTextToSpeech(
  payload: SarvamTtsBody
): Promise<{ status: number; body: unknown }> {
  const key = requireSarvamKey();

  const res = await fetch(`${SARVAM_BASE}/text-to-speech`, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const body = await readJsonBody(res);
  return { status: res.status, body };
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

/** `sarvam-translate:v1` source languages (lowercase keys); see Sarvam API docs. */
const SARVAM_TRANSLATE_V1_SOURCE_CODES = new Set(
  [
    "as-IN",
    "bn-IN",
    "brx-IN",
    "doi-IN",
    "gu-IN",
    "hi-IN",
    "kn-IN",
    "ks-IN",
    "kok-IN",
    "mai-IN",
    "ml-IN",
    "mni-IN",
    "mr-IN",
    "ne-IN",
    "od-IN",
    "pa-IN",
    "sa-IN",
    "sat-IN",
    "sd-IN",
    "ta-IN",
    "te-IN",
    "ur-IN",
  ].map((c) => c.toLowerCase())
);

function normalizeBcp47ForSarvam(tag: string): string {
  const t = tag.trim().replace(/_/g, "-");
  const parts = t.split("-").filter(Boolean);
  if (parts.length === 0) return t;
  const lang = parts[0]!.toLowerCase();
  const rest = parts.slice(1).map((p, i) => (i === 0 ? p.toUpperCase() : p));
  if (rest.length === 0) return lang;
  return [lang, ...rest].join("-");
}

/**
 * Indic (or auto-detected) → English for KB vector search. Same API key as STT/TTS; low-latency path.
 * Returns the original `input` on failure (caller may still use it for embedding).
 */
export async function sarvamTranslateToEnglishForSearch(
  input: string,
  sourceLanguageBcp47: string | null
): Promise<{ ok: boolean; text: string }> {
  const key = (env.sarvam.apiKey || "").trim();
  if (!key) {
    return { ok: false, text: input.trim() };
  }
  const text = input.trim();
  if (!text) {
    return { ok: true, text };
  }
  // Hard limit per Sarvam translate docs (sarvam-translate has higher than Mayura).
  const payloadText = text.length > 2000 ? text.slice(0, 2000) : text;

  const normalized = sourceLanguageBcp47
    ? normalizeBcp47ForSarvam(sourceLanguageBcp47)
    : null;
  const n = normalized ? normalized.toLowerCase() : "";
  const isEnglish = n === "en" || n.startsWith("en-");
  const useSarvamTranslateV1 =
    Boolean(normalized) && !isEnglish && SARVAM_TRANSLATE_V1_SOURCE_CODES.has(n);

  const body: Record<string, string> = {
    input: payloadText,
    target_language_code: "en-IN",
  };

  if (useSarvamTranslateV1 && normalized) {
    body.source_language_code = normalized;
    body.model = "sarvam-translate:v1";
  } else {
    // Unknown or unlisted: Mayura `auto` → English
    body.source_language_code = "auto";
    body.model = "mayura:v1";
  }

  const res = await fetch(`${SARVAM_BASE}/translate`, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const raw = await readJsonBody(res);
  if (!res.ok) {
    return { ok: false, text: input.trim() };
  }
  if (!raw || typeof raw !== "object") {
    return { ok: false, text: input.trim() };
  }
  const o = raw as Record<string, unknown>;
  const translated =
    typeof o.translated_text === "string"
      ? o.translated_text
      : typeof o.translatedText === "string"
        ? o.translatedText
        : "";
  const out = translated.trim();
  if (!out) {
    return { ok: false, text: input.trim() };
  }
  return { ok: true, text: out };
}
