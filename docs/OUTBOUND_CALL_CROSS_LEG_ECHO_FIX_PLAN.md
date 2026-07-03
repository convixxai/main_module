# Outbound Call Cross-Leg Echo Detection Fix Plan

**Date:** 2026-07-03  
**Issue Type:** Critical Bug - AI Talking to AI (Persisting After Initial Fix)  
**Priority:** P0 - Blocking Production Use  
**Document Status:** Planning Phase - DO NOT IMPLEMENT UNTIL APPROVED

---

## 1. Executive Summary

Despite implementing the atomic database lock for campaign script playback (which successfully prevents **duplicate script playback**), the "AI talking to AI" feedback loop **persists**. This document provides deep analysis of the new logs and proposes multiple fix strategies with trade-offs analysis.

---

## 2. Confirmation: What the Previous Fix Solved

The atomic lock mechanism implemented in Section 13 of the original document is working correctly:

| Stream | Action | Log Evidence |
|--------|--------|--------------|
| `req-2` (779346f9...) | **Won** the lock, plays script | `"voicebot: acquired lock to play campaign script (dual-leg coordination)"` |
| `req-5` (6195e501...) | **Lost** the lock, skips playback | `"voicebot: campaign script already being played by another stream — skipping duplicate playback"` |

✅ **Double voice from duplicate script playback is now prevented.**

---

## 3. New Problem Analysis: Cross-Leg Echo

### 3.1 Problem Statement

Even though `req-5` correctly skips playing the campaign script, it is **still listening to audio** and **transcribing `req-2`'s TTS output as "customer speech"**. This transcribed bot speech then gets processed through the RAG pipeline, generating new responses that create a feedback loop.

### 3.2 Detailed Log Timeline

```
Timeline (UTC+5:30)                    req-2 (Leg 1)                    req-5 (Leg 2)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
19:59:45   │ WebSocket connected                    │
           │ Customer says "ठीक है।"                 │
           │ ────────────────────────────────────────┤
19:59:51   │ WINS lock, starts TTS playback         │
           │ "सर मैं छावनी रिसॉर्ट से बोल रही हूँ..."  │
           │                                         │
19:59:52   │                                         │ WebSocket connected
           │ ◄──────── Audio Bridge ─────────────────┤
           │                                         │ Waiting for customer speech
           │                                         │
20:00:08   │ (Still playing TTS ~5 seconds)         │ VAD triggers on req-2's TTS audio!
           │                                         │ Sends to STT ⚠️
           │                                         │
20:00:10   │                                         │ STT returns: "सर मैं छावनी रिसॉर्ट..."
           │                                         │ ─────────────────────────────────────
           │                                         │ THIS IS THE CAMPAIGN SCRIPT!
           │                                         │ ─────────────────────────────────────
           │                                         │ Checks DB lock → lock taken
           │                                         │ ✅ Skips script playback (correct)
           │                                         │ ⚠️ BUT STILL RETURNS EARLY, NO RAG
           │                                         │
20:00:22   │ Script playback complete (mark_1)      │
           │ Enters listening mode                   │
           │                                         │
20:00:23   │                                         │ VAD triggers AGAIN on remainder of audio
           │                                         │ STT: "रिजॉर्ट पोहोचने में किसी भी प्रकार..."
           │                                         │ ─────────────────────────────────────
           │                                         │ THIS IS ALSO THE CAMPAIGN SCRIPT!
           │                                         │ (Second half, not caught by early return)
           │                                         │ ─────────────────────────────────────
           │                                         │ waitingForFirstSpeech already false
           │                                         │ ❌ PROCEEDS TO RAG PIPELINE!
           │                                         │
20:00:27   │                                         │ LLM responds: "आपका स्वागत है! क्या मैं..."
           │                                         │ ◄── Sends TTS ────
           │                                         │
20:00:31   │ Hears req-5's TTS!                     │
           │ STT receives mixed audio               │
           │                                         │
20:00:32   │ STT: "हाँ, मुझे यह जानना था कि..."     │
           │ (Customer speech + req-5's response!)   │
           │ ❌ PROCEEDS TO RAG PIPELINE!            │
           │                                         │
           │          ┌─────────────────────────────┐│
           │          │  FEEDBACK LOOP BEGINS       ││
           │          │  Both streams talking       ││
           │          │  to each other              ││
           │          └─────────────────────────────┘│
```

