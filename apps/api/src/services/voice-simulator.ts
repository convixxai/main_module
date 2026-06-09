import {
  elevenLabsTextToSpeech,
  normalizeVoiceSettingsForApi,
  pcmSampleRateFromElevenOutputFormat,
  type ElevenLabsVoiceSettingsPayload,
} from "./elevenlabs";
import { parseWavPcm16Mono, pcmDurationMs, resamplePcm16 } from "./pcm-audio";

const SIMULATOR_PCM_RATE = 8000;

export type SimulatorTtsSettings = {
  voiceId: string;
  modelId: string;
  languageCode?: string;
  voiceSettings: ElevenLabsVoiceSettingsPayload;
};

export type SimulatorPcmResult = {
  pcm: Buffer;
  sampleRate: typeof SIMULATOR_PCM_RATE;
  durationMs: number;
};

/** Synthesize with ElevenLabs and return mono PCM16 at 8 kHz (telephony preview). */
export async function synthesizeSimulatorPcm8k(
  text: string,
  settings: SimulatorTtsSettings
): Promise<SimulatorPcmResult> {
  const el = await elevenLabsTextToSpeech({
    voiceId: settings.voiceId,
    text,
    modelId: settings.modelId,
    outputFormat: "pcm_8000",
    voiceSettings: settings.voiceSettings,
    languageCode: settings.languageCode,
  });

  if (el.status !== 200 || !Buffer.isBuffer(el.body) || el.body.length === 0) {
    const err =
      typeof el.body === "object" && el.body !== null
        ? JSON.stringify(el.body)
        : String(el.body ?? "empty_body");
    throw new Error(`ElevenLabs TTS failed (${el.status}): ${err.slice(0, 500)}`);
  }

  let pcm = el.body;
  let srcRate = pcmSampleRateFromElevenOutputFormat("pcm_8000");
  const wavParsed = parseWavPcm16Mono(pcm);
  if (wavParsed) {
    pcm = wavParsed.pcm;
    srcRate = wavParsed.sampleRate;
  }
  if (srcRate !== SIMULATOR_PCM_RATE) {
    pcm = resamplePcm16(pcm, srcRate, SIMULATOR_PCM_RATE);
  }

  return {
    pcm,
    sampleRate: SIMULATOR_PCM_RATE,
    durationMs: pcmDurationMs(pcm.length, SIMULATOR_PCM_RATE),
  };
}

function parseBool(raw: string | undefined, defaultVal: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return defaultVal;
  const v = raw.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "on" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "off" || v === "no") return false;
  return defaultVal;
}

function parseNum(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Parse simulator TTS fields from multipart form or JSON body. */
export function parseSimulatorTtsSettings(
  fields: Record<string, string | undefined>,
  defaults: {
    voice_id: string;
    model_id: string;
    language_code: string;
    voice_settings: Required<ElevenLabsVoiceSettingsPayload>;
  }
): SimulatorTtsSettings {
  const modelId = (fields.model_id?.trim() || defaults.model_id).slice(0, 128);
  const rawSettings: ElevenLabsVoiceSettingsPayload = {
    stability: parseNum(
      fields.stability,
      defaults.voice_settings.stability,
      0,
      1
    ),
    similarity_boost: parseNum(
      fields.similarity_boost,
      defaults.voice_settings.similarity_boost,
      0,
      1
    ),
    style: parseNum(fields.style, defaults.voice_settings.style, 0, 1),
    speed: parseNum(fields.speed, defaults.voice_settings.speed, 0.7, 1.2),
    use_speaker_boost: parseBool(
      fields.use_speaker_boost,
      defaults.voice_settings.use_speaker_boost
    ),
  };

  return {
    voiceId: (fields.voice_id?.trim() || defaults.voice_id).slice(0, 128),
    modelId,
    languageCode: (fields.language_code?.trim() || defaults.language_code).slice(
      0,
      16
    ),
    voiceSettings: normalizeVoiceSettingsForApi(rawSettings, modelId) ?? rawSettings,
  };
}
