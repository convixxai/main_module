import WebSocket from "ws";
import { randomUUID } from "crypto";
import { env } from "../config/env";
import {
  CARTESIA_VERSION,
  type CartesiaGenerationConfig,
  type CartesiaOutputFormat,
  resolveCartesiaModel,
} from "./cartesia";

const CARTESIA_WS_BASE = "wss://api.cartesia.ai/tts/websocket";

export type CartesiaWsSpeakParams = {
  transcript: string;
  modelId?: string;
  voiceId: string;
  language?: string | null;
  outputFormat: CartesiaOutputFormat;
  generationConfig?: CartesiaGenerationConfig | null;
  pronunciationDictId?: string | null;
  legacySpeed?: "slow" | "normal" | "fast" | null;
  maxBufferDelayMs?: number;
  continue?: boolean;
  contextId?: string;
};

type PendingContext = {
  chunks: Buffer[];
  resolve: (chunks: Buffer[]) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  onChunk?: (chunk: Buffer) => void;
};

type CartesiaWsInbound =
  | {
      type: "chunk";
      data?: string;
      done?: boolean;
      context_id?: string;
      status_code?: number;
      message?: string;
      title?: string;
      error_code?: string;
    }
  | {
      type: "done";
      context_id?: string;
      status_code?: number;
      message?: string;
      title?: string;
    }
  | {
      type: "error";
      context_id?: string;
      status_code?: number;
      message?: string;
      title?: string;
      error_code?: string;
      done?: boolean;
    };

const CONTEXT_TIMEOUT_MS = 120_000;

/**
 * One Cartesia TTS WebSocket per voicebot call — amortizes TLS/connect cost.
 */
export class CartesiaTtsSession {
  private ws: WebSocket | null = null;
  private connecting: Promise<void> | null = null;
  private closed = false;
  private readonly pending = new Map<string, PendingContext>();

  constructor(private readonly log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("Cartesia TTS session is closed");
    }
    if (this.isOpen) return;
    if (this.connecting) {
      await this.connecting;
      return;
    }

    const key = env.cartesia.apiKey?.trim();
    if (!key) {
      throw new Error("CARTESIA_API_KEY is not configured on this server");
    }

