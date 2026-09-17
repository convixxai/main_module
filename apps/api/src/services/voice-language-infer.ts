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

// Native-language self-names, so "hindi mein" / "मराठीत" etc. are recognized
// even though LANGUAGE_DISPLAY_NAME's values are English names. Shared between
// parseLanguageChoice (answering a pending offer) and
// detectExplicitLanguageSwitchRequest (an unprompted "speak in X" ask).
const LANGUAGE_NATIVE_NAMES: Record<string, string[]> = {
  "hi-IN": ["hindi", "हिंदी", "हिन्दी"],
  "mr-IN": ["marathi", "मराठी"],
  "en-IN": ["english", "इंग्लिश", "इंग्रजी"],
  "gu-IN": ["gujarati", "ગુજરાતી", "गुजराती"],
  "bn-IN": ["bengali", "বাংলা"],
  "kn-IN": ["kannada", "ಕನ್ನಡ"],
  "ml-IN": ["malayalam", "മലയാളം"],
  "od-IN": ["odia", "ଓଡ଼ିଆ"],
  "pa-IN": ["punjabi", "ਪੰਜਾਬੀ"],
  "ta-IN": ["tamil", "தமிழ்"],
  "te-IN": ["telugu", "తెలుగు"],
};

// Endonyms - each language's own name for itself. Used to announce the
// language OPTIONS inside a switch-prompt sentence regardless of which
// language that carrier sentence is spoken in - e.g. a Marathi sentence
// naming "हिंदी, मराठी, English" (mixing scripts to name each option by its
// own native name) is completely natural in Indian multilingual speech and
// avoids needing an error-prone N x N cross-translation matrix of every
// language's name into every other language.
const LANGUAGE_SELF_NAME: Record<string, string> = {
  "en-IN": "English",
  "hi-IN": "हिंदी",
  "mr-IN": "मराठी",
  "gu-IN": "ગુજરાતી",
  "bn-IN": "বাংলা",
  "kn-IN": "ಕನ್ನಡ",
  "ml-IN": "മലയാളം",
  "od-IN": "ଓଡ଼ିଆ",
  "pa-IN": "ਪੰਜਾਬੀ",
  "ta-IN": "தமிழ்",
  "te-IN": "తెలుగు",
};

function localizedLanguageName(tag: string): string {
  return LANGUAGE_SELF_NAME[tag] ?? LANGUAGE_DISPLAY_NAME[tag] ?? tag;
}

/**
 * Same as humanizeAllowedList, but uses each language's own native name
 * instead of its English name - EXCEPT when the active language is English
 * itself, where English names read more naturally in an all-English sentence
 * ("English, Hindi, Marathi" rather than "English, हिंदी, मराठी").
 */
export function humanizeAllowedListForActive(allowed: string[], activeBcp47: string): string {
  const activePrimary = normalizeBcp47Tag(activeBcp47).split("-")[0] ?? "en";
  if (activePrimary === "en") return humanizeAllowedList(allowed);
  return allowed.map((c) => localizedLanguageName(c)).join(", ");
}

// Carrier-sentence templates for "which language would you like?", one per
// active call language. Covers English plus the ten scheduled Indian
// languages this platform supports as allowed_language_codes values
// (Hindi, Marathi, Gujarati, Bengali, Punjabi, Tamil, Telugu, Kannada,
// Malayalam, Odia) - only the four with heaviest current tenant traffic
// (en/hi/mr/gu) have been spoken on live calls and proofread against real
// call audio; the rest are best-effort standard phrasing and worth a native
// speaker's once-over before heavy use.
const LANGUAGE_SWITCH_PROMPT_TEMPLATE_BY_ACTIVE: Record<string, string> = {
  en: "Which language would you like me to continue in - {LANGUAGE_LIST}?",
  hi: "आप किस भाषा में बात करना पसंद करेंगे - {LANGUAGE_LIST}?",
  mr: "तुम्हाला कोणत्या भाषेत बोलायला आवडेल - {LANGUAGE_LIST}?",
  gu: "તમે કઈ ભાષામાં વાત કરવા માંગો છો - {LANGUAGE_LIST}?",
  bn: "আপনি কোন ভাষায় কথা বলতে চান - {LANGUAGE_LIST}?",
  pa: "ਤੁਸੀਂ ਕਿਹੜੀ ਭਾਸ਼ਾ ਵਿੱਚ ਗੱਲ ਕਰਨਾ ਚਾਹੋਗੇ - {LANGUAGE_LIST}?",
  ta: "நீங்கள் எந்த மொழியில் பேச விரும்புகிறீர்கள் - {LANGUAGE_LIST}?",
  te: "మీరు ఏ భాషలో మాట్లాడాలనుకుంటున్నారు - {LANGUAGE_LIST}?",
  kn: "ನೀವು ಯಾವ ಭಾಷೆಯಲ್ಲಿ ಮಾತನಾಡಲು ಬಯಸುತ್ತೀರಿ - {LANGUAGE_LIST}?",
  ml: "നിങ്ങൾ ഏത് ഭാഷയിൽ സംസാരിക്കാൻ ആഗ്രഹിക്കുന്നു - {LANGUAGE_LIST}?",
  od: "ଆପଣ କେଉଁ ଭାଷାରେ କଥା ହେବାକୁ ଚାହୁଁଛନ୍ତି - {LANGUAGE_LIST}?",
};