### 3.3 Root Cause Identification

**The echo detection buffer (`recentTTSTexts`) is SESSION-LOCAL.**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           CURRENT ARCHITECTURE (BROKEN)                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  req-2 Session                           req-5 Session                       │
│  ┌─────────────────────┐                 ┌─────────────────────┐            │
│  │ recentTTSTexts: [   │                 │ recentTTSTexts: [   │            │
│  │   "सर मैं छावनी..." │ ◄── TTS sent    │   (EMPTY!)          │            │
│  │ ]                   │                 │ ]                   │            │
│  └─────────────────────┘                 └─────────────────────┘            │
│           │                                       │                          │
│           │    Audio Bridge (Exotel)              │                          │
│           └───────────────►───────────────────────┤                          │
│                                                   │                          │
│                                                   ▼                          │
│                                          STT receives req-2's TTS            │
│                                          Echo check: recentTTSTexts = []     │
│                                          ❌ No match → processed as speech!  │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The Problem:**
1. `req-2` sends TTS and adds text to its **own** `session.recentTTSTexts` buffer
2. `req-5` receives the audio via Exotel's audio bridge
3. `req-5` transcribes it but checks against its **own** `session.recentTTSTexts` (which is EMPTY)
4. Echo detection fails → processed as legitimate customer speech

---

## 4. Proposed Solutions

### 4.1 Solution A: Shared TTS Buffer in Database (RECOMMENDED)

**Concept:** Store recent TTS texts in the shared `exotel_call_sessions.metadata` JSONB field so both streams can check against the same buffer.

**Implementation:**

```typescript
// When sending TTS (any stream)
async function addToSharedTTSBuffer(callSessionId: string, text: string) {
  await pool.query(`
    UPDATE exotel_call_sessions
    SET metadata = jsonb_set(
      COALESCE(metadata, '{}'::jsonb),
      '{recent_tts_texts}',
      COALESCE(metadata->'recent_tts_texts', '[]'::jsonb) || 
      jsonb_build_object('text', $1::text, 'timestamp', NOW()::text)::jsonb
    )
    WHERE id = $2::uuid
  `, [text, callSessionId]);
}

// When checking for echo (any stream)
async function isEchoOfSharedTTS(callSessionId: string, transcript: string): Promise<boolean> {
  const result = await pool.query(`
    SELECT metadata->'recent_tts_texts' as recent_tts
    FROM exotel_call_sessions
    WHERE id = $1::uuid
  `, [callSessionId]);
  
  const recentTTS = result.rows[0]?.recent_tts || [];
  for (const entry of recentTTS) {
    if (isSimilarText(transcript, entry.text, 0.65)) {
      return true; // Echo detected
    }
  }
  return false;
}
```

**Pros:**
- ✅ Both streams share the same TTS buffer
- ✅ Echo detection works across legs
- ✅ Minimal changes to existing architecture
- ✅ Works with any number of streams

**Cons:**
- ⚠️ Adds DB read on every STT result (latency ~5-10ms)
- ⚠️ Need to handle buffer cleanup (prune old entries)

**Complexity:** Medium  
**Estimated Implementation Time:** 2-3 hours

---

### 4.2 Solution B: Designate Primary Stream + Suppress STT on Secondary

**Concept:** When the script lock is acquired, also mark which stream is the "primary" talker. All other streams should suppress STT processing entirely (not just script playback).

**Implementation:**

```typescript
// In campaign script playback section (existing lock code)
if (lockResult.rows.length > 0) {
  // WON the lock - this stream becomes PRIMARY
  await pool.query(`
    UPDATE exotel_call_sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || 
        jsonb_build_object('primary_stream_sid', $1::text)
    WHERE id = $2::uuid
  `, [session.streamSid, session.callSessionDbId]);
  
  session.isPrimaryStream = true;
} else {
  // LOST the lock - suppress ALL STT processing
  session.isPrimaryStream = false;
  session.suppressSTTProcessing = true; // Complete suppression
}

// In STT processing path
if (session.suppressSTTProcessing) {
  log.info("Secondary stream - suppressing STT processing");
  return; // Skip entirely
}
```

