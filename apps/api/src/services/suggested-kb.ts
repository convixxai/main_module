// Suggested-knowledgebase logging: when a live call gets an answer that looks
// like "not found in the KB", record the question (grouped with any earlier
// near-duplicate) so an admin can review it later and add a real KB entry.
//
// Hard requirement from the person who asked for this feature: must never add
// latency to a call and must never affect what the model says. Every export
// here is called fire-and-forget (`void ...`, never awaited by the caller)
// and all failures are swallowed - this runs entirely after the caller has
// already heard the answer.
import { pool } from "../config/db";
import { generateEmbedding } from "./llm";

/**
 * ask.ts's own isNotFound()/isOutOfScope() only match English sentinel text
 * the model is asked to emit (e.g. "answer_not_found"). That detection stops
 * being reliable once a tenant's system prompt / no_kb_fallback_instruction
 * tells the model to speak the "I don't know" fallback directly in the
 * caller's language (done for this customer 2026-09-16/17) - the model no
 * longer emits an English sentinel at all in that case. So this list is
 * deliberately separate from ask.ts's and matches on short, stable fragments
 * (not full sentences) so LLM paraphrasing of the rest of the sentence
 * doesn't break detection. Extend this list as new tenants/languages are
 * added rather than trying to make it fully generic up front.
 */
const NOT_FOUND_FRAGMENTS = [
  // Structural fallback strings ask.ts itself hardcodes (not LLM-generated,
  // so these are exact and language-independent by construction).
  "no knowledgebase entries found for this customer",
  "i couldn't find an answer to that in the knowledgebase",
  // English - mirrors ask.ts's NOT_FOUND_MARKERS plus this tenant's configured wording.
  "answer_not_found",
  "i don't have enough information",
  "not in the knowledgebase",
  "i cannot find",
  "i couldn't find",
  "no information available",
  "don't have information",
  "i don't have information about that",
  "please check google maps",
  // Marathi (this tenant's configured no_kb_fallback_instruction wording).
  "माहिती नाही",
  "मॅप्स तपासा",
  // Hindi (this tenant's configured no_kb_fallback_instruction wording).
  "जानकारी नहीं",
  "मैप्स देखें",
];

function looksLikeNoAnswer(answer: string): boolean {
  const lower = answer.toLowerCase();
  return NOT_FOUND_FRAGMENTS.some((f) => lower.includes(f.toLowerCase()));
}

/** Cosine distance below which a new question is folded into an existing pending suggestion instead of creating a duplicate row. */
const GROUP_DISTANCE_THRESHOLD = 0.15;

export type LogSuggestedKbParams = {
  customerId: string;
  question: string;
  answer: string;
  languageCode?: string | null;
  /** Free-text tag for where this came from, e.g. "vodafone-voicebot". */
  source: string;
  log?: { warn: (obj: unknown, msg: string) => void };
};

/**
 * Fire-and-forget: checks whether `answer` looks like a KB miss, and if so
 * records/groups it under suggested_kb_entries. Never throws, never returns
 * a promise the caller is expected to await - call this as a bare statement
 * (`logSuggestedKbEntryIfNoAnswer({...})`), not `await`ed.
 */
export function logSuggestedKbEntryIfNoAnswer(params: LogSuggestedKbParams): void {
  const question = params.question.trim();
  const answer = params.answer.trim();
  if (!question || !answer || !looksLikeNoAnswer(answer)) return;

  void (async () => {
    try {
      const embedding = await generateEmbedding(question);
      const embeddingStr = `[${embedding.join(",")}]`;

      const existing = await pool.query<{ id: string; distance: number }>(
        `SELECT id, (embedding <=> $2::vector) AS distance
           FROM suggested_kb_entries
          WHERE customer_id = $1 AND status = 'pending' AND embedding IS NOT NULL
          ORDER BY embedding <=> $2::vector
          LIMIT 1`,
        [params.customerId, embeddingStr]
      );

      const match = existing.rows[0];
      if (match && Number(match.distance) < GROUP_DISTANCE_THRESHOLD) {
        await pool.query(
          `UPDATE suggested_kb_entries
              SET occurrence_count = occurrence_count + 1,
                  last_asked_at = now(),
                  answer_given = $2,
                  updated_at = now()
            WHERE id = $1`,
          [match.id, answer.slice(0, 2000)]
        );
        return;
      }

      await pool.query(
        `INSERT INTO suggested_kb_entries
           (customer_id, question, question_language_code, answer_given, source, embedding)
         VALUES ($1, $2, $3, $4, $5, $6::vector)`,
        [
          params.customerId,
          question.slice(0, 2000),
          params.languageCode || null,
          answer.slice(0, 2000),
          params.source,
          embeddingStr,
        ]
      );
    } catch (err) {
      params.log?.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "suggested-kb: failed to log suggested entry"
      );
    }
  })();
}
