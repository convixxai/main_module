// ============================================================
// Standalone verification for the shared language-switch logic in
// services/voice-language-infer.ts (decideLanguageSwitchAction,
// parseLanguageChoice, languageSwitchOptionsPrompt,
// detectExplicitLanguageSwitchRequest), used by both exotel-voicebot.ts and
// vodafone-voicebot.ts — pure-function checks, since a real phone call can't
// be placed from here. Does NOT touch the DB or any live route.
//
// Usage (from apps/api): npx ts-node scripts/verify-language-switch.ts
// ============================================================

import "@fastify/websocket"; // side-effect import: applies fastify's websocket route-option type augmentation, needed since exotel-voicebot.ts uses { websocket: true } route options
import { createSession } from "../src/services/voicebot-session";
import {
  decideLanguageSwitchAction,
  parseLanguageChoice,
  languageSwitchOptionsPrompt,
  detectExplicitLanguageSwitchRequest,
} from "../src/services/voice-language-infer";
import type { CustomerSettings } from "../src/services/customer-settings";

let failures = 0;
function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail ?? "");
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

function fakeSession(allowLanguageSwitch: boolean) {
  const session = createSession({
    streamSid: "stream-1",
    callSid: "call-1",
    customerId: "cust-1",
    accountSid: "acct-1",
    from: "+911111111111",
    to: "+912222222222",
    mediaFormat: { encoding: "raw", sample_rate: 8000 },
  });
  session.currentLanguageCode = "en-IN";
  session.defaultLanguageCode = "en-IN";
  session.allowedLanguageCodes = ["en-IN", "hi-IN", "mr-IN"];
  const cust = { allow_language_switch: allowLanguageSwitch } as unknown as CustomerSettings;
  return { session, cust };
}

const allowedNorm = ["en-IN", "hi-IN", "mr-IN"];

section("decideLanguageSwitchAction — single noisy turn never triggers an offer");
{
  const { session, cust } = fakeSession(true);
  const decision = decideLanguageSwitchAction(session, cust, {
    multilingual: true,
    clampedDetected: "hi-IN",
    languageProbability: 0.95,
    sttProvider: "sarvam",
    allowedNorm,
  });
  check("single detection -> continue (not offer)", decision.action === "continue", decision);
  check("discrepantLanguageCount is 1 after one detection", session.discrepantLanguageCount === 1, session.discrepantLanguageCount);
}

section("decideLanguageSwitchAction — 2 consecutive detections, feature OFF (allow_language_switch=false) -> still no offer");
{
  const { session, cust } = fakeSession(false);
  decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  const second = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("2 consecutive detections with flag OFF -> continue (inert by default)", second.action === "continue", second);
}

section("decideLanguageSwitchAction — 2 consecutive detections, feature ON -> offers exactly once per call");
{
  const { session, cust } = fakeSession(true);
  const first = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("1st detection -> continue", first.action === "continue", first);
  const second = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("2nd consecutive detection -> offer", second.action === "offer" && second.target === "hi-IN", second);

  // Simulate what the real call site does when an offer fires.
  session.languageSwitchOfferedThisCall = true;
  session.discrepantLanguageCount = 0;
  session.discrepantLanguageTarget = null;

  const third = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  const fourth = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check(
    "after being offered once this call, further consecutive detections never offer again",
    third.action === "continue" && fourth.action === "continue",
    { third, fourth }
  );
}