    const url = `${CARTESIA_WS_BASE}?cartesia_version=${encodeURIComponent(CARTESIA_VERSION)}`;

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
        this.log?.error({ err }, "Cartesia TTS WebSocket error");
        if (this.connecting) {
          this.connecting = null;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
        this.rejectAllPending(
          err instanceof Error ? err : new Error(String(err))
        );
      });

      ws.on("close", () => {
        this.ws = null;
        this.rejectAllPending(new Error("Cartesia TTS WebSocket closed"));
      });
    });

    await this.connecting;
  }

  close(): void {
    this.closed = true;
    this.rejectAllPending(new Error("Cartesia TTS session closed"));
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  /**
   * Synthesize one utterance; yields PCM chunks as they arrive from Cartesia.
   */
  async *speakIncremental(
    params: CartesiaWsSpeakParams
  ): AsyncGenerator<Buffer, void, unknown> {
    const transcript = params.transcript.trim();
    if (!transcript) return;

    await this.connect();
    const contextId = params.contextId ?? randomUUID();
    const body = this.buildRequestBody({ ...params, transcript, contextId });

    const queue: Buffer[] = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let failed: Error | null = null;

    const notify = (): void => {
      const w = wake;
      wake = null;
      w?.();
    };

    const timer = setTimeout(() => {
      this.pending.delete(contextId);
      failed = new Error(`Cartesia TTS context timed out (${CONTEXT_TIMEOUT_MS}ms)`);
      finished = true;
      notify();
    }, CONTEXT_TIMEOUT_MS);

    this.pending.set(contextId, {
      chunks: [],
      onChunk: (chunk) => {
        queue.push(chunk);
        notify();
      },
      resolve: (chunks) => {
        clearTimeout(timer);
        for (const c of chunks) {
          if (c.length > 0) queue.push(c);
        }
        finished = true;
        notify();
      },
      reject: (err) => {
        clearTimeout(timer);
        failed = err;
        finished = true;
        notify();
      },
      timer,
    });

    try {
      this.sendJson(body);
    } catch (err) {
      this.pending.delete(contextId);
      clearTimeout(timer);
      throw err instanceof Error ? err : new Error(String(err));
    }

    while (!finished || queue.length > 0) {
      if (failed) throw failed;
      if (queue.length > 0) {
        yield queue.shift()!;
        continue;
      }
      if (finished) break;
      await new Promise<void>((r) => {
        wake = r;
      });
    }
  }

  /** Aggregate all PCM for one utterance. */
  async speak(params: CartesiaWsSpeakParams): Promise<Buffer> {
    const parts: Buffer[] = [];
    for await (const chunk of this.speakIncremental(params)) {
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  }

  private buildRequestBody(
    params: CartesiaWsSpeakParams & { transcript: string; contextId: string }
  ): Record<string, unknown> {
    const modelId = resolveCartesiaModel(params.modelId);
    const outputFormat: Record<string, unknown> = {
      container: "raw",
      encoding: params.outputFormat.encoding ?? "pcm_s16le",
      sample_rate: params.outputFormat.sample_rate,
    };

    const body: Record<string, unknown> = {
      model_id: modelId,
      transcript: params.transcript,
      voice: { mode: "id", id: params.voiceId.trim() },
      output_format: outputFormat,
      context_id: params.contextId,
      continue: params.continue ?? false,
      max_buffer_delay_ms: params.maxBufferDelayMs ?? 0,
    };

    if (params.language?.trim()) {
      body.language = params.language.trim();
    }

    const gen: Record<string, unknown> = {};
    const gc = params.generationConfig;
    if (gc?.speed != null && Number.isFinite(gc.speed)) {
      gen.speed = Math.min(1.5, Math.max(0.6, gc.speed));
    }
    if (gc?.volume != null && Number.isFinite(gc.volume)) {
      gen.volume = Math.min(2, Math.max(0.5, gc.volume));
    }
    if (gc?.emotion) {
      gen.emotion = String(gc.emotion).trim().toLowerCase();
    }
    if (Object.keys(gen).length > 0) {
      body.generation_config = gen;
    }

    if (params.pronunciationDictId?.trim()) {
      body.pronunciation_dict_id = params.pronunciationDictId.trim();
    }

    if (params.legacySpeed) {
      body.speed = params.legacySpeed;
    }

    return body;
  }

  private sendJson(payload: Record<string, unknown>): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Cartesia TTS WebSocket is not open");
    }
    this.ws.send(JSON.stringify(payload));
  }

  private runContext(
    contextId: string,
    sendFn: () => void
  ): Promise<Buffer[]> {
    return new Promise<Buffer[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(contextId);
        reject(new Error(`Cartesia TTS context timed out (${CONTEXT_TIMEOUT_MS}ms)`));
      }, CONTEXT_TIMEOUT_MS);

      this.pending.set(contextId, {
        chunks: [],
        resolve: (chunks) => {
          clearTimeout(timer);
          resolve(chunks);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      try {
        sendFn();
      } catch (err) {
        this.pending.delete(contextId);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private onMessage(raw: WebSocket.RawData): void {
    let msg: CartesiaWsInbound;
    try {
      msg = JSON.parse(String(raw)) as CartesiaWsInbound;
    } catch {
      this.log?.warn({ raw: String(raw).slice(0, 200) }, "Cartesia WS: invalid JSON");
      return;
    }

    const contextId = msg.context_id;
    if (!contextId) return;

    const pending = this.pending.get(contextId);
    if (!pending) return;

    if (msg.type === "error") {
      this.pending.delete(contextId);
      pending.reject(
        new Error(
          msg.message || msg.title || msg.error_code || "Cartesia TTS WebSocket error"
        )
      );
      return;
    }

    if (msg.type === "chunk") {
      if (msg.status_code != null && msg.status_code >= 400) {
        this.pending.delete(contextId);
        pending.reject(
          new Error(msg.message || msg.title || `Cartesia TTS failed (${msg.status_code})`)
        );
        return;
      }
      if (msg.data) {
        try {
          const buf = Buffer.from(msg.data, "base64");
          pending.chunks.push(buf);
          pending.onChunk?.(buf);
        } catch (err) {
          this.pending.delete(contextId);
          pending.reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
      if (msg.done === true) {
        this.pending.delete(contextId);
        pending.resolve(pending.chunks);
      }
      return;
    }

    if (msg.type === "done") {
      this.pending.delete(contextId);
      if (msg.status_code != null && msg.status_code >= 400) {
        pending.reject(
          new Error(msg.message || msg.title || `Cartesia TTS failed (${msg.status_code})`)
        );
        return;
      }
      pending.resolve(pending.chunks);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, p] of this.pending.entries()) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }
}

export function getOrCreateCartesiaTtsSession(
  session: { cartesiaTts?: CartesiaTtsSession | null },
  log?: { warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void }
): CartesiaTtsSession {
  if (!session.cartesiaTts) {
    session.cartesiaTts = new CartesiaTtsSession(log);
  }
  return session.cartesiaTts;
}

export function closeCartesiaTtsSession(session: {
  cartesiaTts?: CartesiaTtsSession | null;
}): void {
  session.cartesiaTts?.close();
  session.cartesiaTts = null;
}
