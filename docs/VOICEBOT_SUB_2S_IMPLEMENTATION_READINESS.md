# Voicebot sub–2 second response — implementation readiness (no code)

**Status:** Planning and gap analysis only. **No code changes** are described as diffs here; this document lists **what must change** in product, configuration, and engineering to approach a **time-to-first-audio (TTFA)** goal after a customer finishes a spoken question.

**Inputs used**

- Internal: `exotel-voicebot.ts`, `sarvam.ts`, `llm.ts`, `pcm-audio.ts`, `voicebot-session.ts`, `customer-settings` behaviour  
- Analysis: [`VOICEBOT_STREAMING_LOG_ANALYSIS.md`](./VOICEBOT_STREAMING_LOG_ANALYSIS.md) (sample production-style log)  
- Vendor mirrors: [`vendor-offline/`](./vendor-offline/) (Sarvam STT/TTS, Exotel Voicebot)  
- Playbook: [`vendor-offline/LATENCY_STREAMING_PLAYBOOK.md`](./vendor-offline/LATENCY_STREAMING_PLAYBOOK.md)  

---

## 1. Can we hit “&lt; 2 s” after each customer query?

**Short answer:** A **hard guarantee** for **every** query on **every** network path (PSTN → Exotel → your API → Sarvam → OpenAI → back) is **not realistic** without controlled conditions. A **median** or **p90** target of **&lt; 2 s TTFA** (first audio of the **answer** after the customer’s utterance is committed) **is achievable** with the right architecture, but it requires **substantial** changes beyond settings-only tuning.

**Define the metric first (mandatory)**

| Metric | Meaning | Use for SLO |
|--------|---------|-------------|
| **TTFA (recommended)** | Wall time from **`vad.timeout_triggered` / `utterance.received`** (start of `processUtterance`) until **first outbound `media`** for the **answer** | Primary “feels fast” measure |
| **Time after user stops talking** | TTFA **minus** endpointing delay (your VAD + any Sarvam-side behaviour) | Product perception |
| **Full reply complete** | Until last `mark` / playback done | **Not** a good single SLO for “snappy” |

The sample log in `VOICEBOT_STREAMING_LOG_ANALYSIS.md` showed **~4+ s** before first TTS activity on a heavy path (STT ~3 s + pipeline + TTS). That is **far** from &lt; 2 s TTFA until STT and TTS paths are fixed.

---

## 2. Current pipeline (as implemented)

End-to-end order for one user turn:

1. **Exotel** sends `media` (8 kHz PCM) → app buffers PCM while VAD runs (`vad_silence_timeout_ms`, energy threshold, `vad_min_speech_ms`).  
2. **VAD fires** → `processUtterance` runs **only if** `ttsInProgress` is false **and** `pendingMarks.size === 0` (no TTS / pending playback marks).  
3. **STT:** Build WAV from full buffered PCM → **`sarvamSpeechToTextWebsocket`** opens a **new** WebSocket per utterance, sends **one** base64 WAV + flush; waits for final transcript; uses a **2 s idle** timer after last transcript update before settling (`idleMs = 2000` in `sarvam.ts`). **Not** true streaming of live Exotel chunks.  
4. **RAG:** `runVoicebotAskPipeline`:  
   - **Parallel:** embedding pipeline (`prepareQuestionForKbEmbedding` + `generateEmbedding`) and **chat history** load (`Promise.all`).  
   - **Sequential:** agent row fetch (if `agentId`), then **pgvector** KB query, logging, then either:  
     - **KB empty** → fixed string (no LLM)  
     - **Direct KB** → first row answer **only if** `distance < threshold` **and** `priorUserTurns === 0` (first user turn only)  
     - Else **full RAG prompt** (large system + KB + history) → **OpenAI**  
5. **LLM:** If `rag_streaming_enabled` **and** `tts_streaming_enabled`, **`streamChatOpenAI`** streams tokens → **`createStreamingVoiceTts`** calls **`speakToExotel`** per sentence boundary.  
6. **TTS:** **`speakToExotel`** → Sarvam **`/text-to-speech/stream`** when `tts_streaming_enabled`, else REST JSON; implementation **buffers full `arrayBuffer()`** before decode; on decode failure → **REST again** (`stream_body_not_decodable` in logs).  
7. **Exotel outbound:** `sendAudioToExotel` splits PCM into compliant chunks (320-byte rules, min size) — **after** full TTS buffer is available for that sentence.

