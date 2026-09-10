/**
 * Voice-appropriate spoken-reply style, passed as `additionalSystemPrompt` into
 * runAskPipeline for any voice/audio caller (Vodafone, the QA test console's
 * audio/chat_voice modes). Text-only callers (plain chat, production /ask)
 * should NOT get this - it's specifically about the fact that the answer gets
 * spoken aloud, not read on a screen. Mirrors the phone-call-specific wording
 * exotel-voicebot.ts's own separate RAG prompt has always had (short,
 * conversational, no bullet points) - added here so every voice caller gets it
 * through the one shared pipeline, instead of only Exotel having it.
 */
export const VOICE_SPOKEN_REPLY_STYLE_RULE = `
--- Spoken reply style (mandatory - this answer will be read aloud on a phone call) ---
- Keep answers SHORT and conversational - suitable for a live phone call. One or two complete sentences.
- Avoid bullet points, numbered lists, headings, markdown, or any other formatting meant for reading on a screen - speak naturally, the way a person would say it out loud.
- Do not spell out URLs, code, or symbols meant for visual reading; describe them in words instead.`;

/** Appended to voice/chat RAG when multilingual is enabled. */
export const RAG_MULTILINGUAL_GRAMMAR_RULE = `
--- Multilingual writing quality (mandatory for non-English replies) ---
- When you answer in any allowed non-English language, use **fluent, grammatically correct** phrasing a native speaker would say on a phone call — not a word-for-word translation from English.
- Every reply must be **one or two complete sentences** with a proper verb and ending punctuation (। or . or ?). Never produce a noun phrase or fragment such as "चव्हाणी लोणावळा येथे आहे, लोणावळा किल्ल्याजवळ." — instead say "छावणी रिसॉर्ट लोहगड किल्ल्याजवळ, लोणावळ्याजवळ आहे."
- Correct verb agreement, gender/number, natural word order, and idiomatic particles for that language. Avoid stiff calques.
- If KNOWLEDGEBASE passages are in another language, restate the facts clearly and fluently in the user's language.`;

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