/**
 * Builds the "which language would you like?" prompt, spoken as a proper
 * sentence in the language the call is CURRENTLY running in (not always
 * English) - a caller mid-call in Marathi should be asked in Marathi, not
 * handed a bare "Please say one of: Hindi, Marathi, English." in English.
 * A tenant-configured template (customer_settings.language_switch_options_prompt)
 * is still honored verbatim if set, only the {LANGUAGE_LIST} names are localized.
 */
export function languageSwitchOptionsPrompt(
  cust: CustomerSettings | null | undefined,
  allowedNorm: string[],
  activeBcp47: string
): string {
  const activePrimary = normalizeBcp47Tag(activeBcp47).split("-")[0] ?? "en";
  const list = humanizeAllowedListForActive(allowedNorm, activeBcp47);
  const template =
    cust?.language_switch_options_prompt?.trim() ||
    LANGUAGE_SWITCH_PROMPT_TEMPLATE_BY_ACTIVE[activePrimary] ||
    LANGUAGE_SWITCH_PROMPT_TEMPLATE_BY_ACTIVE.en;
  return template.replace("{LANGUAGE_LIST}", list);
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

  for (const tag of allowedNorm) {
    const names = LANGUAGE_NATIVE_NAMES[tag] ?? [LANGUAGE_DISPLAY_NAME[tag]?.toLowerCase() ?? ""];
    if (names.some((n) => n && t.includes(n.toLowerCase()))) {
      return { kind: "language", target: tag };
    }
  }

  const norm = (w: string) => w.trim().toLowerCase();
  if (yesWords.some((w) => norm(w) && t.includes(norm(w)))) return { kind: "yes" };
  if (noWords.some((w) => norm(w) && t.includes(norm(w)))) return { kind: "no" };

  return { kind: "unclear" };
}

// Verbs/nouns that signal the caller is actually asking to change language,
// as opposed to merely saying a language's name in passing (e.g. answering
// "Marathi" to a pending offer, which parseLanguageChoice handles separately,
// or mentioning a language name inside an unrelated sentence).
const EXPLICIT_SWITCH_INTENT_RE =
  /\b(speak|talk|reply|answer|continue|switch|change)\b|\blanguage\b|बोल|भाषा|बदल|બોલ|ભાષા|બદલ|বল|ভাষা|ਬੋਲ|ਭਾਸ਼ਾ|பேசு|மொழி|మాట్లాడ|భాష|ಮಾತನಾಡ|ಭಾಷೆ|സംസാരി|ഭാഷ|କୁହ|ଭାଷା/iu;

