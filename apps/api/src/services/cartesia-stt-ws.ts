import WebSocket from "ws";
import { env } from "../config/env";
import {
  CARTESIA_STT_MODEL,
  CARTESIA_VERSION,
  bcp47ToCartesiaSttLanguage,
  cartesiaSttToSarvamShape,
  resolveCartesiaSttModel,
} from "./cartesia";

const CARTESIA_STT_WS_BASE = "wss://api.cartesia.ai/stt/websocket";

export type CartesiaSttConnectParams = {
  sampleRate: number;
  model?: string;
  /** ISO-639-1 e.g. en, hi, mr — omit for open detect. */
  language?: string;
  minVolume?: number;
  maxSilenceDurationSecs?: number;
};

type CartesiaSttInbound =
  | {
      type: "transcript";
      is_final?: boolean;
      text?: string;
      request_id?: string;
    }
  | {
      type: "flush_done" | "done" | "error";
      message?: string;
      title?: string;
      status_code?: number;
    };

function requireCartesiaKey(): string {
  const key = env.cartesia.apiKey?.trim();
  if (!key) {
    throw new Error("CARTESIA_API_KEY is not configured");
  }
  return key;
}

function buildSttWsUrl(params: CartesiaSttConnectParams): string {
  const model = resolveCartesiaSttModel(params.model);
  const q = new URLSearchParams({
    model,
    encoding: "pcm_s16le",
    sample_rate: String(params.sampleRate),
    cartesia_version: CARTESIA_VERSION,
  });
  if (params.language?.trim()) {
    q.set("language", params.language.trim().toLowerCase());
  }
  const minVol = params.minVolume ?? env.cartesia.sttMinVolume;
  if (Number.isFinite(minVol)) {
    q.set("min_volume", String(minVol));
  }
  const maxSil = params.maxSilenceDurationSecs ?? env.cartesia.sttMaxSilenceSecs;
  if (Number.isFinite(maxSil)) {
    q.set("max_silence_duration_secs", String(maxSil));
  }
  return `${CARTESIA_STT_WS_BASE}?${q.toString()}`;
}

function chunkPcm100ms(pcm: Buffer, sampleRate: number): Buffer[] {
  const chunkBytes = Math.max(1, Math.floor((sampleRate * 2) / 10));
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    chunks.push(pcm.subarray(i, i + chunkBytes));
  }
  return chunks;
}

/**
 * One Cartesia Manual STT WebSocket per voicebot call when streaming is enabled.
 * Streams raw pcm_s16le and finalizes per utterance on VAD silence.
 */
export class CartesiaSttSession {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private connectParams: CartesiaSttConnectParams | null = null;
  private finalizePromise: Promise<string> | null = null;
  private finalizeParts: string[] = [];
  private finalizeResolve: ((t: string) => void) | null = null;
  private finalizeReject: ((err: Error) => void) | null = null;
  private finalizeSettleTimer: ReturnType<typeof setTimeout> | null = null;
  private hardTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private abortPoll: ReturnType<typeof setInterval> | null = null;
  private shouldAbort: (() => boolean) | null = null;

  constructor(
    private readonly log?: {
      warn: (o: unknown, m?: string) => void;
      error: (o: unknown, m?: string) => void;
    }
  ) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get sampleRate(): number | undefined {
    return this.connectParams?.sampleRate;
  }

