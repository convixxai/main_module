import {
  CARTESIA_EMOTIONS,
  type CartesiaEmotion,
  type CartesiaEmotionMode,
  type CartesiaGenerationConfig,
  resolveCartesiaEmotion,
} from "./cartesia";
import {
  buildHumanizerStyleBlock,
  DEFAULT_HUMANIZER_STYLE,
  type HumanizerStyleSettings,
} from "./openai-tts-humanizer";

/** Bump when Cartesia RAG voice prompt changes. */
export const CARTESIA_VOICE_PROMPT_VERSION = 1;

const DEFAULT_ALLOWED_EMOTIONS = [
  "neutral",
  "calm",
  "sympathetic",
  "content",
  "grateful",
  "apologetic",
  "enthusiastic",
  "curious",
  "peaceful",
  "determined",
] as const;

export function resolveHumanizerStyleFromSettings(
  raw: unknown
): HumanizerStyleSettings {
  if (!raw || typeof raw !== "object") {
    return { ...DEFAULT_HUMANIZER_STYLE };
  }
  return { ...DEFAULT_HUMANIZER_STYLE, ...(raw as HumanizerStyleSettings) };
}

/**
 * Merged humanizer + Cartesia TTS instructions for the main RAG system prompt.
 * One LLM call produces phone-ready, tagged speech — no separate humanizer API.
 */
export function buildCartesiaRagVoicePrompt(options?: {
  emotionMode?: CartesiaEmotionMode | null;
  allowedEmotions?: readonly string[] | null;
  humanizerStyle?: HumanizerStyleSettings | null;
  humanizerSystemPromptOverride?: string | null;
  generationConfig?: CartesiaGenerationConfig | null;
  maxBufferDelayMs?: number | null;
}): string {
  const mode = options?.emotionMode ?? "llm_per_sentence";
  const allowed =
    options?.allowedEmotions && options.allowedEmotions.length > 0
      ? options.allowedEmotions
      : [...DEFAULT_ALLOWED_EMOTIONS];

  const style = options?.humanizerStyle ?? DEFAULT_HUMANIZER_STYLE;
  const styleBlock = buildHumanizerStyleBlock(style);

  const customLead = options?.humanizerSystemPromptOverride?.trim();
  const gen = options?.generationConfig;
  const voiceTuning =
    gen != null
      ? `VOICE TUNING (Cartesia generation_config — match delivery to these defaults):
- Base emotion when unsure: ${gen.emotion ?? "neutral"}
- Speaking speed: ${gen.speed ?? 1} (1.0 = normal; lower = slower, higher = faster)
- Volume: ${gen.volume ?? 1}`
      : "";

  const bufferHint =
    options?.maxBufferDelayMs != null && options.maxBufferDelayMs > 0
      ? `- Keep sentences reasonably short; TTS buffer delay is ${options.maxBufferDelayMs}ms.`
      : "- Prefer short sentences so audio can start quickly (low latency).";

  const emotionInstructions =
    mode === "static"
      ? `- Speak in a consistent warm tone; emotion is set on the voice avatar (do not add [emotion] tags).`
      : `- Prefix EVERY sentence with one Cartesia emotion tag in square brackets.
- Tag must be one of: ${allowed.join(", ")}.
- Pick emotion from context (sympathetic for complaints, enthusiastic for good news, apologetic for errors, calm for factual info).
- Format: [emotion] Spoken sentence.
- Example: [sympathetic] I understand your concern. [calm] Let me check that for you.`;

  return `
--- CARTESIA VOICE OUTPUT (mandatory — your reply is spoken on a live phone call) ---
${customLead ? `${customLead}\n` : ""}You write words a real human would SAY on a phone call. Output goes directly to Cartesia Sonic TTS — not OpenAI TTS.

Rules:
- Return ONLY speakable words with emotion tags — no labels, quotes, markdown, JSON, or explanation.
- Keep the same facts and language as the knowledge base allows.
- Stay concise; short sentences; one idea each; contractions where natural.
- Warm, natural phone tone — not formal, not robotic, not a FAQ.
- Use normal punctuation (. ? !) for pacing. Commas for breath.
- Write numbers, dates, currency in conventional form (Rs 7,000, 3 PM).
- For codes/IDs include surrounding words; space characters if needed: "A B C 1 2 3".
- Never: bullet points, "Please be advised", URLs, ALL CAPS for emphasis, stage directions outside tags.
${bufferHint}

${emotionInstructions}
${voiceTuning ? `\n${voiceTuning}\n` : ""}
${styleBlock}

Full list of valid Cartesia emotions (for reference): ${CARTESIA_EMOTIONS.slice(0, 20).join(", ")}, ...
--- END CARTESIA VOICE OUTPUT ---`;
}

/** Parse leading [emotion] tag from a speak chunk (streaming sentence). */
export function parseCartesiaTaggedUtterance(raw: string): {
  text: string;
  emotion: CartesiaEmotion | null;
} {
  const trimmed = raw.trim();
  if (!trimmed) return { text: "", emotion: null };

  const tagged = trimmed.match(/^\[([a-z_]+)\]\s*(.+)$/is);
  if (tagged) {
    const emotion = resolveCartesiaEmotion(tagged[1]);
    const text = tagged[2].trim();
    if (text) return { text, emotion };
  }

  return { text: stripCartesiaEmotionTags(trimmed), emotion: null };
}

/** Remove all [emotion] tags from text (for chat history / logging). */
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
): { text: string; emotion: CartesiaEmotion | null } {
  if (options?.speakRaw) {
    return { text: raw.trim(), emotion: null };
  }
  const emotionOnly = raw.trim().match(/^EMOTION:\s*([a-z_]+)\s*$/i);
  if (emotionOnly) {
    return { text: "", emotion: resolveCartesiaEmotion(emotionOnly[1]) };
  }
  return parseCartesiaTaggedUtterance(raw);
}
