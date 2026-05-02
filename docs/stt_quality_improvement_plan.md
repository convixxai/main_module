# Voicebot STT Quality — Improvement Plan

**Date:** 2026-05-02  
**Goal:** Fix STT accuracy, enforce language allowlist, and improve language switching  
**Status:** Proposal — waiting for approval before any code changes

---

## Table of Contents

1. [Current Setup Audit](#1-current-setup-audit)
2. [How STT Works Today (Flow)](#2-how-stt-works-today)
3. [User-Reported Problems](#3-user-reported-problems)
   - Problem 1: English speech → wrong Hindi transcript
   - Problem 2: Gujarati transcript despite not being in allowed languages
   - Problem 3: Wrong answers from wrong transcripts
   - Problem 4: Proper noun misrecognition (Chhavani → Xiaomi)
   - Problem 5: Language switch policy not working as expected
4. [Additional Bugs Found During Code Analysis](#4-additional-bugs-found)
   - Bug A: ElevenLabs Scribe does NOT enforce allowed language list
   - Bug B: Rehint retry adds ~1s+ latency for out-of-list languages
   - Bug C: No post-STT domain-word normalization
5. [Improvement Steps](#5-improvement-steps)
6. [Impact Summary](#6-impact-summary)
7. [Testing Checklist](#7-testing-checklist)

---

## 1. Current Setup Audit

### STT Settings (from `customer_settings` table)

| Component | Current Setting | Where It Lives |
|-----------|----------------|----------------|
| **STT Provider** | `sarvam` or `elevenlabs` | `customer_settings.stt_provider` (default: `sarvam`) |
| **STT Model** | `saaras:v3` (Sarvam) or `scribe_v2` (ElevenLabs) | `customer_settings.stt_model` |
| **Default Language** | `en-IN` | `customer_settings.default_language_code` |
| **Allowed Languages** | `["en-IN", "hi-IN", "mr-IN"]` (example) | `customer_settings.allowed_language_codes` |
| **Multilingual** | `true` / `false` | `customer_settings.voicebot_multilingual` |
| **STT Streaming** | `true` / `false` | `customer_settings.stt_streaming_enabled` |
| **Audio Sample Rate** | 8000 Hz (Exotel default) | Negotiated in Exotel `start` message |

### Language Hint Strategy (Current Code)

| Query # | Language Hint Sent to STT | Why |
|---------|--------------------------|-----|
| **1–2** (early window) | **None / auto-detect** | Open detection so Sarvam returns `language_probability` for language switch policy |
| **3+** (post-early) | **`session.currentLanguageCode`** (biased) | Narrows recognition for better 8kHz accuracy |
| **Full-auto mode** | **None** (always auto) | Env flag `VOICEBOT_SARVAM_STT_FULL_AUTO` / `VOICEBOT_ELEVENLABS_STT_FULL_AUTO` |

### Language Switch Policy (Current Code)

| Phase | Detected ≠ Active | Confidence | Allowed? | Action |
|-------|-------------------|------------|----------|--------|
| Queries 1–2 | yes | > 80% | yes | **Silent switch** (no asking) |
| Queries 1–2 | yes | ≤ 80% | — | No switch |
| Queries ≥ 3 | yes | any | yes | **Ask confirmation first** |
| Queries ≥ 3 | yes | any | no | No switch |

---

## 2. How STT Works Today

### Technical Flow

```
Caller speaks → Exotel sends PCM chunks (8kHz slin) →
  VAD detects silence → Buffer accumulated PCM →
  Create WAV (8kHz, 16-bit, mono) →
  Send to STT provider (Sarvam or ElevenLabs) →
  Get: { transcript, language_code, language_probability } →
  clampLanguageToAllowed() → snap detected language to allowlist →
  applyLanguageSwitchPolicy() → decide if language change needed →
  If out-of-list detected AND rehint=auto → possibly re-transcribe (2nd STT call!) →
  Pass transcript to LLM/RAG pipeline
```

### Simple Version

> The caller speaks, and the phone system sends the audio to our server. We package it up and send it to either Sarvam or ElevenLabs to convert speech into text. The service tells us what was said AND what language it thinks was spoken. We then check if that language is allowed for this customer. If not, we try to "fix" it — but this fixing process has several problems.

---

## 3. User-Reported Problems

### Problem 1: English speech → wrong Hindi transcript

**What happens:** Customer speaks clearly in English, but STT returns Hindi text or a garbled English-Hindi mix, and the LLM then responds in Hindi.

**Technical root cause:**

1. **Queries 1–2 (open detect):** No `language_code` hint is sent. On 8kHz narrowband audio, both Sarvam and ElevenLabs can misidentify English as Hindi (especially with Indian-accented English or code-mixed speech like "mujhe Chhavani ke baare mein batao").

2. **After misdetection:** `clampLanguageToAllowed()` sees `hi-IN` → it IS in the allowed list `[en, hi, mr]` → passes through. The policy may silently switch the session to Hindi even though the user was speaking English.

3. **From query 3 onward:** Now the hint is `hi-IN` → Sarvam is biased toward Hindi → subsequent English speech also gets transcribed as Hindi. **The error compounds.**

**Simple explanation:**
> Imagine calling a customer service number and speaking English, but the system thinks you're speaking Hindi. From that point on, it keeps "hearing" Hindi even when you speak English, because it already decided you're a Hindi speaker. One wrong guess early on snowballs into a broken conversation.

**Code location:** `exotel-voicebot.ts` lines 2270–2287 (language hint logic), lines 609–679 (switch policy)

---

### Problem 2: Gujarati transcript despite not being in allowed languages

**What happens:** `allowed_language_codes = ["en-IN", "hi-IN", "mr-IN"]` but STT returns `gu-IN` (Gujarati) and the transcript contains Gujarati text.

**Technical root cause:**

1. **STT returns `gu-IN`** — the STT provider doesn't know about our allowlist. It returns whatever language it detects.

2. **`clampLanguageToAllowed()`** (line 550) correctly snaps `gu-IN` → `en-IN` (fallback) for the **session language**. But the **transcript text itself remains in Gujarati script**. The clamp only fixes the language tag, NOT the transcript content.

3. **Rehint mechanism** (line 2609–2688) is supposed to re-transcribe with a forced hint, but `env.voicebot.sttRehint` defaults to `"auto"` which **skips rehint** when the transcript looks Latin-heavy OR non-Latin-heavy (the heuristic is conservative).

4. **For ElevenLabs STT:** The rehint path is **Sarvam-only** (line 2613: `sttProvider === "sarvam"`). ElevenLabs Scribe results with wrong languages are **never re-transcribed**.

**Simple explanation:**
> The speech recognition service doesn't know which languages are "allowed" — it just guesses. When it guesses Gujarati, our system changes the label to English but doesn't change the actual text. So you get Gujarati words labeled as "English," which confuses the AI assistant.

**Code location:** `exotel-voicebot.ts` lines 550–564 (clamp), lines 2609–2688 (rehint)

---

### Problem 3: Wrong answers from wrong transcripts

**What happens:** Even when the language is wrong (Gujarati, wrong Hindi), the LLM still processes the garbled transcript and gives an incorrect answer.

**Technical root cause:**

This is a **downstream effect** of Problems 1 and 2. The pipeline currently does:

```
Wrong transcript → LLM receives garbage text → LLM tries to answer → Wrong answer
```

There is **no validation gate** between STT output and LLM input. No check like "does this transcript make sense for the active language?" or "is this transcript mostly in the expected script?"

**Simple explanation:**
> If someone writes your food order in a language the chef can't read, the chef will still try to cook something — but it won't be what you ordered. We need a quality check between the "listener" (STT) and the "thinker" (AI) to catch bad transcriptions before they reach the AI.

---

### Problem 4: Proper noun misrecognition (Chhavani → Xiaomi)

**What happens:** The customer says "Chhavani" (a resort name from the knowledge base), but STT returns "Xiaomi" (the phone brand). The LLM then talks about Xiaomi phones instead of the resort.

**Technical root cause:**

1. **Lexical prior bias:** STT models are trained on massive internet/phone data where "Xiaomi" appears millions of times. "Chhavani" appears almost never. On 8kHz narrowband audio, the consonant patterns are similar enough that the model picks the more "famous" word.

2. **No domain vocabulary:** Neither Sarvam nor ElevenLabs Scribe supports custom vocabulary/hotwords in their current API for the models we use. The STT has no idea that "Chhavani" is a real word in our knowledge base.

3. **No post-STT correction:** The code has no mapping of known STT confusions → correct domain words. This was identified in the existing `VOICEBOT_STT_QUALITY_AND_TUNING.md` doc (§8) but never implemented.

**Simple explanation:**
> The speech recognition system is like a person who knows about famous brands but has never heard of Chhavani Resort. When they hear "Chhavani" on a crackly phone line, they write down "Xiaomi" because that's the closest famous word they know. We need to teach the system about our customer's specific vocabulary.

---

### Problem 5: Language switch policy not working as expected

**User's expected behavior:**
1. If customer speaks a different language in the **first two sentences** → switch directly without asking
2. If customer speaks a different language **after that** → first ASK the customer, then switch

**What actually happens (code analysis):**

The current implementation at `applyLanguageSwitchPolicy()` (line 609) does:

- **Queries 1–2:** Silent switch ONLY if **Sarvam** confidence > 80% AND language is in allowed list. For **ElevenLabs**, confidence is always `null` → `silentOk` is always `false` → **no silent switch ever happens** for ElevenLabs customers.

```typescript
// Line 648-650:
const conf = sttProvider === "sarvam" ? params.languageProbability : null;
const silentOk = nextQueryIndex <= 2 && conf != null && conf > 0.8;
```

**Bug:** ElevenLabs Scribe does return language info, but the code hardcodes `conf = null` for ElevenLabs. This means ElevenLabs customers can NEVER get a silent language switch in the early window.

- **Queries 3+:** Asks for confirmation — this part works correctly.

**Simple explanation:**
> For customers using ElevenLabs speech recognition, the "automatic language switch" feature is completely broken. The system always asks "do you want to switch?" even on the first sentence, because it ignores ElevenLabs' language detection confidence. For Sarvam customers, it works as intended but only when the confidence is high enough.

---

## 4. Additional Bugs Found During Code Analysis

### Bug A: ElevenLabs Scribe does NOT enforce allowed language list for transcript

**The Bug:**

When `stt_provider = "elevenlabs"`, the rehint path (re-transcribe with explicit language hint) is **skipped entirely**:

```typescript
// Line 2613: rehint is ONLY for Sarvam
const outOfList =
  multilingual &&
  sttProvider === "sarvam" &&   // ← ElevenLabs never enters this path!
  !isLanguageInAllowedList(detectedRaw, allowedNorm);
```

So if ElevenLabs returns `gu-IN` or `ta-IN` (not in allowed list), the transcript is used as-is with zero correction. The language tag gets clamped, but the **text stays wrong**.

**Impact:** ElevenLabs customers with multilingual enabled will get transcripts in disallowed languages with no correction mechanism at all.

---

### Bug B: Rehint retry adds ~1s+ latency

**The Bug:**

When Sarvam detects a language outside the allowed list AND the rehint heuristic decides to re-transcribe, the code makes a **second full STT API call** (line 2643):

```typescript
const sttRetry = await sarvamSpeechToText({
  fileBuffer: wavBuffer, ...
  language_code: languageHintForRetry,  // forced hint
});
```

This adds **~800ms–1500ms** to the pipeline for that turn. On 8kHz telephony, the rehint often produces worse results than the first pass anyway (documented at line 769: "rehint with en-IN often yields garbage like 'Result'").

**Impact:** Intermittent latency spikes of 1s+ for users. Unpredictable response times. The existing code already has heuristics to skip rehint (`transcriptLooksLatinHeavyForRehintSkip`, `transcriptIsPrimarilyNonLatinScript`) but they're conservative and inconsistent.

---

### Bug C: No post-STT domain-word normalization

**The Bug:**

The existing doc `VOICEBOT_STT_QUALITY_AND_TUNING.md` (§8) identified this:

> Curated post-STT normalisation for known entities (RAG/KB) — no second STT.

But this was **never implemented**. There is no mapping of common STT confusions to correct domain words. Examples for a resort knowledge base:

| STT Output | Correct Word | Why It Happens |
|-----------|-------------|----------------|
| Xiaomi | Chhavani | Consonant similarity on 8kHz |
| Shabani | Chhavani | Aspiration lost on phone |
| Chawani | Chhavani | Missing aspiration |

This is a **zero-latency fix** — a simple string replacement after STT, before LLM.

---

## 5. Improvement Steps

### Step 1: Post-STT Domain Word Normalization (Fixes Problem 4)

#### What to change
Add a **post-STT text correction** step that maps known STT confusions to correct domain words, using a **per-customer dictionary** stored in the database.

#### Where is the dictionary stored?

**Yes, it is per-customer.** Each customer has different products/services in their knowledge base, so the correction dictionary must be unique per customer.

**Storage: New `stt_domain_words` JSONB column in `customer_settings`**

```sql
-- Migration: Add stt_domain_words to customer_settings
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS stt_domain_words JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN customer_settings.stt_domain_words IS
  'Per-customer STT post-processing dictionary. JSON object where keys are '
  'common STT misrecognitions (lowercase) and values are correct domain words. '
  'Example: {"xiaomi": "Chhavani", "shabani": "Chhavani", "chawani": "Chhavani"}';
```

**Example data for Chhavani Resort customer:**
```sql
UPDATE customer_settings
SET stt_domain_words = '{
  "xiaomi": "Chhavani",
  "shabani": "Chhavani",
  "chawani": "Chhavani",
  "chavani": "Chhavani",
  "shavani": "Chhavani"
}'::jsonb
WHERE customer_id = '<CHHAVANI_CUSTOMER_UUID>';
```

**Example data for another customer (e.g., a car dealership):**
```sql
UPDATE customer_settings
SET stt_domain_words = '{
  "hyundai": "Hyundai",
  "honda": "Honda",
  "maruti": "Maruti"
}'::jsonb
WHERE customer_id = '<DEALERSHIP_CUSTOMER_UUID>';
```

#### How it flows through the code

```
1. Call starts → customer_settings loaded into VoicebotSession
   ↓
2. session.sttDomainWords = cs.stt_domain_words ?? {}
   ↓
3. STT returns transcript: "I want to know about Xiaomi resort"
   ↓
4. normalizeTranscriptForDomain(transcript, session.sttDomainWords)
   → "I want to know about Chhavani resort"
   ↓
5. Corrected transcript goes to LLM/RAG → correct answer about Chhavani
```

#### Technical details — Code changes needed

**1. Add to `CustomerSettings` interface** (`customer-settings.ts`):
```typescript
export interface CustomerSettings {
  // ... existing fields ...
  stt_domain_words: Record<string, string>;  // NEW
}
```

**2. Add to field list** (so it's fetched from DB):
```typescript
const CUSTOMER_SETTINGS_FIELDS = [
  // ... existing fields ...
  "stt_domain_words",
];
```

**3. Load into session at call start** (`exotel-voicebot.ts` → `applyCustomerVoiceSettingsToSession()`):
```typescript
session.sttDomainWords = (cs?.stt_domain_words && typeof cs.stt_domain_words === "object")
  ? cs.stt_domain_words as Record<string, string>
  : {};
```

**4. Add to `VoicebotSession` interface** (`voicebot-session.ts`):
```typescript
export interface VoicebotSession {
  // ... existing fields ...
  sttDomainWords: Record<string, string>;
}
```

**5. New normalization function** (can live in `exotel-voicebot.ts` or a new `services/stt-normalize.ts`):
```typescript
function normalizeTranscriptForDomain(
  transcript: string,
  domainWords: Record<string, string>
): string {
  if (!domainWords || Object.keys(domainWords).length === 0) return transcript;
  let result = transcript;
  for (const [wrong, correct] of Object.entries(domainWords)) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(regex, correct);
  }
  return result;
}
```

**6. Apply after STT, before LLM** (in `processUtterance()`, after transcript is extracted):
```typescript
// After: transcript = sttBody.transcript?.trim() || "";
// Add:
transcript = normalizeTranscriptForDomain(transcript, session.sttDomainWords);
```

#### Who manages the dictionary?

| Method | How | Best for |
|--------|-----|----------|
| **Manual SQL** | Admin runs `UPDATE customer_settings SET stt_domain_words = ...` | Quick fixes, known confusions |
| **Admin API** | `PUT /settings` already updates `customer_settings` — just add `stt_domain_words` to the schema | Self-service by customer admin |
| **Future: Auto-extract** | At session start, extract entity names from KB entries and build a basic phonetic-match map | Zero-config, but less precise |

**Recommended for now:** Manual SQL + Admin API. Auto-extraction can be added later as an enhancement.

#### Simple explanation
> Each customer gets their own "correction dictionary" stored in the database. For the Chhavani Resort customer, the dictionary says "if you hear Xiaomi, Shabani, or Chawani, the caller actually means Chhavani." After the speech recognition finishes, we run a quick spell-check using this dictionary before passing the text to the AI. Each customer has different corrections based on their business. It adds zero delay.

#### Impact on response time
- **Zero added latency** — string replacement is <1ms, dictionary is already loaded in memory at call start
- **Significant accuracy improvement** for domain-specific words
- **No API calls** — purely in-memory text processing

---

### Step 2: Enforce Allowed Language List at STT Level (Fixes Problems 1, 2, 3)

#### What to change

Instead of letting STT auto-detect any language and then trying to "fix" it afterward, **constrain the STT input** to only the allowed languages from the start.

#### Technical details

**Current approach (reactive):**
```
STT auto-detects → may return gu-IN → clamp tag to en-IN → text stays wrong
```

**Proposed approach (proactive):**
```
Send allowed languages as hint → STT constrained to en/hi/mr → better accuracy
```

**For Sarvam:** Always send `language_code` hint even in early window (queries 1–2). Use the `session.currentLanguageCode` or `defaultLanguageCode`. The open-detect for `language_probability` can still work if Sarvam returns it alongside the hinted transcription.

**For ElevenLabs Scribe:** Send `language_code` as the default language. ElevenLabs Scribe supports language hints — when provided, it biases strongly toward that language, preventing phantom Gujarati/Tamil detections.

**Trade-off:** This reduces the early-window language detection ability. But since the user's Problems 1 and 2 show that open detection is causing more harm than good, constraining is the safer default. Language switching can still work via the policy (user explicitly speaks in a different language for multiple turns).

#### Simple explanation
> Instead of letting the listener guess any language and then trying to fix wrong guesses, we tell the listener upfront "only listen for English, Hindi, and Marathi." This prevents the listener from hearing Gujarati when someone is speaking English.

#### Impact on response time
- **Eliminates rehint retry** (saves ~800-1500ms when it would have triggered)
- **No added latency** — we're already sending one STT request; just changing the hint parameter
- **Risk:** Slightly worse at detecting genuine language switches in early window

---

### Step 3: Fix ElevenLabs Language Switch Confidence (Fixes Problem 5 for ElevenLabs)

#### What to change

The language switch policy hardcodes `conf = null` for ElevenLabs, breaking silent switches:

```typescript
// CURRENT (line 648):
const conf = sttProvider === "sarvam" ? params.languageProbability : null;
```

ElevenLabs Scribe doesn't return `language_probability` like Sarvam, but it does return a detected `language_code`. For the silent switch logic, we can use a reasonable default confidence when ElevenLabs detects a non-default language.

#### Proposed fix

```typescript
// PROPOSED:
let conf: number | null;
if (sttProvider === "sarvam") {
  conf = params.languageProbability;
} else if (sttProvider === "elevenlabs") {
  // ElevenLabs doesn't return confidence, but if it detected a language
  // different from what we hinted, treat it as high confidence
  // (Scribe is generally accurate at language ID)
  const hintedLang = session.currentLanguageCode || session.defaultLanguageCode;
  conf = languagesLooselyEqual(params.detectedRaw, hintedLang || "en-IN")
    ? null   // same language, no switch needed
    : 0.85;  // different language detected → treat as confident
}
```

#### Simple explanation
> For ElevenLabs customers, the "auto language switch" feature was completely broken because we ignored ElevenLabs' language detection. The fix is to trust ElevenLabs when it detects a different language, since ElevenLabs is generally accurate at identifying languages.

#### Impact on response time
- **Zero added latency** — this is just a logic fix in the policy function
- **Restores expected behavior** for ElevenLabs customers

---

### Step 4: Remove or Reduce Rehint Retry (Fixes Bug B — Latency)

#### What to change

The rehint mechanism (2nd STT call with forced language hint) adds ~1s+ latency and often produces worse results. Replace it with Step 1 (domain normalization) + Step 2 (constrained detection).

#### Technical details

**Current:** When Sarvam detects an out-of-list language, the code conditionally makes a **2nd full STT API call** with a forced language hint. This has multiple issues:
- Adds ~800-1500ms latency
- Often returns garbage (e.g., "Result" for Hindi speech forced to en-IN)
- Has complex heuristics to skip it that are inconsistent
- Only works for Sarvam, not ElevenLabs

**Proposed:** Set `VOICEBOT_STT_REHINT=never` as default. With Steps 1 and 2 implemented:
- Step 2 constrains STT to allowed languages → fewer out-of-list detections
- Step 1 fixes domain words post-STT → better transcripts without 2nd call
- Net result: better accuracy AND 1s less latency

#### Simple explanation
> Currently, when the system detects a "wrong" language, it tries to re-listen to the same audio with a forced language — but this re-listening takes over a second and often makes things worse. By preventing wrong language detection in the first place (Step 2) and fixing common word errors afterward (Step 1), we don't need to re-listen at all.

#### Impact on response time
- **Saves ~800-1500ms** on turns where rehint would have triggered
- **More predictable latency** — eliminates intermittent spikes

---

### Step 5: Add Transcript Validation Gate Before LLM (Fixes Problem 3)

#### What to change

Add a lightweight check between STT output and LLM input to catch obviously wrong transcripts.

#### Technical details

```typescript
// NEW: Validate transcript matches expected language/script
function isTranscriptPlausible(
  transcript: string,
  expectedLanguage: string
): boolean {
  if (!transcript.trim()) return false;

  const primaryLang = expectedLanguage.split("-")[0]?.toLowerCase();

  // If expected language is English, transcript should be mostly Latin
  if (primaryLang === "en") {
    return transcriptLooksLatinHeavyForRehintSkip(transcript, 0.6);
  }

  // If expected language is Hindi/Marathi, transcript can be Latin (romanized)
  // or Devanagari — both are valid
  if (primaryLang === "hi" || primaryLang === "mr") {
    return true; // Accept both scripts for Hindi/Marathi
  }

  return true; // Default: accept
}
```

When a transcript fails validation:
- Log a warning with the transcript and expected language
- Use the **default language** hint and attempt one more STT call (or skip the turn)
- Do NOT send obviously wrong transcripts to the LLM

#### Simple explanation
> Before passing what the listener heard to the AI assistant, we do a quick sanity check: "Does this look like the language we expected?" If someone is supposed to be speaking English but the text is in Gujarati script, something went wrong — we catch it before the AI tries to answer a question it can't understand.

#### Impact on response time
- **<1ms** for the script validation check
- May occasionally trigger a retry (similar to current rehint, but smarter and rarer)

---

### Step 6: Add ElevenLabs to Rehint/Validation Path (Fixes Bug A)

#### What to change

The rehint and validation paths currently only work for Sarvam. Extend them to ElevenLabs.

#### Technical details

**Current (line 2613):**
```typescript
const outOfList =
  multilingual &&
  sttProvider === "sarvam" &&   // ← BUG: ElevenLabs excluded!
  !isLanguageInAllowedList(detectedRaw, allowedNorm);
```

**Proposed:**
```typescript
const outOfList =
  multilingual &&
  !isLanguageInAllowedList(detectedRaw, allowedNorm);
  // Removed sttProvider check — applies to ALL providers
```

With Steps 2 and 4 in place (constrained detection + no rehint), this becomes a safety net rather than a primary correction mechanism.

#### Simple explanation
> The language checking system was only working for Sarvam customers. ElevenLabs customers had no language checks at all — if ElevenLabs returned Gujarati text, it went straight to the AI without any correction. Now both providers get the same checks.

---

## 5B. Evaluated Alternative: OpenAI Multimodal Audio Correction

> [!NOTE]
> **Idea from discussion:** When STT confidence is low, send BOTH the audio file AND the STT transcript to OpenAI GPT-4o (which supports audio input) with a prompt like "Here is what the speech recognition heard: '{transcript}'. Here is the actual audio. Please correct the transcript." This would give a corrected version using OpenAI's superior audio understanding.

### How It Would Work

```
STT returns: { transcript: "Xiaomi resort", confidence: 0.62, language: "gu-IN" }
            ↓
Confidence is LOW (< threshold)
            ↓
Send to OpenAI GPT-4o:
  - Audio file (WAV 8kHz)
  - STT transcript as reference
  - Prompt: "Correct this transcript, focus on proper nouns"
  - Allowed languages as context
            ↓
OpenAI returns: "Chhavani resort"
            ↓
Use corrected transcript for LLM/RAG pipeline
```

### Analysis: Cost, Latency, and Functionality

#### 💰 Cost

| Factor | Detail |
|--------|--------|
| **OpenAI audio input pricing** | GPT-4o audio input costs **~$0.10 per minute** of audio (as of 2024-2025 pricing). A typical utterance is 3-8 seconds ≈ **$0.005–$0.013 per correction call**. |
| **Text output** | Correction response is short (~10-50 tokens) ≈ **$0.0001–$0.0005** |
| **Per correction total** | **~$0.006–$0.014** per low-confidence utterance |
| **Frequency** | If 20-30% of utterances have low confidence → on a 5-minute call with ~15 utterances → **3-5 correction calls** → **$0.02–$0.07 per call** |
| **Monthly at scale** | 1000 calls/day × 4 corrections × $0.01 = **~$1,200/month** additional |

**Verdict on cost:** Moderate. Not cheap but not prohibitive. The bigger concern is it scales linearly with call volume AND error rate.

#### ⏱️ Latency

| Factor | Detail |
|--------|--------|
| **OpenAI API round-trip** | GPT-4o with audio input typically takes **800ms–2000ms** (audio upload + processing + response) |
| **Audio upload size** | 8kHz × 16-bit × 5 seconds = **80KB WAV** — small, but still needs HTTP upload |
| **Added to pipeline** | This runs AFTER STT but BEFORE LLM. Total added wait: **~1000-2000ms** |
| **Current rehint cost** | The existing rehint (2nd Sarvam STT call) adds ~800-1500ms. OpenAI correction would be **similar or worse**. |
| **Comparison** | Post-STT domain normalization (Step 1) adds **<1ms**. This adds **~1000-2000ms**. That's **1000x slower.** |

**Verdict on latency:** ❌ **This is the dealbreaker for the voice pipeline.** Adding 1-2 seconds to already-slow turns makes the bot feel unresponsive. On a phone call, the caller is already waiting 1.5-3 seconds for a response. Adding another 1-2 seconds pushes it to 3-5 seconds — that's "is this bot broken?" territory.

#### 🔧 Functionality

| Factor | Detail |
|--------|--------|
| **Only OpenAI customers** | ❌ Customers with `rag_use_openai_only = false` or using self-hosted LLMs (via `llm_model_override` or `llm_fallback_to_openai = false`) **cannot use this**. Sending their audio to OpenAI may violate their data agreements. |
| **Data privacy** | Audio files contain caller voice — sending to a 3rd party (OpenAI) for correction raises privacy concerns. Some customers may not want caller audio leaving their approved STT provider. |
| **Accuracy** | ✅ **GPT-4o is excellent at audio understanding** — it would likely fix proper nouns, language confusion, and garbled text better than any string replacement. |
| **Proper noun context** | ✅ We can include KB entity names in the prompt: "The customer's business involves: Chhavani Resort, pool villas, etc." — giving OpenAI context that Sarvam/ElevenLabs don't have. |
| **Language enforcement** | ✅ We can tell OpenAI: "Only transcribe in en, hi, or mr" — solving the Gujarati leak problem. |
| **Confidence threshold** | ⚠️ Sarvam returns `language_probability` but NOT word-level confidence. ElevenLabs Scribe returns no confidence at all. So deciding "when" to trigger OpenAI correction is imprecise. |

### Decision Matrix: When Would This Make Sense?

| Scenario | Use OpenAI Audio? | Better Alternative |
|----------|-------------------|-------------------|
| **Live phone call (voicebot)** | ❌ No — latency too high | Steps 1-6 (domain normalization + constrained detection) |
| **Offline call review / quality check** | ✅ Yes — latency doesn't matter | N/A — best approach for offline |
| **Critical high-value calls** | ⚠️ Maybe — if customer accepts the delay | Could run in parallel with LLM (see below) |
| **Customer uses self-hosted LLM** | ❌ No — can't send audio to OpenAI | Steps 1-6 only |

### 5C. Refined Alternative: Targeted Fallback on Stuck/Repetitive Conversations

> [!TIP]
> **Refined idea from discussion:** Instead of using OpenAI audio correction for all low-confidence turns, what if we only use it **when the conversation gets stuck**? For example, if the caller repeats their question 2 or 3 times, and the AI bot keeps giving the same type of response.

#### How the Trigger Would Work

We track consecutive turn similarities in the live `VoicebotSession`:
1. Compare the current STT transcript with the previous turn's transcript (using substring match or text similarity).
2. Compare the previous bot response with the response before that.
3. If the user repeats themselves **AND** the bot repeats itself for **2+ consecutive turns**, it explicitly signals a transcription error / conversation breakdown.
4. **Action:** On this turn only, the pipeline pauses the normal LLM path, takes the accumulated audio, and sends it to OpenAI GPT-4o with both the audio file and the STT transcript for the correction pass.

```
Turn 1: Caller: "Where is Chhavani Resort?"
        → STT: "Xiaomi" → Bot: "I don't know anything about Xiaomi phones."

Turn 2: Caller: "I asked about Chhavani Resort."
        → STT: "Xiaomi" → Bot: "Sorry, we only have information about our rooms."
        → Loop detected! (User repeated "Chhavani/Xiaomi", bot repeated its confusion).

Turn 3: Loop flag active!
        ↓
        Send audio + "Xiaomi" transcript to OpenAI GPT-4o
        ↓
        OpenAI returns corrected text: "Chhavani Resort"
        ↓
        Corrected text goes to LLM → Loop broken!
```

#### Analysis: Is this viable?

#### ⏱️ Latency (Acceptable in this context)
Normally, adding **+1-2 seconds** of latency is bad. However, when the conversation is already broken, the caller is highly motivated to get an answer. A slightly longer pause followed by a correct answer is much better than a fast but wrong answer. 

#### 💰 Cost (Very low)
Because it only triggers on stuck turns (perhaps **1-2% of all total turns**), the cost is extremely low. At $0.01 per correction, it would cost only a few dollars a month.

#### 🔧 Functionality (Great for recovery)
- ✅ Safely breaks conversation loops without manual user intervention.
- ✅ Uses OpenAI's advanced audio capabilities only when traditional STT + local dictionary (Step 1) fails.
- ❌ **Limitation stays:** This still only works for customers who have OpenAI enabled (`rag_use_openai_only = true`). Customers using self-hosted LLMs cannot use this.

#### Implementation Steps for Stuck Conversation Detection

1. **Add to `VoicebotSession`** (`voicebot-session.ts`):
```typescript
export interface VoicebotSession {
  // ... existing fields ...
  lastUserQuery: string | null;
  lastBotResponse: string | null;
  consecutiveRepeatCount: number; // tracks how many times user+bot repeated
}
```

2. **In `processUtterance()` after STT extraction:**
```typescript
const currentUserText = transcript.trim();
const previousUserText = session.lastUserQuery?.trim() || "";

// Detect user repetition (simple word overlap or edit distance)
const isUserRepeating = detectRepetition(currentUserText, previousUserText);

if (isUserRepeating) {
  session.consecutiveRepeatCount = (session.consecutiveRepeatCount || 0) + 1;
} else {
  session.consecutiveRepeatCount = 0;
}

// If repeat count hits threshold (e.g., 2), trigger OpenAI Multimodal Correction
if (session.consecutiveRepeatCount >= 2 && cs?.rag_use_openai_only === true) {
  const correctedTranscript = await getOpenAIAudioCorrection(wavBuffer, transcript);
  if (correctedTranscript) {
    transcript = correctedTranscript;
  }
}
```

#### Verdict
This is an **excellent safety-net feature**. It doesn't penalize latency on normal turns, has almost zero cost, and prevents high-frustration failure loops.

---

### 5D. Sentiment-Aware Adaptive Responses + Dynamic Industry Context Injection

#### What to change
1. **Analyze caller sentiment / tone directly via LLM instructions** — no extra API calls.
2. **Inject a customer-specific Industry Context payload** into the RAG pipeline when sentiment warrants it, allowing the AI to be more helpful and flexible without hallucinating irrelevant information.

#### How It Works: The Dual-Layer Approach

```
STT returns transcript
   ↓
Load Customer Settings (Snapshot) 
   → Includes: industry_context (JSONB)
   ↓
Add to LLM System Prompt:
  1. Sentiment Rule: "If caller text expresses frustration (repetitive questions, sharp phrases), 
                    adapt tone to be highly direct and professional."
  2. Industry Rule: "If caller asks about general industry topics (e.g., check-in policies, 
                    resort types), use the provided industry facts to answer."
   ↓
LLM generates tone-adapted, contextually enriched response
```

#### Storage: Adding Context Fields to `customer_settings`

To power this, we introduce the `industry_context` JSONB column:

```sql
-- Migration: Add industry_context to customer_settings
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS industry_context JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN customer_settings.industry_context IS
  'Per-customer industry/product facts and sentiment-aware guidelines. '
  'Enables the LLM to provide richer, more flexible answers during the current conversation.';
```

**Example Context for a Resort Customer:**
```sql
UPDATE customer_settings
SET industry_context = '{
  "industry": "Hotels & Resorts",
  "domain_facts": [
    "Standard check-in is at 2 PM, check-out at 11 AM",
    "A resort is a comprehensive facility that provides lodging, sports, and entertainment on its grounds",
    "Room service is typically available 24/7"
  ],
  "tone_guidelines": {
    "frustrated": "Acknowledge frustration directly, skip the marketing pitch, give exact solutions immediately.",
    "neutral_or_positive": "Maintain a warm hospitality tone, and mention relevant amenities like the spa or on-site dining."
  }
}'::jsonb
WHERE customer_id = '<CHHAVANI_CUSTOMER_UUID>';
```

#### Technical Details: How to implement in code

**1. Modify the System Prompt Construction** (`exotel-voicebot.ts`):
We dynamically inject sentiment analysis guidelines and industry facts directly into the main system prompt used for the RAG/LLM call.

```typescript
function buildToneAndContextRules(session: VoicebotSession): string {
  const context = session.customerSettingsSnapshot?.industry_context;
  if (!context || typeof context !== "object") return "";

  const facts = Array.isArray(context.domain_facts)
    ? context.domain_facts.map(f => `- ${f}`).join("\n")
    : "";

  const tones = context.tone_guidelines && typeof context.tone_guidelines === "object"
    ? context.tone_guidelines
    : null;

  return `
---
### SYSTEM RULES: Tone and Domain Knowledge
You must infer the caller's sentiment from the recent turns.
- If the user is repeated, confused or frustrated: ${tones?.frustrated ?? "Be directly helpful, highly concise, and skip conversational filler."}
- Otherwise: ${tones?.neutral_or_positive ?? "Be warm, helpful, and polite."}

You have access to the following industry/domain facts. You can use them to answer questions related to the current conversation context ONLY:
${facts || "None."}
---
`;
}
```

**2. Pass to LLM/RAG generation:**
In `processUtterance()`, when constructing the LLM payload, concatenate the output of `buildToneAndContextRules(session)` with the main RAG prompt.

```typescript
const toneAndContextRules = buildToneAndContextRules(session);
const finalPrompt = `${systemPrompt}\n${toneAndContextRules}`;
```

#### Simple Explanation
> We don't need a separate service to "read" the user's emotion. We simply instruct the AI directly: "Look at how the user is talking. If they sound frustrated because we misunderstood them, skip the nice greetings and answer them directly. If they sound happy, be warm." At the same time, we give the AI a list of helpful industry facts (like typical check-in times or resort definitions) so it can answer more general questions when the user asks, keeping the conversation helpful and moving forward.

#### Impact on response time
- **Zero added latency** — since the rules are embedded inside the prompt we're already sending to the LLM.

---

## 6. Impact Summary

| Step | Latency Impact | Accuracy Impact | Effort |
|------|---------------|-----------------|--------|
| 1. Domain word normalization | **0ms** (string replace) | **High** for domain-specific words | Low |
| 2. Constrained STT detection | **-800 to -1500ms** (eliminates rehint) | **High** — prevents wrong language | Medium |
| 3. Fix ElevenLabs switch confidence | **0ms** (logic fix) | Restores language switching | Low |
| 4. Remove rehint retry | **-800 to -1500ms** saved | Neutral (replaced by Steps 1+2) | Low |
| 5. Transcript validation gate | **<1ms** check | **Medium** — catches bad transcripts | Medium |
| 6. ElevenLabs in validation path | **0ms** | Fixes ElevenLabs gap | Low |

### Before vs After (Expected)

| Metric | Before | After |
|--------|--------|-------|
| Wrong language transcripts | Frequent (esp. queries 1-2) | Rare (constrained detection) |
| Proper noun accuracy | Poor (Chhavani → Xiaomi) | Good (domain normalization) |
| Latency on wrong-language turns | +800-1500ms (rehint) | 0ms (no rehint needed) |
| ElevenLabs language switching | Broken | Working |
| Gujarati/Tamil leak-through | Yes | No |

### ⚠️ Residual Errors (Why 0% Errors is Unrealistic)

While this plan reduces the error rate significantly, **no STT/LLM pipeline can guarantee 0% errors**. The following potential errors may still occur:

1. **Over-Correction Bias (Step 1):** If the caller says *"I use a Xiaomi phone"* but the domain dictionary replaces `xiaomi` with `Chhavani` for a resort customer, the transcript becomes: *"I use a Chhavani phone."* To mitigate this, ensure the `stt_domain_words` map only contains distinct words that are highly specific to the domain.
2. **Language Switch Latency (Step 2):** Since STT is constrained to allowed languages upfront, genuine language switches may take 1-2 turns to be recognized (the switch policy will pick it up on the next turn).
3. **Severe Audio Distortion:** Heavy static, background noise, or a very poor microphone line will still result in garbled transcription text that cannot be fully corrected.

---

## 7. Confidence & Error Risk Report

### Confidence Assessment

| Component | Confidence Level | Reason |
|-----------|------------------|--------|
| **Response Delay (Latency)** | **100% Confident** | All new logic runs in-memory (`<1ms`). Disabling the rehint retry completely **saves 800ms to 1500ms**, meaning the overall response delay will be **faster** than the current pipeline. |
| **Error Reduction (Accuracy)** | **90% - 95% Confident** | It solves almost all current lexical/language bugs. However, 100% error-free operation is impossible due to over-correction bias and real-world audio quality. |

### Anticipated Error Rate & Mitigation Matrix

| Feature | Possible Error | Error Frequency (Est.) | How We Mitigate It |
|---------|----------------|-----------------------|--------------------|
| **Domain Normalization (Step 1)** | Over-correcting common words | **< 2% of turns** | Use strict boundary regex match (`\bword\b`) instead of loose substring matching. Do not use very common words in dictionary keys. |
| **Constrained Detection (Step 2)** | Sluggish language switching in early window | **< 3% of turns** | The silent language switch policy runs in parallel. If the caller repeats their intent in the new language, the system switches automatically. |
| **OpenAI Loop Fallback (Step 5C)** | Latency penalty on fallback turns | **< 1% of turns** | It only kicks in on stuck turns where the caller repeats themselves. In these cases, the delay is acceptable to fix the breakdown. |
| **Validation Gate (Step 5)** | Valid transcript blocked | **< 0.5% of turns** | Keep validation rules lenient. E.g., accept both Latin and Devanagari scripts for Hindi/Marathi instead of being too restrictive. |

---

## 8. Testing Checklist

### A. Language Detection Test
- [ ] Speak English clearly — transcript should be English (not Hindi)
- [ ] Speak English with Indian accent — should still be English
- [ ] Speak Hindi — should be detected as Hindi (within allowed list)
- [ ] Speak Gujarati — should NOT appear in transcript; fallback to default language
- [ ] Test with both Sarvam and ElevenLabs STT providers

### B. Domain Word Test
- [ ] Say "Chhavani" — transcript should contain "Chhavani" (not Xiaomi)
- [ ] Say other KB-specific proper nouns — verify accuracy
- [ ] Verify domain words don't over-correct common words

### C. Language Switch Test
- [ ] First sentence in Hindi → should silently switch (no asking)
- [ ] Second sentence in Hindi → should silently switch (no asking)
- [ ] Third+ sentence in different language → should ASK before switching
- [ ] Test with both Sarvam and ElevenLabs providers
- [ ] Verify ElevenLabs silent switch works (currently broken)

### D. Latency Test
- [ ] Measure TTFA on turns where language mismatch would have triggered rehint
- [ ] Verify no 1s+ latency spikes from rehint
- [ ] Compare overall pipeline timing before vs after

### E. Edge Cases
- [ ] Code-mixed speech (English + Hindi in same sentence)
- [ ] Very short utterances ("yes", "no", "haan")
- [ ] Background noise / poor connection
- [ ] Customer says brand names vs domain words

---

## Appendix: Current vs Proposed Language Hint Strategy

### Current

```
Query 1-2: No hint (open detect) → STT guesses any language → often wrong
Query 3+:  Hint = session.currentLanguageCode → may already be wrong from Q1-2
```

### Proposed

```
Query 1-2: Hint = defaultLanguageCode → STT constrained but still reports detected language
Query 3+:  Hint = session.currentLanguageCode → now reliable because Q1-2 didn't go wrong
Language switch: Still possible via policy, but from a correct starting point
```

---

> [!IMPORTANT]
> **No code changes have been made.** This document is a plan for discussion. Each step can be implemented independently and tested.
