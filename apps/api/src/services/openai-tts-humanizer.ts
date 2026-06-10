import { chatOpenAI, type OpenAIUsageResult } from "./llm";
import type { RagTraceFn } from "./rag-trace";

/** Bump when default prompts change — UI uses this to drop stale localStorage overrides. */
export const HUMANIZER_PROMPT_VERSION = 2;

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

export type HumanizeDepth = "fast" | "deep";

export const DEFAULT_HUMANIZER_STYLE: HumanizerStyleSettings = {
  emotion_intensity: "high",
  speaking_pace: "natural_conversational",
  warmth: "warm_friendly",
  formality: "casual_professional",
  use_fillers: "natural_phone",
  emphasis_style: "highly_expressive",
  scenario: "live_phone_call",
  speaker_persona: "warm real person on a phone call — not a call-center script reader",
  target_language: "preserve_input_language",
  reaction_level: "animated",
  pause_style: "natural_micro_pauses",
};

const FEW_SHOT_EXAMPLES = `## Examples (robotic source → human spoken script)

ENGLISH:
ROBOTIC: I would like to inform you that your appointment has been confirmed for tomorrow at 3 PM.
HUMAN: Oh, perfect — you're all set for tomorrow! Three in the afternoon, yeah?

ROBOTIC: Please be advised that we did not receive your payment.
HUMAN: Hmm, okay so... I'm not actually seeing that payment come through on my end yet. Want me to help you fix that?

ROBOTIC: Your order has been delivered successfully. Thank you for shopping with us.
HUMAN: Hey, good news — your order just got delivered! Hope you love it.

ROBOTIC: The refund will be processed within 5 to 7 business days.
HUMAN: So the refund's on its way — usually takes about five to seven working days, alright?

HINDI:
ROBOTIC: आपका ऑर्डर सफलतापूर्वक डिलीवर हो गया है।
HUMAN: अच्छा, बढ़िया खबर — आपका ऑर्डर पहुँच गया है!

ROBOTIC: कृपया ध्यान दें कि आपका भुगतान प्राप्त नहीं हुआ है।
HUMAN: हम्म... देखिए, अभी तक पेमेंट मुझे दिख नहीं रही है। चलिए, एक बार साथ में चेक करते हैं?

MARATHI:
ROBOTIC: तुमची भेट उद्या दुपारी ३ वाजता निश्चित झाली आहे.
HUMAN: छान! उद्या दुपारी तीन वाजता तुमची भेट कन्फर्म झाली आहे, बरं?`;

export const DEFAULT_HUMANIZER_SYSTEM_PROMPT = `You rewrite written text into a SPOKEN SCRIPT for OpenAI text-to-speech on a LIVE phone call.

The listener must believe a real human is talking — not an AI, not a news reader, not a FAQ bot.

## Output format (strict)
Return ONLY the final spoken words inside a single block after the line:
SCRIPT:
(no text before SCRIPT: except nothing — start your reply with SCRIPT: on the first line)

Rules for SCRIPT content:
- Same facts as the source. Do not invent numbers, dates, names, or promises.
- Same language as source unless style settings force another language.
- 1–4 short sentences. One breath per sentence. Max ~35 spoken words unless source truly needs more.
- Contractions and colloquial speech where natural.
- NEVER: bullet points, lists, markdown, parentheses, emojis, "Dear customer", "Please be advised", "Kindly note", "I would like to inform you", URLs, meta-commentary.
- Numbers spoken as humans say them: "three PM", "five to seven days", not "3 PM" or "5-7".
- Add genuine emotional color: relief, warmth, concern, enthusiasm — match what the message deserves.
- Use fillers when settings allow: "well", "so", "okay", "hmm", "you know", "actually" — sparingly, naturally.
- Use commas and periods for breath and pause. Ellipsis (...) only for a real hesitation.
- Start with a human reaction when it fits: "Oh!", "Hmm", "Yeah", "Right", "अच्छा", "हम्म", "बरं" — not every time.
- Do NOT echo the source verbatim if it sounds written; transform it completely while keeping meaning.

## Oral delivery checklist (apply silently before writing SCRIPT)
1. Would I say this to someone's ear in one or two breaths per sentence?
2. Did I remove every written/formal phrase?
3. Does it sound like a person who cares, not a policy document?
4. Is there vocal emotion in word choice, not ALL CAPS or brackets?

${FEW_SHOT_EXAMPLES}

Follow the STYLE SETTINGS block below — they override generic tone.`;

