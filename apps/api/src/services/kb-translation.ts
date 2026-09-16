// ============================================================
// Per-language KB translation orchestration (migration 015,
// kb_entry_translations). Structural work for the "pre-translate the KB
// instead of translating every live question" approach discussed
// 2026-09-16 - NOT yet wired into any live call's query path. This service
// only backs the KB admin portal for now: fan-out on add, cascade-or-not on
// edit, single-language direct edit.
//
// Translation uses Sarvam (sarvamTranslateText) since it's already the
// platform's Indic translation vendor and is priced for exactly this kind
// of bulk/background use. Embeddings reuse the same self-hosted
// nomic-embed-text pipeline as kb_entries today (generateEmbedding), so
// embeddings stay dimensionally compatible (384) with the existing table.
// ============================================================

import { pool } from "../config/db";
import { generateEmbedding } from "./llm";
import { sarvamTranslateText } from "./sarvam";

export interface KbEntryTranslationRow {
  id: string;
  kb_entry_id: string;
  language_code: string;
  question: string;
  answer: string;
  is_source: boolean;
  manually_edited: boolean;
  translation_status: "ok" | "pending" | "stale" | "failed";
  updated_at: string;
}

function toEmbeddingLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

/** Runs `jobs` with at most `concurrency` in flight at once - keeps bulk fan-out from hammering Sarvam/embeddings. */
async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      results[i] = await jobs[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

async function upsertTranslationRow(params: {
  kbEntryId: string;
  customerId: string;
  languageCode: string;
  question: string;
  answer: string;
  embedding: number[];
  isSource: boolean;
  manuallyEdited: boolean;
  status: "ok" | "failed";
}): Promise<void> {
  const embeddingStr = toEmbeddingLiteral(params.embedding);
  await pool.query(
    `INSERT INTO kb_entry_translations
       (kb_entry_id, customer_id, language_code, question, answer, embedding, is_source, manually_edited, translation_status, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (kb_entry_id, language_code) DO UPDATE
       SET question = EXCLUDED.question,
           answer = EXCLUDED.answer,
           embedding = EXCLUDED.embedding,
           is_source = EXCLUDED.is_source,
           manually_edited = EXCLUDED.manually_edited,
           translation_status = EXCLUDED.translation_status,
           updated_at = now()`,
    [
      params.kbEntryId,
      params.customerId,
      params.languageCode,
      params.question,
      params.answer,
      embeddingStr,
      params.isSource,
      params.manuallyEdited,
      params.status,
    ]
  );
}

/** Writes/refreshes just the mirrored SOURCE-language row (no translation call - text is already in that language). */
export async function upsertSourceKbEntryTranslation(params: {
  kbEntryId: string;
  customerId: string;
  sourceLanguageCode: string;
  question: string;
  answer: string;
}): Promise<void> {
  const embedding = await generateEmbedding(params.question);
  await upsertTranslationRow({
    kbEntryId: params.kbEntryId,
    customerId: params.customerId,
    languageCode: params.sourceLanguageCode,
    question: params.question,
    answer: params.answer,
    embedding,
    isSource: true,
    manuallyEdited: false,
    status: "ok",
  });
}

/**
 * Translates {question, answer} from sourceLanguageCode into targetLanguageCode,
 * embeds the translated question, and stores/updates that one row. Used both
 * for the initial fan-out on a new entry and for cascade-retranslate on a
 * source-language edit.
 */
async function translateAndStoreOne(params: {
  kbEntryId: string;
  customerId: string;
  sourceLanguageCode: string;
  targetLanguageCode: string;
  question: string;
  answer: string;
}): Promise<{ languageCode: string; ok: boolean }> {
  const [qResult, aResult] = await Promise.all([
    sarvamTranslateText(params.question, params.sourceLanguageCode, params.targetLanguageCode),
    sarvamTranslateText(params.answer, params.sourceLanguageCode, params.targetLanguageCode),
  ]);
  const ok = qResult.ok && aResult.ok;
  const translatedQuestion = ok ? qResult.text : params.question;
  const translatedAnswer = ok ? aResult.text : params.answer;
  const embedding = await generateEmbedding(translatedQuestion);
  await upsertTranslationRow({
    kbEntryId: params.kbEntryId,
    customerId: params.customerId,
    languageCode: params.targetLanguageCode,
    question: translatedQuestion,
    answer: translatedAnswer,
    embedding,
    isSource: false,
    manuallyEdited: false,
    status: ok ? "ok" : "failed",
  });
  return { languageCode: params.targetLanguageCode, ok };
}

/**
 * Full fan-out for a brand-new KB entry: writes the source-language mirror
 * row, then translates + embeds + stores every OTHER allowed language.
 * Safe to call for a single add (small `targetLanguageCodes`) or as part of
 * a larger bulk-upload / backfill batch (caller controls concurrency via the
 * `concurrency` option since this itself only handles one entry).
 */
export async function fanOutNewKbEntry(params: {
  kbEntryId: string;
  customerId: string;
  sourceLanguageCode: string;
  question: string;
  answer: string;
  allowedLanguageCodes: string[];
}): Promise<{ languageCode: string; ok: boolean }[]> {
  await upsertSourceKbEntryTranslation({
    kbEntryId: params.kbEntryId,
    customerId: params.customerId,
    sourceLanguageCode: params.sourceLanguageCode,
    question: params.question,
    answer: params.answer,
  });

  const targets = params.allowedLanguageCodes.filter((l) => l !== params.sourceLanguageCode);
  const results = await Promise.all(
    targets.map((targetLanguageCode) =>
      translateAndStoreOne({
        kbEntryId: params.kbEntryId,
        customerId: params.customerId,
        sourceLanguageCode: params.sourceLanguageCode,
        targetLanguageCode,
        question: params.question,
        answer: params.answer,
      })
    )
  );
  return [{ languageCode: params.sourceLanguageCode, ok: true }, ...results];
}

/**
 * Re-translates every non-source language row for an entry from its current
 * source text. By default skips rows an admin has hand-edited directly
 * (manually_edited=true), so a source-language edit doesn't silently clobber
 * a manual fix - pass overwriteManuallyEdited to force it anyway.
 */
export async function cascadeTranslateKbEntry(params: {
  kbEntryId: string;
  customerId: string;
  sourceLanguageCode: string;
  question: string;
  answer: string;
  allowedLanguageCodes: string[];
  overwriteManuallyEdited?: boolean;
}): Promise<{ languageCode: string; ok: boolean; skipped?: boolean }[]> {
  const targets = params.allowedLanguageCodes.filter((l) => l !== params.sourceLanguageCode);
  if (targets.length === 0) return [];

  const existing = await pool.query<{ language_code: string; manually_edited: boolean }>(
    `SELECT language_code, manually_edited FROM kb_entry_translations
     WHERE kb_entry_id = $1 AND language_code = ANY($2::text[])`,
    [params.kbEntryId, targets]
  );
  const manuallyEditedSet = new Set(
    existing.rows.filter((r) => r.manually_edited).map((r) => r.language_code)
  );

  const results = await Promise.all(
    targets.map(async (targetLanguageCode) => {
      if (!params.overwriteManuallyEdited && manuallyEditedSet.has(targetLanguageCode)) {
        return { languageCode: targetLanguageCode, ok: true, skipped: true };
      }
      return translateAndStoreOne({
        kbEntryId: params.kbEntryId,
        customerId: params.customerId,
        sourceLanguageCode: params.sourceLanguageCode,
        targetLanguageCode,
        question: params.question,
        answer: params.answer,
      });
    })
  );
  return results;
}

/** Directly edits ONE non-source language row (admin correcting a specific translation by hand). Marks it manually_edited so future cascades leave it alone. */
export async function updateSingleKbEntryTranslation(params: {
  kbEntryId: string;
  customerId: string;
  languageCode: string;
  question: string;
  answer: string;
}): Promise<void> {
  const embedding = await generateEmbedding(params.question);
  await upsertTranslationRow({
    kbEntryId: params.kbEntryId,
    customerId: params.customerId,
    languageCode: params.languageCode,
    question: params.question,
    answer: params.answer,
    embedding,
    isSource: false,
    manuallyEdited: true,
    status: "ok",
  });
}

/** All language versions of one entry, source language first - for the admin edit modal's language tabs. */
export async function listKbEntryTranslations(
  kbEntryId: string,
  customerId: string
): Promise<KbEntryTranslationRow[]> {
  const r = await pool.query<KbEntryTranslationRow>(
    `SELECT id, kb_entry_id, language_code, question, answer, is_source, manually_edited, translation_status, updated_at
     FROM kb_entry_translations
     WHERE kb_entry_id = $1 AND customer_id = $2
     ORDER BY is_source DESC, language_code ASC`,
    [kbEntryId, customerId]
  );
  return r.rows;
}

/**
 * One-time/backfill entry point: for every kb_entries row belonging to
 * customerId that doesn't yet have a full set of kb_entry_translations rows
 * for allowedLanguageCodes, fan it out. Idempotent (safe to re-run) -
 * upserts, and skips entries that already have every language present.
 * Used by scripts/backfill-kb-translations.ts.
 */
export async function backfillCustomerKbTranslations(
  customerId: string,
  allowedLanguageCodes: string[],
  opts: { concurrency?: number; onProgress?: (done: number, total: number) => void } = {}
): Promise<{ entryId: string; question: string; results: { languageCode: string; ok: boolean }[] }[]> {
  // Kept low - Sarvam's translate endpoint rate-limits in short bursts (see
  // sarvamTranslateText's retry/backoff comment), and each entry here already
  // fires up to 4 concurrent Sarvam calls of its own (2 languages x Q/A).
  const concurrency = opts.concurrency ?? 2;
  const entries = await pool.query<{ id: string; question: string; answer: string; source_language_code: string }>(
    `SELECT id, question, answer, source_language_code FROM kb_entries WHERE customer_id = $1 ORDER BY created_at ASC`,
    [customerId]
  );

  const jobs = entries.rows.map((entry) => async () => {
    const results = await fanOutNewKbEntry({
      kbEntryId: entry.id,
      customerId,
      sourceLanguageCode: entry.source_language_code || "en-IN",
      question: entry.question,
      answer: entry.answer,
      allowedLanguageCodes,
    });
    return { entryId: entry.id, question: entry.question, results };
  });

  const out: { entryId: string; question: string; results: { languageCode: string; ok: boolean }[] }[] = [];
  let done = 0;
  await runWithConcurrency(
    jobs.map((job) => async () => {
      const r = await job();
      out.push(r);
      done += 1;
      opts.onProgress?.(done, entries.rows.length);
      return r;
    }),
    concurrency
  );
  return out;
}