**Pros:**
- ✅ Complete elimination of cross-leg interference
- ✅ Simple boolean check, very fast
- ✅ No similarity calculations needed

**Cons:**
- ⚠️ Secondary stream becomes "deaf" - won't hear customer even after script
- ⚠️ Need to re-enable STT after script completes (timing issues)
- ⚠️ What if customer is on the "secondary" leg?

**Complexity:** Low  
**Estimated Implementation Time:** 1-2 hours

---

### 4.3 Solution C: Time-Based STT Suppression Window

**Concept:** After losing the script lock, suppress STT processing for a calculated duration (script length + buffer time).

**Implementation:**

```typescript
// When losing the lock
if (lockResult.rows.length === 0) {
  // Calculate suppression window based on script length
  const scriptLengthMs = estimateScriptDuration(campaign.script); // ~30s
  const bufferMs = 5000; // 5 second safety margin
  
  session.sttSuppressionUntil = Date.now() + scriptLengthMs + bufferMs;
  
  log.info({
    suppressionMs: scriptLengthMs + bufferMs,
    suppressUntil: new Date(session.sttSuppressionUntil).toISOString()
  }, "Secondary stream - STT suppressed during script playback");
}

// In STT processing path
if (session.sttSuppressionUntil && Date.now() < session.sttSuppressionUntil) {
  log.info("STT suppressed during script window");
  return;
}
```

**Pros:**
- ✅ Automatic re-enablement after script completes
- ✅ No ongoing DB reads
- ✅ Simple timing-based logic

**Cons:**
- ⚠️ Script duration estimation may be inaccurate
- ⚠️ Network delays could cause timing misalignment
- ⚠️ Still susceptible to post-script echo

**Complexity:** Low-Medium  
**Estimated Implementation Time:** 1-2 hours

---

### 4.4 Solution D: Coordinated Mark-Based Re-Enablement

**Concept:** Combine Solution B with mark-based coordination. When the primary stream receives the script completion mark, it broadcasts (via DB) that secondary streams can resume listening.

**Implementation:**

```typescript
// Primary stream: on mark event for script completion
if (mark.name === session.campaignScriptMarkName && session.isPrimaryStream) {
  await pool.query(`
    UPDATE exotel_call_sessions
    SET metadata = COALESCE(metadata, '{}'::jsonb) || 
        jsonb_build_object('script_playback_complete', true, 'script_completed_at', NOW()::text)
    WHERE id = $1::uuid
  `, [session.callSessionDbId]);
  
  log.info("Primary stream: script complete, broadcasting to secondary streams");
}

// Secondary stream: periodic check or on STT result
async function shouldProcessSTT(session: VoicebotSession): Promise<boolean> {
  if (session.isPrimaryStream) return true;
  
  // Check if primary has completed script
  const result = await pool.query(`
    SELECT metadata->>'script_playback_complete' as complete
    FROM exotel_call_sessions
    WHERE id = $1::uuid
  `, [session.callSessionDbId]);
  
  return result.rows[0]?.complete === 'true';
}
```

**Pros:**
- ✅ Precise coordination between streams
- ✅ Secondary stream re-enabled at exactly the right moment
- ✅ No timing estimation needed

**Cons:**
- ⚠️ More DB queries
- ⚠️ Complex state management
- ⚠️ What if primary stream disconnects before completing?

**Complexity:** High  
**Estimated Implementation Time:** 3-4 hours

---

### 4.5 Solution E: Terminate Secondary WebSocket Connection

**Concept:** The most aggressive solution - after losing the script lock, the secondary stream's WebSocket connection is gracefully closed. Only one stream handles the call.

**Implementation:**

