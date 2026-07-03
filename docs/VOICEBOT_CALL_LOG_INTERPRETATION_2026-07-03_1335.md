# Voicebot Call Log Interpretation — 2026-07-03 13:35:57

## Call Summary

| Field | Value |
|-------|-------|
| **Call Start** | 13:35:57 |
| **Call End** | 13:37:02 |
| **Duration** | ~65 seconds |
| **Customer ID** | `ead34d8f-de23-452c-9091-85b2af98ac82` |
| **Stream SID** | `10f7710a841554b17f181800a7051a73` |
| **Call SID** | `1729d029bf093c720b211f8049651a73` |
| **From** | 07900002299 |
| **To** | 02048555864 |
| **Sample Rate** | 8000 Hz |
| **TTS Provider** | Cartesia (sonic-3.5) |
| **STT Provider** | Sarvam (WebSocket streaming) |
| **LLM Provider** | OpenAI (gpt-4o-mini) |
| **Outcome** | Call completed, caller hung up |

---

## Call Flow Timeline

| Time | Event | Details | Status |
|------|-------|---------|--------|
| 13:35:57 | Connection | WebSocket established, `start` event received | ✅ OK |
| 13:35:57 | Session Created | Chat session + call session created | ✅ OK |
| 13:35:58 | Greeting Sent | "Hello! How can I help you today?" (27,874 bytes PCM) | ✅ OK |
| 13:36:00 | Greeting Played | mark_1 received — playback complete | ✅ OK |
| 13:36:06 | Utterance 1 | 88,000 bytes (~5.5s) → STT: "ആ ആ." (Malayalam) | ⚠️ Wrong language |
| 13:36:07 | Response 1 | Language restriction message sent | ✅ Handled |
| 13:36:14 | Playback Done | mark_2 received | ✅ OK |
| 13:36:18 | Utterance 2 | "Am I speaking with Chavani Resort?" | ✅ OK |
| 13:36:26 | Response 2 | "Yes, you're speaking with Chhavani Resort..." | ⚠️ **TTFA: 8176ms** |
| 13:36:29 | Playback Done | mark_3 received | ✅ OK |
| 13:36:38 | Utterance 3 | "Can you tell me what is the types of rooms..." | ✅ OK |
| 13:36:41 | Response 3 | Room types listed | ⚠️ **TTFA: 3090ms** |
| 13:36:50 | Playback Done | mark_4 received | ✅ OK |
| 13:36:53 | Utterance 4 | "Which" (incomplete utterance) | ✅ OK |
| 13:36:55 | Response 4 | "Could you please clarify..." | ⚠️ **TTFA: 2084ms** |
| 13:37:02 | Call End | Caller hung up | ✅ Normal |

---

## Issues Identified

### 🔴 CRITICAL: Extremely High TTFA on Utterance 2

| Metric | Value | Target | Status |
|--------|-------|--------|--------|
| **TTFA (Time To First Audio)** | **8176ms** | 2000ms | ❌ **4x over target** |
| STT Time | 1418ms | — | ✅ OK |
| **Ask Pipeline (LLM) Time** | **7229ms** | <1000ms | ❌ **VERY SLOW** |

**Root Cause:** OpenAI API latency spike. The LLM call took **7.2 seconds** for a simple response.

**Evidence from logs:**
```
13:36:19 - pipeline.rag.llm_request
13:36:26 - openai_chat_stream_response (7 seconds later!)
```

**Impact:** Caller waited 8+ seconds in silence before hearing "Yes, you're speaking with Chhavani Resort."

---

### 🟠 WARNING: Consistently Missing TTFA Target

| Utterance | TTFA | Target | Over By |
|-----------|------|--------|---------|
| Greeting | ~1000ms | 2000ms | ✅ Met |
| Utterance 1 (disallowed lang) | 1068ms | 2000ms | ✅ Met |
| **Utterance 2** | **8176ms** | 2000ms | ❌ +6176ms |
| **Utterance 3** | **3090ms** | 2000ms | ❌ +1090ms |
| **Utterance 4** | **2084ms** | 2000ms | ❌ +84ms |

