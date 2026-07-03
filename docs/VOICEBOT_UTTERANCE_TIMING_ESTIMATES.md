# Voicebot Utterance Timing Estimates

This document provides expected timing breakdowns for each stage of the voicebot pipeline, helping identify bottlenecks and set performance targets.

---

## Target Metrics

| Metric | Target | Acceptable | Poor |
|--------|--------|------------|------|
| **TTFA (Time To First Audio)** | < 2000ms | 2000-3000ms | > 3000ms |
| **Total Utterance Processing** | < 4000ms | 4000-6000ms | > 6000ms |
| **STT Latency** | < 1500ms | 1500-2500ms | > 2500ms |
| **LLM Response Time** | < 1500ms | 1500-3000ms | > 3000ms |
| **TTS First Chunk** | < 500ms | 500-1000ms | > 1000ms |

---

## Pipeline Stage Breakdown

### Stage 1: Audio Capture & VAD

| Component | Duration | Notes |
|-----------|----------|-------|
| Audio accumulation | 1000-5000ms | Depends on utterance length |
| VAD silence detection | 1500ms | Fixed timeout (VAD_SILENCE_TIMEOUT_MS) |
| PCM buffering | ~0ms | In-memory, negligible |
| **Stage Total** | 2500-6500ms | Variable based on speech length |

### Stage 2: Speech-to-Text (STT)

| Provider | Expected | Best Case | Worst Case |
|----------|----------|-----------|------------|
| **Sarvam (WebSocket)** | 800-1500ms | 500ms | 2500ms |
| **Sarvam (REST)** | 1200-2000ms | 800ms | 3000ms |
| **Cartesia (WebSocket)** | 600-1200ms | 400ms | 2000ms |
| **ElevenLabs (Scribe)** | 1000-2000ms | 600ms | 3000ms |

**Factors affecting STT latency:**
- Audio duration (longer = slower)
- Network latency to provider
- Provider load/capacity
- Sample rate (8kHz vs 16kHz)

### Stage 3: Language Detection

| Method | Duration | Notes |
|--------|----------|-------|
| **Sarvam (in STT response)** | 0ms | Included in STT |
| **OpenAI Language Detect** | 300-800ms | Separate API call |
| **LLM-Integrated Detection** | 0ms | Included in LLM call (proposed) |

### Stage 4: RAG Pipeline

| Component | Expected | Best Case | Worst Case |
|-----------|----------|-----------|------------|
| Embedding generation | 50-150ms | 30ms | 300ms |
| Vector search (KB) | 20-50ms | 10ms | 100ms |
| Chat history fetch | 10-30ms | 5ms | 50ms |
| **RAG Prep Total** | 80-230ms | 45ms | 450ms |

### Stage 5: LLM Response

| Model | Expected | Best Case | Worst Case |
|-------|----------|-----------|------------|
| **gpt-4o-mini (streaming)** | 800-2000ms | 500ms | 8000ms* |
| **gpt-4o (streaming)** | 1500-3000ms | 800ms | 10000ms* |
| **Self-hosted LLM** | 500-1500ms | 300ms | 3000ms |

*Worst case includes OpenAI API latency spikes

**Factors affecting LLM latency:**
- Prompt token count
- Max completion tokens
- OpenAI API load
- Network latency
- Model choice

### Stage 6: Text-to-Speech (TTS)

| Provider | First Chunk | Full Audio | Notes |
|----------|-------------|------------|-------|
| **Cartesia (WebSocket)** | 100-300ms | +streaming | Fastest |
| **Sarvam (REST)** | 500-1000ms | 800-2000ms | Full audio only |
| **Sarvam (Stream)** | 200-500ms | +streaming | Incremental |
| **ElevenLabs (Stream)** | 300-600ms | +streaming | Good quality |

### Stage 7: Audio Transmission

| Component | Duration | Notes |
|-----------|----------|-------|
| PCM chunking | ~0ms | In-memory |
| Base64 encoding | ~0ms | In-memory |
| WebSocket send | 5-20ms | Per chunk |
| Network to Exotel | 20-100ms | Depends on location |
| Exotel playback queue | 0-500ms | Variable |

---

## Complete Utterance Timing Examples

### Example 1: Optimal Path (Greeting)
```
Greeting TTS (cached):     0ms  (cache hit)
PCM transmission:         50ms
Exotel playback:        200ms
--------------------------------
Total:                  250ms  ✅ Excellent
```

### Example 2: Simple English Question
```
Audio capture:          2500ms  (1s speech + 1.5s VAD)
STT (Sarvam WS):        1200ms
Language detect:           0ms  (in STT)
RAG prep:                150ms
LLM (gpt-4o-mini):      1000ms
TTS first chunk:         200ms
--------------------------------
TTFA from end of speech: 2550ms  ⚠️ Slightly over target
Total pipeline:         5050ms
```

