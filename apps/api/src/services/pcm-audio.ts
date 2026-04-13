// ============================================================
// PCM Audio Utilities for Exotel Voicebot
// Reference: docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md §7
// ============================================================

/**
 * Exotel chunk constraints (bidirectional):
 *  - Minimum chunk size: ~3200 bytes (3.2 KB = ~100 ms at 16kHz 16-bit)
 *  - Maximum chunk size: 100,000 bytes (100 KB)
 *  - Must be a multiple of 320 bytes
 */
export const PCM_CHUNK_MULTIPLE = 320;
export const PCM_MIN_CHUNK_BYTES = 3200;
export const PCM_MAX_CHUNK_BYTES = 100_000;

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

  /** Flush remaining data (pads to the nearest 320 multiple if needed). */
  flush(): Buffer | null {
    if (this.buffer.length === 0) return null;
    // Pad to nearest 320-byte multiple
    const remainder = this.buffer.length % PCM_CHUNK_MULTIPLE;
    if (remainder !== 0) {
      const pad = PCM_CHUNK_MULTIPLE - remainder;
      this.buffer = Buffer.concat([this.buffer, Buffer.alloc(pad, 0)]);
    }
    const chunk = this.buffer;
    this.buffer = Buffer.alloc(0);
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