const ORAL_ANALYSIS_PROMPT = `You analyze text that will be spoken on a live phone call via TTS.

Return a short ORAL PLAN (max 120 words) with:
- Detected emotion(s) the speaker should convey
- Opening reaction word/phrase if appropriate
- Which formal phrases to kill and replace
- Pace feel (slow / natural / energetic)
- 2-3 concrete oral rewrite hints for THIS specific text

No script yet. No markdown lists. Plain prose.`;

export function buildHumanizerStyleBlock(settings: HumanizerStyleSettings): string {
  const s = { ...DEFAULT_HUMANIZER_STYLE, ...settings };
  const fillerGuide: Record<string, string> = {
    none: "no fillers at all",
    light_natural: "1 light filler max (well / so / okay)",
    natural_phone: "1-2 natural fillers where a human would hesitate",
    heavy_colloquial: "colloquial fillers allowed but stay believable",
  };
  const emotionGuide: Record<string, string> = {
    subtle: "gentle emotional coloring only",
    moderate: "clear but restrained emotion",
    high: "obvious warmth, relief, concern, or enthusiasm as appropriate",
    theatrical: "dramatic expressive delivery — still believable on a phone",
  };
  return [
    "=== STYLE SETTINGS (mandatory) ===",
    `Emotion: ${s.emotion_intensity} — ${emotionGuide[s.emotion_intensity] || emotionGuide.high}`,
    `Pace feel: ${s.speaking_pace}`,
    `Warmth: ${s.warmth}`,
    `Formality: ${s.formality}`,
    `Fillers: ${s.use_fillers} — ${fillerGuide[s.use_fillers] || fillerGuide.natural_phone}`,
    `Emphasis: ${s.emphasis_style}`,
    `Scenario: ${s.scenario}`,
    `Persona: ${s.speaker_persona}`,
    `Language: ${s.target_language}`,
    `Reactions: ${s.reaction_level}`,
    `Pauses: ${s.pause_style}`,
    "=== END STYLE SETTINGS ===",
  ].join("\n");
}

