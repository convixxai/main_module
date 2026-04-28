// ============================================================
// PCM Audio Utilities for Exotel Voicebot
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §7
// ============================================================

/**
 * Exotel Voicebot / stream rules (each outbound `media` PCM payload):
 *  - Minimum: 3.2 KB (~100 ms) — below this, jitter can break audio.
 *  - Maximum: 100 KB — above this, timeouts.
 *  - Length must be a multiple of 320 bytes — otherwise the platform may wait ~20 ms
 *    on undersized tail fragments and cause gaps.
 * @see docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §7
 */
export const PCM_CHUNK_MULTIPLE = 320;
export const PCM_MIN_CHUNK_BYTES = 3200;
/** Largest size ≤ 100 KB that is a multiple of 320 (Exotel max + alignment). */
export const PCM_MAX_CHUNK_BYTES = Math.floor(100_000 / PCM_CHUNK_MULTIPLE) * PCM_CHUNK_MULTIPLE;

/** Default outbound chunk size: ~6400 bytes (~200ms at 16kHz/16-bit mono) */
export const DEFAULT_OUTBOUND_CHUNK_SIZE = 6400;

/**
 * Rounds `size` down to the nearest multiple of 320, within Exotel bounds.
 */
export function alignChunkSize(size: number): number {
  const aligned = Math.floor(size / PCM_CHUNK_MULTIPLE) * PCM_CHUNK_MULTIPLE;
  return Math.max(PCM_MIN_CHUNK_BYTES, Math.min(PCM_MAX_CHUNK_BYTES, aligned));
}

/**
 * Accumulates raw PCM bytes and emits aligned chunks.
 * Call `push(data)` with incoming PCM; call `flush()` to emit remaining data.
 */
export class PcmChunkBuffer {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly chunkSize: number;

  constructor(chunkSize: number = DEFAULT_OUTBOUND_CHUNK_SIZE) {
    this.chunkSize = alignChunkSize(chunkSize);
  }

  /** Append PCM data. Returns any complete chunks that can be emitted. */
  push(data: Buffer): Buffer[] {
    this.buffer = Buffer.concat([this.buffer, data]);
    const chunks: Buffer[] = [];
    while (this.buffer.length >= this.chunkSize) {
      chunks.push(this.buffer.subarray(0, this.chunkSize));
      this.buffer = this.buffer.subarray(this.chunkSize);
    }
    return chunks;
  }

  /**
   * Flush remaining PCM as one or more chunks for Exotel:
   * 1) pad to a 320-byte multiple (avoids sub-320 B tail, 20 ms wait, and gaps);
   * 2) if still below 3.2 KB, pad with silence to minimum (reduces jitter on short tails);
   * 3) if above max, emit a full max-sized frame and leave the rest in the buffer (call flush again).
   */
  flush(): Buffer | null {
    if (this.buffer.length === 0) return null;

    const rem = this.buffer.length % PCM_CHUNK_MULTIPLE;
    if (rem !== 0) {
      this.buffer = Buffer.concat([
        this.buffer,
        Buffer.alloc(PCM_CHUNK_MULTIPLE - rem, 0),
      ]);
    }

    let chunk = this.buffer;
    this.buffer = Buffer.alloc(0);

    if (chunk.length < PCM_MIN_CHUNK_BYTES) {
      chunk = Buffer.concat([
        chunk,
        Buffer.alloc(PCM_MIN_CHUNK_BYTES - chunk.length, 0),
      ]);
    }

    if (chunk.length > PCM_MAX_CHUNK_BYTES) {
      const head = chunk.subarray(0, PCM_MAX_CHUNK_BYTES);
      this.buffer = chunk.subarray(PCM_MAX_CHUNK_BYTES);
      return head;
    }

    return chunk;
  }

  /** Current buffered byte count. */
  get pending(): number {
    return this.buffer.length;
  }

  /** Reset the buffer. */
  reset(): void {
    this.buffer = Buffer.alloc(0);
  }
}

/**
 * Decode a base64-encoded PCM payload (as received from Exotel).
 */
export function decodeBase64Pcm(payload: string): Buffer {
  return Buffer.from(payload, "base64");
}

/**
 * Encode raw PCM bytes to base64 for sending to Exotel.
 */
export function encodeBase64Pcm(pcm: Buffer): string {
  return pcm.toString("base64");
}

/**
 * Simple linear resampling of 16-bit LE mono PCM.
 * This is a basic interpolating resampler; good enough for telephony.
 *
 * @param input     Raw 16-bit LE PCM buffer
 * @param fromRate  Source sample rate (e.g. 24000)
 * @param toRate    Target sample rate (e.g. 16000)
 * @returns         Resampled 16-bit LE PCM buffer
 */
export function resamplePcm16(
  input: Buffer,
  fromRate: number,
  toRate: number
): Buffer {
  if (fromRate === toRate) return input;

  const inputSamples = input.length / 2; // 16-bit = 2 bytes per sample
  const ratio = fromRate / toRate;
  const outputSamples = Math.ceil(inputSamples / ratio);
  const output = Buffer.alloc(outputSamples * 2);

  for (let i = 0; i < outputSamples; i++) {
    const srcPos = i * ratio;
    const srcIdx = Math.floor(srcPos);
    const frac = srcPos - srcIdx;

    const s0 = srcIdx < inputSamples ? input.readInt16LE(srcIdx * 2) : 0;
    const s1 =
      srcIdx + 1 < inputSamples ? input.readInt16LE((srcIdx + 1) * 2) : s0;

    const sample = Math.round(s0 + frac * (s1 - s0));
    const clamped = Math.max(-32768, Math.min(32767, sample));
    output.writeInt16LE(clamped, i * 2);
  }

  return output;
}