**Pattern:** The first valid customer utterance had catastrophic latency, then improved gradually.

---

### 🟠 WARNING: Missing `connected` Event

```json
"receivedConnectedEvent": false,
"receivedStartEvent": true
```

Exotel sent `start` without first sending `connected`. This is unusual but the call still worked. Your new diagnostic logging caught this.

**Impact:** None (call proceeded normally), but indicates potential Exotel protocol inconsistency.

---

### 🟡 NOTICE: First Utterance Detected as Malayalam

```json
"raw_transcript": "ആ ആ.",
"detected_language": "ml-IN",
"language_probability": 1
```

The first 5.5 seconds of caller audio was transcribed as Malayalam characters "ആ ആ." (which means "ah ah" — likely just noise or hesitation sounds).

**Handling:** System correctly detected disallowed language (`ml-IN` not in `[en-IN, hi-IN, mr-IN]`) and responded with the language restriction message.

**Possible causes:**
1. Background noise at call start
2. Caller hesitating/making non-speech sounds
3. STT auto-detect incorrectly classified filler sounds

---

### 🟡 NOTICE: VAD Timeout During Greeting

```json
"time": "13:35:58",
"voicebotStage": "vad.timeout_triggered",
"buffered_chunks": 5,
"buffered_bytes": 1600
```

VAD triggered with only 1600 bytes while greeting was still playing. This was correctly ignored because `greetingPending` prevents processing during playback.

---

## Pipeline Timing Breakdown

### Utterance 2: "Am I speaking with Chavani Resort?"

| Stage | Duration | Cumulative |
|-------|----------|------------|
| STT (Sarvam WebSocket) | 1418ms | 1418ms |
| Embedding | ~100ms | ~1518ms |
| KB Vector Search | ~50ms | ~1568ms |
| **LLM (OpenAI)** | **~6500ms** | **~8068ms** |
| TTS First Chunk | ~100ms | ~8168ms |
| **Total TTFA** | — | **8176ms** |

**Bottleneck:** OpenAI LLM response time (6.5+ seconds)

### Utterance 3: "Can you tell me what is the types of rooms..."

| Stage | Duration |
|-------|----------|
| STT | 1443ms |
| Ask Pipeline | 2920ms |
| **Total** | 4363ms |

### Utterance 4: "Which"

| Stage | Duration |
|-------|----------|
| STT | 660ms |
| Ask Pipeline | 1816ms |
| **Total** | 2477ms |

---

## What Went Right ✅

1. **Start event received** — Unlike the previous failed call, this one worked
2. **Greeting played successfully** — Cartesia TTS working, cached for next call
3. **Language detection working** — Malayalam correctly identified and rejected
4. **STT quality good** — "Am I speaking with Chavani Resort?" transcribed accurately
5. **RAG responses accurate** — KB search found relevant room type information
6. **Playback marks working** — All mark events received, buffer clearing working
7. **Conversation completed** — 4 turn conversation before caller hung up

---

## What Needs Improvement 🔧

### 1. OpenAI LLM Latency (CRITICAL)

**Problem:** First valid LLM call took 7.2 seconds

**Potential fixes:**
- [ ] Add LLM timeout with fallback to simpler response
- [ ] Consider faster model for first response (e.g., `gpt-4o-mini` is already being used, but check region)
- [ ] Add retry logic for slow responses
- [ ] Monitor OpenAI API status during calls
- [ ] Consider caching common first-turn responses

### 2. Improve First-Utterance Handling

**Problem:** 5.5s of audio classified as Malayalam noise

**Potential fixes:**
- [ ] Add minimum speech confidence threshold before processing
- [ ] Implement audio energy detection to skip near-silence
- [ ] Consider waiting for higher `language_probability` before responding

### 3. Add LLM Latency Alerting

**Recommendation:** Log a warning when LLM takes >3 seconds:
```typescript
if (llmMs > 3000) {
  log.warn({
    llm_ms: llmMs,
    model: "gpt-4o-mini",
    prompt_tokens: usage.prompt_tokens,
  }, "voicebot: LLM latency exceeded 3s threshold");
}
```

