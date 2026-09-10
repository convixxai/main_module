// ============================================================
// Batch (non-streaming) TTS -> 8kHz 16-bit linear PCM, for the Vodafone
// voicebot route. Vodafone/VI requires exactly this format (confirmed in
// docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md §8.5.1)
// — the same encoding Exotel uses, so this reuses the same provider REST
// calls exotel-voicebot.ts uses, just without its streaming/incremental
// machinery (accepted duplication — see roadmap §8.5.2 "route + wiring now"
// decision).
// ============================================================

import { cartesiaTextToSpeech, cartesiaOutputFormatForExotel } from "./cartesia";
import { sarvamTextToSpeech } from "./sarvam";
import { elevenLabsTextToSpeech, elevenLabsPcmOutputFormat } from "./elevenlabs";
import { parseWavToPcmS16leMono, resamplePcm16 } from "./pcm-audio";

export interface VodafoneTtsConfig {
  provider: "sarvam" | "elevenlabs" | "cartesia";
  model?: string | null;
  speaker?: string | null;
  language?: string | null;
}

const TARGET_SAMPLE_RATE = 8000;

/** Synthesizes `text` and returns raw 16-bit LE mono PCM at 8kHz, regardless of provider. */
export async function synthesizeSpeechToPcm8k(
  text: string,
  cfg: VodafoneTtsConfig
): Promise<Buffer> {
  if (cfg.provider === "cartesia") {
    if (!cfg.speaker?.trim()) throw new Error("Cartesia voice_id (speaker) is required");
    const result = await cartesiaTextToSpeech({
      transcript: text,
      modelId: cfg.model ?? undefined,
      voiceId: cfg.speaker,
      language: cfg.language ?? "en",
      outputFormat: cartesiaOutputFormatForExotel(TARGET_SAMPLE_RATE),
    });
    // cartesiaOutputFormatForExotel(8000) always returns raw pcm_s16le @ 8000 for this input.
    return result.body;
  }

  if (cfg.provider === "elevenlabs") {
    if (!cfg.speaker?.trim()) throw new Error("ElevenLabs voice_id (speaker) is required");
    const outputFormat = elevenLabsPcmOutputFormat(TARGET_SAMPLE_RATE);
    const res = await elevenLabsTextToSpeech({
      text,
      voiceId: cfg.speaker,
      modelId: cfg.model ?? "eleven_multilingual_v2",
      outputFormat,
    });
    if (res.status !== 200 || !Buffer.isBuffer(res.body)) {
      throw new Error(`ElevenLabs TTS failed (${res.status})`);
    }
    // outputFormat name encodes the actual rate (e.g. "pcm_8000"/"pcm_16000") — resample if it
    // wasn't able to honor 8000 directly (v3 models forced to 16000, see elevenLabsPcmOutputFormat).
    const m = /pcm_(\d+)/.exec(outputFormat);
    const actualRate = m ? Number(m[1]) : TARGET_SAMPLE_RATE;
    return actualRate === TARGET_SAMPLE_RATE
      ? res.body
      : resamplePcm16(res.body, actualRate, TARGET_SAMPLE_RATE);
  }

  // sarvam (default)
  const res = await sarvamTextToSpeech({
    text,
    target_language_code: cfg.language ?? "en-IN",
    speaker: cfg.speaker ?? undefined,
    model: (cfg.model as "bulbul:v3" | "bulbul:v2" | undefined) ?? "bulbul:v3",
    speech_sample_rate: String(TARGET_SAMPLE_RATE),
  });
  if (res.status !== 200) {
    throw new Error(`Sarvam TTS failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  const body = res.body as { audios: string[] };
  const wavBuf = Buffer.from(body.audios[0], "base64");
  const parsed = parseWavToPcmS16leMono(wavBuf);
  if (!parsed) throw new Error("Sarvam returned an unparseable WAV buffer");
  return parsed.sampleRate === TARGET_SAMPLE_RATE
    ? parsed.pcm
    : resamplePcm16(parsed.pcm, parsed.sampleRate, TARGET_SAMPLE_RATE);
}
