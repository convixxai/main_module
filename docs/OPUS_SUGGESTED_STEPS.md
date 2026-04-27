# Opus Suggested Steps — Sub-2-Second Voicebot Response Time

**Goal:** From the moment the customer pauses speaking to when they hear the first word of the AI answer — **under 2 seconds**.

**Date:** 2026-04-27

---

## Current Pipeline (Sequential Bottleneck Chain)

```
Customer speaks → VAD silence timeout (500ms) → Build WAV → STT (1.5-3s) →
  Translate for embedding (0-0.5s, multilingual only) → Embedding (0.1-0.3s) →
  KB vector search (0.05-0.1s) → LLM/OpenAI (0.5-2s TTFT) →
  TTS per sentence (1-4s) → Exotel outbound audio
```

**Current measured TTFA:** ~4-11 seconds (from production logs)
**Target:** < 2 seconds (p90)

---

## Time Budget for Sub-2s

| Step | Current | Target | How |
|------|---------|--------|-----|
| VAD silence timeout | 500ms | 400-500ms | Already aggressive; keep |
| STT | 1500-3000ms | 200-400ms | True streaming STT |
| Translation (multilingual) | 0-500ms | **0ms** | Skip when `multilingual=false` |
| Embedding | 100-300ms | 80-150ms | Cache + overlap |
| KB search | 50-100ms | 50-100ms | Already fast |
| LLM (TTFT) | 500-2000ms | 300-600ms | Smaller model, shorter prompt, streaming |
| TTS (first sentence) | 1000-4000ms | 200-500ms | Fix decode, true streaming |
| **Total** | **4000-11000ms** | **1300-1900ms** | |

---

## Phase 1: Quick Wins — No Architecture Change (Target: 3-4s → ~2.5s)

### 1.1 FIX: Stop Double TTS (CRITICAL — saves 1-4s per sentence)

**Problem:** `sarvamTextToSpeechStream` returns audio that `tryDecodeSarvamAudio` cannot decode → falls back to REST `sarvamTextToSpeech` → **two full TTS calls per sentence**.

**Evidence:** Logs show `pipeline.tts.sarvam_decode_rest` with `reason: "stream_body_not_decodable"` on most calls.

**File:** `apps/api/src/routes/exotel-voicebot.ts` (lines 1168-1326) + `apps/api/src/services/sarvam.ts` (lines 107-170)

**Fix:**
- In `sarvamTextToSpeechStream`, force `output_audio_codec: "linear16"` and `speech_sample_rate` to match the Exotel stream rate (8000). The env var `SARVAM_TTS_STREAM_LINEAR16` already exists and defaults to `true`.
- Verify the response from Sarvam `/text-to-speech/stream` when `linear16` is requested — if the body is headerless raw s16le PCM (no RIFF), the `tryDecodeSarvamAudio` fallback path at line 1269 already handles it (`buf.length > 0 && buf.length % 2 === 0` → treat as raw PCM).
- If the stream path still fails for some parameter combos, **disable `tts_streaming_enabled` in DB** and use REST-only until fixed — one REST call is faster than stream+fail+REST.

**Immediate action:** For any customer where `tts_streaming_enabled = true` and logs show `sarvam_decode_rest`, either fix the codec alignment or set `tts_streaming_enabled = false` to eliminate the double-fetch.

### 1.2 FIX: Reduce STT WebSocket Idle Timer (saves 0.4-1.5s)

**Problem:** `sarvamSpeechToTextWebsocket` has `idleMs` = `SARVAM_STT_WS_IDLE_MS` (default 400 from env, but code was historically 2000). After the last transcript message, it waits this long before settling.

**File:** `apps/api/src/services/sarvam.ts` (line 218) + `apps/api/src/config/env.ts` (line 65-67)

**Fix:**
- Set env `SARVAM_STT_WS_IDLE_MS=250` (from current 400). Sarvam sends a flush response quickly after receiving our flush signal; 250ms is safe with the explicit `flush_signal: true`.
- Monitor for transcript truncation — if quality drops, bump to 300.

### 1.3 FIX: Skip Translation When `multilingual = false` (saves 0-500ms)

**Problem:** `prepareQuestionForKbEmbedding` in `llm.ts` already checks `opts.multilingual` and returns early when `false`. However, the voicebot passes `multilingual: session.voicebotMultilingualEffective === true` which is correct. **This path is already correct for non-multilingual customers.**

**File:** `apps/api/src/services/llm.ts` (lines 288-341)

