// ============================================================
// Native-language KB search (customer_settings.kb_native_languages).
//
// A tenant that stores its KB in kb_entries in several languages (e.g. the
// same entries in English, Marathi and Hindi) lists those languages in
// kb_native_languages. A question in a listed language is then embedded as
// spoken, without the Sarvam translate-for-search call (~0.5 s per turn).
//
// Safety: a configured language only takes effect when the KB really holds
// entries in it. A row counts for a language when its source_language_code
// is that language, or its question is written in that language's script
// (Devanagari for hi/mr, etc.). Otherwise the flag is ignored and the
// question is translated as before, so a flag set too early never searches
// Marathi words against an English-only KB.
// ============================================================

import { pool } from "../config/db";

/** Script of each supported non-English language (Unicode block). */
const SCRIPT_RANGES: Record<string, [number, number]> = {
  hi: [0x0900, 0x097f], mr: [0x0900, 0x097f], ne: [0x0900, 0x097f], // Devanagari
  bn: [0x0980, 0x09ff], as: [0x0980, 0x09ff], // Bengali / Assamese
  pa: [0x0a00, 0x0a7f], // Gurmukhi
  gu: [0x0a80, 0x0aff], // Gujarati
  or: [0x0b00, 0x0b7f], // Odia
  ta: [0x0b80, 0x0bff], // Tamil
  te: [0x0c00, 0x0c7f], // Telugu
  kn: [0x0c80, 0x0cff], // Kannada
  ml: [0x0d00, 0x0d7f], // Malayalam
};

export const KB_NATIVE_LANGUAGE_CODES = ["en", ...Object.keys(SCRIPT_RANGES)];

/** "mr-IN" / "mr_IN" / "MR" -> "mr". */
export function primaryLanguage(code: string): string {
  return String(code).trim().toLowerCase().split(/[-_]/)[0];
}

/** Normalised, de-duplicated list of supported primary codes ("mr-IN" -> "mr"). Unknown codes are dropped. */
export function normaliseKbNativeLanguages(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const out = new Set<string>();
  for (const c of codes) {
    if (typeof c !== "string") continue;
    const p = primaryLanguage(c);
    if (KB_NATIVE_LANGUAGE_CODES.includes(p)) out.add(p);
  }
  return [...out];
}

function scriptClass(lang: string): string | null {
  const r = SCRIPT_RANGES[lang];
  return r ? `[${String.fromCodePoint(r[0])}-${String.fromCodePoint(r[1])}]` : null;
}

/** How many KB entries of this customer are in each of the given languages. */
export async function kbEntryCountsByLanguage(customerId: string, langs: string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const list = [...new Set(langs.map(primaryLanguage))];
  await Promise.all(
    list.map(async (lang) => {
      const cls = scriptClass(lang);
      const r = await pool.query(
        cls
          ? `SELECT COUNT(*)::int AS n FROM kb_entries
              WHERE customer_id = $1
                AND (lower(split_part(replace(coalesce(source_language_code, ''), '_', '-'), '-', 1)) = $2
                     OR question ~ $3 OR answer ~ $3)`
          : // English (or another Latin-script language): rows with no Indic script at all.
            `SELECT COUNT(*)::int AS n FROM kb_entries
              WHERE customer_id = $1 AND question !~ $3 AND answer !~ $3 AND $2 = $2`,
        [customerId, lang, cls ?? "[ऀ-ൿ]"]
      );
      out[lang] = r.rows[0]?.n ?? 0;
    })
  );
  return out;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { key: string; ts: number; langs: string[] }>();

export function invalidateKbNativeLanguagesCache(customerId: string): void {
  cache.delete(customerId);
}

/**
 * The configured languages that the KB actually holds entries in (cached
 * 1 min). Empty when nothing is configured: callers then translate as before.
 * Never throws: on a DB error the flag is ignored for this turn.
 */
export async function effectiveKbNativeLanguages(customerId: string, configured: unknown): Promise<string[]> {
  const langs = normaliseKbNativeLanguages(configured).filter((l) => l !== "en");
  if (langs.length === 0) return [];
  const key = langs.join(",");
  const hit = cache.get(customerId);
  if (hit && hit.key === key && Date.now() - hit.ts < CACHE_TTL_MS) return hit.langs;
  try {
    const counts = await kbEntryCountsByLanguage(customerId, langs);
    const usable = langs.filter((l) => (counts[l] ?? 0) > 0);
    cache.set(customerId, { key, ts: Date.now(), langs: usable });
    return usable;
  } catch {
    return [];
  }
}
