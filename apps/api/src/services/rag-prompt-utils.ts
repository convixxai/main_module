/** Appended to voice/chat RAG when multilingual is enabled. */
export const RAG_MULTILINGUAL_GRAMMAR_RULE = `
--- Multilingual writing quality (mandatory for non-English replies) ---
- When you answer in any allowed non-English language, use **fluent, grammatically correct** phrasing a native speaker would use on a phone call—not a literal word-for-word translation from English.
- Pay attention to correct verb agreement, gender/number, natural word order, particles/postpositions, and idioms for that language. Prefer one or two short, correct sentences.
- If KNOWLEDGEBASE passages are in another language, restate the facts clearly in the user's language without broken grammar or awkward calques.`;

/** Always safe for multilingual voice: do not echo STT entity errors (any tenant/language). */
export const RAG_STT_ENTITY_INTEGRITY_RULE = `
--- Speech-to-text & entity names (mandatory) ---
- Caller messages are speech-to-text transcripts and may mistranscribe business, product, place, or person names.
- Do NOT echo likely STT errors in your reply. Prefer authoritative names from KNOWLEDGEBASE and any OFFICIAL ENTITY NAMES block when present.
- Answer with KB facts in natural, conversational phrasing for the reply language — suitable for live telephony.`;

/**
 * Softens strict "KB ONLY" instructions in the agent's main system prompt
 * when allow_related_general_answers is enabled.
 */
export function relaxAgentPrompt(prompt: string, allowRelated: boolean): string {
  if (!allowRelated) return prompt;
  return prompt
    .replace(/Answer from (the )?given knowledgebase only/gi, "Answer primarily from the given knowledgebase")
    .replace(/Answer using ONLY information from (the )?KNOWLEDGEBASE/gi, "Answer primarily using information from the KNOWLEDGEBASE")
    .replace(/only if you don't have answer in knowledgebase/gi, "if you don't have a specific answer in the knowledgebase")
    .replace(/only use information from (the )?provided context/gi, "primarily use information from the provided context")
    .replace(/strictly use the knowledgebase/gi, "primarily use the knowledgebase")
    .replace(/answer from given knowledgebase/gi, "answer primarily from given knowledgebase")
    .replace(/don't have answer in knowledgebase/gi, "don't have a specific answer in the knowledgebase")
    .replace(/only if you don't have answer/gi, "if you don't have a specific answer");
}

/**
 * Prepends simulator (or other) extra instructions at the top of the RAG system prompt.
 * When blank, returns `basePrompt` unchanged.
 */
export function prependAdditionalSystemPromptOverride(
  basePrompt: string,
  additional: string | null | undefined
): string {
  const extra = additional?.trim();
  if (!extra) return basePrompt;
  return `--- HIGHEST PRIORITY OVERRIDE (mandatory) ---
The instructions below override any conflicting guidance in the agent prompt, customer prompt, RAG rules, or knowledgebase delivery hints. When in conflict, follow this block.

${extra}

--- END HIGHEST PRIORITY OVERRIDE ---

${basePrompt}`;
}
