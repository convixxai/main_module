// Suggested knowledgebase (suggested_kb_entries, migrations 017 + 026).
//
// Two kinds of caller questions are recorded for the customer to review in
// the SaaS (pending -> added / rejected):
//   - "unanswered":  the bot could not answer (no KB entry, out of scope, or
//                    the model said it doesn't know);
//   - "ai_answered": the AI answered, but nothing in the KB was close to the
//                    question, so the answer came from the model, not the KB.
// Near-duplicate questions are grouped into one pending row
// (occurrence_count) by embedding distance.
//
// Hard requirement: zero effect on the call. runAskPipeline calls
// queueSuggestedKb() only after the answer exists; it is a synchronous push
// onto an in-memory queue (no I/O, no await). A single background worker
// drains the queue one item at a time, starting on a later event-loop turn,
// so it never competes with a reply for the embedding server or the DB
// pool. Every failure is swallowed (logged at most). If the queue is full the
// item is dropped: suggestions are best-effort, the call never waits.
import { pool } from "../config/db";
import { generateEmbedding } from "./llm";
import { isLanguageNeutralUtterance } from "./voice-language-infer";

/**
 * Fragments of "I don't know" replies. Matched on short, stable fragments so
 * paraphrasing doesn't break detection. Extend as tenants/languages are added.
 */
const NOT_FOUND_FRAGMENTS = [
  // Fixed fallback strings ask.ts itself returns.
  "no knowledgebase entries found for this customer",
  "i couldn't find an answer to that in the knowledgebase",
  "i can help with questions related to this business and its services",
  // English.
  "answer_not_found",
  "i don't have enough information",
  "not in the knowledgebase",
  "i cannot find",
  "i couldn't find",
  "no information available",
  "don't have information",
  "i don't have information about that",
  "i don't have that information",
  "please check google maps",
  // Marathi.
  "माहिती नाही",
  "माहिती उपलब्ध नाही",
  "मॅप्स तपासा",
  // Hindi.
  "जानकारी नहीं",
  "जानकारी उपलब्ध नहीं",
  "मैप्स देखें",
];

export function looksLikeNoAnswer(answer: string): boolean {
  const lower = answer.toLowerCase();
  return NOT_FOUND_FRAGMENTS.some((f) => lower.includes(f.toLowerCase()));
}

/** Cosine distance below which a question is folded into an existing pending suggestion. */
const GROUP_DISTANCE_THRESHOLD = 0.15;

/**
 * An AI answer counts as "not from the KB" when the best KB match is at least
 * this far (cosine distance) from the question, or there was no match at all.
 * KB direct matches are < 0.3 (ask.ts DIRECT_MATCH_THRESHOLD).
 */
const AI_ANSWER_MIN_KB_DISTANCE = (() => {
  const v = Number(process.env.SUGGESTED_KB_AI_ANSWER_MIN_DISTANCE);
  return Number.isFinite(v) && v > 0 && v < 2 ? v : 0.45;
})();

/** Questions shorter than this (chars, after trimming) are small talk ("yes", "ok"): skipped. */
const MIN_QUESTION_CHARS = 10;

const ENABLED = String(process.env.SUGGESTED_KB_ENABLED ?? "true").toLowerCase() !== "false";
const MAX_QUEUE = 500;

export type SuggestedKbKind = "unanswered" | "ai_answered";

export type SuggestedKbTurn = {
  customerId: string;
  question: string;
  answer: string;
  /** AskPipelineResult.source: "none" | "kb-direct" | "openai" | "self-hosted" | ... */
  answerSource: string;
  agentId: string | null;
  sessionId: string | null;
  languageCode: string | null;
  topDistance: number | null;
  kbMatchCount: number;
  toolCalls: string[];
  /** Where the question came from, e.g. "vodafone-voicebot", "ask-api". */
  source: string;
};

/** Which kind of suggestion a turn is, or null when it should not be suggested. Pure, no I/O. */
export function classifySuggestedKbTurn(t: SuggestedKbTurn): SuggestedKbKind | null {
  const q = t.question.trim();
  const a = t.answer.trim();
  if (q.length < MIN_QUESTION_CHARS || !a) return null;
  if (isLanguageNeutralUtterance(q)) return null;
  // Turns that used CRM tools are about the caller's own data (name, order,
  // booking), not general knowledge.
  if (t.toolCalls.length > 0) return null;
  if (t.answerSource === "none" || looksLikeNoAnswer(a)) return "unanswered";
  if (t.answerSource === "kb-direct") return null; // answered straight from the KB
  if (t.topDistance === null || t.topDistance >= AI_ANSWER_MIN_KB_DISTANCE) return "ai_answered";
  return null; // answered with a close KB match
}

