/**
 * Multi-tenant entity-name handling for voicebot STT correction and RAG replies.
 * STT often mistranscribes business/product/place names; RAG must use KB + tenant config, not echo errors.
 */

/** Apply tenant STT correction map; Unicode phrases use substring match (not \\b). */
export function applySttDomainWordCorrections(
  transcript: string,
  domainWords: Record<string, string>
): string {
  let out = transcript;
  const entries = Object.entries(domainWords)
    .filter(([k, v]) => k.trim() && v.trim())
    .sort((a, b) => b[0].length - a[0].length);

  for (const [misrecognised, correctWord] of entries) {
    const escaped = misrecognised.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const isAsciiToken = /^[\x00-\x7F]+$/.test(misrecognised);
    const re = isAsciiToken
      ? new RegExp(`\\b${escaped}\\b`, "gi")
      : new RegExp(escaped, "giu");
    out = out.replace(re, correctWord);
  }
  return out;
}

function readStringRecord(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === "string" && typeof v === "string" && k.trim() && v.trim()) {
      out[k.trim()] = v.trim();
    }
  }
  return out;
}

function readStringList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
}

/**
 * Merge customer_settings.stt_domain_words with optional industry_context STT correction maps.
 * Supported keys (any tenant): `stt_corrections`, `brand_stt_corrections` (legacy alias).
 */
export function mergeIndustryBrandSttCorrections(
  domainWords: Record<string, string> | undefined,
  industryContext: Record<string, unknown> | undefined
): Record<string, string> {
  const merged: Record<string, string> = { ...(domainWords ?? {}) };
  if (!industryContext || typeof industryContext !== "object") return merged;

  for (const key of ["stt_corrections", "brand_stt_corrections"] as const) {
    Object.assign(merged, readStringRecord(industryContext[key]));
  }
  return merged;
}

/** Collect tenant-declared entity names from industry_context (language-agnostic). */
export function collectConfiguredEntityNames(
  industryContext: Record<string, unknown> | undefined
): string[] {
  if (!industryContext || typeof industryContext !== "object") return [];
  const names = new Set<string>();

  const brand = typeof industryContext.brand === "string" ? industryContext.brand.trim() : "";
  if (brand) names.add(brand);

  for (const item of readStringList(industryContext.official_entity_names)) {
    names.add(item);
  }

  for (const key of ["localized_entity_names", "brand_names"] as const) {
    for (const v of Object.values(readStringRecord(industryContext[key]))) {
      names.add(v);
    }
  }

  return [...names];
}

/** Heuristic proper-name extraction from KB Q/A (Latin + quoted spans; any tenant). */
export function extractEntityNamesFromKbRows(
  rows: Array<{ question?: string; answer?: string }>
): string[] {
  const names = new Set<string>();
  const skipWords = new Set([
    "what", "how", "the", "it", "from", "is", "are", "your", "our", "this", "that",
  ]);

  for (const row of rows) {
    for (const text of [row.question, row.answer]) {
      if (!text) continue;

      let m: RegExpExecArray | null;
      const whatIs = /(?:what is|tell me about|who is|about)\s+(.+?)\?/gi;
      while ((m = whatIs.exec(text)) !== null) {
        const candidate = m[1]?.trim();
        if (candidate && candidate.length >= 3 && candidate.length <= 80) {
          names.add(candidate);
        }
      }

      const howFar = /how far is\s+([A-Za-z][A-Za-z0-9\s.'-]{1,50}?)\s+from/gi;
      while ((m = howFar.exec(text)) !== null) {
        const candidate = m[1]?.trim();
        if (candidate && candidate.length >= 3) names.add(candidate);
      }

      for (const quoted of text.matchAll(/["'""]([^"''""]{2,80})["'""]/gu)) {
        names.add(quoted[1].trim());
      }

      for (const cap of text.matchAll(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,4})\b/g)) {
        const candidate = cap[1].trim();
        const first = candidate.split(/\s+/)[0]?.toLowerCase() ?? "";
        if (candidate.length >= 3 && !skipWords.has(first)) names.add(candidate);
      }
    }
  }
  return [...names].slice(0, 12);
}

function resolveLocalizedEntityName(
  industryContext: Record<string, unknown>,
  replyLanguageBcp47?: string | null
): string | null {
  const bcp = (replyLanguageBcp47 || "").trim().toLowerCase();
  if (!bcp) return null;

  for (const key of ["localized_entity_names", "brand_names"] as const) {
    const map = readStringRecord(industryContext[key]);
    const exact = map[bcp] ?? map[bcp.replace("_", "-")];
    if (exact) return exact;
    const primary = bcp.split("-")[0];
    if (primary) {
      for (const [k, v] of Object.entries(map)) {
        if (k.split("-")[0]?.toLowerCase() === primary) return v;
      }
    }
  }
  return null;
}

/**
 * RAG addendum listing authoritative entity names for this tenant (when any are known).
 * Language-agnostic; uses replyLanguageBcp47 only for optional localized display name.
 */
export function buildOfficialEntityNamesRagHint(
  industryContext: Record<string, unknown> | undefined,
  kbRows: Array<{ question?: string; answer?: string }>,
  replyLanguageBcp47?: string | null,
  replyLanguageLabel?: string | null
): string {
  const configured = collectConfiguredEntityNames(industryContext);
  const kbNames = extractEntityNamesFromKbRows(kbRows);
  const allNames = new Set<string>([...configured, ...kbNames]);

  if (allNames.size === 0) return "";

  const namesList = [...allNames].join(", ");
  const langLabel = replyLanguageLabel?.trim() || replyLanguageBcp47?.trim() || "the reply language";
  const localized =
    industryContext && replyLanguageBcp47
      ? resolveLocalizedEntityName(industryContext, replyLanguageBcp47)
      : null;

  const localizedLine = localized
    ? `\n- When replying in ${langLabel}, prefer the localized form **${localized}** for the business/entity when appropriate.`
    : `\n- When replying in ${langLabel}, use natural phrasing for entity names from KNOWLEDGEBASE — not garbled wording from the caller transcript.`;

  return `
--- OFFICIAL ENTITY NAMES (mandatory when referring to this business) ---
Authoritative names for this tenant: ${namesList}
- Use these names (or natural equivalents in ${langLabel}) for businesses, products, places, and services.
- Caller transcripts may contain speech-to-text errors — do NOT repeat mistranscribed entity names in your answer.
- Numeric facts and policies must match KNOWLEDGEBASE; express them in fluent, conversational ${langLabel} suited to a phone call.${localizedLine}
--- END OFFICIAL ENTITY NAMES ---`;
}