const NEGATION_NEAR_RE = /\b(don't|do not|dont|no|not|nahi|nahin|नहीं|नको|नाही)\b/iu;

/**
 * Detects an UNPROMPTED, explicit ask to change the conversation language,
 * e.g. "Can you speak in English" or "मराठीत बोला" - on ANY turn, not just
 * as an answer to a pending offer. Unlike the passive two-consecutive-
 * detections path, this fires immediately on a single turn once the caller
 * clearly states what they want, per the tenant's allowed language list.
 * Returns null if no clear ask is found (a bare mention of a language name
 * without an accompanying "speak/talk/language/बोल/भाषा" cue does not count,
 * to avoid misfiring on incidental mentions).
 */
export function detectExplicitLanguageSwitchRequest(
  transcript: string,
  allowedNorm: string[]
): string | null {
  const raw = transcript.trim();
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (!EXPLICIT_SWITCH_INTENT_RE.test(t)) return null;

  for (const tag of allowedNorm) {
    const names = LANGUAGE_NATIVE_NAMES[tag] ?? [LANGUAGE_DISPLAY_NAME[tag]?.toLowerCase() ?? ""];
    for (const rawName of names) {
      const name = rawName.toLowerCase();
      if (!name) continue;
      const idx = t.indexOf(name);
      if (idx === -1) continue;
      const before = t.slice(Math.max(0, idx - 25), idx);
      if (NEGATION_NEAR_RE.test(before)) continue;
      return tag;
    }
  }
  return null;
}

/**
 * Strips the "speak in X" / "X मध्ये बोला" phrasing (and the language name
 * itself) out of a transcript that triggered detectExplicitLanguageSwitchRequest,
 * so a packed utterance like "Speak in English, what's my balance" can still
 * have its real question answered on the same turn instead of being discarded.
 */
export function stripLanguageSwitchPhrase(transcript: string, targetTag: string): string {
  const names = (LANGUAGE_NATIVE_NAMES[targetTag] ?? [LANGUAGE_DISPLAY_NAME[targetTag] ?? targetTag]).map((n) =>
    n.toLowerCase()
  );
  let t = transcript.toLowerCase();
  for (const name of names) {
    if (name) t = t.split(name).join(" ");
  }
  t = t.replace(
    /\b(please|can|could|you|speak|talk|reply|answer|switch|change|continue|in|to|language|mein|mai|madhe|मध्ये|में)\b/giu,
    " "
  );
  return t.replace(/\s+/g, " ").trim();
}

// Spoken right after a confirmed switch, in the NEW target language, before
// the (optional) held-back question is answered. Female-voiced first-person
// forms where the target language marks verb gender (Hindi/Marathi/Punjabi),
// matching this platform's female Cartesia/Sarvam voices - see
// buildVoiceGenderRule in vodafone-voicebot.ts for the same convention.
const LANGUAGE_SWITCH_ACK_BY_TARGET: Record<string, string> = {
  en: "Okay, let's continue in English. How can I help you?",
  hi: "ठीक है, अब हम हिंदी में बात करेंगे। मैं आपकी क्या मदद कर सकती हूँ?",
  mr: "ठीक आहे, आता आपण मराठीत बोलूया. मी तुम्हाला कशी मदत करू?",
  gu: "ભલે, હવે આપણે ગુજરાતીમાં વાત કરીશું. હું તમારી કેવી રીતે મદદ કરી શકું?",
  bn: "ঠিক আছে, এখন আমরা বাংলায় কথা বলব। আমি আপনাকে কীভাবে সাহায্য করতে পারি?",
  pa: "ਠੀਕ ਹੈ, ਹੁਣ ਅਸੀਂ ਪੰਜਾਬੀ ਵਿੱਚ ਗੱਲ ਕਰਾਂਗੇ। ਮੈਂ ਤੁਹਾਡੀ ਕਿਵੇਂ ਮਦਦ ਕਰ ਸਕਦੀ ਹਾਂ?",
  ta: "சரி, இப்போது நாம் தமிழில் பேசுவோம். நான் உங்களுக்கு எப்படி உதவலாம்?",
  te: "సరే, ఇప్పుడు మనం తెలుగులో మాట్లాడుకుందాం. నేను మీకు ఎలా సహాయం చేయగలను?",
  kn: "ಸರಿ, ಈಗ ನಾವು ಕನ್ನಡದಲ್ಲಿ ಮಾತನಾಡೋಣ. ನಾನು ನಿಮಗೆ ಹೇಗೆ ಸಹಾಯ ಮಾಡಲಿ?",
  ml: "ശരി, ഇനി നമുക്ക് മലയാളത്തിൽ സംസാരിക്കാം. ഞാൻ എങ്ങനെ സഹായിക്കാം?",
  od: "ଠିକ୍ ଅଛି, ବର୍ତ୍ତମାନ ଆମେ ଓଡ଼ିଆରେ କଥା ହେବା. ମୁଁ ଆପଣଙ୍କୁ କିପରି ସାହାଯ୍ୟ କରିପାରିବି?",
};

/** Default acknowledgement spoken right after a confirmed switch, before the (optional) held-back question is answered. */
export function languageSwitchAcknowledgement(targetBcp47: string): string {
  const primary = normalizeBcp47Tag(targetBcp47).split("-")[0] ?? "en";
  return LANGUAGE_SWITCH_ACK_BY_TARGET[primary] ?? LANGUAGE_SWITCH_ACK_BY_TARGET.en;
}

const LANGUAGE_SWITCH_DECLINE_BY_ACTIVE: Record<string, (label: string) => string> = {
  en: (l) => `Okay, we'll continue in ${l}.`,
  hi: (l) => `ठीक है, हम ${l} में बात करना जारी रखेंगे।`,
  mr: (l) => `ठीक आहे, आपण ${l} भाषेत बोलणे सुरू ठेवू.`,
  gu: (l) => `ભલે, આપણે ${l} માં વાત ચાલુ રાખીશું.`,
  bn: (l) => `ঠিক আছে, আমরা ${l} তে কথা চালিয়ে যাব।`,
  pa: (l) => `ਠੀਕ ਹੈ, ਅਸੀਂ ${l} ਵਿੱਚ ਗੱਲ ਜਾਰੀ ਰੱਖਾਂਗੇ।`,
  ta: (l) => `சரி, நாம் ${l} இல் தொடர்வோம்.`,
  te: (l) => `సరే, మేము ${l} లో కొనసాగిస్తాము.`,
  kn: (l) => `ಸರಿ, ನಾವು ${l} ನಲ್ಲಿ ಮುಂದುವರಿಸೋಣ.`,
  ml: (l) => `ശരി, നമുക്ക് ${l} ൽ തുടരാം.`,
  od: (l) => `ଠିକ୍ ଅଛି, ଆମେ ${l} ରେ ଜାରି ରଖିବା.`,
};

/** Spoken when the caller declines a pending switch offer ("no") - stays in the CURRENT language, properly localized. */
export function languageSwitchDeclineAcknowledgement(activeBcp47: string): string {
  const n = normalizeBcp47Tag(activeBcp47);
  const primary = n.split("-")[0] ?? "en";
  const label = localizedLanguageName(n);
  const fn = LANGUAGE_SWITCH_DECLINE_BY_ACTIVE[primary] ?? LANGUAGE_SWITCH_DECLINE_BY_ACTIVE.en;
  return fn(label);
}

const LANGUAGE_SWITCH_GIVEUP_BY_ACTIVE: Record<string, (label: string) => string> = {
  en: (l) => `Okay, I'll continue in ${l}.`,
  hi: (l) => `ठीक है, मैं ${l} में ही बात जारी रखती हूँ।`,
  mr: (l) => `ठीक आहे, मी ${l} भाषेतच बोलणे सुरू ठेवते.`,
  gu: (l) => `ભલે, હું ${l} માં જ વાત ચાલુ રાખીશ.`,
  bn: (l) => `ঠিক আছে, আমি ${l} তেই কথা চালিয়ে যাব।`,
  pa: (l) => `ਠੀਕ ਹੈ, ਮੈਂ ${l} ਵਿੱਚ ਹੀ ਗੱਲ ਜਾਰੀ ਰੱਖਾਂਗੀ।`,
  ta: (l) => `சரி, நான் ${l} இல் தொடர்கிறேன்.`,
  te: (l) => `సరే, నేను ${l} లోనే కొనసాగిస్తాను.`,
  kn: (l) => `ಸರಿ, ನಾನು ${l} ನಲ್ಲಿಯೇ ಮುಂದುವರಿಸುತ್ತೇನೆ.`,
  ml: (l) => `ശരി, ഞാൻ ${l} ൽ തന്നെ തുടരും.`,
  od: (l) => `ଠିକ୍ ଅଛି, ମୁଁ ${l} ରେ ହିଁ ଜାରି ରଖିବି.`,
};

/** Spoken after max reprompt attempts are exhausted with no clear answer - falls back to the CURRENT language, properly localized. */
export function languageSwitchGiveUpAcknowledgement(activeBcp47: string): string {
  const n = normalizeBcp47Tag(activeBcp47);
  const primary = n.split("-")[0] ?? "en";
  const label = localizedLanguageName(n);
  const fn = LANGUAGE_SWITCH_GIVEUP_BY_ACTIVE[primary] ?? LANGUAGE_SWITCH_GIVEUP_BY_ACTIVE.en;
  return fn(label);
}