  async connect(params: CartesiaSttConnectParams): Promise<void> {
    if (this.closed) {
      throw new Error("Cartesia STT session is closed");
    }
    const nextLang = params.language?.trim().toLowerCase() ?? "";
    const prevLang = this.connectParams?.language?.trim().toLowerCase() ?? "";
    const sameConn =
      this.isOpen &&
      this.connectParams?.sampleRate === params.sampleRate &&
      resolveCartesiaSttModel(this.connectParams?.model) ===
        resolveCartesiaSttModel(params.model) &&
      nextLang === prevLang;
    if (sameConn) return;

    if (this.isOpen || this.ws) {
      this.closeWsOnly();
    }

    this.connectParams = { ...params };
    const key = requireCartesiaKey();
    const url = buildSttWsUrl(params);

    this.connecting = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${key}`,
          "Cartesia-Version": CARTESIA_VERSION,
        },
      });

      ws.on("open", () => {
        this.ws = ws;
        this.connecting = null;
        resolve();
      });

      ws.on("message", (raw) => {
        this.onMessage(raw);
      });

      ws.on("error", (err) => {
        this.log?.error({ err }, "Cartesia STT WebSocket error");
        if (this.connecting) {
          this.connecting = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        this.rejectFinalize(
          err instanceof Error ? err : new Error(String(err))
        );
      });

      ws.on("close", () => {
        this.ws = null;
        if (this.finalizePromise) {
          const joined = this.finalizeParts.join("");
          if (joined.trim()) {
            this.resolveFinalize(joined);
          } else {
            this.rejectFinalize(new Error("Cartesia STT WebSocket closed"));
          }
        }
      });
    });

    await this.connecting;
  }

  sendPcm(pcm: Buffer): void {
    if (!pcm.length || this.closed) return;
    if (!this.isOpen) return;
    try {
      this.ws!.send(pcm);
    } catch (err) {
      this.log?.warn({ err }, "Cartesia STT sendPcm failed");
    }
  }

  /**
   * Send buffered PCM in ~100 ms chunks, then finalize (one-shot per utterance).
   */
  async transcribePcmBuffer(
    pcm: Buffer,
    opts?: { shouldAbort?: () => boolean; languageHintBcp47?: string }
  ): Promise<{ status: number; body: unknown }> {
    if (!pcm.length) {
      return { status: 400, body: { error: "Empty PCM buffer" } };
    }
    const sampleRate = this.connectParams?.sampleRate;
    if (!sampleRate) {
      throw new Error("Cartesia STT session not connected");
    }
    for (const chunk of chunkPcm100ms(pcm, sampleRate)) {
      if (opts?.shouldAbort?.()) {
        return { status: 499, body: { error: "Cartesia STT aborted" } };
      }
      this.sendPcm(chunk);
    }
    try {
      const transcript = await this.finalize({
        shouldAbort: opts?.shouldAbort,
      });
      const shaped = cartesiaSttToSarvamShape(
        transcript,
        opts?.languageHintBcp47
      );
      return {
        status: 200,
        body: {
          transcript: shaped.transcript,
          language_code: shaped.language_code,
        },
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("aborted")) {
        return { status: 499, body: { error: msg } };
      }
      return { status: 500, body: { error: msg } };
    }
  }

  /** Signal end of user turn; resolves with concatenated is_final transcript deltas. */
  finalize(opts?: { shouldAbort?: () => boolean }): Promise<string> {
    if (this.finalizePromise) {
      return this.finalizePromise;
    }
    if (!this.isOpen) {
      return Promise.reject(new Error("Cartesia STT WebSocket is not open"));
    }

    this.shouldAbort = opts?.shouldAbort ?? null;
    this.finalizeParts = [];

    this.finalizePromise = new Promise<string>((resolve, reject) => {
      this.finalizeResolve = resolve;
      this.finalizeReject = reject;

      const hardMs = env.cartesia.sttWsHardTimeoutMs;
      this.hardTimeoutTimer = setTimeout(() => {
        this.rejectFinalize(new Error("Cartesia STT WebSocket hard timeout"));
      }, hardMs);

      this.abortPoll = setInterval(() => {
        if (this.shouldAbort?.()) {
          this.rejectFinalize(new Error("Cartesia STT aborted (session closing)"));
        }
      }, 200);

      try {
        this.ws!.send("finalize");
      } catch (err) {
        this.rejectFinalize(
          err instanceof Error ? err : new Error(String(err))
        );
      }
    });

    return this.finalizePromise;
  }

  close(): void {
    this.closed = true;
    this.clearFinalizeTimers();
    if (this.isOpen) {
      try {
        this.ws!.send("close");
      } catch {
        /* ignore */
      }
    }
    this.closeWsOnly();
  }

  private closeWsOnly(): void {
    this.clearFinalizeTimers();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.finalizePromise = null;
    this.finalizeParts = [];
    this.finalizeResolve = null;
    this.finalizeReject = null;
  }

  private clearFinalizeTimers(): void {
    if (this.hardTimeoutTimer) {
      clearTimeout(this.hardTimeoutTimer);
      this.hardTimeoutTimer = null;
    }
    if (this.finalizeSettleTimer) {
      clearTimeout(this.finalizeSettleTimer);
      this.finalizeSettleTimer = null;
    }
    if (this.abortPoll) {
      clearInterval(this.abortPoll);
      this.abortPoll = null;
    }
  }

  private scheduleFinalizeSettle(): void {
    if (this.finalizeSettleTimer) clearTimeout(this.finalizeSettleTimer);
    this.finalizeSettleTimer = setTimeout(() => {
      this.resolveFinalize(this.finalizeParts.join(""));
    }, 350);
  }

  private resolveFinalize(transcript: string): void {
    if (!this.finalizePromise) return;
    this.clearFinalizeTimers();
    const resolve = this.finalizeResolve;
    this.finalizePromise = null;
    this.finalizeResolve = null;
    this.finalizeReject = null;
    this.finalizeParts = [];
    resolve?.(transcript);
  }

  private rejectFinalize(err: Error): void {
    if (!this.finalizePromise) return;
    this.clearFinalizeTimers();
    const reject = this.finalizeReject;
    this.finalizePromise = null;
    this.finalizeResolve = null;
    this.finalizeReject = null;
    this.finalizeParts = [];
    reject?.(err);
  }

  private onMessage(raw: WebSocket.RawData): void {
    let msg: CartesiaSttInbound;
    try {
      msg = JSON.parse(String(raw)) as CartesiaSttInbound;
    } catch {
      return;
    }

    if (msg.type === "error") {
      this.rejectFinalize(
        new Error(msg.message || msg.title || "Cartesia STT error")
      );
      return;
    }

    if (msg.type === "transcript") {
      if (msg.is_final === true && typeof msg.text === "string") {
        this.finalizeParts.push(msg.text);
        if (this.finalizePromise) {
          this.scheduleFinalizeSettle();
        }
      }
      return;
    }

    if (msg.type === "flush_done" || msg.type === "done") {
      if (this.finalizePromise) {
        this.resolveFinalize(this.finalizeParts.join(""));
      }
    }
  }
}

/** Per-utterance Manual STT (opens WS, sends PCM, finalize, close). */
export async function cartesiaSpeechToTextWebsocket(params: {
  pcmBuffer: Buffer;
  sampleRate: number;
  model?: string;
  language?: string;
  minVolume?: number;
  maxSilenceDurationSecs?: number;
  languageHintBcp47?: string;
  shouldAbort?: () => boolean;
}): Promise<{ status: number; body: unknown }> {
  if (!params.pcmBuffer.length) {
    return { status: 400, body: { error: "Empty PCM buffer" } };
  }

  const session = new CartesiaSttSession();
  try {
    await session.connect({
      sampleRate: params.sampleRate,
      model: params.model,
      language: params.language,
      minVolume: params.minVolume,
      maxSilenceDurationSecs: params.maxSilenceDurationSecs,
    });
    return await session.transcribePcmBuffer(params.pcmBuffer, {
      shouldAbort: params.shouldAbort,
      languageHintBcp47: params.languageHintBcp47,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (params.shouldAbort?.()) {
      return { status: 499, body: { error: msg } };
    }
    return { status: 500, body: { error: msg } };
  } finally {
    session.close();
  }
}

export function getOrCreateCartesiaSttSession(
  session: { cartesiaStt?: CartesiaSttSession | null },
  log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }
): CartesiaSttSession {
  if (!session.cartesiaStt) {
    session.cartesiaStt = new CartesiaSttSession(log);
  }
  return session.cartesiaStt;
}

export function closeCartesiaSttSession(session: {
  cartesiaStt?: CartesiaSttSession | null;
}): void {
  session.cartesiaStt?.close();
  session.cartesiaStt = null;
}

export async function cartesiaSttFinalizeStreamingSession(
  sttSession: CartesiaSttSession,
  opts: {
    /** When streaming missed chunks, send full utterance PCM before finalize. */
    pcmFallback?: Buffer;
    shouldAbort?: () => boolean;
    languageHintBcp47?: string;
  }
): Promise<{ status: number; body: unknown }> {
  try {
    if (opts.pcmFallback && opts.pcmFallback.length > 0) {
      const sr = sttSession.sampleRate ?? 8000;
      for (const chunk of chunkPcm100ms(opts.pcmFallback, sr)) {
        sttSession.sendPcm(chunk);
      }
    }
    const transcript = await sttSession.finalize({
      shouldAbort: opts.shouldAbort,
    });
    const shaped = cartesiaSttToSarvamShape(
      transcript,
      opts.languageHintBcp47
    );
    return {
      status: 200,
      body: {
        transcript: shaped.transcript,
        language_code: shaped.language_code,
      },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (opts.shouldAbort?.() || msg.includes("aborted")) {
      return { status: 499, body: { error: msg } };
    }
    return { status: 500, body: { error: msg } };
  }
}

export { bcp47ToCartesiaSttLanguage, cartesiaSttToSarvamShape, CARTESIA_STT_MODEL };
