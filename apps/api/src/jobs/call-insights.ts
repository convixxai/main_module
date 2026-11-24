// ============================================================
// Post-call analysis (A4 disposition, A5 voicemail, A6 sentiment, A7 markers).
//
// Runs in its own process (jobs/call-insights-worker.ts, PM2
// "convixx-call-insights"), never in the API process that handles calls, and
// only for calls that have ENDED: nothing here touches a live call. One LLM
// request per call with a conversation (OpenAI, the customer's own model
// setting); a call where the caller never spoke is saved as
// "no_conversation" without any LLM request.
//
// Per customer (call_insight_settings; no row = on, markers off):
//   enabled          analyse this customer's calls
//   markers_enabled  also return up to 8 {at_seconds, label} topic markers
// Result: one call_insights row per call (status done | error; an error is
// retried up to 3 times, 10 minutes apart).
// ============================================================

import { pool } from "../config/db";
import { env } from "../config/env";
import { decrypt } from "../services/crypto";

export const DISPOSITIONS = [
  "interested",
  "not_interested",
  "callback",
  "qualified",
  "converted",
  "voicemail",
  "wrong_number",
  "no_conversation",
] as const;
type Disposition = (typeof DISPOSITIONS)[number];

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
const MAX_ATTEMPTS = 3;
const MAX_TRANSCRIPT_CHARS = 12_000;

/** USD per 1M tokens (input, output), for the cost column only. */
const PRICES: Record<string, [number, number]> = {
  "gpt-6-luna": [0.1, 0.5],
  "gpt-5.6-luna": [0.2, 1.2],
  "gpt-5-mini": [0.25, 2],
  "gpt-5-nano": [0.05, 0.4],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1": [2, 8],
  "gpt-4o-mini": [0.15, 0.6],
  "gpt-4o": [2.5, 10],
};

export interface InsightOptions {
  batch: number;
  lookbackDays: number;
  /** Overrides every customer's model (CALL_INSIGHTS_MODEL). */
  model?: string | null;
  log: (msg: string, extra?: Record<string, unknown>) => void;
}

interface CallRow {
  id: string;
  customer_id: string;
  chat_session_id: string | null;
  duration_seconds: number;
  direction: string | null;
  markers_enabled: boolean;
  model: string | null;
  attempts: number | null;
}

interface Line {
  at: number;
  role: "bot" | "caller";
  text: string;
}

/** Request params per model family (GPT-5 / GPT-6 reject temperature / max_tokens). */
function generationParams(model: string, maxTokens: number): Record<string, unknown> {
  if (/^gpt-6/i.test(model)) return { max_completion_tokens: maxTokens, reasoning_effort: "none" };
  if (/^gpt-5/i.test(model)) return { max_completion_tokens: maxTokens + 400, reasoning_effort: "minimal" };
  return { max_tokens: maxTokens, temperature: 0 };
}

function cost(model: string, prompt: number, completion: number): number | null {
  const p = PRICES[model.replace(/-\d{4}-\d{2}-\d{2}$/, "")];
  return p ? (prompt / 1e6) * p[0] + (completion / 1e6) * p[1] : null;
}

const clamp = (v: unknown, lo: number, hi: number): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null;
};

async function pickCalls(o: InsightOptions): Promise<CallRow[]> {
  const r = await pool.query(
    `SELECT s.id, s.customer_id, s.chat_session_id, s.direction,
            GREATEST(0, EXTRACT(EPOCH FROM (s.ended_at - s.started_at)))::int AS duration_seconds,
            COALESCE(st.markers_enabled, FALSE) AS markers_enabled,
            COALESCE(NULLIF(TRIM(cs.llm_model_override), ''), NULLIF(TRIM(cs.openai_model), '')) AS model,
            ci.attempts
       FROM exotel_call_sessions s
       LEFT JOIN call_insights ci ON ci.call_session_id = s.id
       LEFT JOIN call_insight_settings st ON st.customer_id = s.customer_id
       LEFT JOIN customer_settings cs ON cs.customer_id = s.customer_id
      WHERE s.ended_at IS NOT NULL
        AND s.ended_at < (NOW() AT TIME ZONE 'UTC') - interval '2 minutes'
        AND s.started_at > (NOW() AT TIME ZONE 'UTC') - make_interval(days => $1::int)
        AND COALESCE(st.enabled, TRUE)
        AND (ci.call_session_id IS NULL
             OR (ci.status = 'error' AND ci.attempts < ${MAX_ATTEMPTS} AND ci.updated_at < NOW() - interval '10 minutes'))
      ORDER BY s.ended_at DESC
      LIMIT $2`,
    [o.lookbackDays, o.batch]
  );
  return r.rows;
}