const queue: SuggestedKbTurn[] = [];
let draining = false;
let log: { warn: (o: object, m: string) => void } | null = null;

/** Optional logger for background failures (set once at startup). */
export function setSuggestedKbLogger(l: { warn: (o: object, m: string) => void }): void {
  log = l;
}

/**
 * Fire-and-forget, synchronous, never throws. Classifies the turn (pure CPU,
 * microseconds) and, when it is a suggestion, pushes it for the background
 * worker. Call it as a bare statement, never awaited.
 */
export function queueSuggestedKb(turn: SuggestedKbTurn): void {
  try {
    if (!ENABLED) return;
    const kind = classifySuggestedKbTurn(turn);
    if (!kind) return;
    if (queue.length >= MAX_QUEUE) return; // best-effort: never grow without bound
    queue.push(turn);
    if (!draining) {
      draining = true;
      // Start on a later event-loop turn, after the current reply's work.
      setImmediate(() => void drain());
    }
  } catch {
    // never affect the caller
  }
}

async function drain(): Promise<void> {
  try {
    while (queue.length > 0) {
      const turn = queue.shift()!;
      try {
        await saveSuggestion(turn);
      } catch (err) {
        log?.warn({ err: err instanceof Error ? err.message : String(err), source: turn.source }, "suggested-kb: failed to save suggestion");
      }
    }
  } finally {
    draining = false;
    if (queue.length > 0) {
      draining = true;
      setImmediate(() => void drain());
    }
  }
}

async function saveSuggestion(t: SuggestedKbTurn): Promise<void> {
  const kind = classifySuggestedKbTurn(t);
  if (!kind) return;
  const question = t.question.trim().slice(0, 2000);
  const answer = t.answer.trim().slice(0, 2000);
  const embedding = await generateEmbedding(question);
  const embeddingStr = `[${embedding.join(",")}]`;

  // Nearest earlier suggestion in any status: a question the customer
  // already rejected (or added) is counted on that row, not suggested again.
  const existing = await pool.query<{ id: string; distance: number; status: string }>(
    `SELECT id, status, (embedding <=> $2::vector) AS distance
       FROM suggested_kb_entries
      WHERE customer_id = $1 AND embedding IS NOT NULL
      ORDER BY embedding <=> $2::vector
      LIMIT 1`,
    [t.customerId, embeddingStr]
  );
  const match = existing.rows[0];
  if (match && Number(match.distance) < GROUP_DISTANCE_THRESHOLD && match.status !== "pending") {
    await pool.query(
      `UPDATE suggested_kb_entries
          SET occurrence_count = occurrence_count + 1, last_asked_at = now(), updated_at = now()
        WHERE id = $1`,
      [match.id]
    );
    return;
  }
  if (match && Number(match.distance) < GROUP_DISTANCE_THRESHOLD) {
    // Same question again: count it, keep the latest answer and call. An
    // "unanswered" stays unanswered; an AI answer is kept as the draft answer.
    await pool.query(
      `UPDATE suggested_kb_entries
          SET occurrence_count = occurrence_count + 1,
              last_asked_at = now(),
              answer_given = $2,
              kind = CASE WHEN kind = 'unanswered' OR $3 = 'unanswered' THEN 'unanswered' ELSE 'ai_answered' END,
              kb_top_distance = $4,
              last_session_id = COALESCE($5::uuid, last_session_id),
              agent_id = COALESCE($6::uuid, agent_id),
              updated_at = now()
        WHERE id = $1`,
      [match.id, answer, kind, t.topDistance, t.sessionId, t.agentId]
    );
    return;
  }

  await pool.query(
    `INSERT INTO suggested_kb_entries
       (customer_id, question, question_language_code, answer_given, source, embedding,
        kind, kb_top_distance, last_session_id, agent_id)
     VALUES ($1, $2, $3, $4, $5, $6::vector, $7, $8, $9::uuid, $10::uuid)`,
    [t.customerId, question, t.languageCode || null, answer, t.source, embeddingStr, kind, t.topDistance, t.sessionId, t.agentId]
  );
}

/** For tests: wait until the background queue is empty. */
export async function waitForSuggestedKbIdle(timeoutMs = 10_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while ((draining || queue.length > 0) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20));
  }
}
