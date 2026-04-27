# Voicebot: sub–2 second response time — planning guide

**Status:** Planning and product/engineering guidance only. **No code** in this document.

**Related internal docs**

- [EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md](./EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md) — WebSocket protocol, **chunk rules** (320-byte alignment, min/max size), `media` / `mark` / `clear`, **§10 Latency**
- [EXOTEL_VOICE_INTEGRATION.md](./EXOTEL_VOICE_INTEGRATION.md) — AgentStream context, architecture
- [SETTINGS_AND_FEATURES_CATALOG.md](./SETTINGS_AND_FEATURES_CATALOG.md) — `rag_streaming_enabled`, `vad_silence_timeout_ms`, `tts_streaming_enabled`

**External**

- Exotel: [Stream & Voicebot applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet), [exotel/Agent-Stream](https://github.com/exotel/Agent-Stream) (reference server patterns)

**Source of truth (code, `apps/api/src`):** The Exotel voicebot (`exotel-voicebot.ts`) reads **`rag_streaming_enabled`**, **`tts_streaming_enabled`**, and **`stt_streaming_enabled`** via `applyCustomerVoiceSettingsToSession`. Incremental LLM + TTS requires **both** RAG and TTS streaming **true**; STT remains **batch** with `stt_implementation: "batch"` in traces when streaming is requested. See **§2**.

---

## 1. Define the SLO (what “&lt; 2 seconds” means)

“Response time” must be one measurable instant; different choices change whether **&lt; 2 s** is achievable on PSTN.

| Metric | Definition | Typical use |
|--------|------------|-------------|
| **TTFA (time to first audio)** | Wall-clock from **end of caller speech** (or from **VAD fire**) until **first PCM you send to Exotel** for the answer | **Recommended** SLO for “feels fast”; benefits most from **streaming** LLM + **chunked** TTS |
| **TTFH (time to first heard)** | TTFA + Exotel/telephony playout delay | Harder; needs measurement on real calls |
| **Time to end of full reply** | Until last `media` (or `mark`) for the full utterance | Dominated by TTS length and **not** a good single SLO for “snappy” |

**Recommendation:** Target **TTFA &lt; 2 s** from **VAD commit** (start of `processUtterance`), and separately report **endpointing delay** (silence after speech). A hard **&lt; 2 s** from the moment a human *stops* talking is only realistic if **endpointing** is **well under 1 s** *and* the pipeline is fully streaming and tuned.

**Current order-of-magnitude (from production-style logs, not a guarantee):** default **1.5 s** silence before utterance is finalized (`vad_silence_timeout_ms`), plus **~3–4+ s** for batch STT + RAG + non-incremental TTS in heavy paths. That already exceeds 2 s before considering playback.

---

## 2. Customer `streaming` flags — Exotel voicebot behavior (implemented)

| `customer_settings` field | Session field | Behavior in `exotel-voicebot` |
|---------------------------|---------------|-------------------------------|
| **`rag_streaming_enabled`** | `ragStreamingForVoice` | Must be **true** for streaming *candidates*; **and** `tts_streaming_enabled` must be **true** for `streamToCall` to be passed. |
| **`tts_streaming_enabled`** | `ttsStreamingForVoice` | When **false** with RAG on, logs `pipeline.rag.tts_streaming_off` and uses **full** `chatOpenAI` + **one** `speakToExotel` (higher latency to first sound). When **true** *and* RAG on, passes `streamToCall` so `streamChatOpenAI` + `createStreamingVoiceTts` run. |
| **`stt_streaming_enabled`** | `sttStreamingForVoice` | Traced on `pipeline.stt.request` as `stt_streaming_enabled` and `stt_implementation: "batch"`. **True streaming STT** is not implemented yet; no behavior change to latency. |

**Operators:** For sentence-level TTS, set **both** `rag_streaming_enabled` and `tts_streaming_enabled` to **true**. If only RAG is true (TTS false, e.g. DB default), the bot **will not** use the fast LLM stream path.

---

## 3. Latency budget (illustrative)

A **theoretical** budget for **TTFA from VAD commit** to first outbound audio, if everything pipelines:

| Stage | Target range | Notes |
|-------|----------------|--------|
| STT (to usable transcript) | 200–600 ms | Batch WAV is **higher**; **streaming** STT cuts time-to-first *partial* text |
| RAG: embed + retrieve | 100–300 ms | Translation step adds if enabled; **cache** and **skip** work when **direct KB** applies |
| LLM: first token | 200–500 ms | Smaller system prompt, faster model, **streaming** to TTS path |
| TTS: first audio | 200–500 ms | Depends on **first chunk** size and provider; **true streaming TTS** vs one WAV per sentence |
| Exotel send + first play | 50–200+ ms | Obey **min chunk / alignment**; avoid tiny misaligned frames (see spec §7) |

Getting **cumulative TTFA** under 2 s requires **overlapping** work (e.g. speculative work on partials) and **not** waiting for the full user utterance for every stage—see §5–7.

---

## 4. What the codebase already supports (leverage)

These are **implemented** in `apps/api/src/routes/exotel-voicebot.ts` and related services; they must be **enabled and tuned** in tenant settings and operations.

### 4.1 LLM streaming → sentence-style TTS

- When **`rag_streaming_enabled` and `tts_streaming_enabled`** are **true**, the RAG+LLM path uses `streamChatOpenAI` and `createStreamingVoiceTts` (see **§2**). If RAG is true but TTS is false, the handler uses full `chatOpenAI` then one TTS.
- **Action:** Enable **both** flags for low-latency first audio; confirm logs with `pipeline.rag.llm_stream` and `tts_streaming_enabled: true` on that trace (not on every `tts.start` from other paths).

### 4.2 Endpointing (VAD) delay

- `vad_silence_timeout_ms` (default **1500** ms) controls how long **low-energy** audio must continue after speech before the utterance is processed.
- **Action:** For lower time-to-response, **reduce** in controlled steps (e.g. toward **500–800 ms**), with QA on **false cuts** (user pauses mid-sentence) and **noise** misclassified as speech.

### 4.3 Direct KB short-circuit

- The voice pipeline can answer from KB without waiting for a full generative path when the match is **strong** (see `VOICEBOT_DIRECT_KB_DISTANCE` and related logic in the same file).
- **Action:** Keep KB well-formed; tune threshold via product rules so **factual** questions hit the fast path more often (fewer LLM seconds).

### 4.4 Exotel outbound audio rules

- [EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md](./EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md) **§7** and **`pcm-audio` / `PcmChunkBuffer`**: min chunk size, max size, **320-byte** multiples. **Violations** can add **~20 ms** gaps or instability.
- **Action:** When optimizing “first sound,” do **not** sacrifice alignment rules; first optimize **TTS and LLM**; keep outbound chunking consistent with the existing buffer.

### 4.5 Sample rate

- The spec **§5 / §10** suggest evaluating **16 kHz** (vs 8 kHz) for a quality/latency tradeoff; telephony and resampling cost must be weighed.

---

## 5. STT: moving beyond batch utterance STT (high impact)

**Today’s typical path:** accumulate PCM until VAD fires → **WAV** → **batch** STT (full utterance) → then RAG.

**Problem:** The pipeline **cannot start** until the whole buffer is STT’d.

**Direction (no implementation here):**

- Adopt a **streaming / partial** ASR API (provider-specific: Sarvam or alternative) on the Exotel **media** stream: emit **transcript updates** while the user is still talking.
- **Policy:** Define when a “partial” is stable enough to start **lightweight** intent detection or even **speculative** embedding (with cancellation if the final text changes a lot).
- **Risk:** Premature RAG/LLM on wrong partials; needs **reconciliation** when final STT arrives (abort, replace, or merge — product decision).

The design spec already flags batch STT as suboptimal for telephony latency: [EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md](./EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md) **§10** and **§11** mapping.

---

## 6. TTS: streaming vs sentence-chunk WAV

**Current incremental path** (with RAG streaming) still does **TTS per text chunk** (e.g. per sentence) to Exotel. That is **faster to first sound** than one giant WAV, but each chunk may still be a **round-trip** to the TTS API.

**Direction:**

- If the TTS provider exposes **true streaming** (token → audio chunks), connect it to **`PcmChunkBuffer` / `speakToExotel`** with **low-latency first packet** and same Exotel **chunk** constraints.
- **Prompt/behavior:** Shorter, voice-friendly answers (already in system rules) **reduce** total synthesis time; avoid long first sentences so **first TTS** starts earlier.

---

## 7. RAG and LLM: fewer sequential waits

- **Embeddings + translation:** If every question is translated for search, that adds **one network hop**. For tenants that are **single-language** or STT is already in the KB language, **skip** or **async** with care.
- **Parallelism:** The voice ask pipeline already structures work so **embedding** and **chat history** can overlap where dependencies allow—avoid **new** serial steps on the hot path.
- **Model choice:** A **faster** chat model (with acceptable quality) reduces time-to-first token; keep **low** `max_tokens` for voice.
- **RAG size:** Shorter system + KB context → lower prompt tokens → faster first token.

---

## 8. Exotel- and network-side levers

- **TLS and region:** Terminate and run API + WebSocket **close to Exotel and providers** in the chosen geography.
- **Connection reuse / warm clients:** Long-lived HTTP/2 or pooled clients to OpenAI, Sarvam, embedding host—**measure** connect vs request time in traces.
- **`clear` and barge-in:** [EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md](./EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md) **§8.2** — use **`clear`** when the user interrupts; **smaller** outbound chunks can make `clear` feel more precise (spec §7 tradeoffs).

---

## 9. Measurement (mandatory for any &lt; 2 s program)

- **Instrument** sub-stage timings on the voice path: VAD start → first STT output (final / partial) → first embedding complete → first LLM token → first TTS frame sent → first `media` out. The code already logs `utterance.completed` with `elapsed_ms` for **end-to-end processing after VAD**; **extend** observability to **TTFA** and **per-stage** budgets.
- **A/B** or shadow **compare:** batch STT + batch TTS vs streaming stacks; **8 kHz vs 16 kHz**; **VAD 1500 vs 600 ms** with quality scoring.

---

## 10. Realistic expectations

- **&lt; 2 s** from “user **stopped** talking” to “first **heard** response” is **aggressive** on real PSTN: it requires **tight** endpointing (hundreds of ms, not 1.5 s default), **streaming** STT/LLM/TTS, and **no** long translation/RAG detours.
- **&lt; 2 s** from **VAD commit** to **first audio sent to Exotel** is **more** achievable with the stack above, but still requires tuning and may **conflict** with **accuracy** and **barge-in** safety—**treat SLOs per tenant** (sales vs. compliance-heavy).

---

## 11. Suggested implementation order (engineering backlog)

1. **Enable and verify** `rag_streaming_enabled` **and** `tts_streaming_enabled` on staging (see **§2**); **measure** TTFA and confirm logs show `pipeline.rag.llm_stream` with `tts_streaming_enabled: true` on that trace.
2. **Tune** `vad_silence_timeout_ms` with call-quality checklist (false end-of-utterance, noise).
3. **Reduce** RAG/LLM path weight: direct KB, shorter prompts, faster model, optional translation **skip** where safe.
4. **Prototype** streaming STT (partials) + **policy** for when to start the downstream pipeline.
5. **Prototype** **streaming TTS** or **smaller** first chunk policy if the provider supports it.
6. **Harden** Exotel outbound path (sample rate, chunking, `clear` behavior) under load.

This document should stay **up to date** when the Exotel handler gains new settings or when provider APIs (Sarvam STT/TTS streaming) are integrated.