**Implication:** Streaming helps the **LLM → TTS** boundary **only when** both RAG and TTS streaming flags are on; **STT** and **Sarvam HTTP TTS body handling** still dominate in the log.

---

## 3. Evidence from the analyzed log (why &lt; 2 s is missed today)

From [`VOICEBOT_STREAMING_LOG_ANALYSIS.md`](./VOICEBOT_STREAMING_LOG_ANALYSIS.md):

- **STT ~2–3 s** after `processUtterance` start for multi-second utterances.  
- **TTS ~3–4 s** per sentence on HTTP “stream” path, with **`sarvam_decode_rest`** (double work with REST).  
- **Greeting ~3 s** to first TTS response.  
- **`utterance.completed` elapsed_ms** in the **11 s** range for a long first turn (includes long captured audio + full pipeline).

These numbers are **consistent** with batch STT + non-incremental TTS + optional double TTS.

---

## 4. Gap analysis: what must improve (by layer)

### 4.1 Endpointing (before STT)

| Item | Current | Impact on TTFA | Change needed |
|------|---------|----------------|---------------|
| `vad_silence_timeout_ms` | Tenant e.g. **500 ms** | Adds up to ~0.5 s after last “speech” frame | Already aggressive; tune only with QA (false cuts) |
| Energy / min speech | `customer_settings` | Too high min speech → delayed start; wrong energy → long buffers | Tune with real line audio; document in ops runbook |
| **Blocking gate** | `processUtterance` returns early if `ttsInProgress` **or** `pendingMarks` | **Cannot** start next STT while previous answer still playing | Product choice: barge-in / shorter answers / accept delay between **turns** |

**Conclusion:** Endpointing alone cannot deliver &lt; 2 s if the **pipeline after VAD** takes 3–6 s.

---

### 4.2 STT (Sarvam)

| Item | Current | Impact | Change needed |
|------|---------|--------|---------------|
| **Audio feeding** | Single WAV after VAD | Waits for **entire** utterance + server processing | **Stream** PCM windows into Sarvam STT WebSocket **during** speech; align with [vendor STT streaming doc](./vendor-offline/sarvam-stt-streaming.md) (“continuous streaming”) |
| **Connection** | **New** WebSocket per utterance in `sarvamSpeechToTextWebsocket` | Extra handshake latency every turn | **Reuse** session-level STT WebSocket per call where possible |
| **Idle tail** | **2000 ms** after last transcript message before `finish` | Adds up to **2 s** even when audio is done | Reduce or remove when using explicit **flush** / final message semantics; validate with Sarvam contract |
| **`high_vad_sensitivity`** | Set `false` in query | Affects Sarvam-side silence behaviour | Experiment per [Sarvam best practices](./vendor-offline/sarvam-stt-streaming.md) vs app VAD |
| **Rehint / multilingual** | Extra STT pass in voicebot when language flips | Extra latency on some turns | Language policy + fewer round-trips |

**Conclusion:** **Largest** engineering lift for TTFA is **true streaming STT** + **connection reuse** + **idle timer** review.

---

### 4.3 RAG / embedding / KB

| Item | Current | Impact | Change needed |
|------|---------|--------|---------------|
| **Embedding** | Self-hosted `nomic-embed-text` via `env.llm.baseUrl` | ~tens–low hundreds ms + network | Keep; add **caching** (already LRU in `llm.ts` for identical text); consider **latency SLO** on embedding service |
| **prepareQuestionForKbEmbedding** | May translate / rewrite for multilingual | Extra hop | Only if needed; measure |
| **Direct KB** | Only **first** user turn (`priorUserTurns === 0`) | **All later** turns pay **full** LLM + embedding | **Extend** direct-answer path (e.g. strong match on any turn), or **smaller** classifier to skip LLM when safe |
| **KB `top_k` / prompt size** | Configurable; system prompt can be **very** large | Larger **first token** from OpenAI | Shorter voice-specific prompts; trim KB injection for voice |