**Verification needed:** Confirm in `exotel-voicebot.ts` line 2035 that `multilingual` is passed correctly:
```typescript
const { textForEmbedding, translatedForSearch } =
  await prepareQuestionForKbEmbedding(question, {
    multilingual: session.voicebotMultilingualEffective === true,
    languageTag: session.effectiveSttLanguageThisTurn,
    trace: ragTrace,
  });
```
This is correct — when `customer_settings.voicebot_multilingual = false`, `session.voicebotMultilingualEffective` is `false`, and `prepareQuestionForKbEmbedding` returns immediately without translating.

**Also verify STT language hint:** When `multilingual = false`, line 1511-1513:
```typescript
const sttLanguageHint = multilingual ? undefined : "en-IN";
```
STT is always hinted to `en-IN` for non-multilingual — correct.

**Also verify TTS language:** Line 1763-1765:
```typescript
const ttsLanguage = multilingual
  ? mapToTtsLanguage(effectiveLanguage)
  : "en-IN";
```
TTS always uses `en-IN` for non-multilingual — correct.

**Also verify RAG language rule:** Line 2218-2220:
```typescript
} else {
  languageRule =
    "\n- ALWAYS respond in English regardless of the question language.";
}
```
When NOT multilingual, LLM is told to respond in English only — correct.

**IMPORTANT SAFETY CHECK — Answer must not break when multilingual=false:**
- STT hint is `en-IN` → Sarvam returns English transcript
- No translation step
- LLM told "respond in English"
- TTS language `en-IN`
- No rehint loop (rehint only triggers when `multilingual && sttProvider === "sarvam" && !isLanguageInAllowedList(...)`)

All correct. No code change needed, but document this in ops runbook.

### 1.4 FIX: Enable RAG + TTS Streaming in Customer Settings DB

**Problem:** The streaming LLM → sentence-by-sentence TTS path only activates when BOTH `rag_streaming_enabled` AND `tts_streaming_enabled` are `true` in `customer_settings`.

**File:** `apps/api/src/routes/exotel-voicebot.ts` (lines 1852-1855)

**Fix:** Run this SQL for all customers that need low latency:
```sql
UPDATE customer_settings
SET rag_streaming_enabled = true,
    tts_streaming_enabled = true
WHERE voicebot_enabled = true
  AND (rag_streaming_enabled = false OR tts_streaming_enabled = false);
```

**Impact:** Without both flags, the pipeline uses `chatOpenAI` (non-streaming) then a single `speakToExotel` for the full answer — the customer waits for the entire LLM response before TTS even starts.

### 1.5 FIX: Extend Direct-KB Shortcut Beyond First Turn (saves 500-2000ms)

**Problem:** Direct KB answer (skip LLM entirely) only works on `priorUserTurns === 0` (first user turn).

**File:** `apps/api/src/routes/exotel-voicebot.ts` (lines 2167-2193)

**Fix:** Remove the `priorUserTurns === 0` gate. Allow direct KB on any turn when vector distance is below threshold:
```typescript
// BEFORE:
const canDirectKb =
  Number.isFinite(dist) && dist < directTh && priorUserTurns === 0;

// AFTER:
const canDirectKb =
  Number.isFinite(dist) && dist < directTh;
```

**Risk:** On follow-up turns, a near-exact KB match may ignore conversation context. Mitigate by tightening the threshold for turns > 0:
```typescript
const directThForTurn = priorUserTurns === 0 ? directTh : directTh * 0.6;
const canDirectKb =
  Number.isFinite(dist) && dist < directThForTurn;
```

**Impact:** When the customer asks a question that closely matches a KB entry (distance < 0.18 for follow-ups, < 0.3 for first turn), skip the entire LLM call — saves 500-2000ms.

### 1.6 FIX: Reduce LLM Max Tokens for Voice (saves 200-500ms)

**Problem:** `llm_max_tokens` defaults to 150, capped at `VOICEBOT_VOICE_LLM_MAX_TOKENS` (default 120). For voice, shorter is faster.

**File:** `apps/api/src/config/env.ts` (line 99) + `apps/api/src/routes/exotel-voicebot.ts` (line 2250)

**Fix:** Set env `VOICEBOT_VOICE_LLM_MAX_TOKENS=80` and in DB set `llm_max_tokens=80` per customer. Voice answers should be 1-3 short sentences.

**Impact:** Fewer tokens = faster completion + shorter TTS.

### 1.7 FIX: Shorter Voice System Prompt

