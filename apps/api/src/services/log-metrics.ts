// ============================================================
// Engine timings (C4) and notable events (C5), computed on request from the
// server log files the engine already writes (logs/convixx-YYYY-MM-DD.log,
// JSON lines, one file per UTC day, times in IST). Nothing new is measured
// or written on a request or a call: these lines exist today.
//
//   http.out                                  route, status, responseTimeMs  -> per-route latency, slow requests
//   vodafone-voicebot: transcript ready       sttMs
//   vodafone-voicebot: ask pipeline done      askMs (KB search + LLM)
//   vodafone-voicebot: answer spoken (batch)  ttsMs, totalMsSinceSilence
//   vodafone-voicebot: turn complete (streaming)  firstLlmTokenMs, firstSpokenMs, totalMsSinceSilence
//   voicebot:pipeline.utterance.timing (Exotel)   stt_ms, ask_pipeline_ms, final_tts_ms, total_ms
//   level >= 40 lines, "Server listening on"  -> events
//
// History is limited to the log files kept on the server (about 7 days).
// Results are cached for 15 s.
// ============================================================

import fs from "fs";
import path from "path";
import readline from "readline";
import { getLogDirectory } from "../config/logger-factory";

const CACHE_MS = 15_000;
/** WebSocket routes: their "response time" is a whole call, not a request. */
const WS_ROUTE_RE = /^\/(exotel\/voicebot|telephony\/vodafone\/voicebot)\//;
const SECRET_KEY_RE = /^(x-api-key|x-admin-token|authorization|cookie|set-cookie|api[_-]?key|token|access[_-]?token|password|secret|credentials?(_enc)?|headers)$/i;

const istFmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

export function toIstText(d: Date): string {
  return istFmt.format(d).replace(", ", " ");
}

/** Log time ("YYYY-MM-DD HH:MM:SS" IST; old lines wrote midnight as "24") -> ISO instant. */
export function logTimeToIso(t: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  const hh = String(Number(m[2]) % 24).padStart(2, "0");
  const ms = Date.parse(`${m[1]}T${hh}:${m[3]}:${m[4]}+05:30`);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function normalizedLogTime(t: string): string {
  return t.length >= 13 && t.slice(11, 13) === "24" ? `${t.slice(0, 11)}00${t.slice(13)}` : t;
}

/** Log files that can hold lines at or after `since` (UTC file days). */
function filesSince(since: Date): string[] {
  const dir = getLogDirectory();
  const out: string[] = [];
  const day = new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate()));
  // One day earlier too: a UTC file starts at 05:30 IST.
  day.setUTCDate(day.getUTCDate() - 1);
  const end = Date.now();
  while (day.getTime() <= end) {
    const p = path.join(dir, `convixx-${day.toISOString().slice(0, 10)}.log`);
    if (fs.existsSync(p)) out.push(p);
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return out;
}

/** Calls `onLine` for each JSON line logged at or after `since`, oldest first. */
async function scan(since: Date, prefilter: (raw: string) => boolean, onLine: (line: Record<string, any>, time: string) => void) {
  const sinceIst = toIstText(since);
  for (const file of filesSince(since)) {
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
    for await (const raw of rl) {
      if (!raw.startsWith(`{"level":`) || !prefilter(raw)) continue;
      const tm = /"time":"([^"]+)"/.exec(raw);
      if (!tm) continue;
      const time = normalizedLogTime(tm[1]);
      if (time < sinceIst) continue;
      let line: Record<string, any>;
      try {
        line = JSON.parse(raw);
      } catch {
        continue;
      }
      onLine(line, time);
    }
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

function stats(values: number[]) {
  const s = values.filter((v) => Number.isFinite(v) && v >= 0).sort((a, b) => a - b);
  return {
    count: s.length,
    p50_ms: percentile(s, 50),
    p95_ms: percentile(s, 95),
    p99_ms: percentile(s, 99),
    max_ms: s.length ? s[s.length - 1] : null,
  };
}

/** /kb/entries/3f2c...-uuid?x=1 -> /kb/entries/:id */
export function routeOf(url: string): string {
  return (
    url
      .split("?")[0]
      .split("/")
      .map((seg) =>
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
          ? ":id"
          : /^\+?\d{4,}$/.test(seg)
            ? ":n"
            : seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg)
              ? ":token"
              : seg
      )
      .join("/") || "/"
  );
}

const cache = new Map<string, { at: number; value: unknown }>();
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value as T;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

