import { env } from "../config/env";

const ELEVEN_BASE = "https://api.elevenlabs.io";

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

export type ElevenLabsTtsParams = {
  voiceId: string;
  text: string;
  modelId: string;
  /** e.g. pcm_8000, pcm_16000 — see ElevenLabs docs */
  outputFormat: string;
};

export async function elevenLabsTextToSpeech(
  params: ElevenLabsTtsParams
): Promise<{ status: number; body: Buffer | unknown }> {
  const key = requireElevenLabsKey();
  const q = new URLSearchParams({ output_format: params.outputFormat });
  const res = await fetch(
    `${ELEVEN_BASE}/v1/text-to-speech/${encodeURIComponent(params.voiceId)}?${q}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": key,
        "Content-Type": "application/json",
        Accept: "audio/*",
      },
      body: JSON.stringify({
        text: params.text.slice(0, 2500),
        model_id: params.modelId,
      }),
      signal: AbortSignal.timeout(60_000),
    }
  );

  const ct = res.headers.get("content-type") || "";
  if (!res.ok) {
    const errBody = ct.includes("json") ? await readJsonBody(res) : await res.text();
    return { status: res.status, body: errBody };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, body: buf };
}

/** Pick ElevenLabs `output_format` from desired PCM sample rate (telephony). */
export function elevenLabsPcmOutputFormat(sampleRate: number): string {
  if (sampleRate <= 8000) return "pcm_8000";
  if (sampleRate <= 16000) return "pcm_16000";
  if (sampleRate <= 22050) return "pcm_22050";
  if (sampleRate <= 24000) return "pcm_24000";
  return "pcm_44100";
}

/** Sample rate of raw PCM returned for `pcm_*` output_format values. */
export function pcmSampleRateFromElevenOutputFormat(outputFormat: string): number {
  const f = outputFormat.toLowerCase();
  if (f === "pcm_8000") return 8000;
  if (f === "pcm_16000") return 16000;
  if (f === "pcm_22050") return 22050;
  if (f === "pcm_24000") return 24000;
  if (f === "pcm_32000") return 32000;
  if (f === "pcm_44100") return 44100;
  if (f === "pcm_48000") return 48000;
  return 8000;
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