**Problem:** Large system prompts increase OpenAI TTFT (time to first token). The RAG prompt includes full KB context + history + system prompt + multilingual rules.

**Fix:** In agents table, ensure `system_prompt` for voice agents is concise — under 200 words. Remove any web-chat-specific instructions. The RAG rules block already adds KB context.

### 1.8 FIX: Use Faster OpenAI Model

**Problem:** `gpt-4o-mini` is good but there may be faster options.

**File:** `customer_settings.openai_model` or `llm_model_override`

**Fix:** Evaluate `gpt-4o-mini` (current) vs `gpt-4.1-mini` or `gpt-4.1-nano` for voice-specific use. Voice answers are short and KB-grounded — a smaller model may suffice with lower TTFT.

**DB:**
```sql
UPDATE customer_settings SET openai_model = 'gpt-4.1-mini' WHERE voicebot_enabled = true;
```

---

## Phase 2: Architecture Changes (Target: ~2.5s → ~1.5-2s)

### 2.1 True Streaming TTS — ReadableStream Consumer

**Problem:** `sarvamTextToSpeechStream` uses `await res.arrayBuffer()` — buffers entire response body before any audio reaches Exotel.

**File:** `apps/api/src/services/sarvam.ts` (line 163: `const ab = await res.arrayBuffer()`)

**Fix:** Replace with incremental `ReadableStream` consumption:
```typescript
export async function sarvamTextToSpeechStreamIncremental(payload: {
  text: string;
  target_language_code: string;
  speaker?: string | null;
  model?: string;
  speech_sample_rate?: number;
  output_audio_codec?: string; // force "linear16"
  // ... other params
}): AsyncGenerator<Buffer, void, unknown> {
  const res = await fetch(`${SARVAM_BASE}/text-to-speech/stream`, {
    method: "POST",
    headers: { "api-subscription-key": key, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) throw new Error(`Sarvam TTS stream: ${res.status}`);

  const reader = res.body.getReader();
  let pending = Buffer.alloc(0);
  const MIN_CHUNK = 3200; // 200ms at 8kHz s16le

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending = Buffer.concat([pending, Buffer.from(value)]);
    while (pending.length >= MIN_CHUNK) {
      const aligned = Math.floor(pending.length / 320) * 320;
      if (aligned < MIN_CHUNK) break;
      yield pending.subarray(0, aligned);
      pending = pending.subarray(aligned);
    }
  }
  if (pending.length >= 320) {
    const aligned = Math.floor(pending.length / 320) * 320;
    if (aligned > 0) yield pending.subarray(0, aligned);
  }
}
```

Then in `speakToExotel`, pipe chunks to `sendAudioToExotel` as they arrive instead of waiting for the full buffer.

**Impact:** First audio can reach Exotel within 200-400ms of Sarvam starting to generate, instead of waiting for the full sentence.

### 2.2 True Streaming STT — Persistent WebSocket + Incremental PCM

**Problem:** Current STT opens a new WebSocket per utterance and sends the entire buffered WAV at once after VAD fires.

**File:** `apps/api/src/services/sarvam.ts` (`sarvamSpeechToTextWebsocket`)

**Fix (2 parts):**

**Part A — Reuse STT WebSocket per call:**
- Open one Sarvam STT WebSocket at call `start` event.
- Keep it alive for the call duration.
- Eliminates ~100-200ms WebSocket handshake per utterance.

**Part B — Stream PCM during speech:**
- Instead of buffering all PCM in `session.inboundPcm` then sending one WAV:
  - Forward decoded Exotel PCM to Sarvam STT WebSocket in 100-200ms windows **while the caller speaks**.
  - When VAD fires (silence timeout), send a `flush` signal.
  - Sarvam may already have partial/final transcripts ready — TTFA from VAD = just the last partial + flush latency (~100-300ms instead of 1.5-3s).

**Impact:** Biggest single improvement. STT goes from 1.5-3s (post-VAD batch) to 100-300ms (flush after already-streamed audio).

### 2.3 Overlap STT → Embedding (Speculative Pipeline)

**Problem:** Currently sequential: STT finishes → then start embedding + LLM.

**Fix:** While STT partials arrive (from 2.2), speculatively start embedding on the latest stable partial. If the final transcript matches, skip re-embedding.