---

## Conversation Transcript

| Turn | Speaker | Text |
|------|---------|------|
| 1 | Bot | Hello! How can I help you today? |
| 2 | Caller | *(noise/hesitation — detected as Malayalam)* |
| 3 | Bot | Sorry, I only understand English, Hindi, Marathi. Please speak in one of these languages. |
| 4 | Caller | Am I speaking with Chavani Resort? |
| 5 | Bot | Yes, you're speaking with Chhavani Resort. How can I assist you? |
| 6 | Caller | Can you tell me what is the types of rooms available for this Saturday Sunday? |
| 7 | Bot | We offer Sarja Raja Mini Carts, Rahuti Tents, Royal Rahuti Tents, Royal Carts, and Yashwantrao Wada. Would you like to book a specific type? |
| 8 | Caller | Which |
| 9 | Bot | Could you please clarify which type of room you're interested in? |
| 10 | — | *(Caller hung up)* |

---

## Metrics Summary

| Metric | Value |
|--------|-------|
| Total Messages Received | 3234 |
| Media Messages | 3227 |
| Connection Duration | 64,700ms |
| User Utterances | 4 |
| Bot Responses | 5 (including greeting) |
| Average TTFA (excluding greeting) | ~3358ms |
| Worst TTFA | 8176ms |
| LLM Cost (estimated) | ~$0.00096 |

---

## Action Items

| Priority | Issue | Action |
|----------|-------|--------|
| 🔴 P0 | LLM latency spike (8.2s) | Investigate OpenAI API; add timeout/fallback |
| 🔴 P0 | Sarvam STT wrong language detection | Move language detection to OpenAI LLM (see §Proposed Solution below) |
| 🟠 P1 | Consistently over TTFA target | Optimize pipeline; consider faster LLM tier |
| 🟡 P2 | First utterance noise handling | Add audio energy threshold |
| 🟢 P3 | Missing `connected` event | Monitor; may be Exotel protocol variance |

---

## Proposed Solution: Move Language Detection to OpenAI LLM

