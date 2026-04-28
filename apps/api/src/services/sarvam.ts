import { env } from "../config/env";
import WebSocket from "ws";

const SARVAM_BASE = "https://api.sarvam.ai";
const SARVAM_WS_BASE = "wss://api.sarvam.ai";

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

/**
 * Sarvam HTTP streaming TTS — `POST /text-to-speech/stream` (binary WAV/MP3/…).
 * @see https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/http-stream
 */
export async function sarvamTextToSpeechStream(payload: {
  text: string;
  target_language_code: string;
  speaker?: string | null;
  model?: string;
  pace?: number | null;
  speech_sample_rate?: number;
  output_audio_codec?: string;
  temperature?: number | null;
  pitch?: number | null;
  loudness?: number | null;
  enable_preprocessing?: boolean;
  dict_id?: string | null;
}): Promise<{
  status: number;
  body: unknown;
  /** Raw audio when status is 200 */
  audioBuffer?: Buffer;
  contentType?: string | null;
}> {
  const key = requireSarvamKey();
  const body: Record<string, unknown> = {
    text: payload.text.slice(0, 3500),
    target_language_code: payload.target_language_code,
    model: payload.model ?? "bulbul:v3",
    output_audio_codec: payload.output_audio_codec ?? "wav",
  };
  if (payload.speaker) body.speaker = payload.speaker;
  if (payload.speech_sample_rate != null) {
    body.speech_sample_rate = payload.speech_sample_rate;
  }
  if (payload.pace != null && !Number.isNaN(payload.pace)) body.pace = payload.pace;
  if (payload.temperature != null && !Number.isNaN(payload.temperature)) {
    body.temperature = payload.temperature;
  }
  if (payload.pitch != null && !Number.isNaN(payload.pitch)) body.pitch = payload.pitch;
  if (payload.loudness != null && !Number.isNaN(payload.loudness)) {
    body.loudness = payload.loudness;
  }
  if (payload.enable_preprocessing === true) body.enable_preprocessing = true;
  if (payload.dict_id) body.dict_id = payload.dict_id;

  const res = await fetch(`${SARVAM_BASE}/text-to-speech/stream`, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const ct = res.headers.get("content-type");
  if (!res.ok) {
    const errBody = await readJsonBody(res);
    return { status: res.status, body: errBody, contentType: ct };
  }
  const ab = await res.arrayBuffer();
  return {
    status: 200,
    body: { streamed: true },
    audioBuffer: Buffer.from(ab),
    contentType: ct,
  };
}

/**
 * True incremental streaming TTS — yields PCM chunks as they arrive from Sarvam
 * instead of buffering the full response body. Each yielded Buffer is aligned to
 * `alignBytes` (default 320, Exotel's requirement) and at least `minChunkBytes`
 * (default 3200, Exotel's minimum for jitter-free playback).
 *
 * Caller should request `output_audio_codec: "linear16"` at the target sample rate
 * so the body is headerless raw s16le PCM — no RIFF parsing needed.
 */
export async function* sarvamTtsStreamIncremental(payload: {
  text: string;
  target_language_code: string;
  speaker?: string | null;
  model?: string;
  pace?: number | null;
  speech_sample_rate?: number;
  output_audio_codec?: string;
  temperature?: number | null;
  pitch?: number | null;
  loudness?: number | null;
  enable_preprocessing?: boolean;
  dict_id?: string | null;
  /** Minimum bytes per yielded chunk (default 3200 = Exotel min). */
  minChunkBytes?: number;
  /** Alignment in bytes (default 320 = Exotel requirement). */
  alignBytes?: number;
}): AsyncGenerator<Buffer, void, unknown> {
  const key = requireSarvamKey();
  const body: Record<string, unknown> = {
    text: payload.text.slice(0, 3500),
    target_language_code: payload.target_language_code,
    model: payload.model ?? "bulbul:v3",
    output_audio_codec: payload.output_audio_codec ?? "linear16",
  };
  if (payload.speaker) body.speaker = payload.speaker;
  if (payload.speech_sample_rate != null) {
    body.speech_sample_rate = payload.speech_sample_rate;
  }
  if (payload.pace != null && !Number.isNaN(payload.pace)) body.pace = payload.pace;
  if (payload.temperature != null && !Number.isNaN(payload.temperature)) {
    body.temperature = payload.temperature;
  }
  if (payload.pitch != null && !Number.isNaN(payload.pitch)) body.pitch = payload.pitch;
  if (payload.loudness != null && !Number.isNaN(payload.loudness)) {
    body.loudness = payload.loudness;
  }
  if (payload.enable_preprocessing === true) body.enable_preprocessing = true;
  if (payload.dict_id) body.dict_id = payload.dict_id;

  const align = payload.alignBytes ?? 320;
  const minChunk = payload.minChunkBytes ?? 3200;

  const res = await fetch(`${SARVAM_BASE}/text-to-speech/stream`, {
    method: "POST",
    headers: {
      "api-subscription-key": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Sarvam TTS stream HTTP ${res.status}`);
  }
  if (!res.body) {
    throw new Error("Sarvam TTS stream: no response body");
  }

  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  let pending = Buffer.alloc(0);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = Buffer.concat([pending, Buffer.from(value)]);

    while (pending.length >= minChunk) {
      const aligned = Math.floor(pending.length / align) * align;
      if (aligned < minChunk) break;
      const take = Math.min(aligned, 102400);
      yield pending.subarray(0, take);
      pending = pending.subarray(take);
    }
  }
  // Flush remaining: pad to alignment, then to min chunk if needed.
  if (pending.length > 0) {
    const rem = pending.length % align;
    if (rem !== 0) {
      pending = Buffer.concat([pending, Buffer.alloc(align - rem, 0)]);
    }
    if (pending.length < minChunk) {
      pending = Buffer.concat([pending, Buffer.alloc(minChunk - pending.length, 0)]);
    }
    yield pending;
  }
}

/** Models supported on Sarvam STT WebSocket (see API reference). */
export function sarvamSttWebsocketModelSupported(model: string | undefined): boolean {
  const m = (model ?? "saaras:v3").trim().toLowerCase();
  return m.startsWith("saaras:") || m.startsWith("saarika:");
}

/**
 * One-shot STT over Sarvam WebSocket: full utterance in, final transcript out.
 * @see https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws
 * @see https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api
 */
export async function sarvamSpeechToTextWebsocket(params: {
  wavBuffer: Buffer;
  sampleRate: number;
  model: string;
  mode: SarvamSttMode;
  language_code: string;
  /** When true (e.g. Exotel stream ended), close the socket and fail fast so work does not block ~60s. */
  shouldAbort?: () => boolean;
}): Promise<{ status: number; body: unknown }> {
  const key = requireSarvamKey();
  const sr = params.sampleRate === 8000 ? 8000 : 16000;
  const model = params.model || "saaras:v3";
  const languageCode = params.language_code.trim() || "unknown";

  const u = new URL(`${SARVAM_WS_BASE}/speech-to-text/ws`);
  u.searchParams.set("language-code", languageCode);
  u.searchParams.set("model", model);
  u.searchParams.set("mode", params.mode);
  u.searchParams.set("sample_rate", String(sr));
  u.searchParams.set("input_audio_codec", "wav");
  u.searchParams.set("flush_signal", "true");
  u.searchParams.set("high_vad_sensitivity", "false");

  return await new Promise((resolve) => {
    const ws = new WebSocket(u.toString(), {
      headers: {
        "api-subscription-key": key,
        "Api-Subscription-Key": key,
      },
      handshakeTimeout: 15_000,
    });

    let lastTranscript = "";
    let lastLang: string | null = null;
    let lastLangProb: number | null = null;
    let lastRequestId: string | null = null;
    let settled = false;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    let firstDataTimer: ReturnType<typeof setTimeout> | null = null;
    const idleMs = env.sarvam.sttWsIdleAfterTranscriptMs;
    const firstDataMs = env.sarvam.sttWsFirstDataTimeoutMs;
    const maxWait = env.sarvam.sttWsHardTimeoutMs;
    let abortPoll: ReturnType<typeof setInterval> | null = null;

    let hardTimeout: ReturnType<typeof setTimeout>;
    const finish = (status: number, body: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardTimeout);
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
      if (firstDataTimer) {
        clearTimeout(firstDataTimer);
        firstDataTimer = null;
      }
      if (abortPoll) {
        clearInterval(abortPoll);
        abortPoll = null;
      }
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      resolve({ status, body });
    };

    hardTimeout = setTimeout(() => {
      if (!settled) {
        finish(504, { error: "Sarvam STT WebSocket hard timeout" });
      }
    }, maxWait);

    abortPoll = setInterval(() => {
      if (settled) return;
      if (params.shouldAbort?.()) {
        finish(499, { error: "Sarvam STT WebSocket aborted (session closing)" });
      }
    }, 200);

    const scheduleIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!settled) {
          finish(200, {
            request_id: lastRequestId,
            transcript: lastTranscript,
            language_code: lastLang ?? "en-IN",
            language_probability: lastLangProb,
          });
        }
      }, idleMs);
    };

    ws.on("error", (err) => {
      if (!settled) {
        finish(500, { error: String(err) });
      }
    });

    ws.on("message", (data: WebSocket.RawData) => {
      const text = data.toString();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return;
      }
      const p = parsed as { type?: string; data?: unknown };
      if (p.type === "data" && p.data && typeof p.data === "object") {
        const d = p.data as Record<string, unknown>;
        if (typeof d.error === "string" && d.code) {
          finish(400, { error: d.error, code: d.code });
          return;
        }
        if (typeof d.transcript === "string") {
          lastTranscript = d.transcript;
          lastLang = typeof d.language_code === "string" ? d.language_code : null;
          const lp = d.language_probability;
          if (typeof lp === "number" && Number.isFinite(lp)) {
            lastLangProb = lp;
          }
          lastRequestId = typeof d.request_id === "string" ? d.request_id : null;
          if (firstDataTimer) {
            clearTimeout(firstDataTimer);
            firstDataTimer = null;
          }
          scheduleIdle();
        }
      }
    });

    ws.on("open", () => {
      const b64 = params.wavBuffer.toString("base64");
      // Must match the WAV in `data` and `sample_rate` query param (`sr`); Exotel is 8 kHz s16le mono.
      const perMessageRate = String(sr) as "8000" | "16000";
      const audioMsg = {
        audio: {
          data: b64,
          encoding: "audio/wav",
          sample_rate: perMessageRate,
        },
      };
      try {
        ws.send(JSON.stringify(audioMsg));
        ws.send(JSON.stringify({ type: "flush" }));
        firstDataTimer = setTimeout(() => {
          if (!settled && !lastTranscript.trim()) {
            finish(504, { error: "Sarvam STT WebSocket first data timeout" });
          }
        }, firstDataMs);
      } catch (err) {
        finish(500, { error: String(err) });
      }
    });

    ws.on("close", () => {
      if (!settled) {
        const t = lastTranscript.trim();
        if (!t) {
          finish(504, { error: "Sarvam STT WebSocket closed without transcript" });
        } else {
          finish(200, {
            request_id: lastRequestId,
            transcript: lastTranscript,
            language_code: lastLang ?? "en-IN",
            language_probability: lastLangProb,
          });
        }
      }
    });
  });
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
    signal: AbortSignal.timeout(5000),
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