```typescript
// Pseudocode during streaming STT
let lastPartial = "";
let speculativeEmbedding: Promise<number[]> | null = null;

onSttPartial((text) => {
  if (text.length > 10 && text !== lastPartial) {
    lastPartial = text;
    speculativeEmbedding = generateEmbedding(text);
  }
});

onSttFinal((finalText) => {
  if (finalText === lastPartial && speculativeEmbedding) {
    // Use cached speculative embedding — saves 100-300ms
    embedding = await speculativeEmbedding;
  } else {
    embedding = await generateEmbedding(finalText);
  }
});
```

**Impact:** Saves 100-300ms by overlapping embedding with STT finalization.

### 2.4 Pre-Cache Greeting Audio

**Problem:** First greeting pays full TTS latency (~3s from logs).

**Fix:**
- On call `start`, after loading agent settings, check if a cached greeting PCM exists for this `(customer_id, greeting_text, tts_provider, tts_speaker, language)` tuple.
- If not, generate and cache (in-memory Map or Redis with 1-hour TTL).
- Send cached PCM directly to Exotel — greeting plays instantly.

**File:** `apps/api/src/routes/exotel-voicebot.ts` (lines 2595-2658)

**Impact:** Greeting plays in <100ms instead of 3s.

---

## Phase 3: Optimizations (Target: Reliable p90 < 2s)

### 3.1 Parallel Agent Row + Embedding + History

**Problem:** In `runVoicebotAskPipeline`, agent row fetch (line 2064) is sequential after embed+history `Promise.all`.

**Fix:** Include agent row fetch in the `Promise.all`:
```typescript
const [embedBundle, historyRaw, agentRow] = await Promise.all([
  embedPipeline,
  historyP,
  session.agentId ? pool.query(`SELECT ... FROM agents WHERE id = $1`, [session.agentId]) : null,
]);
```

**Impact:** Saves 20-50ms (DB round-trip overlap).

### 3.2 Cache Customer System Prompt

**Problem:** `voiceRagCustomerCache` already caches system prompt after first utterance. But agent row is re-fetched every turn (line 2064).

**Fix:** Cache agent row similarly to `voiceRagCustomerCache`:
```typescript
if (!session.voiceRagAgentCache && session.agentId) {
  const agentResult = await pool.query(...);
  session.voiceRagAgentCache = agentResult.rows[0];
}
```

**Impact:** Saves 20-50ms per turn after the first.

### 3.3 Filler-Word Fast Path (Already Implemented)

The `isFillerOnlyTranscript` check (line 1799) already skips RAG/LLM for "hmm", "um", etc. This is good — keep it.

### 3.4 Reduce `rag_top_k` for Voice

**Fix:** Set `rag_top_k = 3` (from default 5) for voice customers. Fewer KB passages = shorter LLM prompt = faster TTFT.

```sql
UPDATE customer_settings SET rag_top_k = 3 WHERE voicebot_enabled = true;
```

### 3.5 Reduce Chat History for Voice

**Fix:** Set `rag_history_max_turns = 2` (from default 3 pairs). Less context = shorter prompt.

```sql
UPDATE customer_settings SET rag_history_max_turns = 2 WHERE voicebot_enabled = true;
```

---

## Multilingual = false Safety Checklist

For customers with `customer_settings.voicebot_multilingual = false`:

| Step | What Happens | Safe? |
|------|-------------|-------|
| STT language hint | Always `"en-IN"` | Yes — forces English recognition |
| STT rehint (2nd pass) | **Never runs** — rehint only when `multilingual && outOfList` | Yes — saves ~1s |
| Translation for embedding | **Skipped** — `prepareQuestionForKbEmbedding` returns early | Yes — saves 0-500ms |
| LLM language rule | `"ALWAYS respond in English"` | Yes |
| TTS language | Always `"en-IN"` | Yes |
| Allowed language list | Not used (all clamping skipped) | Yes |

**Result:** Non-multilingual path is the fastest path. No translation, no rehint, no language detection overhead. Answer is always in English and won't break.

**CAUTION for multilingual=true customers:** The translation step (`sarvamTranslateToEnglishForSearch`) adds 200-500ms. This is necessary for correct KB embedding search when questions are in Hindi/Marathi/etc. For multilingual, accept slightly higher latency or consider:
- Multilingual embeddings (future — eliminate translation step)
- Pre-translated KB entries (match in source language)

---

## Implementation Priority Order