**Conclusion:** After turn 1, **RAG+LLM is mandatory** today for many calls — **strong** direct-match or **smaller** models are needed for consistent &lt; 2 s.

---

### 4.4 LLM (OpenAI)

| Item | Current | Impact | Change needed |
|------|---------|--------|---------------|
| **Streaming** | Used when `rag_streaming_enabled` **and** `tts_streaming_enabled` | Good: TTS can start at first sentence | Ensure both flags **true** in production DB |
| **Model** | `llm_model_override` / `openai_model` (e.g. `gpt-4o-mini`) | TTFT varies | Evaluate **faster** models for voice-only; A/B quality |
| **`max_tokens`** | Capped in session (e.g. 150) | Helps | Keep answers short |
| **History** | Full `trimRagHistory` | Longer prompts | Cap turns for voice (`rag_history_max_turns` is catalogued; **not enforced** in code per `SETTINGS_AND_FEATURES_CATALOG.md`) — **implement** cap for voice |

**Conclusion:** Streaming is **necessary but not sufficient**; **prompt size** and **model choice** must be part of the budget.

---

### 4.5 TTS (Sarvam)

| Item | Current | Impact | Change needed |
|------|---------|--------|---------------|
| **HTTP stream** | `fetch` + **`arrayBuffer()`** full body | No early audio | Use **`ReadableStream`** incremental read **or** switch to [**Sarvam TTS WebSocket**](./vendor-offline/sarvam-tts-websocket.md) for chunkwise audio |
| **Decode** | WAV/PCM parse; on failure → **REST** | **Double** latency (seen in logs) | Fix format/codec alignment; or **single** API (REST only) until fixed |
| **Codec** | Often `wav` for Exotel path | Must match parser and resampler | Explicit contract: e.g. **linear16 / 8 kHz** if Sarvam supports for telephony, or resample once |
| **Per-sentence `speakToExotel`** | Sequential `await` each sentence | Second sentence waits for first TTS HTTP to complete | Overlap only if streaming decode pipes partial PCM (today: **no**) |

**Conclusion:** **P0** — eliminate double TTS; **P1** — true chunked TTS → Exotel.

---

### 4.6 Exotel outbound

| Item | Current | Impact | Change needed |
|------|---------|--------|---------------|
| **Chunking** | `PcmChunkBuffer` after PCM ready | Correct per [Exotel rules](./vendor-offline/exotel-stream-voicebot-applet.md) | **No** change once PCM arrives early |
| **Marks** | Pending marks block next `processUtterance` | Turn-taking delay | By design; only “change” is product (barge-in) |

**Conclusion:** Exotel is **rarely** the bottleneck; **upstream** generation is.

---

### 4.7 Configuration / feature flags (database)

| Setting | Required for | Note |
|--------|----------------|------|
| `rag_streaming_enabled` | `streamChatOpenAI` path | **Both** with TTS |
| `tts_streaming_enabled` | Stream path + HTTP stream attempt | Triggers `http_stream` in logs |
| `stt_streaming_enabled` | WebSocket STT in code | Does **not** change feeding pattern today — still batch WAV |
| `vad_silence_timeout_ms` | Endpointing | 500 ms is already tight |

**Change needed:** Operate with **RAG + TTS streaming on**; treat **STT** flag as “use WS transport” only until true streaming is implemented (see [`VOICEBOT_LATENCY_SUB_2S_PLAN.md`](./VOICEBOT_LATENCY_SUB_2S_PLAN.md) §2).

---

## 5. Feasibility summary

| Scenario | Achievable &lt; 2 s TTFA (roughly)? | Why |
|----------|-------------------------------------|-----|
| **Direct KB hit** (short answer, single TTS) | **Yes**, often | No LLM; still need **fast** TTS (no double round trip) |
| **First user turn** with direct KB + fixed threshold | **Possible** if TTS &lt; ~1.5 s | Embeddings + DB + one TTS |
| **Subsequent turns** (full RAG + LLM today) | **Hard** for p90 &lt; 2 s | Embedding + OpenAI TTFT + at least one TTS call — need **faster** model, **shorter** prompt, **streaming TTS** |
| **Long user utterance** (many seconds of audio) | **No** for “after query” if STT is end-of-utterance batch | **Streaming STT** required to overlap |

