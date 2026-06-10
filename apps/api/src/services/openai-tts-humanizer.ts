import { chatOpenAI, type OpenAIUsageResult } from "./llm";
import type { RagTraceFn } from "./rag-trace";

export type HumanizerStyleSettings = {
  emotion_intensity: string;
  speaking_pace: string;
  warmth: string;
  formality: string;
  use_fillers: string;
  emphasis_style: string;
  scenario: string;
  speaker_persona: string;
  target_language: string;
  reaction_level: string;
  pause_style: string;
};

export const DEFAULT_HUMANIZER_STYLE: HumanizerStyleSettings = {
  emotion_intensity: "high",
  speaking_pace: "natural_conversational",
  warmth: "warm_friendly",
  formality: "casual_professional",
  use_fillers: "light_natural",
  emphasis_style: "expressive_balanced",
  scenario: "live_phone_call",
  speaker_persona: "helpful human agent who genuinely cares",
  target_language: "preserve_input_language",
  reaction_level: "believable_not_dramatic",
  pause_style: "natural_micro_pauses",
};

export const DEFAULT_HUMANIZER_SYSTEM_PROMPT = `You are a world-class dialogue writer for spoken audio. Your ONLY job is to rewrite plain text into a script that sounds like a real human said it out loud on a live call.

## Output rules (strict)
1. Return ONLY the final spoken words. No titles, labels, markdown, JSON, or explanations.
2. Do NOT wrap the answer in quotes.
3. Keep the same factual meaning as the source — do not invent new facts, numbers, names, or promises.
4. Match the language of the source unless the style settings explicitly force another language.
5. Length: stay close to the source unless emotion naturally needs a few extra words; never bloat with filler paragraphs.
6. Write for the ear, not the eye: short clauses, natural rhythm, contractions where humans use them.
7. Embed emotion in word choice and rhythm — not in bracketed stage directions like [sighs] unless the style settings ask for audible reactions.

## How to make it sound human
- Add believable vocal color: relief, concern, enthusiasm, empathy, confidence, gentle humor when appropriate.
- Use micro-pauses with commas, ellipses sparingly, or split sentences where a person would breathe.
- Light disfluency is OK when settings allow: "um", "well", "you know", "actually", "so" — never overdo it.
- Vary sentence length. Humans do not speak in perfect essay paragraphs.
- Stress important words through phrasing, not ALL CAPS.
- If the source is dry or robotic, inject life while staying professional for the scenario.
- If the source is already emotional, refine it so TTS can deliver it naturally without melodrama unless intensity is theatrical.

## Phone-call realism
- Sound like someone speaking to one person, not announcing to a crowd.
- Prefer direct address ("you", "I") when the source implies it.
- Avoid bullet lists, semicolons chains, and written-only phrasing.
- End on a natural spoken cadence — not a formal written sign-off unless the scenario needs it.

## What you receive
- STYLE SETTINGS block: follow every line; they override generic defaults.
- SOURCE TEXT: rewrite this for OpenAI text-to-speech so playback sounds like a human genuinely said it.`;

export function buildHumanizerStyleBlock(settings: HumanizerStyleSettings): string {
  const s = { ...DEFAULT_HUMANIZER_STYLE, ...settings };
  return [
    "=== STYLE SETTINGS (apply all) ===",
    `Emotion intensity: ${s.emotion_intensity}`,
    `Speaking pace feel: ${s.speaking_pace}`,
    `Warmth: ${s.warmth}`,
    `Formality: ${s.formality}`,
    `Fillers / disfluency: ${s.use_fillers}`,
    `Emphasis style: ${s.emphasis_style}`,
    `Scenario / context: ${s.scenario}`,
    `Speaker persona: ${s.speaker_persona}`,
    `Target language: ${s.target_language}`,
    `Reaction level: ${s.reaction_level}`,
    `Pause / breath style: ${s.pause_style}`,
    "=== END STYLE SETTINGS ===",
  ].join("\n");
}

export function parseHumanizerStyleFields(
  fields: Record<string, string | undefined>
): HumanizerStyleSettings {
  const pick = (key: keyof HumanizerStyleSettings, fallback: string) =>
    (fields[key]?.trim() || fallback).slice(0, 200);

  return {
    emotion_intensity: pick("emotion_intensity", DEFAULT_HUMANIZER_STYLE.emotion_intensity),
    speaking_pace: pick("speaking_pace", DEFAULT_HUMANIZER_STYLE.speaking_pace),
    warmth: pick("warmth", DEFAULT_HUMANIZER_STYLE.warmth),
    formality: pick("formality", DEFAULT_HUMANIZER_STYLE.formality),
    use_fillers: pick("use_fillers", DEFAULT_HUMANIZER_STYLE.use_fillers),
    emphasis_style: pick("emphasis_style", DEFAULT_HUMANIZER_STYLE.emphasis_style),
    scenario: pick("scenario", DEFAULT_HUMANIZER_STYLE.scenario),
    speaker_persona: pick("speaker_persona", DEFAULT_HUMANIZER_STYLE.speaker_persona),
    target_language: pick("target_language", DEFAULT_HUMANIZER_STYLE.target_language),
    reaction_level: pick("reaction_level", DEFAULT_HUMANIZER_STYLE.reaction_level),
    pause_style: pick("pause_style", DEFAULT_HUMANIZER_STYLE.pause_style),
  };
}

export type HumanizeForTtsResult = {
  humanized_text: string;
  llm: OpenAIUsageResult;
  system_prompt_used: string;
  style_settings: HumanizerStyleSettings;
};

export async function humanizeTextForOpenAiTts(params: {
  sourceText: string;
  systemPrompt?: string | null;
  styleSettings: HumanizerStyleSettings;
  llmModel?: string | null;
  temperature?: number;
  maxTokens?: number;
  trace?: RagTraceFn;
}): Promise<HumanizeForTtsResult> {
  const basePrompt = (params.systemPrompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT).slice(
    0,
    12000
  );
  const styleBlock = buildHumanizerStyleBlock(params.styleSettings);
  const systemContent = `${basePrompt}\n\n${styleBlock}`;

  const userContent = [
    "Rewrite the SOURCE TEXT below for OpenAI text-to-speech.",
    "The listener should feel a real human said this with natural emotion.",
    "",
    "SOURCE TEXT:",
    params.sourceText.trim(),
  ].join("\n");

  const llm = await chatOpenAI(
    [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    params.maxTokens ?? 600,
    params.trace,
    {
      temperature: params.temperature ?? 0.85,
      model: params.llmModel?.trim() || undefined,
    }
  );

  const humanized = llm.answer.replace(/^["']|["']$/g, "").trim();
  return {
    humanized_text: humanized || params.sourceText.trim(),
    llm,
    system_prompt_used: systemContent,
    style_settings: params.styleSettings,
  };
}