export async function engineMetrics(minutes: number) {
  return cached(`m:${minutes}`, async () => {
    const since = new Date(Date.now() - minutes * 60_000);
    const routes = new Map<string, { durations: number[]; s4: number; s5: number }>();
    const turn = { stt: [] as number[], ask: [] as number[], tts: [] as number[], llmFirst: [] as number[], firstAudio: [] as number[], total: [] as number[] };
    let turns = 0;
    await scan(
      since,
      (raw) => raw.includes(`"msg":"http.out"`) || raw.includes(`"msg":"vodafone-voicebot: `) || raw.includes(`"msg":"voicebot:pipeline.utterance.timing"`),
      (line) => {
        const msg = String(line.msg ?? "");
        if (msg === "http.out") {
          const url = String(line.url ?? "");
          if (WS_ROUTE_RE.test(url)) return;
          const key = `${line.method ?? "GET"} ${routeOf(url)}`;
          const r = routes.get(key) ?? { durations: [], s4: 0, s5: 0 };
          r.durations.push(Number(line.responseTimeMs));
          const st = Number(line.statusCode);
          if (st >= 500) r.s5++;
          else if (st >= 400) r.s4++;
          routes.set(key, r);
        } else if (msg === "vodafone-voicebot: transcript ready") {
          turn.stt.push(Number(line.sttMs));
        } else if (msg.startsWith("vodafone-voicebot: ask pipeline done")) {
          turn.ask.push(Number(line.askMs));
        } else if (msg === "vodafone-voicebot: answer spoken (batch)") {
          turns++;
          turn.tts.push(Number(line.ttsMs));
          turn.total.push(Number(line.totalMsSinceSilence));
        } else if (msg === "vodafone-voicebot: turn complete (streaming)") {
          turns++;
          if (line.firstLlmTokenMs != null) turn.llmFirst.push(Number(line.firstLlmTokenMs));
          if (line.firstSpokenMs != null) turn.firstAudio.push(Number(line.firstSpokenMs));
          turn.total.push(Number(line.totalMsSinceSilence));
        } else if (msg === "voicebot:pipeline.utterance.timing") {
          turns++;
          turn.stt.push(Number(line.stt_ms));
          turn.ask.push(Number(line.ask_pipeline_ms));
          if (Number(line.final_tts_ms) > 0) turn.tts.push(Number(line.final_tts_ms));
          turn.total.push(Number(line.total_ms));
        }
      }
    );
    const routeRows = [...routes.entries()]
      .map(([key, r]) => {
        const [method, ...rest] = key.split(" ");
        return { method, route: rest.join(" "), ...stats(r.durations), errors_4xx: r.s4, errors_5xx: r.s5 };
      })
      .sort((a, b) => b.count - a.count);
    const all = [...routes.values()].flatMap((r) => r.durations);
    return {
      minutes,
      from: since.toISOString(),
      to: new Date().toISOString(),
      source: "server log files (http.out and voicebot timing lines)",
      requests: { ...stats(all), routes: routeRows },
      call_turns: {
        turns,
        stt: stats(turn.stt),
        ask_kb_and_llm: stats(turn.ask),
        llm_first_token_since_caller_stopped: stats(turn.llmFirst),
        tts: stats(turn.tts),
        first_audio_since_caller_stopped: stats(turn.firstAudio),
        total_since_caller_stopped: stats(turn.total),
      },
    };
  });
}

function redact(v: unknown, depth = 0): unknown {
  if (depth > 5 || v === null || typeof v !== "object") return typeof v === "string" && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (k === "stack") continue;
    out[k] = SECRET_KEY_RE.test(k) && val != null && val !== "" ? "[hidden]" : redact(val, depth + 1);
  }
  return out;
}

export type EngineEventType = "restart" | "slow_request" | "server_error" | "error" | "warning";

export async function engineEvents(params: { since: Date; limit: number; slowMs: number; types?: EngineEventType[] }) {
  const { since, limit, slowMs } = params;
  return cached(`e:${since.getTime()}:${limit}:${slowMs}:${params.types?.join(",") ?? ""}`, async () => {
    const want = new Set<EngineEventType>(params.types ?? ["restart", "slow_request", "server_error", "error", "warning"]);
    const events: Array<Record<string, unknown>> = [];
    const keep = 5000; // newest kept while scanning
    await scan(
      since,
      (raw) =>
        raw.startsWith(`{"level":40`) || raw.startsWith(`{"level":50`) || raw.startsWith(`{"level":60`) ||
        raw.includes(`"msg":"http.out"`) || raw.includes(`"msg":"Server listening on`),
      (line, time) => {
        const msg = String(line.msg ?? "");
        const level = Number(line.level) || 30;
        let type: EngineEventType | null = null;
        let detail: Record<string, unknown> = {};
        if (msg.startsWith("Server listening on")) {
          type = "restart";
          detail = { pid: line.pid ?? null };
        } else if (msg === "http.out") {
          const url = String(line.url ?? "");
          if (WS_ROUTE_RE.test(url)) return;
          const ms = Number(line.responseTimeMs);
          const st = Number(line.statusCode);
          if (st >= 500) type = "server_error";
          else if (ms >= slowMs) type = "slow_request";
          else return;
          detail = { method: line.method, route: routeOf(url), status: st, duration_ms: ms };
        } else if (level >= 50) {
          type = "error";
        } else if (level === 40) {
          type = "warning";
        }
        if (!type || !want.has(type)) return;
        if (type === "error" || type === "warning") {
          const { level: _l, time: _t, msg: _m, pid: _p, hostname: _h, reqId: _r, ...rest } = line;
          const err = rest.err as Record<string, unknown> | undefined;
          detail = redact({ ...rest, err: err ? { type: err.type, message: err.message, code: err.code } : undefined }) as Record<string, unknown>;
        }
        events.push({ at: logTimeToIso(time), at_ist: time, type, level: level >= 50 ? "error" : level === 40 ? "warn" : "info", message: msg.slice(0, 300), detail });
        if (events.length > keep) events.splice(0, events.length - keep);
      }
    );
    events.reverse(); // newest first
    const counts: Record<string, number> = {};
    for (const e of events) counts[String(e.type)] = (counts[String(e.type)] ?? 0) + 1;
    return { since: since.toISOString(), slow_ms: slowMs, counts, total: events.length, events: events.slice(0, limit) };
  });
}