**Bottom line:** **&lt; 2 s as a median TTFA** is a reasonable **12–18+ month** cross-functional goal with a **phased** roadmap; **&lt; 2 s every time** is not a promise without **scope** limits (e.g. short questions, warm STT/TTS, regional low RTT).

---

## 6. What to change (checklist, no code)

### P0 — Must-fix for any honest latency improvement

1. **TTS:** Stop **stream decode failure → second REST** on every sentence (root-cause format/codec; or single API until fixed). **Evidence:** `pipeline.tts.sarvam_decode_rest` in logs.  
2. **TTS:** Replace full-body `arrayBuffer()` with **streamed** consumption **or** Sarvam **TTS WebSocket** with chunked decode → resample → Exotel. **Docs:** [`sarvam-tts-http-stream.md`](./vendor-offline/sarvam-tts-http-stream.md), [`sarvam-tts-websocket.md`](./vendor-offline/sarvam-tts-websocket.md).  
3. **STT:** Revisit **`idleMs = 2000`** in `sarvamSpeechToTextWebsocket` for batch mode; confirm against Sarvam’s flush/final message semantics.  
4. **Settings:** Ensure **`rag_streaming_enabled`** and **`tts_streaming_enabled`** are **true** for tenants that need low latency.  

### P1 — Structural (needed for consistent sub–2 s)

5. **STT:** **Persistent** STT WebSocket per call + **stream** Exotel PCM incrementally (not one WAV at end). **Doc:** STT streaming + [`LATENCY_STREAMING_PLAYBOOK.md`](./vendor-offline/LATENCY_STREAMING_PLAYBOOK.md).  
6. **RAG:** **Extend** strong-match shortcut beyond first user turn **or** add a lightweight **intent/router** to skip LLM when safe.  
7. **RAG:** **Enforce** a **max history turns** for voice (catalog field exists; wire it in `trimRagHistory` or voice path only).  
8. **LLM:** Voice-specific **shorter** system prompt; evaluate **faster** model.  

### P2 — Product and operations

9. **Greeting:** Pre-render or cache greeting audio per voice/settings.  
10. **Observability:** Log **TTFA** explicitly (timestamp `utterance.received` → first `exotel.out.media_batch` of answer).  
11. **SLO:** Define **p50 / p90** on TTFA, not a single max.  
12. **Load tests:** Self-hosted **embeddings** and **OpenAI** region RTT.  

### P3 — Optional / longer term

13. **Barge-in** (`barge_in_enabled`) — product trade-offs; can unblock `processUtterance` during TTS.  
14. **ElevenLabs** path — separate tuning; not covered in Sarvam logs.  

---

## 7. What we do **not** need to change (usually)

- **Exotel** bidirectional protocol and 320-byte rules — already encoded in `pcm-audio.ts`.  
- **Basic RAG** vector index — unless latency tests show DB as top bottleneck.  

---

## 8. Validation (before/after any milestone)

- **A/B** logs: rate of `stream_body_not_decodable`, p50/p90 **STT** duration, **first `tts.start` − `utterance.received`**.  
- **Synthetic calls** with **short** questions at **8 kHz** (match production).  
- **Regression:** multilingual rehint, direct KB, empty KB, error paths.  

---

## 9. Document map

| Doc | Role |
|-----|------|
| This file | **What to change** to approach &lt; 2 s; feasibility |
| [`VOICEBOT_STREAMING_LOG_ANALYSIS.md`](./VOICEBOT_STREAMING_LOG_ANALYSIS.md) | Evidence from one call + plain-language conclusion |
| [`VOICEBOT_LATENCY_SUB_2S_PLAN.md`](./VOICEBOT_LATENCY_SUB_2S_PLAN.md) | SLO definitions, customer flags |
| [`vendor-offline/`](./vendor-offline/) | Sarvam + Exotel **offline** references |
| [`EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`](./EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md) | Chunk alignment details |

---

*Prepared from codebase review and internal/vendor docs. Update this document when the voicebot pipeline or database schema for settings changes.*
