import type { CustomerSettings } from "./customer-settings";
import type { VoicebotSession } from "./voicebot-session";

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

// ============================================================
// Mid-call language switch (explicit-confirmation only)
//
// Extracted from exotel-voicebot.ts (2026-09) so vodafone-voicebot.ts can
// share the exact same, already-proven flow instead of a second
// implementation. The core rule, unchanged from Exotel's original design:
// the bot NEVER silently changes the active conversation language on its
// own inference. A detected mismatch (from STT) only ever produces one of
// two outcomes - keep answering in the current language, or explicitly ask
// the caller which language they'd like - and the active language changes
// ONLY once the caller confirms (by naming a language, or a yes/no word) on
// a later turn. This was itself a fix for callers hearing the bot flip
// language mid-call with no warning from a single noisy/mis-detected turn.
// ============================================================

export const LANGUAGE_DISPLAY_NAME: Record<string, string> = {
  "en-IN": "English",
  "hi-IN": "Hindi",
  "mr-IN": "Marathi",
  "bn-IN": "Bengali",
  "gu-IN": "Gujarati",
  "kn-IN": "Kannada",
  "ml-IN": "Malayalam",
  "od-IN": "Odia",
  "pa-IN": "Punjabi",
  "ta-IN": "Tamil",
  "te-IN": "Telugu",
};

export function humanizeAllowedList(allowed: string[]): string {
  return allowed.map((c) => LANGUAGE_DISPLAY_NAME[c] ?? c).join(", ");
}

