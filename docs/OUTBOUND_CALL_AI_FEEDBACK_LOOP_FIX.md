# Outbound Call "AI Talking to AI" Issue - Analysis & Fix Plan

**Date:** 2026-07-03  
**Issue Type:** Critical Bug - Outbound Campaign Call Flow  
**Priority:** High  

---

## 1. Executive Summary

During outbound campaign calls, after the campaign script is played to the customer, the system enters an infinite feedback loop where **the AI is talking to itself** instead of waiting for and responding to the human caller. This document analyzes the root cause and proposes a fix that will not disturb the existing incoming call flow.

---

## 2. Problem Description

### 2.1 Expected Behavior

1. Outbound call is initiated via Exotel "Connect Two Numbers" API
2. System waits for customer to pick up and speak (speech detection)
3. Campaign script is played via TTS to the customer
4. **After script playback completes**, system transitions to normal conversational flow
5. AI waits for customer's questions/responses
6. AI answers customer questions using RAG pipeline (same as incoming calls)

### 2.2 Actual (Broken) Behavior

1. Outbound call is initiated correctly
2. Customer picks up and speaks - detected correctly
3. Campaign script is played via TTS - works correctly
4. **PROBLEM STARTS HERE**: Instead of waiting for human input:
   - The TTS audio output is captured by STT on a parallel WebSocket stream
   - This creates a feedback loop where AI responds to its own speech
   - The AI's response is again captured and processed
   - Infinite loop: AI → TTS → captured by STT → AI → TTS → ...

---

## 3. Log Analysis Evidence

### 3.1 Multiple Concurrent WebSocket Streams

The logs show **multiple WebSocket streams** sharing the same `exotel_call_session_id`:

| Request ID | Stream SID | Call SID | Session ID |
|------------|------------|----------|------------|
| `req-u` | `bbc9979d...` | `7a968885c545...` | `5dfa3e13-f127-4b0a-8577-e9a787528adf` |
| `req-v` | `0dd9b52b...` | `9302e4d3d556...` | `5dfa3e13-f127-4b0a-8577-e9a787528adf` |
| `req-z` | `eef0f973...` | `81686b827d9b...` | `5dfa3e13-f127-4b0a-8577-e9a787528adf` |
| `req-11` | `b9024dbd...` | `5b60d7182f94...` | `10538734-b271-4784-93bb-c8e112282161` |

**Key Finding:** Multiple streams with the SAME `exotel_call_session_id` indicates **dual-leg audio streaming** from Exotel's Connect Two Numbers API.

### 3.2 Evidence of Feedback Loop

#### Step 1: Campaign Script Triggered
```json
{
  "time": "2026-07-03 18:17:18",
  "transcript": "बोल रही हूँ।",
  "msg": "voicebot: customer speech confirmed via STT — playing campaign script"
}
```

#### Step 2: Campaign Script TTS Sent
```json
{
  "time": "2026-07-03 18:17:18",
  "chars": 473,
  "msg": "voicebot: synthesizing realtime TTS for campaign script"
}
```

#### Step 3: AI's TTS Output Captured as STT Input (THE BUG)

**Stream `req-v` captures AI's script:**
```json
{
  "time": "2026-07-03 18:17:41",
  "reqId": "req-v",
  "transcript": "छावनी रिसॉर्ट को चुनने के लिए आपका धन्यवाद। हम आपके स्वागत के लिए उत्सुक हैं। आपका दिन शुभ हो। धन्यवाद।",
  "msg": "voicebot STT result"
}
```

This is the **campaign script itself** being picked up by STT!

#### Step 4: AI Responds to Its Own Script
```json
{
  "time": "2026-07-03 18:17:42",
  "raw_reply": "धन्यवाद! क्या मैं आपकी किसी और चीज़ में मदद कर सकती हूँ?",
  "msg": "[rag:openai_chat_stream_lang_detect_response]"
}
```

#### Step 5: Another Stream Captures That Response