section("decideLanguageSwitchAction — disallowed / same-language / non-multilingual guards");
{
  const { session, cust } = fakeSession(true);
  const notMultilingual = decideLanguageSwitchAction(session, cust, {
    multilingual: false, clampedDetected: "hi-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("multilingual=false -> continue", notMultilingual.action === "continue", notMultilingual);

  const sameLang = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "en-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("detected == current language -> continue", sameLang.action === "continue", sameLang);

  const disallowed = decideLanguageSwitchAction(session, cust, {
    multilingual: true, clampedDetected: "ta-IN", languageProbability: 0.95, sttProvider: "sarvam", allowedNorm,
  });
  check("detected language not in tenant's allowed list -> continue", disallowed.action === "continue", disallowed);
}

section("parseLanguageChoice");
{
  const yesWords = ["yes", "haan", "हाँ", "ho", "हो"];
  const noWords = ["no", "nahi", "नहीं"];

  check(
    "named language (English name) -> matches",
    JSON.stringify(parseLanguageChoice("Hindi please", allowedNorm, yesWords, noWords)) === JSON.stringify({ kind: "language", target: "hi-IN" })
  );
  check(
    "named language (native script) -> matches",
    JSON.stringify(parseLanguageChoice("मराठीत बोलूया", allowedNorm, yesWords, noWords)) === JSON.stringify({ kind: "language", target: "mr-IN" })
  );
  check(
    "language outside allowed list is NOT matched even if named",
    parseLanguageChoice("Tamil please", allowedNorm, yesWords, noWords).kind !== "language"
  );
  check(
    "yes-word -> kind yes",
    parseLanguageChoice("haan theek hai", allowedNorm, yesWords, noWords).kind === "yes"
  );
  check(
    "no-word -> kind no",
    parseLanguageChoice("nahi rehne do", allowedNorm, yesWords, noWords).kind === "no"
  );
  check(
    "gibberish/unrelated -> unclear",
    parseLanguageChoice("what's the weather like", allowedNorm, yesWords, noWords).kind === "unclear"
  );
  check(
    "empty transcript -> unclear",
    parseLanguageChoice("   ", allowedNorm, yesWords, noWords).kind === "unclear"
  );
}

section("languageSwitchOptionsPrompt — tenant template still honored, {LANGUAGE_LIST} localized");
{
  const custWithTemplate = { language_switch_options_prompt: "Please say one of: {LANGUAGE_LIST}." } as unknown as CustomerSettings;
  const prompt = languageSwitchOptionsPrompt(custWithTemplate, allowedNorm, "en-IN");
  check(
    "fills {LANGUAGE_LIST} with humanized allowed languages",
    prompt === "Please say one of: English, Hindi, Marathi.",
    prompt
  );
  const custNoTemplate = {} as unknown as CustomerSettings;
  const fallbackPromptEn = languageSwitchOptionsPrompt(custNoTemplate, allowedNorm, "en-IN");
  check(
    "no template, active=English -> sensible default with all names",
    fallbackPromptEn.includes("English") && fallbackPromptEn.includes("Hindi") && fallbackPromptEn.includes("Marathi"),
    fallbackPromptEn
  );
}

section("languageSwitchOptionsPrompt — asks in the CURRENTLY ACTIVE language, not always English");
{
  const custNoTemplate = {} as unknown as CustomerSettings;
  const promptMr = languageSwitchOptionsPrompt(custNoTemplate, allowedNorm, "mr-IN");
  check(
    "active=Marathi -> prompt sentence itself is in Devanagari/Marathi, not 'Please say one of'",
    /[ऀ-ॿ]/.test(promptMr) && !promptMr.startsWith("Please say"),
    promptMr
  );
  const promptHi = languageSwitchOptionsPrompt(custNoTemplate, allowedNorm, "hi-IN");
  check(
    "active=Hindi -> prompt sentence itself is in Devanagari/Hindi",
    /[ऀ-ॿ]/.test(promptHi) && !promptHi.startsWith("Please say"),
    promptHi
  );
}

section("detectExplicitLanguageSwitchRequest — unprompted ask on any turn");
{
  check(
    "'Can you speak in English' -> en-IN",
    detectExplicitLanguageSwitchRequest("Can you speak in English", allowedNorm) === "en-IN"
  );
  check(
    "'मराठीत बोला' -> mr-IN",
    detectExplicitLanguageSwitchRequest("मराठीत बोला", allowedNorm) === "mr-IN"
  );
  check(
    "'please switch to hindi' -> hi-IN",
    detectExplicitLanguageSwitchRequest("please switch to hindi", allowedNorm) === "hi-IN"
  );
  check(
    "bare mention with no switch-intent cue ('my name is Hindi') -> null (no misfire)",
    detectExplicitLanguageSwitchRequest("my name is hindi kumar", allowedNorm) === null
  );
  check(
    "negated ('I don't want to speak hindi') -> null",
    detectExplicitLanguageSwitchRequest("I don't want to speak hindi", allowedNorm) === null
  );
  check(
    "language not in tenant's allowed list -> null even with clear intent",
    detectExplicitLanguageSwitchRequest("can you speak in tamil", allowedNorm) === null
  );
  check(
    "no language named at all -> null",
    detectExplicitLanguageSwitchRequest("can you help me with my recharge", allowedNorm) === null
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
