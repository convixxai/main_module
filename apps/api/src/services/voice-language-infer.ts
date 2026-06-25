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
      /(?:आहे|नाही|मी\s|तुम्ही|बोल|मराठी|काय|कशी|ऐकत|सांग)/u;
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

/** Fast-path spoken reply (Cartesia emotion tag optional). */
export function conversationalOpenerReply(
  languageBcp47: string,
  options?: { withEmotionTags?: boolean }
): string {
  const tag = options?.withEmotionTags !== false ? "[enthusiastic] " : "";
  const bcp = languageBcp47.trim().toLowerCase();
  if (bcp.startsWith("hi")) {
    return `${tag}नमस्ते! बताइए, मैं आपकी कैसे मदद कर सकता हूँ?`;
  }
  if (bcp.startsWith("mr")) {
    return `${tag}नमस्कार! मी तुम्हाला कशी मदत करू शकतो?`;
  }
  if (bcp.startsWith("gu")) {
    return `${tag}નમસ્તે! હું તમારી કેવી રીતે મદદ કરી શકું?`;
  }
  return `${tag}Hi there! How can I help you today?`;
}