### Example 3: Hindi Question with Language Switch
```
Audio capture:          3000ms  (1.5s speech + 1.5s VAD)
STT (Sarvam WS):        1500ms
Language detect:           0ms  (in STT)
Language switch logic:    50ms
RAG prep:                200ms
LLM (gpt-4o-mini):      1500ms  (Hindi response)
TTS first chunk:         300ms
--------------------------------
TTFA from end of speech: 3550ms  ⚠️ Over target
Total pipeline:         6550ms
```

### Example 4: Slow Path (API Latency Spike)
```
Audio capture:          2500ms
STT (Sarvam WS):        2000ms  (slow)
Language detect:           0ms
RAG prep:                300ms  (slow embedding)
LLM (gpt-4o-mini):      7000ms  (API spike!)
TTS first chunk:         500ms
--------------------------------
TTFA from end of speech: 9800ms  ❌ CRITICAL
Total pipeline:        12300ms  ❌ UNACCEPTABLE
```

---

## Timing Budget Allocation

### Target: 2000ms TTFA Budget

| Stage | Allocation | Priority |
|-------|------------|----------|
| STT | 800ms | High |
| RAG Prep | 150ms | Medium |
| LLM | 800ms | Critical |
| TTS First Chunk | 250ms | High |
| **Total** | **2000ms** | — |

### Optimization Priorities

1. **LLM (Critical)** — Largest variable; add timeout/fallback
2. **STT (High)** — Consider faster provider or caching
3. **TTS (High)** — Use streaming, pre-connect WebSocket
4. **RAG (Medium)** — Cache embeddings, optimize KB queries

---

## Streaming vs Non-Streaming Comparison

### Without Streaming (Sequential)
```
STT complete:        1200ms
RAG complete:         150ms
LLM complete:        2000ms  (full response)
TTS complete:        1500ms  (full audio)
--------------------------------
TTFA:                4850ms  ❌
```

### With Streaming (Parallel TTS)
```
STT complete:        1200ms
RAG complete:         150ms
LLM first token:      500ms
TTS first chunk:      200ms  (starts immediately)
--------------------------------
TTFA:                2050ms  ✅
(LLM continues streaming while TTS plays)
```

**Streaming reduces TTFA by ~2800ms (58%)**

---

## Monitoring Checkpoints

Add logging at these points to track actual timing:

```typescript
// In processUtterance()
const t0 = Date.now();  // Utterance received

// After STT
const t1 = Date.now();
const sttMs = t1 - t0;

// After RAG prep
const t2 = Date.now();
const ragPrepMs = t2 - t1;

// After LLM first token (streaming) or complete
const t3 = Date.now();
const llmMs = t3 - t2;

// After TTS first chunk sent
const t4 = Date.now();
const ttsFirstChunkMs = t4 - t3;
const ttfaMs = t4 - t0;  // Total TTFA
```

---

## Performance SLA Recommendations

| Percentile | TTFA Target | Notes |
|------------|-------------|-------|
| p50 | < 1800ms | Typical case |
| p90 | < 2500ms | Most users |
| p99 | < 4000ms | Edge cases |
| p99.9 | < 8000ms | API spikes (add fallback) |

### Alert Thresholds

| Metric | Warning | Critical |
|--------|---------|----------|
| TTFA p50 | > 2000ms | > 3000ms |
| TTFA p99 | > 4000ms | > 6000ms |
| LLM p99 | > 3000ms | > 5000ms |
| STT error rate | > 5% | > 10% |

---

## Optimization Recommendations

### Quick Wins
1. **Cache greetings** — Already implemented ✅
2. **Pre-connect TTS WebSocket** — Reduce first-chunk latency
3. **Streaming TTS** — Already implemented ✅
4. **Shorter max_tokens** — Reduce LLM generation time

### Medium Effort
1. **LLM timeout with fallback** — Return generic response if > 3s
2. **Embedding cache** — Already implemented ✅
3. **Regional API endpoints** — Reduce network latency
4. **Parallel operations** — Overlap STT tail with RAG prep

### Long-term
1. **Edge-deployed STT** — Reduce round-trip
2. **Fine-tuned smaller model** — Faster inference
3. **Predictive responses** — Cache common Q&A
4. **Real-time STT** — Process audio as it streams

---

## Appendix: Actual Timing from Logs (2026-07-03)

### Call at 13:35:57

| Utterance | STT | Ask Pipeline | Final TTS | Total | TTFA |
|-----------|-----|--------------|-----------|-------|------|
| 1 (noise) | — | — | 1068ms | 1068ms | 1068ms ✅ |
| 2 (identity) | 1418ms | 7229ms | 0ms | 8648ms | 8176ms ❌ |
| 3 (rooms) | 1443ms | 2920ms | 0ms | 4363ms | 3090ms ⚠️ |
| 4 (which) | 660ms | 1816ms | 0ms | 2477ms | 2084ms ⚠️ |

**Observation:** Utterance 2 had catastrophic LLM latency (7.2s). This is the primary optimization target.