> **✅ IMPLEMENTED** — This solution has been implemented in `apps/api/src/routes/exotel-voicebot.ts` and `apps/api/src/services/llm.ts`. See [Implementation Status](#implementation-status) section below.

### Problem Statement

Sarvam STT is unreliable for language detection:
- Detects noise/filler sounds as wrong languages (e.g., "ആ ആ." as Malayalam)
- Language detection errors cascade into wrong TTS language selection
- Current flow depends entirely on `detected_language` from Sarvam response
- When Sarvam gets the language wrong, the entire utterance handling fails

**Example from this call:**
```json
{
  "raw_transcript": "ആ ആ.",
  "detected_language": "ml-IN",      // WRONG - was just noise
  "language_probability": 1          // High confidence but still wrong!
}
```

### Proposed Architecture

**Current Flow (Problematic):**
```
Caller Audio → Sarvam STT → {transcript, detected_language} → Use Sarvam's language → RAG/LLM → TTS
                                     ↑
                              UNRELIABLE
```

**Proposed Flow:**
```
Caller Audio → Sarvam STT → {transcript only} → OpenAI LLM → {answer, detected_language} → Extract language → Update session → TTS
                                                      ↑
                                              MORE RELIABLE
                                    (LLM sees text context, not just audio)
```

### Implementation Design

#### 1. Modified LLM Prompt

Add language detection instruction to the existing system prompt:

```
--- LANGUAGE DETECTION (mandatory) ---
- Analyze the user's transcript and detect the language they are speaking.
- Consider: script used (Latin, Devanagari, etc.), vocabulary, sentence structure.
- If transcript is noise, gibberish, or unclear, default to the session's current language.
- Return your response in a specific JSON structure (see OUTPUT FORMAT).
--- END LANGUAGE DETECTION ---
```

#### 2. Structured JSON Output Format

Modify the LLM to return a fixed JSON structure instead of plain text:

```json
{
  "detected_language": "en-IN",
  "confidence": "high",
  "answer": "Yes, you're speaking with Chhavani Resort. How can I assist you?"
}
```

**Field definitions:**
| Field | Type | Description |
|-------|------|-------------|
| `detected_language` | string | BCP-47 tag: `en-IN`, `hi-IN`, `mr-IN` |
| `confidence` | string | `high`, `medium`, `low`, `noise` |
| `answer` | string | The actual response text to speak via TTS |

#### 3. Language Detection Rules for LLM

Include these rules in the prompt:

```
Language Detection Rules:
1. If transcript uses Devanagari script (हिंदी, मराठी) → Check vocabulary:
   - Hindi-specific words → "hi-IN"
   - Marathi-specific words → "mr-IN"
2. If transcript uses Latin script with English words → "en-IN"
3. If transcript is code-mixed (Hinglish/Marathlish) → Prefer the dominant language
4. If transcript is very short (<3 words) or unclear → Use session's current language
5. If transcript appears to be noise ("ആ ആ", "uhh", "hmm") → confidence: "noise", use session's current language
6. NEVER detect a language not in the allowed list [en-IN, hi-IN, mr-IN]
```

#### 4. Session Language Update Logic

After receiving LLM response, extract and update session:

```
1. Parse JSON response from LLM
2. Extract `detected_language` and `confidence`
3. If confidence is "high" or "medium":
   - Update session.currentLanguageCode = detected_language
   - Use detected_language for TTS
4. If confidence is "low" or "noise":
   - Keep session.currentLanguageCode unchanged
   - Use existing session language for TTS
5. Extract `answer` field for TTS input
```

#### 5. Fallback Handling

If LLM returns invalid JSON or missing fields:
- Log warning with raw LLM response
- Fall back to session's current language
- Use raw LLM response as answer text (strip any JSON artifacts)

### Benefits

| Aspect | Current (Sarvam) | Proposed (OpenAI) |
|--------|------------------|-------------------|
| **Context awareness** | Audio-only | Text + conversation history |
| **Noise handling** | Poor (detects noise as language) | Better (LLM can recognize gibberish) |
| **Code-mixed speech** | Unreliable | Better (understands Hinglish) |
| **Consistency** | Language can flip-flop | Can enforce session continuity |
| **Cost** | Included in STT | Slightly more tokens (~20 extra) |
| **Latency** | Separate step | Same LLM call (no extra round-trip) |

### Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| LLM returns invalid JSON | Fallback parser; use session language |
| Increased token count | ~20 extra tokens per response; negligible cost |
| LLM hallucinates language | Strict allowed list in prompt; validate output |
| Slower response | Already in LLM call; no extra API round-trip |

### Example Scenarios

**Scenario 1: Noise/Filler (Current Issue)**
```
Sarvam STT: "ആ ആ." (detected: ml-IN) ❌
LLM Detection: { "detected_language": "en-IN", "confidence": "noise", "answer": "I'm sorry, I didn't catch that..." } ✅
```

**Scenario 2: Clear English**
```
Sarvam STT: "Am I speaking with Chavani Resort?" (detected: en-IN) ✅
LLM Detection: { "detected_language": "en-IN", "confidence": "high", "answer": "Yes, you're speaking with Chhavani Resort." } ✅
```

**Scenario 3: Hindi Request**
```
Sarvam STT: "कमरे की कीमत क्या है?" (detected: hi-IN) ✅
LLM Detection: { "detected_language": "hi-IN", "confidence": "high", "answer": "कमरे की कीमत 7,000 रुपये प्रति रात है।" } ✅
```

**Scenario 4: Code-Mixed (Hinglish)**
```
Sarvam STT: "Room ka price kya hai?" (detected: en-IN or hi-IN — inconsistent)
LLM Detection: { "detected_language": "hi-IN", "confidence": "medium", "answer": "Room ki price 7,000 rupees per night hai." } ✅
```

### Implementation Steps

1. **Update system prompt** — Add language detection instructions and JSON output format
2. **Modify LLM response parsing** — Parse JSON, extract `answer` and `detected_language`
3. **Add validation** — Ensure `detected_language` is in allowed list
4. **Update session logic** — Set `session.currentLanguageCode` from LLM response
5. **Add fallback handling** — Handle invalid JSON gracefully
6. **Update TTS call** — Use extracted language for TTS
7. **Add logging** — Log detected language, confidence, and any fallbacks
8. **Test scenarios** — Noise, clear speech, code-mixed, language switching

### Configuration Options

Consider adding tenant-level settings:

```typescript
{
  "language_detection_source": "llm",  // "stt" | "llm" | "hybrid"
  "llm_language_confidence_threshold": "medium",  // "high" | "medium" | "low"
  "fallback_language": "en-IN"
}
```

### Monitoring

Track these metrics after implementation:
- Language detection accuracy (manual sampling)
- JSON parse success rate
- Fallback trigger rate
- Language switch frequency per call
- TTFA impact (should be negligible)

---

## Implementation Status

### ✅ Completed (2026-07-03)

The LLM-based language detection solution has been implemented with the following changes:

#### 1. New Functions in `apps/api/src/services/llm.ts`

| Function | Description |
|----------|-------------|
| `getLlmLanguageDetectionPrompt()` | Generates the language detection instruction for the system prompt |
| `parseLlmLanguagePrefix()` | Parses the `[LANG:xx-XX]` prefix from LLM responses |
| `streamChatOpenAIWithLanguageDetection()` | Streaming LLM call with inline language detection |

#### 2. Changes to `apps/api/src/routes/exotel-voicebot.ts`

- Added import for new LLM language detection functions
- Added `useLlmLanguageDetection` flag (enabled when `voicebot_multilingual: true`)
- Modified system prompt to include language detection instructions when enabled
- Updated streaming LLM call to use `streamChatOpenAIWithLanguageDetection()`
- Added callback to update session language based on LLM detection
- Added logging for `pipeline.llm_language_detected` events

#### 3. New Customer Setting

Added `llm_language_detection_enabled` field to:
- `CustomerSettings` interface in `apps/api/src/services/customer-settings.ts`
- `ALL_SETTINGS_FIELDS` array for database persistence
- Zod schema in `apps/api/src/routes/settings.ts`

**Default:** Enabled when `voicebot_multilingual: true` (can be disabled per-tenant via `llm_language_detection_enabled: false`)

#### 4. How It Works

1. **Prompt Injection:** When multilingual is enabled, the system prompt includes a language detection instruction
2. **Response Format:** LLM prefixes its response with `[LANG:xx-XX]` (e.g., `[LANG:hi-IN]`)
3. **Streaming Parse:** First ~50 characters are buffered to extract the language tag
4. **Session Update:** If confidence is high and language is allowed, session is updated
5. **TTS Routing:** Extracted language is used for TTS voice selection

#### 5. Example Flow

```
User speaks: "कमरे की कीमत क्या है?"
STT: "कमरे की कीमत क्या है?" (may detect wrong language)
LLM receives: "कमरे की कीमत क्या है?"
LLM responds: "[LANG:hi-IN]\nकमरे की कीमत 7,000 रुपये प्रति रात है।"
System extracts: detected_language = "hi-IN", confidence = "high"
System updates: session.currentLanguageCode = "hi-IN"
TTS speaks: Hindi response with Hindi voice
```

#### 6. Logging

New log events:
- `pipeline.llm_language_detected` — Logged when LLM detects language
- `llm_detected_language` — Added to `pipeline.rag.llm_response` trace

---

## Related Documentation

- `docs/VOICEBOT_LATENCY_SUB_2S_PLAN.md` — Latency optimization strategies
- `docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md` — WebSocket protocol
- `docs/VOICEBOT_TEST_SCRIPTS.md` — Multi-language test scripts
- `docs/VOICEBOT_UTTERANCE_TIMING_ESTIMATES.md` — Timing breakdown per pipeline stage
- `apps/api/src/routes/exotel-voicebot.ts` — Main voicebot handler
- `apps/api/src/services/llm.ts` — LLM service with language detection