async function transcript(call: CallRow): Promise<Line[]> {
  if (!call.chat_session_id) return [];
  const r = await pool.query(
    `SELECT m.role, m.content,
            GREATEST(0, EXTRACT(EPOCH FROM (m.created_at - s.started_at)))::int AS at
       FROM chat_messages m JOIN exotel_call_sessions s ON s.id = $2
      WHERE m.session_id = $1 AND m.role IN ('user', 'assistant')
      ORDER BY m.created_at ASC, m.id ASC
      LIMIT 400`,
    [call.chat_session_id, call.id]
  );
  const out: Line[] = [];
  for (const m of r.rows) {
    let text = "";
    try {
      text = decrypt(m.content);
    } catch {
      continue;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text) out.push({ at: Math.min(Number(m.at) || 0, call.duration_seconds || Number(m.at) || 0), role: m.role === "user" ? "caller" : "bot", text });
  }
  return out;
}

const mmss = (s: number) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

function prompt(call: CallRow, lines: Line[]): { system: string; user: string } {
  let body = lines.map((l) => `[${mmss(l.at)}] ${l.role}: ${l.text}`).join("\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) body = `${body.slice(0, MAX_TRANSCRIPT_CHARS / 2)}\n…\n${body.slice(-MAX_TRANSCRIPT_CHARS / 2)}`;
  const markers = call.markers_enabled
    ? `"markers": up to 8 objects {"at_seconds": <integer, from the [mm:ss] times>, "label": "<2-4 English words, e.g. Greeting, Pricing, Demo offer>"} for the topics in order.`
    : `"markers": [] (not requested).`;
  const system = `You label finished phone calls between a voice bot and a caller (the transcript may be in any Indian language or English). Reply with ONE JSON object only, no prose:
{"disposition": one of ${DISPOSITIONS.map((d) => `"${d}"`).join(", ")},
 "disposition_confidence": 0..1,
 "sentiment": "positive" | "neutral" | "negative" (the caller's overall mood),
 "sentiment_score": -1..1,
 "is_voicemail": true if the "caller" is an answering machine / voicemail greeting, else false,
 ${markers}}
Dispositions: interested = wants to know more / positive; qualified = interested AND meets the stated criteria or gave the details asked for; converted = agreed to buy / book / confirm; callback = asked to be called later or is busy; not_interested = declined; voicemail = answering machine; wrong_number = not the intended person or business; no_conversation = the caller said nothing meaningful.`;
  const user = `Call: ${call.direction ?? "unknown"} direction, ${call.duration_seconds} seconds.\nTranscript:\n${body}`;
  return { system, user };
}

async function save(call: CallRow, v: Record<string, unknown>): Promise<void> {
  await pool.query(
    `INSERT INTO call_insights (call_session_id, customer_id, status, disposition, disposition_confidence, sentiment, sentiment_score,
                                is_voicemail, markers, model, prompt_tokens, completion_tokens, cost_usd, error, attempts, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, 1, NOW())
     ON CONFLICT (call_session_id) DO UPDATE SET
       status = EXCLUDED.status, disposition = EXCLUDED.disposition, disposition_confidence = EXCLUDED.disposition_confidence,
       sentiment = EXCLUDED.sentiment, sentiment_score = EXCLUDED.sentiment_score, is_voicemail = EXCLUDED.is_voicemail,
       markers = EXCLUDED.markers, model = EXCLUDED.model, prompt_tokens = EXCLUDED.prompt_tokens,
       completion_tokens = EXCLUDED.completion_tokens, cost_usd = EXCLUDED.cost_usd, error = EXCLUDED.error,
       attempts = call_insights.attempts + 1, updated_at = NOW()`,
    [
      call.id,
      call.customer_id,
      v.status,
      v.disposition ?? null,
      v.disposition_confidence ?? null,
      v.sentiment ?? null,
      v.sentiment_score ?? null,
      v.is_voicemail ?? null,
      v.markers != null ? JSON.stringify(v.markers) : null,
      v.model ?? null,
      v.prompt_tokens ?? null,
      v.completion_tokens ?? null,
      v.cost_usd ?? null,
      v.error ?? null,
    ]
  );
}

/** Validates the model's JSON; throws on anything unusable. */
export function parseInsight(raw: string, call: { duration_seconds: number; markers_enabled: boolean }) {
  const j = JSON.parse(raw) as Record<string, unknown>;
  const disposition = String(j.disposition ?? "").toLowerCase() as Disposition;
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`invalid disposition "${String(j.disposition).slice(0, 40)}"`);
  const sentiment = String(j.sentiment ?? "neutral").toLowerCase();
  const isVoicemail = j.is_voicemail === true || disposition === "voicemail";
  let markers: Array<{ at_seconds: number; label: string }> | null = null;
  if (call.markers_enabled) {
    markers = (Array.isArray(j.markers) ? j.markers : [])
      .map((m) => m as Record<string, unknown>)
      .filter((m) => m && typeof m.label === "string" && m.label.trim())
      .map((m) => ({ at_seconds: Math.round(clamp(m.at_seconds, 0, Math.max(0, call.duration_seconds)) ?? 0), label: String(m.label).trim().slice(0, 40) }))
      .sort((a, b) => a.at_seconds - b.at_seconds)
      .slice(0, 8);
  }
  return {
    disposition: isVoicemail ? ("voicemail" as Disposition) : disposition,
    disposition_confidence: clamp(j.disposition_confidence, 0, 1),
    sentiment: (SENTIMENTS as readonly string[]).includes(sentiment) ? sentiment : "neutral",
    sentiment_score: clamp(j.sentiment_score, -1, 1),
    is_voicemail: isVoicemail,
    markers,
  };
}

