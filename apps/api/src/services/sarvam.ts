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
  model?: "bulbul:v3" | "bulbul:v2";
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
