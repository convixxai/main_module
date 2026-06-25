import {
  type CartesiaGenerationConfig,
} from "./cartesia";
import {
  buildHumanizerStyleBlock,
  DEFAULT_HUMANIZER_STYLE,
  type HumanizerStyleSettings,
} from "./openai-tts-humanizer";

/** Bump when Cartesia RAG voice prompt changes. */
export const CARTESIA_VOICE_PROMPT_VERSION = 2;

export function resolveHumanizerStyleFromSettings(
  raw: unknown
): HumanizerStyleSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_HUMANIZER_STYLE };
  }
  const merged = { ...DEFAULT_HUMANIZER_STYLE, ...(raw as HumanizerStyleSettings) };
  return {
    ...merged,
    speaker_persona:
      "warm professional female receptionist on a live phone call — feminine wording",
    use_fillers: "minimal",
    pause_style: "smooth_flowing",
  };
}

function feminineGrammarHint(languageBcp47?: string | null): string {
  const bcp = (languageBcp47 || "en-IN").toLowerCase();
  if (bcp.startsWith("hi")) {
    return `
HINDI GRAMMAR (female voice — mandatory):
- Use feminine verb forms: मैं सुन रही हूँ, मैं बता सकती हूँ, मैं मदद कर सकती हूँ.
- Never use masculine forms: सकता, रहा हूँ, करूँगा.`;
  }
  if (bcp.startsWith("mr")) {
    return `
MARATHI GRAMMAR (female voice — mandatory):
- Use feminine forms: मी ऐकते आहे, मी मदत करू शकते.
- Avoid masculine: शकतो, ऐकतोय (male).`;
  }
  return `
ENGLISH VOICE (female receptionist):
- Natural, warm, professional female tone — not male or androgynous phrasing.
- Prefer: "I'm happy to help" / "How can I help you?" — conversational and clear.`;
}

/**
 * Merged humanizer + Cartesia TTS instructions for the main RAG system prompt.
 * Neutral emotion only — no [emotion] tags.
 */
export function buildCartesiaRagVoicePrompt(options?: {
  humanizerStyle?: HumanizerStyleSettings | null;
  humanizerSystemPromptOverride?: string | null;
  generationConfig?: CartesiaGenerationConfig | null;
  replyLanguageBcp47?: string | null;
}): string {
  const style = resolveHumanizerStyleFromSettings(options?.humanizerStyle);
  const styleBlock = buildHumanizerStyleBlock(style);
  const customLead = options?.humanizerSystemPromptOverride?.trim();
  const gen = options?.generationConfig;
  const feminineHint = feminineGrammarHint(options?.replyLanguageBcp47);

  return `
--- CARTESIA VOICE OUTPUT (mandatory — spoken on a live phone call) ---
${customLead ? `${customLead}\n` : ""}You write words a real female receptionist would SAY on a phone call. Output goes directly to Cartesia Sonic TTS.

Rules:
- Return ONLY speakable words — no labels, quotes, markdown, JSON, emotion tags, or explanation.
- Do NOT use [emotion] tags or EMOTION: lines — voice tone is always neutral.
- Keep the same facts and language as the knowledge base allows.
- Write **complete flowing sentences** with proper punctuation (. ? !).
- Use commas only for natural breath within one sentence — do not break one thought into choppy fragments.
- Prefer one or two full sentences over many tiny pieces.
- Stay concise; contractions where natural; warm professional phone tone.
- Write numbers, dates, currency in conventional form (Rs 7,000, 3 PM).
- Never: bullet points, URLs, ALL CAPS, stage directions.
${feminineHint}

VOICE TUNING: neutral tone; speed ~${gen?.speed ?? 1.05}; speak clearly for telephony.

${styleBlock}
--- END CARTESIA VOICE OUTPUT ---`;
}

/** Strip legacy [emotion] tags from text (for chat history / TTS). */
export function stripCartesiaEmotionTags(raw: string): string {
  return raw
    .replace(/\[[a-z_]+\]\s*/gi, "")
    .replace(/\nEMOTION:\s*[a-z_]+\s*$/i, "")
    .trim();
}

/** Prepare text for Cartesia TTS from an LLM chunk (not raw greeting). */
export function prepareCartesiaTtsText(
  raw: string,
  options?: { speakRaw?: boolean }
): { text: string; emotion: null } {
  if (options?.speakRaw) {
    return { text: raw.trim(), emotion: null };
  }
  return { text: stripCartesiaEmotionTags(raw), emotion: null };
}
