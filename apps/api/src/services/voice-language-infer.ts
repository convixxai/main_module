/**
 * Infer reply language from transcript script when STT metadata is wrong
 * (e.g. ElevenLabs tags `eng` for Hindi Devanagari).
 */

export function inferLanguageFromTranscript(
  transcript: string,
  allowedBcp47: readonly string[],
  defaultBcp47: string
): string | null {
  const t = transcript.trim();
  if (t.length < 1) return null;

  const allowed = new Set(
    allowedBcp47.map((x) => x.trim().replace(/_/g, "-").toLowerCase())
  );
  const pick = (tag: string): string | null => {
    const n = tag.trim().replace(/_/g, "-");
    const lower = n.toLowerCase();
    if (allowed.has(lower)) return n;
    const primary = lower.split("-")[0] ?? "";
    for (const a of allowed) {
      if (a.startsWith(`${primary}-`)) return a;
    }
    return null;
  };

  if (/\p{Script=Devanagari}/u.test(t)) {
    const marathiHints =
      /(?:आहे|नाही|मी\s|मला|तुम्ही|तुमच|बोल|मराठी|काय|कशी|ऐकत|सांग|विचार|होत|पासून|किती|लांब|शकते|शकत)/u;
    const candidate = marathiHints.test(t) ? "mr-IN" : "hi-IN";
    return pick(candidate) ?? pick("hi-IN") ?? pick("mr-IN");
  }

  if (/\p{Script=Gujarati}/u.test(t)) return pick("gu-IN");
  if (/\p{Script=Tamil}/u.test(t)) return pick("ta-IN");
  if (/\p{Script=Telugu}/u.test(t)) return pick("te-IN");
  if (/\p{Script=Kannada}/u.test(t)) return pick("kn-IN");
  if (/\p{Script=Bengali}/u.test(t)) return pick("bn-IN");
  if (/\p{Script=Gurmukhi}/u.test(t)) return pick("pa-IN");

  let latin = 0;
  let letters = 0;
  for (const ch of t) {
    if (/[A-Za-z]/.test(ch)) {
      latin++;
      letters++;
    } else if (/\p{L}/u.test(ch)) {
      letters++;
    }
  }
  if (letters > 0 && latin / letters >= 0.6) {
    return pick("en-IN") ?? pick(defaultBcp47);
  }

  return null;
}

const INDIC_DIGIT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0966, 0x096f], // Devanagari
  [0x09e6, 0x09ef], // Bengali
  [0x0a66, 0x0a6f], // Gurmukhi
  [0x0ae6, 0x0aef], // Gujarati
  [0x0b66, 0x0b6f], // Oriya
  [0x0c66, 0x0c6f], // Telugu
  [0x0ce6, 0x0cef], // Kannada
  [0x0d66, 0x0d6f], // Malayalam
  [0x0e50, 0x0e59], // Thai
  [0x0f20, 0x0f29], // Tibetan
];

/** Indic-script digits → ASCII 0-9 so telephony TTS reads numbers reliably. */
export function normalizeIndicDigitsForTts(text: string): string {
  return [...text]
    .map((ch) => {
      const cp = ch.codePointAt(0);
      if (cp == null) return ch;
      for (const [start, end] of INDIC_DIGIT_RANGES) {
        if (cp >= start && cp <= end) return String(cp - start);
      }
      return ch;
    })
    .join("");
}

/**
 * STT noise: punctuation-only or no speakable letters (e.g. Cartesia returning "." on silence).
 * Treat like empty transcript — do not run RAG/LLM.
 */
export function isEffectivelyEmptySttTranscript(raw: string): boolean {
  const t = raw.trim();
  if (!t) return true;
  const withoutPunct = t.replace(/[\s.,!?…:;'"`\-–—()[\]{}]/gu, "");
  if (!withoutPunct) return true;
  let letters = 0;
  for (const ch of withoutPunct) {
    if (/\p{L}|\p{N}/u.test(ch)) letters++;
  }
  return letters === 0;
}

/** Short greetings / openers that should not trigger full KB + LLM. */
export function isConversationalOpener(raw: string): boolean {
  const t = raw
    .trim()
    .replace(/[\u201c\u201d\u2018\u2019'"`]/g, "")
    .replace(/\s+/g, " ");
  if (!t || t.length > 48) return false;
  return (
    /^(?:(?:hi|hello|hey|howdy|hola|yo)\s*[.!?…]*|good\s+(?:morning|afternoon|evening)\s*[.!?…]*|(?:namaste|नमस्ते|नमस्कार)\s*[.!?…]*|(?:ह(?:ा|ाँ)|हां)(?:\s*,\s*|\s+)(?:हेलो|hello)?\s*[.!?…]*|(?:हेलो|hello)\s*[.!?…]*|(?:हां|हाँ)\s*[.!?…]*)$/iu.test(
      t
    ) ||
    /^(?:yes|yeah|yep|okay|ok|sure|right|haan|हाँ|हां|जी|ठीक\s*है)\s*[.!?…]*$/iu.test(
      t
    )
  );
}

/** Fast-path spoken reply — neutral tone, feminine wording. */
export function conversationalOpenerReply(
  languageBcp47: string,
  _options?: { withEmotionTags?: boolean }
): string {
  const bcp = languageBcp47.trim().toLowerCase();
  if (bcp.startsWith("hi")) {
    return "नमस्ते! बताइए, मैं आपकी कैसे मदद कर सकती हूँ?";
  }
  if (bcp.startsWith("mr")) {
    return "नमस्कार! मी तुम्हाला कशी मदत करू शकते?";
  }
  if (bcp.startsWith("gu")) {
    return "નમસ્તે! હું તમારી કેવી રીતે મદદ કરી શકું?";
  }
  return "Hi there! How can I help you today?";
}