/** Rich delivery block for gpt-4o-mini-tts `instructions` — style knobs must reach the audio model. */
export function buildOpenAiTtsDeliveryInstructions(
  settings: HumanizerStyleSettings,
  userOverride?: string | null
): string {
  const s = { ...DEFAULT_HUMANIZER_STYLE, ...settings };
  const paceMap: Record<string, string> = {
    slow_thoughtful: "Speak slowly and thoughtfully, with gentle pauses between phrases.",
    natural_conversational: "Speak at a natural conversational pace, like a real person on a phone call.",
    energetic: "Speak with lively energy — engaged and animated, not rushed or shouty.",
    rushed_urgent: "Speak with urgent energy — faster but still clear and human.",
  };
  const warmthMap: Record<string, string> = {
    neutral: "Neutral warmth — professional but human.",
    warm_friendly: "Warm and friendly — smile in the voice.",
    very_warm_empathetic: "Very warm and empathetic — the listener should feel cared for.",
    cool_professional: "Cool and professional — crisp but not cold or robotic.",
  };
  const emotionMap: Record<string, string> = {
    subtle: "Subtle emotional inflection.",
    moderate: "Moderate emotional expression.",
    high: "Strong emotional expression — joy, concern, relief, or enthusiasm as the words imply.",
    theatrical: "Highly expressive, dramatic delivery — like a skilled voice actor on a phone call.",
  };

  const autoBlock = [
    "Voice delivery (mandatory):",
    "You are a real human on a live phone call — NEVER sound like you are reading text, a script, or an announcement.",
    warmthMap[s.warmth] || warmthMap.warm_friendly,
    paceMap[s.speaking_pace] || paceMap.natural_conversational,
    emotionMap[s.emotion_intensity] || emotionMap.high,
    `Persona: ${s.speaker_persona}.`,
    `Scenario: ${s.scenario.replace(/_/g, " ")}.`,
    "Use natural pitch variation, micro-pauses, breath, and intonation — rise on questions, soften on empathy, brighten on good news.",
    "Pronounce contractions naturally. Do not over-articulate every syllable like a robot.",
    "If the text has fillers (um, well, hmm), deliver them like real hesitation — not emphasized.",
    "Never monotone. Never corporate narrator. Never Siri-like.",
  ].join(" ");

  const override = (userOverride || "").trim();
  if (!override) return autoBlock.slice(0, 4096);
  return `${autoBlock}\n\nAdditional direction: ${override}`.slice(0, 4096);
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

export function parseHumanizeDepth(raw: string | undefined): HumanizeDepth {
  return raw?.trim().toLowerCase() === "fast" ? "fast" : "deep";
}

/** Strip model scaffolding and written-artifact patterns from LLM output. */
export function polishHumanizedScript(raw: string): string {
  let t = raw.trim();
  const scriptMatch = t.match(/(?:^|\n)SCRIPT:\s*([\s\S]*)$/i);
  if (scriptMatch) t = scriptMatch[1].trim();

  t = t.replace(/^["'`]|["'`]$/g, "");
  t = t.replace(/^(here(?:'s| is) the (?:rewritten|humanized)[^:]*:)\s*/i, "");
  t = t.replace(/^[\-*•]\s+/gm, "");
  t = t.replace(/\*\*/g, "");
  t = t.replace(/\[(?:happy|sad|excited|calm|warmly|sighs|laughs)[^\]]*\]\s*/gi, "");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

export type HumanizeForTtsResult = {
  humanized_text: string;
  llm: OpenAIUsageResult;
  /** Combined usage when deep mode runs two LLM calls. */
  llm_analysis?: OpenAIUsageResult;
  system_prompt_used: string;
  style_settings: HumanizerStyleSettings;
  humanize_depth: HumanizeDepth;
};

function mergeUsage(a: OpenAIUsageResult, b: OpenAIUsageResult): OpenAIUsageResult {
  return {
    answer: b.answer,
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    model: b.model,
    costUsd: a.costUsd + b.costUsd,
  };
}

export async function humanizeTextForOpenAiTts(params: {
  sourceText: string;
  systemPrompt?: string | null;
  styleSettings: HumanizerStyleSettings;
  llmModel?: string | null;
  temperature?: number;
  maxTokens?: number;
  depth?: HumanizeDepth;
  trace?: RagTraceFn;
}): Promise<HumanizeForTtsResult> {
  const depth = params.depth ?? "deep";
  const basePrompt = (params.systemPrompt?.trim() || DEFAULT_HUMANIZER_SYSTEM_PROMPT).slice(
    0,
    12000
  );
  const styleBlock = buildHumanizerStyleBlock(params.styleSettings);
  const systemContent = `${basePrompt}\n\n${styleBlock}`;
  const llmOpts = {
    temperature: params.temperature ?? 1,
    model: params.llmModel?.trim() || undefined,
  };
  const source = params.sourceText.trim();

  let analysisResult: OpenAIUsageResult | undefined;
  let oralPlan = "";

  if (depth === "deep") {
    analysisResult = await chatOpenAI(
      [
        { role: "system", content: `${ORAL_ANALYSIS_PROMPT}\n\n${styleBlock}` },
        { role: "user", content: `Analyze for oral delivery:\n\n${source}` },
      ],
      180,
      params.trace,
      llmOpts
    );
    oralPlan = analysisResult.answer.trim();
  }

  const userContent = [
    depth === "deep" && oralPlan
      ? `ORAL PLAN (follow this):\n${oralPlan}\n`
      : "",
    "Transform SOURCE TEXT into a human spoken SCRIPT (start your reply with SCRIPT: on line 1).",
    "Make it sound dramatically more human than the source — full emotion, natural phone speech.",
    "",
    "SOURCE TEXT:",
    source,
  ]
    .filter(Boolean)
    .join("\n");

  const rewriteResult = await chatOpenAI(
    [
      { role: "system", content: systemContent },
      { role: "user", content: userContent },
    ],
    params.maxTokens ?? 600,
    params.trace,
    llmOpts
  );

  const mergedLlm = analysisResult
    ? mergeUsage(analysisResult, rewriteResult)
    : rewriteResult;

  const humanized =
    polishHumanizedScript(rewriteResult.answer) || polishHumanizedScript(source) || source;

  return {
    humanized_text: humanized,
    llm: mergedLlm,
    llm_analysis: analysisResult,
    system_prompt_used: systemContent,
    style_settings: params.styleSettings,
    humanize_depth: depth,
  };
}