```typescript
// When losing the lock
if (lockResult.rows.length === 0) {
  log.info({
    stream_sid: session.streamSid,
    primary_stream: existingLockHolder
  }, "Secondary stream detected - closing WebSocket to prevent interference");
  
  // Send close frame to Exotel
  ws.close(1000, "Dual-leg coordination: secondary stream terminated");
  
  // Clean up session
  return;
}
```

**Pros:**
- ✅ Eliminates ALL cross-leg issues permanently
- ✅ Simple, definitive solution
- ✅ No ongoing state management needed

**Cons:**
- ⚠️ May break Exotel's expected behavior
- ⚠️ Could cause call quality issues if wrong leg is closed
- ⚠️ Loss of audio recording from that leg
- ⚠️ May trigger Exotel errors/reconnects

**Complexity:** Low (but risky)  
**Estimated Implementation Time:** 30 mins (but needs extensive testing)

---

## 5. Solution Comparison Matrix

| Criteria | A: Shared DB Buffer | B: Primary/Secondary | C: Time Window | D: Mark Coordination | E: Close WebSocket |
|----------|---------------------|----------------------|----------------|----------------------|-------------------|
| **Echo Prevention Effectiveness** | High | Very High | Medium | Very High | Complete |
| **Implementation Complexity** | Medium | Low | Low-Medium | High | Low |
| **Runtime Overhead** | Medium (DB reads) | Low | Low | Medium (DB reads) | None |
| **Post-Script Handling** | ✅ Handles | ⚠️ Needs re-enable | ✅ Auto re-enable | ✅ Precise | N/A |
| **Risk of Breaking Things** | Low | Medium | Medium | Medium | High |
| **Incoming Call Impact** | None | None | None | None | None |
| **Testability** | Easy | Easy | Medium | Medium | Risky |

---

## 6. Recommended Approach: Hybrid Solution (A + C)

Based on the analysis, I recommend a **hybrid approach** combining Solutions A and C:

### 6.1 Phase 1: Immediate STT Suppression After Lock Loss (Solution C)

When a stream loses the script lock, immediately suppress STT processing for a calculated window:

```typescript
// Estimated duration = script length * 1.5 (safety margin) + 5 seconds
session.sttSuppressionUntil = Date.now() + estimatedDuration;
```

**Benefit:** Prevents the immediate feedback from script audio.

### 6.2 Phase 2: Shared TTS Buffer for Post-Script Period (Solution A)

After the suppression window, both streams check against a shared TTS buffer for ongoing echo detection:

```typescript
// All TTS outputs written to shared DB buffer
// All STT inputs checked against shared DB buffer
// Similarity threshold: 0.65 (to catch slight STT variations)
```

**Benefit:** Prevents feedback from any subsequent responses.

### 6.3 Combined Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         PROPOSED HYBRID SOLUTION                             │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. Both streams connect                                                     │
│     ↓                                                                        │
│  2. Customer speaks → both detect                                            │
│     ↓                                                                        │
│  3. Atomic lock for script playback                                          │
│     ├── WINNER (req-2): plays script, adds to SHARED TTS buffer             │
│     └── LOSER (req-5):  sttSuppressionUntil = now + scriptDuration + 5s     │
│                         ↓                                                    │
│  4. During script playback                                                   │
│     ├── req-2: playing TTS, buffer accumulating                             │
│     └── req-5: ALL STT suppressed (time window)                             │
│                         ↓                                                    │
│  5. Script completes (mark received by req-2)                                │
│     ├── req-2: enters listening mode                                         │
│     └── req-5: suppression window expires, starts listening                  │
│                         ↓                                                    │
│  6. Post-script conversation                                                 │
│     ├── Any stream: TTS sent → added to SHARED buffer                        │
│     └── Any stream: STT received → checked against SHARED buffer             │
│                         ↓                                                    │
│  7. Echo detected? → Suppress                                                │
│     Genuine speech? → Process via RAG                                        │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 7. Implementation Plan

### 7.1 Files to Modify

| File | Changes |
|------|---------|
| `apps/api/src/routes/exotel-voicebot.ts` | Add shared buffer integration, time-based suppression |
| `apps/api/src/services/voicebot-session.ts` | Add `sttSuppressionUntil` field |
| `apps/api/src/utils/echo-detection.ts` | Add shared buffer functions |
| `apps/api/src/config/env.ts` | Add feature flags |