export function normalizeBcp47Tag(code: string): string {
  const t = code.trim();
  if (!t) return "en-IN";
  const parts = t.split(/[-_]/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0].toLowerCase()}-${parts[1].toUpperCase()}`;
  }
  return parts[0].toLowerCase();
}

/** Non-empty allowlist; if DB list empty, use `[fallback]`. */
export function normalizeAllowedLangList(
  fromSession: string[] | undefined,
  fallback: string
): string[] {
  const fb = normalizeBcp47Tag(fallback);
  const raw = fromSession?.length ? fromSession : [fb];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of raw) {
    const n = normalizeBcp47Tag(c);
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out.length > 0 ? out : [fb];
}

/** Same acceptance rule as clamp (exact tag or matching primary subtag). */
export function isLanguageInAllowedList(detectedRaw: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const d = normalizeBcp47Tag(detectedRaw);
  if (allowed.includes(d)) return true;
  const primary = d.split("-")[0]?.toLowerCase() ?? "";
  return allowed.some((a) => a.split("-")[0]?.toLowerCase() === primary);
}

/**
 * If Sarvam STT guesses a language outside the tenant allowlist (e.g. ta-IN),
 * snap to the tenant default so TTS/LLM stay within policy.
 */
export function clampLanguageToAllowed(
  detectedRaw: string,
  allowed: string[],
  fallback: string
): string {
  if (allowed.length === 0) return normalizeBcp47Tag(fallback);
  const d = normalizeBcp47Tag(detectedRaw);
  if (allowed.includes(d)) return d;
  const primary = d.split("-")[0]?.toLowerCase() ?? "";
  const byPrimary = allowed.find((a) => a.split("-")[0]?.toLowerCase() === primary);
  if (byPrimary) return byPrimary;
  return normalizeBcp47Tag(fallback);
}

export function languagesLooselyEqual(a: string, b: string): boolean {
  const na = normalizeBcp47Tag(a);
  const nb = normalizeBcp47Tag(b);
  if (na === nb) return true;
  const pa = na.split("-")[0]?.toLowerCase() ?? "";
  const pb = nb.split("-")[0]?.toLowerCase() ?? "";
  return pa.length > 0 && pa === pb;
}

/**
 * Persists the active conversation language onto the session. Callers should
 * only invoke this after an EXPLICIT customer confirmation (see
 * decideLanguageSwitchAction/parseLanguageChoice below) - never from a bare
 * detection signal.
 */
export function persistSessionActiveLanguage(session: VoicebotSession, lang: string): string {
  const n = normalizeBcp47Tag(lang);
  session.currentLanguageCode = n;
  return n;
}

type LanguageSwitchDecision =
  | { action: "continue" }
  | { action: "offer"; target: string; confidence: number | null };

/**
 * Decides whether a detected language mismatch should be surfaced to the
 * caller as an explicit "which language would you like?" question, or
 * ignored for now. Deliberately NEVER returns a silent-switch action - the
 * only two outcomes are "keep answering in the current session language" or
 * "offer an explicit choice."
 */
export function decideLanguageSwitchAction(
  session: VoicebotSession,
  cust: CustomerSettings | null | undefined,
  params: {
    multilingual: boolean;
    clampedDetected: string;
    languageProbability: number | null;
    sttProvider: string;
    allowedNorm: string[];
  }
): LanguageSwitchDecision {
  const { multilingual, clampedDetected, languageProbability, sttProvider, allowedNorm } = params;
  if (!multilingual) return { action: "continue" };

  const active = normalizeBcp47Tag(
    session.currentLanguageCode || session.defaultLanguageCode || "en-IN"
  );
  if (!isLanguageInAllowedList(clampedDetected, allowedNorm)) {
    return { action: "continue" };
  }
  if (languagesLooselyEqual(clampedDetected, active)) {
    return { action: "continue" };
  }

  // Track consecutive detections of the same different language - a single
  // noisy/mis-detected turn should never trigger anything by itself.
  if (session.discrepantLanguageTarget === clampedDetected) {
    session.discrepantLanguageCount = (session.discrepantLanguageCount || 0) + 1;
  } else {
    session.discrepantLanguageTarget = clampedDetected;
    session.discrepantLanguageCount = 1;
  }

  const conf = sttProvider === "sarvam" ? languageProbability : null;
  const canOffer =
    cust?.allow_language_switch === true &&
    !session.languageSwitchOfferedThisCall &&
    !session.pendingLanguageSwitch &&
    (session.discrepantLanguageCount ?? 0) >= 2;

  if (!canOffer) {
    return { action: "continue" };
  }

  return { action: "offer", target: normalizeBcp47Tag(clampedDetected), confidence: conf };
}

/** Builds the "which language would you like?" prompt from the tenant's configured template. */
export function languageSwitchOptionsPrompt(
  cust: CustomerSettings | null | undefined,
  allowedNorm: string[]
): string {
  const template =
    cust?.language_switch_options_prompt?.trim() || "Please say one of: {LANGUAGE_LIST}.";
  return template.replace("{LANGUAGE_LIST}", humanizeAllowedList(allowedNorm));
}

/**
 * Parses the customer's reply to a pending language-switch offer. Accepts
 * either a directly-named language (from the tenant's allowed list) or a
 * tenant-configured yes/no word confirming/declining the best-guess target.
 */
export function parseLanguageChoice(
  transcript: string,
  allowedNorm: string[],
  yesWords: string[],
  noWords: string[]
): { kind: "language"; target: string } | { kind: "yes" } | { kind: "no" } | { kind: "unclear" } {
  const t = transcript.trim().toLowerCase();
  if (!t) return { kind: "unclear" };

  // Native-language self-names, so "hindi mein" / "मराठीत" etc. are recognized
  // even though LANGUAGE_DISPLAY_NAME's values are English names.
  const NATIVE_NAMES: Record<string, string[]> = {
    "hi-IN": ["hindi", "हिंदी", "हिन्दी"],
    "mr-IN": ["marathi", "मराठी"],
    "en-IN": ["english", "इंग्लिश"],
    "gu-IN": ["gujarati", "ગુજરાતી"],
    "bn-IN": ["bengali", "বাংলা"],
    "kn-IN": ["kannada", "ಕನ್ನಡ"],
    "ml-IN": ["malayalam", "മലയാളം"],
    "od-IN": ["odia", "ଓଡ଼ିଆ"],
    "pa-IN": ["punjabi", "ਪੰਜਾਬੀ"],
    "ta-IN": ["tamil", "தமிழ்"],
    "te-IN": ["telugu", "తెలుగు"],
  };
  for (const tag of allowedNorm) {
    const names = NATIVE_NAMES[tag] ?? [LANGUAGE_DISPLAY_NAME[tag]?.toLowerCase() ?? ""];
    if (names.some((n) => n && t.includes(n.toLowerCase()))) {
      return { kind: "language", target: tag };
    }
  }

  const norm = (w: string) => w.trim().toLowerCase();
  if (yesWords.some((w) => norm(w) && t.includes(norm(w)))) return { kind: "yes" };
  if (noWords.some((w) => norm(w) && t.includes(norm(w)))) return { kind: "no" };

  return { kind: "unclear" };
}

/** Default acknowledgement spoken right after a confirmed switch, before the (optional) held-back question is answered. */
export function languageSwitchAcknowledgement(targetBcp47: string): string {
  if (targetBcp47.startsWith("hi")) {
    return "ठीक है, अब हम हिंदी में बात करेंगे। मैं आपकी क्या मदद कर सकता हूँ?";
  }
  if (targetBcp47.startsWith("mr")) {
    return "ठीक आहे, आता आपण मराठीत बोलूया. मी तुम्हाला कशी मदत करू?";
  }
  const label = LANGUAGE_DISPLAY_NAME[targetBcp47] ?? targetBcp47;
  return `Okay, let's continue in ${label}. How can I help you?`;
}
