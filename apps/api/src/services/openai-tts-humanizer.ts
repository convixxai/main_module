import { chatOpenAI, type OpenAIUsageResult } from "./llm";
import type { RagTraceFn } from "./rag-trace";

/** Bump when default prompts change — UI uses this to drop stale localStorage overrides. */
export const HUMANIZER_PROMPT_VERSION = 3;

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

export const DEFAULT_HUMANIZER_SYSTEM_PROMPT = `You rewrite plain text into words a real human would SAY on a live phone call. Output goes to OpenAI text-to-speech.

Return ONLY the final spoken words — no labels, quotes, markdown, or explanation.

Rules:
- Keep the same facts and language as the source (unless style settings say otherwise).
- Stay close in length; do not pad with extra sentences.
- Short sentences. One idea each. Contractions where natural.
- Warm, natural phone tone — not formal, not robotic, not a FAQ.
- Light emotion in word choice: relief, warmth, concern, enthusiasm when it fits.
- Commas and periods for breath; light fillers only if settings allow (well, so, hmm).
- Never: bullet points, "Please be advised", "I would like to inform you", Dear customer, URLs, ALL CAPS.

Example:
Written: I would like to inform you that your appointment is confirmed for tomorrow at 3 PM.
Spoken: Great — you're all set for tomorrow, three in the afternoon!

Follow STYLE SETTINGS below.`;

export function buildHumanizerStyleBlock(settings: HumanizerStyleSettings): string {
  const s = { ...DEFAULT_HUMANIZER_STYLE, ...settings };
  return [
    "STYLE SETTINGS:",
    `emotion=${s.emotion_intensity}`,
    `pace=${s.speaking_pace}`,
    `warmth=${s.warmth}`,
    `formality=${s.formality}`,
    `fillers=${s.use_fillers}`,
    `emphasis=${s.emphasis_style}`,
    `scenario=${s.scenario}`,
    `persona=${s.speaker_persona}`,
    `language=${s.target_language}`,
    `reactions=${s.reaction_level}`,
    `pauses=${s.pause_style}`,
  ].join("\n");
}

/** Concise delivery line for gpt-4o-mini-tts — short instructions work better than long blocks. */
export function buildOpenAiTtsDeliveryInstructions(
  settings: HumanizerStyleSettings,
  userOverride?: string | null
): string {
  const s = { ...DEFAULT_HUMANIZER_STYLE, ...settings };
  const bits = [
    "Speak on a live phone call like a real human.",
    s.warmth.includes("warm") ? "Warm, friendly tone." : "Natural professional tone.",
    s.emotion_intensity === "theatrical" || s.emotion_intensity === "high"
      ? "Express clear emotion — not flat or monotone."
      : "Natural emotional inflection.",
    s.speaking_pace.includes("slow")
      ? "Slightly slower, thoughtful pace."
      : s.speaking_pace.includes("energetic") || s.speaking_pace.includes("rushed")
        ? "Energetic pace."
        : "Conversational pace.",
    "Never sound like you are reading a script.",
  ];
  const auto = bits.join(" ");
  const extra = (userOverride || "").trim();
  if (!extra) return auto.slice(0, 4096);
  return `${auto} ${extra}`.slice(0, 4096);
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

export function polishHumanizedScript(raw: string): string {
  let t = raw.trim();
  t = t.replace(/^["'`]|["'`]$/g, "");
  t = t.replace(/^(?:SCRIPT:\s*)/i, "");
  t = t.replace(/^(here(?:'s| is)[^:]*:)\s*/i, "");
  t = t.replace(/\*\*/g, "");
  return t.trim();
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
    8000
  );
  const styleBlock = buildHumanizerStyleBlock(params.styleSettings);
  const systemContent = `${basePrompt}\n\n${styleBlock}`;
  const source = params.sourceText.trim();

  const llm = await chatOpenAI(
    [
      { role: "system", content: systemContent },
      {
        role: "user",
        content: `Rewrite for spoken delivery:\n\n${source}`,
      },
    ],
    params.maxTokens ?? 350,
    params.trace,
    {
      temperature: params.temperature ?? 0.85,
      model: params.llmModel?.trim() || undefined,
    }
  );

  const humanized = polishHumanizedScript(llm.answer) || source;

  return {
    humanized_text: humanized,
    llm,
    system_prompt_used: systemContent,
    style_settings: params.styleSettings,
  };
}