**Stream `req-z` captures the AI's response:**
```json
{
  "time": "2026-07-03 18:17:47",
  "reqId": "req-z",
  "transcript": "धन्यवाद, क्या मैं आपकी किसी और चीज़ में मदद कर सकती हूँ?",
  "msg": "voicebot STT result"
}
```

#### Step 6: Loop Continues

The pattern repeats with each stream capturing the other's audio:

| Time | Stream | What was captured (STT) |
|------|--------|-------------------------|
| 18:17:41 | req-v | Campaign script (AI's TTS) |
| 18:17:43 | req-v | "धन्यवाद! क्या मैं आपकी किसी और चीज़ में..." |
| 18:17:47 | req-z | Same AI response echoed |
| 18:17:56 | req-v | "आपका धन्यवाद, क्या आप छावनी रिसॉर्ट में..." |
| 18:18:03 | req-z | "क्या आप विशेष गतिविधियों या पैकेज के बारे में..." |
| ... | ... | Loop continues until call ends |

---

## 4. Root Cause Analysis

### 4.1 Exotel Dual-Leg Architecture

When using Exotel's "Connect Two Numbers" API with WebSocket streaming:

```
┌─────────────────────────────────────────────────────────────┐
│                    EXOTEL BRIDGE                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   LEG 1 (System/Agent)          LEG 2 (Customer)           │
│   ┌─────────────────┐           ┌─────────────────┐        │
│   │ WebSocket #1    │◄─────────►│ WebSocket #2    │        │
│   │ (stream_sid A)  │   Audio   │ (stream_sid B)  │        │
│   └────────┬────────┘   Bridge  └────────┬────────┘        │
│            │                              │                 │
└────────────┼──────────────────────────────┼─────────────────┘
             │                              │
             ▼                              ▼
    ┌────────────────┐            ┌────────────────┐
    │ Convixx Server │            │ Convixx Server │
    │ (processes as  │            │ (processes as  │
    │  separate call)│            │  separate call)│
    └────────────────┘            └────────────────┘
```

**Problem:** Both legs send audio to the Convixx voicebot handler independently. The system:
1. Sends TTS to Leg 1 (to be played to customer)
2. Leg 2 picks up that audio and sends it back to the server
3. Server processes it as "customer speech"
4. Generates a response and sends TTS
5. The other leg picks it up... and the loop continues

### 4.2 Missing Safeguards

The current implementation lacks:

1. **Leg Identification**: No mechanism to distinguish which WebSocket stream is Leg 1 (system) vs Leg 2 (customer)
2. **Echo Detection**: No check to identify if incoming STT matches recently-sent TTS
3. **Mode Awareness**: After script playback, both streams continue processing normally
4. **Audio Isolation**: No suppression of audio during TTS playback on the opposite leg

---

## 5. Impact Assessment

### 5.1 Current Impact

- **User Experience**: Customers hear AI talking to itself, creating confusion
- **Cost**: Wasted LLM, TTS, and STT API calls in the feedback loop
- **Call Duration**: Calls run until timeout or manual hangup
- **Data Quality**: Call transcripts contain AI-to-AI conversation, not customer interaction

### 5.2 What Still Works

- **Incoming calls**: Not affected (single WebSocket stream per call)
- **Outbound call initiation**: Works correctly
- **Campaign script playback**: Works correctly
- **Speech detection before script**: Works correctly

---

## 6. Proposed Fix Strategy

### 6.1 Guiding Principles

1. **Do NOT modify incoming call flow** - all changes must be conditional on outbound campaign mode
2. **Minimal changes** - surgical fixes to avoid regression
3. **Backward compatible** - existing campaign configurations must work

### 6.2 Fix Components

#### Component 1: Leg Identification

**Goal:** Identify which WebSocket stream corresponds to Leg 1 (system) vs Leg 2 (customer).

**Approach:**
- Use Exotel's `custom_parameters` or `leg_sid` to identify the leg
- Store leg type in session state: `session.legType = 'leg1_system' | 'leg2_customer'`
- Only process STT input from `leg2_customer`

**Implementation Location:** `exotel-voicebot.ts` → `start` event handler

```typescript
// Pseudocode - NOT actual implementation
if (session.mode === 'outbound_campaign') {
  // Check custom_parameters or metadata from Exotel
  if (customParams.leg === '1' || isSystemLeg(startPayload)) {
    session.legType = 'leg1_system';
    session.suppressSTT = true; // Don't process STT from system leg
  } else {
    session.legType = 'leg2_customer';
    session.suppressSTT = false; // Process STT from customer leg
  }
}
```

#### Component 2: Post-Script Mode Transition

**Goal:** After campaign script finishes playing, transition to "listening for customer" mode.

**Approach:**
- Track when script TTS playback completes (via `mark` event)
- Set `session.scriptPlaybackComplete = true`
- Clear any buffered audio from during playback
- Enter "listening mode" for genuine customer input

**Implementation Location:** `exotel-voicebot.ts` → `mark` event handler

```typescript
// Pseudocode - NOT actual implementation
if (mark.name === 'campaign_script_complete') {
  session.scriptPlaybackComplete = true;
  session.awaitingCustomerResponse = true;
  clearInboundAudioBuffer(); // Discard any echo of script
  log.info('Campaign script complete, awaiting customer response');
}
```

#### Component 3: Echo Detection & Suppression

**Goal:** Detect and ignore STT results that match recently-sent TTS content.

**Approach:**
- Keep a rolling buffer of recent TTS text (last 30 seconds)
- Compare incoming STT transcript against recent TTS
- If similarity > 70%, treat as echo and ignore
- Use simple fuzzy matching (Levenshtein or similar)

**Implementation Location:** `exotel-voicebot.ts` → STT result handler

```typescript
// Pseudocode - NOT actual implementation
function isEchoOfRecentTTS(transcript: string, session: VoicebotSession): boolean {
  if (!session.mode === 'outbound_campaign') return false;
  
  for (const recentTTS of session.recentTTSBuffer) {
    const similarity = calculateSimilarity(transcript, recentTTS.text);
    if (similarity > 0.7) {
      log.info('Echo detected, suppressing', { transcript, matchedTTS: recentTTS.text });
      return true;
    }
  }
  return false;
}
```

#### Component 4: Outbound-Specific Audio Buffering

**Goal:** During script playback, buffer but don't process audio.

**Approach:**
- While `session.playingCampaignScript = true`:
  - Continue buffering inbound audio (for barge-in detection)
  - Don't trigger STT processing
  - Don't send to RAG pipeline
- Once script completes:
  - Discard buffered audio (it's echo of script)
  - Start fresh listening for customer

**Implementation Location:** `exotel-voicebot.ts` → `media` event handler

---

## 7. Detailed Implementation Plan

### Phase 1: Leg Identification (Priority: Critical)

**Files to Modify:**
- `apps/api/src/routes/exotel-voicebot.ts`

**Changes:**

1. **Add leg type to session interface:**
```typescript
interface VoicebotSession {
  // ... existing fields
  legType?: 'leg1_system' | 'leg2_customer' | 'inbound';
  suppressSTTProcessing?: boolean;
}
```

2. **Identify leg in `start` event:**
- Parse `custom_parameters` from Exotel start payload
- Check for `leg` parameter or derive from `stream_sid` / `call_sid` patterns
- Set appropriate leg type

3. **Conditionally process STT:**
- If `session.legType === 'leg1_system'`, skip RAG pipeline
- Only fully process audio from customer leg

### Phase 2: Script Playback Tracking (Priority: High)

**Files to Modify:**
- `apps/api/src/routes/exotel-voicebot.ts`

**Changes:**

1. **Add playback state to session:**
```typescript
interface VoicebotSession {
  // ... existing fields
  playingCampaignScript?: boolean;
  scriptPlaybackComplete?: boolean;
  campaignScriptMarkName?: string;
}
```

2. **Set unique mark for campaign script:**
- When sending campaign script TTS, use a distinctive mark name
- Example: `mark_campaign_script_${campaignId}`

3. **Handle mark event for script completion:**
- On receiving the campaign script mark, set `scriptPlaybackComplete = true`
- Clear audio buffers
- Log transition to listening mode

### Phase 3: Echo Detection (Priority: Medium)

**Files to Modify:**
- `apps/api/src/routes/exotel-voicebot.ts`
- New utility: `apps/api/src/utils/echo-detection.ts`

**Changes:**

1. **Create echo detection utility:**
```typescript
// echo-detection.ts
export function isSimilarText(a: string, b: string, threshold = 0.7): boolean {
  // Normalize both strings (lowercase, remove punctuation)
  // Calculate similarity (Levenshtein ratio or similar)
  // Return true if similarity >= threshold
}
```

2. **Add TTS buffer to session:**
```typescript
interface VoicebotSession {
  // ... existing fields
  recentTTSTexts?: Array<{ text: string; timestamp: number }>;
}
```

3. **Buffer TTS text when sending:**
- On every TTS send, add text to `recentTTSTexts` buffer
- Expire entries older than 30 seconds

4. **Check STT against buffer:**
- Before processing STT result, check against `recentTTSTexts`
- If echo detected, log and skip processing

### Phase 4: Testing & Validation

1. **Unit Tests:**
   - Echo detection utility
   - Leg identification logic
   - Mark event handling

2. **Integration Tests:**
   - Outbound campaign call with mock Exotel
   - Verify no feedback loop
   - Verify customer responses are processed

3. **Manual QA:**
   - Real outbound call test
   - Verify script plays once
   - Verify AI waits for customer
   - Verify customer questions are answered

---

## 8. Risk Assessment

### 8.1 Risks of the Fix

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Incoming calls affected | Low | High | All changes conditional on `mode === 'outbound_campaign'` |
| Legitimate customer speech filtered | Medium | Medium | Tune echo similarity threshold; only filter high matches |
| Exotel API changes | Low | Medium | Implement fallback if leg detection fails |
| Performance impact | Low | Low | Echo detection uses simple string comparison |

### 8.2 Rollback Plan

1. Feature flag: `OUTBOUND_ECHO_SUPPRESSION_ENABLED`
2. If issues arise, disable via env var
3. System falls back to current behavior

---

## 9. Success Criteria

1. ✅ After campaign script plays, AI waits silently for customer
2. ✅ When customer speaks, AI responds appropriately via RAG
3. ✅ No feedback loop (AI does not respond to its own TTS)
4. ✅ Incoming calls work exactly as before
5. ✅ Call transcripts show real customer interactions, not AI-to-AI

---

## 10. Timeline Estimate

| Phase | Description | Effort |
|-------|-------------|--------|
| Phase 1 | Leg Identification | ~2-3 hours |
| Phase 2 | Script Playback Tracking | ~2 hours |
| Phase 3 | Echo Detection | ~3-4 hours |
| Phase 4 | Testing & Validation | ~3-4 hours |
| **Total** | | **~10-13 hours** |

---

## 11. Appendix: Key Log Entries Reference

### A1. Campaign Script Trigger
```
"msg":"voicebot: customer speech confirmed via STT — playing campaign script"
```

### A2. TTS Sent to Exotel
```
"voicebotStage":"tts.sent_to_exotel"
"pcm_bytes":490948
```

### A3. Playback Complete Mark
```
"mark":"mark_2"
"msg":"voicebot: playback complete, cleared inbound buffer, ready for caller speech"
```

### A4. Echo Detection Point (Where Fix Applies)
```
"transcript":"छावनी रिसॉर्ट को चुनने के लिए आपका धन्यवाद..."
"msg":"voicebot STT result"
```
**This is where the fix should intercept and detect echo.**

---

## 12. Related Documentation

- `docs/outbound_campaign_process_plan.md` - Original campaign implementation plan
- `docs/EXOTEL_OUTBOUND_CALL_API_SPEC.md` - Exotel API specification
- `docs/EXOTEL_VOICE_INTEGRATION.md` - Overall voice integration docs
- `apps/api/src/routes/exotel-voicebot.ts` - Main implementation file

---

**Document Status:** Ready for Review  
**Next Action:** Await approval to implement Phase 1