async function analyse(call: CallRow, o: InsightOptions): Promise<void> {
  const lines = await transcript(call);
  if (!lines.some((l) => l.role === "caller" && l.text.length > 1)) {
    // The caller never spoke: no LLM request needed.
    await save(call, {
      status: "done",
      disposition: "no_conversation",
      disposition_confidence: 1,
      sentiment: "neutral",
      sentiment_score: 0,
      is_voicemail: false,
      markers: call.markers_enabled ? [] : null,
    });
    return;
  }
  const model = (o.model || call.model || env.openai.model).trim();
  const { system, user } = prompt(call, lines);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      response_format: { type: "json_object" },
      ...generationParams(model, call.markers_enabled ? 500 : 200),
    }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await res.json().catch(() => null)) as any;
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
  const text = String(body?.choices?.[0]?.message?.content ?? "");
  const usage = body?.usage ?? {};
  const parsed = parseInsight(text, call);
  await save(call, {
    status: "done",
    ...parsed,
    model: String(body?.model ?? model),
    prompt_tokens: usage.prompt_tokens ?? null,
    completion_tokens: usage.completion_tokens ?? null,
    cost_usd: cost(model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
  });
}

/** One pass: analyses up to `batch` ended calls. Returns how many were handled. */
export async function runInsightsBatch(o: InsightOptions): Promise<{ done: number; failed: number }> {
  const calls = await pickCalls(o);
  let done = 0;
  let failed = 0;
  for (const call of calls) {
    try {
      await analyse(call, o);
      done++;
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      o.log("call-insights: analysis failed (will retry)", { call_session_id: call.id, error: message });
      await save(call, { status: "error", error: message.slice(0, 500) }).catch(() => {});
    }
  }
  return { done, failed };
}