| Priority | Change | Effort | Impact | Files |
|----------|--------|--------|--------|-------|
| **P0.1** | Fix/disable double TTS | 30 min | -1 to -4s | `exotel-voicebot.ts`, DB |
| **P0.2** | Enable RAG+TTS streaming flags in DB | 5 min | -1 to -2s | DB SQL |
| **P0.3** | Reduce STT idle timer to 250ms | 5 min | -0.15s | env config |
| **P0.4** | Reduce LLM max tokens to 80 | 5 min | -0.2 to -0.5s | env config, DB |
| **P0.5** | Reduce rag_top_k to 3, history to 2 | 5 min | -0.1 to -0.3s | DB SQL |
| **P1.1** | Extend direct-KB beyond first turn | 1 hour | -0.5 to -2s | `exotel-voicebot.ts` |
| **P1.2** | Use faster OpenAI model | 30 min | -0.2 to -0.5s | DB SQL |
| **P1.3** | Shorter voice system prompt | 1 hour | -0.1 to -0.3s | DB agents table |
| **P2.1** | True streaming TTS (ReadableStream) | 1-2 days | -0.5 to -1.5s | `sarvam.ts`, `exotel-voicebot.ts` |
| **P2.2** | Persistent + streaming STT | 3-5 days | -1 to -2.5s | `sarvam.ts`, `exotel-voicebot.ts` |
| **P2.3** | Speculative embedding overlap | 1 day | -0.1 to -0.3s | `exotel-voicebot.ts` |
| **P2.4** | Pre-cache greeting audio | 2-3 hours | -2 to -3s (greeting only) | `exotel-voicebot.ts` |
| **P3.1** | Parallel agent+embed+history | 30 min | -0.02 to -0.05s | `exotel-voicebot.ts` |
| **P3.2** | Cache agent row per call | 30 min | -0.02 to -0.05s | `exotel-voicebot.ts` |

---

## Expected Outcome by Phase

| Phase | Changes | Expected TTFA | Confidence |
|-------|---------|---------------|------------|
| **Current** | None | 4-11s | Measured |
| **Phase 1** (P0 + P1) | Config + minor code | **2.5-4s** | High |
| **Phase 2** (streaming) | Architecture | **1.5-2.5s** | Medium-High |
| **Phase 3** (polish) | Optimizations | **1.2-2.0s** (p90) | Medium |

---

## DB Settings Template for Low-Latency Customer

```sql
UPDATE customer_settings SET
  -- Streaming (both must be true)
  rag_streaming_enabled = true,
  tts_streaming_enabled = true,
  stt_streaming_enabled = true,

  -- VAD
  vad_silence_timeout_ms = 500,
  vad_energy_threshold = 200,
  vad_min_speech_ms = 200,

  -- LLM
  llm_max_tokens = 80,
  rag_top_k = 3,
  rag_history_max_turns = 2,
  rag_use_history = true,
  openai_model = 'gpt-4o-mini',  -- or gpt-4.1-mini when available

  -- TTS
  tts_streaming_enabled = true,
  tts_default_sample_rate = 8000,  -- match Exotel, avoid resample

  -- For English-only customers
  voicebot_multilingual = false,
  default_language_code = 'en-IN'
WHERE customer_id = '<CUSTOMER_UUID>';
```

---

## Monitoring After Changes

Search logs for these events to measure improvement:

```
pipeline.utterance.timing  → stt_ms, ask_pipeline_ms, final_tts_ms, total_ms
utterance.completed        → timing_stt_ms, timing_ask_pipeline_ms, timing_final_tts_ms
pipeline.tts.sarvam_decode_rest  → should disappear after P0.1
pipeline.stt.rehint_skipped      → confirms multilingual=false skips rehint
```

**TTFA measurement:** Add explicit log of time from `utterance.received` to first `exotel.out.media_batch` for the answer (not greeting).

---

## Files Reference

| File | Role |
|------|------|
| `apps/api/src/routes/exotel-voicebot.ts` | Main pipeline: VAD, processUtterance, speakToExotel, streaming TTS |
| `apps/api/src/services/sarvam.ts` | Sarvam STT (batch + WebSocket), TTS (REST + HTTP stream) |
| `apps/api/src/services/llm.ts` | OpenAI chat (batch + stream), embeddings, translation |
| `apps/api/src/services/customer-settings.ts` | Customer settings DAO, cache (1min TTL) |
| `apps/api/src/services/voicebot-session.ts` | Per-call session state |
| `apps/api/src/config/env.ts` | Environment config for all services |

---

*This document was prepared from a complete code review of the voicebot pipeline, all existing latency documentation, customer settings schema, and production log analysis. Update as changes are implemented.*
