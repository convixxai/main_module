// ============================================================
// Standalone verification for the language-switch rewrite in
// exotel-voicebot.ts (decideLanguageSwitchAction, parseLanguageChoice,
// languageSwitchOptionsPrompt) — pure-function checks, since a real phone
// call can't be placed from here. Does NOT touch the DB or any live route.
//
// Usage (from apps/api): npx ts-node scripts/verify-language-switch.ts
// ============================================================

import "@fastify/websocket"; // side-effect import: applies fastify's websocket route-option type augmentation, needed since exotel-voicebot.ts uses { websocket: true } route options
import { createSession } from "../src/services/voicebot-session";
import {
  decideLanguageSwitchAction,
  parseLanguageChoice,
  languageSwitchOptionsPrompt,
} from "../src/routes/exotel-voicebot";
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

section("languageSwitchOptionsPrompt");
{
  const custWithTemplate = { language_switch_options_prompt: "Please say one of: {LANGUAGE_LIST}." } as unknown as CustomerSettings;
  const prompt = languageSwitchOptionsPrompt(custWithTemplate, allowedNorm);
  check(
    "fills {LANGUAGE_LIST} with humanized allowed languages",
    prompt === "Please say one of: English, Hindi, Marathi.",
    prompt
  );
  const custNoTemplate = {} as unknown as CustomerSettings;
  const fallbackPrompt = languageSwitchOptionsPrompt(custNoTemplate, allowedNorm);
  check(
    "falls back to a sensible default when customer_settings has no template",
    fallbackPrompt.includes("English") && fallbackPrompt.includes("Hindi") && fallbackPrompt.includes("Marathi"),
    fallbackPrompt
  );
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