/**
 * Linear crossfade across the first `sampleCount` samples of `pcm` with the last `sampleCount`
 * samples of `prevTail` (same-length s16le mono tail from the prior utterance). Reduces clicks
 * when concatenating separate TTS syntheses (e.g. incremental ElevenLabs chunks on the voicebot).
 */
export function crossfadePcm16MonoUtteranceJoin(
  prevTail: Buffer,
  pcm: Buffer,
  sampleCount: number
): Buffer {
  const n = Math.min(
    sampleCount,
    Math.floor(prevTail.length / 2),
    Math.floor(pcm.length / 2)
  );
  if (n <= 0) return pcm;
  const out = Buffer.from(pcm);
  const prevOffset = prevTail.length - n * 2;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const p = prevTail.readInt16LE(prevOffset + i * 2);
    const c = pcm.readInt16LE(i * 2);
    const mixed = Math.round(p * (1 - t) + c * t);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), i * 2);
  }
  return out;
}

/**
 * Calculate duration in milliseconds for a given number of PCM bytes.
 * Assumes 16-bit (2 bytes/sample) mono.
 */
export function pcmDurationMs(
  byteCount: number,
  sampleRate: number
): number {
  const samples = byteCount / 2;
  return (samples / sampleRate) * 1000;
}

/**
 * Parse a WAV (PCM 16-bit LE mono) buffer and return raw PCM + sample rate from the `fmt` chunk.
 * Returns null if not a valid PCM WAV.
 */
export function parseWavPcm16Mono(
  buffer: Buffer
): { pcm: Buffer; sampleRate: number } | null {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let sampleRate = 8000;
  let bitsPerSample = 16;
  let dataChunk: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (payloadStart + size > buffer.length) break;

    if (id === "fmt " && size >= 16) {
      sampleRate = buffer.readUInt32LE(payloadStart + 4);
      bitsPerSample = buffer.readUInt16LE(payloadStart + 14);
    }
    if (id === "data") {
      dataChunk = buffer.subarray(payloadStart, payloadStart + size);
      break;
    }

    offset = payloadStart + size + (size % 2);
  }

  if (!dataChunk || bitsPerSample !== 16) return null;
  return { pcm: dataChunk, sampleRate };
}

const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;

function interleavedS16leStereoToMono(buf: Buffer): Buffer {
  const n = Math.floor(buf.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const l = buf.readInt16LE(i * 4);
    const r = buf.readInt16LE(i * 4 + 2);
    const m = Math.round((l + r) / 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, m)), i * 2);
  }
  return out;
}

function interleavedF32StereoToMonoS16le(buf: Buffer): Buffer {
  const n = Math.floor(buf.length / 8);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const l = buf.readFloatLE(i * 8);
    const r = buf.readFloatLE(i * 8 + 4);
    const f = (l + r) * 0.5;
    const s = f * 32767;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

function float32MonoWavDataToS16le(buf: Buffer): Buffer {
  const n = Math.floor(buf.length / 4);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const f = buf.readFloatLE(i * 4);
    const s = f * 32767;
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s))), i * 2);
  }
  return out;
}

/**
 * Sarvam (and other) TTS WAV buffers may be 16-bit PCM, stereo, or IEEE float.
 * Produces 16-bit LE mono PCM for telephony. Returns null for unsupported or invalid WAV.
 */
export function parseWavToPcmS16leMono(
  buffer: Buffer
): { pcm: Buffer; sampleRate: number } | null {
  if (
    buffer.length < 44 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    return null;
  }

  let sampleRate = 8000;
  let audioFormat = 0;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataChunk: Buffer | null = null;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    if (payloadStart + size > buffer.length) break;

    if (id === "fmt " && size >= 16) {
      audioFormat = buffer.readUInt16LE(payloadStart);
      numChannels = buffer.readUInt16LE(payloadStart + 2);
      sampleRate = buffer.readUInt32LE(payloadStart + 4);
      bitsPerSample = buffer.readUInt16LE(payloadStart + 14);
    }
    if (id === "data") {
      dataChunk = buffer.subarray(payloadStart, payloadStart + size);
      break;
    }

    offset = payloadStart + size + (size % 2);
  }

  if (!dataChunk || dataChunk.length === 0) return null;
  if (numChannels < 1 || numChannels > 2) return null;

  if (audioFormat === WAVE_FORMAT_PCM && bitsPerSample === 16) {
    if (numChannels === 1) return { pcm: dataChunk, sampleRate };
    return { pcm: interleavedS16leStereoToMono(dataChunk), sampleRate };
  }
  if (audioFormat === WAVE_FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
    if (numChannels === 1) {
      return { pcm: float32MonoWavDataToS16le(dataChunk), sampleRate };
    }
    return { pcm: interleavedF32StereoToMonoS16le(dataChunk), sampleRate };
  }
  return null;
}

/** True if buffer looks like MP3 (ID3 tag or frame sync), not RIFF. */
export function isLikelyMp3Buffer(b: Buffer): boolean {
  if (b.length < 2) return false;
  if (b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return true; // "ID3"
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return true; // MPEG frame sync
  return false;
}
