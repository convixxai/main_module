// ============================================================
// Filler-only utterance acknowledgments (voicebot) — per language
// Short lines when STT is only "hmm / um …" so RAG is skipped.
// ============================================================

import { randomInt } from "crypto";

/** BCP-47 → 2–3 variants each; keep concise for telephony TTS. */
export const FILLER_ACK_PHRASES: Record<string, readonly string[]> = {
  "en-IN": [
    "Go ahead, I'm listening.",
    "Yes, please continue.",
    "I'm listening—go on.",
  ],
  "hi-IN": [
    "जी, बोलिए, मैं सुन रहा हूँ।",
    "हाँ, आगे बोलिए।",
    "बताइए, मैं सुन रहा हूँ।",
  ],
  "mr-IN": [
    "बोला, मी ऐकतोय.",
    "हो, पुढे सांगा.",
    "सांगा, मी ऐकत आहे.",
  ],
  "bn-IN": [
    "বলুন, শুনছি।",
    "হ্যাঁ, চালিয়ে যান।",
    "শুনছি, এগিয়ে বলুন।",
  ],
  "gu-IN": [
    "બોલો, હું સાંભળી રહ્યો છું.",
    "હા, આગળ કહો.",
    "સાંભળું છું, બોલો.",
  ],
  "kn-IN": [
    "ಹೇಳಿ, ಕೇಳುತ್ತಿದ್ದೇನೆ.",
    "ಹೌದು, ಮುಂದುವರಿಸಿ.",
    "ಕೇಳುತ್ತಿದ್ದೇನೆ, ಹೇಳಿ.",
  ],
  "ml-IN": [
    "പറയൂ, ശ്രദ്ധിച്ചുകൊണ്ടിരിക്കുന്നു.",
    "അതെ, തുടരുക.",
    "ശ്രദ്ധിക്കുന്നു, പറയൂ.",
  ],
  "od-IN": [
    "କୁହନ୍ତୁ, ଶୁଣୁଛି।",
    "ହଁ, ଆଗକୁ କହନ୍ତୁ।",
    "ଶୁଣିବା ପାଇଁ ପ୍ରସ୍ତୁତ, କୁହନ୍ତୁ।",
  ],
  "pa-IN": [
    "ਬੋਲੋ, ਸੁਣ ਰਿਹਾ ਹਾਂ।",
    "ਹਾਂ, ਜਾਰੀ ਰੱਖੋ।",
    "ਸੁਣ ਰਿਹਾ ਹਾਂ, ਦੱਸੋ।",
  ],
  "ta-IN": [
    "சொல்லுங்கள், கேட்டுக்கொண்டிருக்கிறேன்.",
    "சரி, தொடருங்கள்.",
    "கேட்கிறேன், சொல்லுங்கள்.",
  ],
  "te-IN": [
    "చెప్పండి, వింటున్నాను.",
    "అవును, కొనసాగించండి.",
    "వింటున్నాను, చెప్పండి.",
  ],
};

function normalizeLangKey(tag: string): keyof typeof FILLER_ACK_PHRASES {
  const t = tag.trim().replace(/_/g, "-").toLowerCase();
  if (!t) return "en-IN";
  if (t in FILLER_ACK_PHRASES) return t as keyof typeof FILLER_ACK_PHRASES;
  const primary = t.split("-")[0] ?? "";
  const hit = (Object.keys(FILLER_ACK_PHRASES) as (keyof typeof FILLER_ACK_PHRASES)[]).find(
    (k) => k.startsWith(`${primary}-`)
  );
  return hit ?? "en-IN";
}

export type PickFillerAckOptions = {
  /**
   * When set (e.g. `VOICEBOT_FILLER_ACK_TEXT`), merged into the **en-IN** pool so ops can override/add.
   */
  englishOverride?: string | null;
};

/**
 * Random acknowledgment for the call's effective language (`effectiveSttLanguageThisTurn`).
 */
export function pickFillerAckPhrase(
  languageBcp47: string,
  options?: PickFillerAckOptions
): string {
  const key = normalizeLangKey(languageBcp47);
  const base = FILLER_ACK_PHRASES[key];
  let pool: readonly string[] = base ?? FILLER_ACK_PHRASES["en-IN"];

  if (key === "en-IN" && options?.englishOverride?.trim()) {
    const o = options.englishOverride.trim();
    pool = Array.from(new Set([o, ...FILLER_ACK_PHRASES["en-IN"]]));
  }

  return pool[randomInt(pool.length)]!;
}