### 7.2 Database Schema (No Changes Needed)

The existing `exotel_call_sessions.metadata` JSONB field can store:
```json
{
  "script_played_by_stream": "779346f9...",
  "script_played_at": "2026-07-03T19:59:51Z",
  "recent_tts_texts": [
    { "text": "सर मैं छावनी...", "timestamp": "2026-07-03T19:59:51Z", "stream_sid": "779346f9..." },
    { "text": "आपका स्वागत है...", "timestamp": "2026-07-03T20:00:27Z", "stream_sid": "6195e501..." }
  ]
}
```

### 7.3 Step-by-Step Implementation Tasks

1. **Add `sttSuppressionUntil` to VoicebotSession interface**
2. **Modify lock-losing path to set suppression window**
3. **Add early return in STT processing if within suppression window**
4. **Create `addToSharedTTSBuffer()` function**
5. **Create `isEchoOfSharedTTS()` function**
6. **Integrate shared buffer check in STT processing path**
7. **Add buffer cleanup (prune entries > 60 seconds old)**
8. **Add feature flag: `OUTBOUND_CROSS_LEG_ECHO_ENABLED`**
9. **Add comprehensive logging for debugging**

---

## 8. Feature Flags & Rollback

### 8.1 Feature Flags

```env
# Master switch for all cross-leg echo handling
OUTBOUND_CROSS_LEG_ECHO_ENABLED=true

# Time-based suppression duration multiplier (default: 1.5)
OUTBOUND_STT_SUPPRESSION_MULTIPLIER=1.5

# Similarity threshold for echo detection (default: 0.65)
OUTBOUND_ECHO_SIMILARITY_THRESHOLD=0.65

# Max age for TTS buffer entries in seconds (default: 60)
OUTBOUND_TTS_BUFFER_MAX_AGE_SECONDS=60
```

### 8.2 Rollback Plan

If issues arise:
1. Set `OUTBOUND_CROSS_LEG_ECHO_ENABLED=false`
2. System reverts to previous behavior
3. Investigate logs and adjust thresholds

---

## 9. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Legitimate speech filtered as echo | Medium | Medium | Tune similarity threshold; log all filtered transcripts |
| DB latency affects response time | Low | Low | Async buffer writes; cache reads |
| Suppression window too long | Low | Medium | Make multiplier configurable |
| Suppression window too short | Medium | Medium | Add 5-second buffer; monitor logs |
| Incoming calls affected | Very Low | High | All changes gated by `session.campaignId` check |

---

## 10. Success Criteria

1. ✅ Campaign script plays exactly ONCE (already working)
2. ✅ Secondary stream does NOT process script audio as speech
3. ✅ Post-script, neither stream processes the other's TTS as speech
4. ✅ Genuine customer speech IS processed correctly
5. ✅ Call transcripts show human-bot conversation, not bot-bot
6. ✅ Incoming calls completely unaffected

---

## 11. Alternative Approaches Considered But Rejected

### 11.1 Audio-Level Echo Cancellation
**Why Rejected:** Too complex for the application layer. Would require DSP processing, buffering raw audio, and complex correlation algorithms. Better handled at the telephony layer.

### 11.2 Single-Stream Mode
**Why Rejected:** Exotel's dual-leg architecture is designed for call bridging. Forcing single-stream would require changes to Exotel flow configuration and may break call recording.

### 11.3 LLM-Based Echo Detection
**Why Rejected:** Latency too high. Would require sending transcripts to LLM to ask "is this a repetition of recent bot speech?" Adds 500ms+ to response time.

---

## 12. Next Steps

1. **APPROVAL REQUIRED** - Review this plan and select approach
2. If approved, proceed with implementation
3. Test with controlled outbound calls
4. Monitor logs for edge cases
5. Tune thresholds based on real-world data

---

**Document Prepared By:** AI Assistant  
**Review Status:** Pending User Approval  
**Last Updated:** 2026-07-03 20:03 IST
