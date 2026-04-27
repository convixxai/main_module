# Voicebot streaming & latency — analysis from `Streaming call.json` (2026-04-27)

This document ties the sample call log to the current implementation in `apps/api/src/routes/exotel-voicebot.ts`, `apps/api/src/services/sarvam.ts`, and `apps/api/src/services/pcm-audio.ts`. It answers: **where time goes**, **what is actually streaming**, **why it still feels slow**, and **what to change** to approach a **&lt; 2 s time-to-first-audio (TTFA)** SLO from end-of-utterance (VAD commit).

---

## 1. Timestamps from the log (one call, `req-2`)

All times are server log timestamps (single host `convixx-ai-main`).

### 1.1 Greeting

| Event | Time | Δ from previous |
|--------|------|-----------------|
| `tts.start` (greeting) | 12:37:46 | — |
| `pipeline.tts.response` | 12:37:49 | **~3 s** |
| `tts.sent_to_exotel` | 12:37:50 | ~1 s batch send |

Greeting TTS alone waits on Sarvam for about **3 seconds** before the API has audio to send.

### 1.2 First user turn (after `mark_1` playback)

| Event | Time | Notes |
|--------|------|--------|
| `vad.timeout_triggered` / `utterance.received` | 12:38:02 | `buffered_bytes` 139840 ≈ **8.74 s** of 8 kHz s16le mono audio |
| `pipeline.stt.request` | 12:38:02 | `stt_streaming_enabled: true`, `stt_implementation: "websocket"` |
| `stt.done` / `pipeline.stt.response` | 12:38:05 | **~3 s** after STT start |
| `pipeline.rag.llm_stream` | 12:38:05 | `tts_streaming_enabled: true` |
| `tts.start` (first sentence) | 12:38:07 | ~2 s after RAG+LLM start (embed + first LLM tokens + sentence cut) |
| `pipeline.tts.response` | 12:38:11 | **~4 s** after first `tts.start` for this sentence |
| `openai_chat_stream_response` (full text) | 12:38:13 | LLM finished; TTS for second clause already started earlier |
| `utterance.completed` | 12:38:13 | `elapsed_ms`: **11513** (wall time from VAD/utterance start to turn completion) |

So for this turn, **TTFA** (from 12:38:02 to first audio outbound) is roughly **2 s (STT) + 2 s (to first TTS start) = ~4+ s** before Exotel even gets the first `media` batch — and the first TTS call alone logs **~4 s** from `tts.start` to `pipeline.tts.response` (12:38:07 → 11).

### 1.3 Second user turn (pet-friendly)

Similar pattern: STT 12:38:22 → 24 (~2 s), TTS work through 12:38:28–30, `elapsed_ms` **8284**.

---

## 2. Is “streaming” happening? (STT / LLM / TTS / Exotel)

### 2.1 STT (Sarvam)

- **Log:** `stt_streaming_enabled: true`, `stt_implementation: "websocket"`.
- **Code:** `sarvamSpeechToTextWebsocket` (`sarvam.ts`) opens a WebSocket, then on `open` sends the **entire** utterance as **one** base64 WAV payload and a `flush` — it is **not** interleaved with live Exotel `media` chunks.
- **Conclusion:** The path uses the **Sarvam STT WebSocket** transport, but end-to-end it behaves like a **batch** job: the full buffer is sent once after VAD, then the server waits for the final transcript (plus an idle window). **True real-time STT** (send PCM as the caller speaks) is **not** implemented. This matches `docs/VOICEBOT_LATENCY_SUB_2S_PLAN.md` §2: `stt_implementation: "batch"` in spirit even when the trace says `websocket`.

### 2.2 LLM (OpenAI)

- **Log:** `pipeline.rag.llm_stream`, `mode: "stream"`, `openai_chat_stream_request` / `openai_chat_stream_response`.
- **Code:** `streamChatOpenAI` with `createStreamingVoiceTts` — token deltas are buffered and `speakToExotel` is called per sentence (see `findNextSpeakCut`).
- **Conclusion:** **LLM streaming is used** when `rag_streaming_enabled` and `tts_streaming_enabled` are true. First TTS can start before the model finishes the full reply (first sentence at 12:38:07 while the logged full reply is at 12:38:13).

### 2.3 TTS (Sarvam)

- **Log:** `sarvam_tts_path: "http_stream"` and **`pipeline.tts.sarvam_decode_rest`** with `reason: "stream_body_not_decodable"`.
- **Code:**
  1. `sarvamTextToSpeechStream` does `await res.arrayBuffer()` — the **entire** HTTP body is buffered before return (`sarvam.ts`). There is **no** incremental reader.
  2. In `speakToExotel`, the buffer is passed through `tryDecodeSarvamAudio` / `parseWavToPcmS16leMono`. If decoding fails, the code calls **`sarvamTextToSpeech` (REST JSON)** again — a **second** full TTS request.

**Conclusion:** The log proves **Sarvam HTTP stream is not decoded in the current pipeline**; every such failure triggers a **REST fallback**, which **roughly doubles** TTS latency and work. The feature flag `tts_streaming_enabled` therefore enables *attempted* stream fetch, not **low-latency first PCM** to Exotel. **True TTS streaming** (chunked decode or PCM-only output, pipe to `sendAudioToExotel` as soon as a frame is valid) is **not** implemented.

### 2.4 Exotel (outbound)

- **Log:** `exotel.out.media_batch` with `media_chunks` 3–7, `outbound_b64_chars` in the tens of thousands.
- **Code:** `sendAudioToExotel` splits finished PCM with `PcmChunkBuffer` and sends **multiple** `media` WebSocket frames (aligned to 320-byte rules per `pcm-audio.ts` / spec).
- **Conclusion:** The **Exotel WebSocket** carries audio in **several** messages per utterance. That is **outbound chunking** over an already-finished TTS buffer — **not** the same as starting playback from Sarvam the millisecond the first 20–40 ms of audio exist. The bottleneck is **upstream**: we only call `sendAudioToExotel` after we have a full decode (or after REST returns).

**Summary table**

| Layer | Streaming? | What the log/code shows |
|--------|------------|-------------------------|
| Exotel → app (inbound) | Yes | Continuous `media` (not shown in snippet; session runs) |
| STT | No (batch end-of-utterance) | One WAV over WS after VAD |
| RAG+LLM | Yes | `pipeline.rag.llm_stream` |
| Sarvam TTS HTTP | No to caller | `arrayBuffer()` + often **decode fail → REST** |
| App → Exotel (outbound) | Chunked | Many `media` frames per TTS **segment** after PCM ready |

---

## 3. Why responses exceed ~4 s (and blow past 2 s TTFA)

1. **TTS path:** `http_stream` response is not decoded; **`stream_body_not_decodable` → REST** doubles work and time (see `exotel-voicebot.ts` around `pipeline.tts.sarvam_decode_rest`).
2. **TTS not incremental:** Even when decode succeeds, `sarvamTextToSpeechStream` waits for the **full** body before any audio is sent to Exotel.
3. **STT:** ~2–3 s for multi-second utterances is typical for a **single** round-trip after a long WAV; no overlap with the caller’s speech.
4. **Greeting** still pays full TTS + any double-fetch delay (~3 s in this log).
5. **RAG:** Embedding + `pipeline.rag.kb_hit` in the same second as STT in this log — not the top bottleneck vs STT+TTS here.
6. **VAD / buffer size:** The first turn buffered **~8.7 s** of audio (`estimated_ms`: 8740). That number is the **length of the audio clip** we kept, not the silence-timeout setting. This customer uses **`vad_silence_timeout_ms` = 500** (500 ms of quiet after speech to end the turn—see §4). A long buffer simply means the caller was still classified as “speaking” (or the line was non-quiet) for most of that window before **500 ms** of silence finally fired the timer.

---

## 4. Customer settings: `vad_silence_timeout_ms` = 500 (confirmed)

**Confirmed for this customer:** `customer_settings.vad_silence_timeout_ms` is **500**.

In `exotel-voicebot.ts`, `vadSilenceTimeoutMs()` applies values **300–30000** ms. So **500** means: after we last saw energy above the speech threshold, we wait **500 ms** of “silence” (low energy) and then **end the utterance** and run STT. That is a **relatively short** end-of-speech wait—good for snappy turns, with more risk of cutting off a slow speaker or a short mid-sentence pause.

**Not the same as:** `vad_energy_threshold` (RMS for speech vs silence, default 200). This tenant’s **500** is the **silence timeout in milliseconds**, not the energy threshold.

**Why the log can still show ~8 s of buffered audio (§1.2):** The timer only starts when the line looks **quiet** enough. If the caller is still talking, or background/line energy stays above the speech threshold, we **keep appending** audio until a **500 ms** quiet period ends the turn. The big buffer in the sample log is **not** because silence timeout is 8 seconds—it is how much audio we collected **before** that 500 ms quiet window completed.

---

## 5. Recommended fixes (priority order)

### P0 — Fix Sarvam stream decode (stop double TTS)

- Inspect the **Content-Type** and first KB of the HTTP stream from `POST /text-to-speech/stream` in staging (WAV 24-bit, MP3, or malformed RIFF are common reasons `parseWavToPcmS16leMono` returns null after RIFF is detected; see `tryDecodeSarvamAudio` in `exotel-voicebot.ts`).
- Extend decoding (or **force** `output_audio_codec` / request parameters) so the **stream** path decodes in **one** call.
- Until fixed, **disable** `tts_streaming_enabled` and use **REST JSON** only to avoid **two** full generations per sentence — often **lower** latency than stream+fail+REST.

### P1 — Real HTTP streaming for TTS

- Replace `res.arrayBuffer()` with a **ReadableStream** consumer: buffer until a decodable PCM/WAV window exists, or use Sarvam’s documented **PCM / chunk** behaviour if available.
- Feed `sendAudioToExotel` incrementally (still respecting `PCM_MIN_CHUNK_BYTES` and 320 alignment).

### P2 — Real streaming STT

- Pipe inbound Exotel PCM into Sarvam (or another) **streaming** STT session **during** the utterance, with endpointing from Silero/VAD or from Sarvam partials, instead of one WAV at VAD. This is the largest structural change for cutting **post-speech** latency.

### P3 — Product / RAG

- Shorter system prompts for voice, **direct-KB** short-circuit when distance &lt; threshold, faster/smaller `openai` model for voice if quality allows.

### P4 — Greeting

- Pre-render greeting once per voice/settings or use the **same** TTS path as P0 after decode fix; avoid **double** fetch on the first message.

---

## 6. How to verify in logs (after changes)

- **TTS:** No `pipeline.tts.sarvam_decode_rest` with `stream_body_not_decodable` on happy path; **one** of `http_stream` success or single REST, not both per sentence.
- **TTFA:** Time from `utterance.received` (or `vad.timeout_triggered`) to first `exotel.out.media_batch` for the **answer** — target **&lt; 2000 ms** in median on short questions.
- **STT:** If you add real streaming, new traces like `pipeline.stt.partial` / first partial before VAD if you use speculative pipeline (optional).

---

## 7. References in repo

- `docs/VOICEBOT_LATENCY_SUB_2S_PLAN.md` — SLO definition, customer flags, batch STT note.
- `docs/SETTINGS_AND_FEATURES_CATALOG.md` — `rag_streaming_enabled`, `tts_streaming_enabled`, `stt_streaming_enabled`, VAD fields.
- `docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md` — outbound PCM chunk rules.
- `apps/api/src/routes/exotel-voicebot.ts` — `speakToExotel`, `createStreamingVoiceTts`, `processUtterance`, VAD timer.
- `apps/api/src/services/sarvam.ts` — `sarvamTextToSpeechStream`, `sarvamSpeechToTextWebsocket`.
- `apps/api/src/services/pcm-audio.ts` — `parseWavToPcmS16leMono`, Exotel chunk bounds.

---

## 8. Conclusion (simple language)

On this call, the bot **felt slow** mainly because several steps run **one after another**, and some steps **do the same work twice**. After the customer stopped speaking, the system still needed a few seconds to turn speech into text, think of an answer, and turn that answer into voice. The **phone line itself** can send audio in a steady stream—that part is fine—but **our app waits** until it has the **full** recording before sending it to speech-to-text, and it often **waits for the full voice file** from Sarvam before playing anything. So even though the **brain of the reply** (the AI model) can stream words as they are generated, the **ears and mouth** side (speech recognition and text-to-speech) are still mostly **“wait until everything is ready”** in practice.

For this customer, **“500”** is confirmed as **`vad_silence_timeout_ms`**: the bot waits **half a second** of quiet after speech before it decides the user has finished. That is a reasonable choice for low latency. A different number (**`vad_energy_threshold`**) would control how loud the signal must be to count as speech; those two settings are not the same.

Getting consistently under **2 seconds** from “user finished talking” to “user hears the first word” will need **engineering changes** (especially fixing the double text-to-speech issue and, longer term, true streaming for recognition and speech). Tweaking settings alone can help a bit, but it won’t fix the big delays by itself.

---

## 9. What to fix (plain-language list)

Use this as a **non-technical checklist** aligned with the technical sections above.

1. **Stop doing text-to-speech twice** — When the “streaming” voice request returns audio we can’t decode, the system falls back and **generates the same line again** the slow way. Fix the format/decoding so we only generate once, or use the reliable method only until streaming is fixed.

2. **Make text-to-speech actually “stream”** — Today we download the **whole** audio file before playing. The next step is to start playing **small pieces** as soon as they arrive (while still following phone-network rules for chunk sizes).

3. **Make speech recognition work while the user is still talking** — Send audio to the recognizer **as it comes in**, instead of waiting for the full clip after silence. That cuts the wait after the user stops.

4. **Tune “when is the user done talking?”** — Adjust silence timing so we don’t wait too long after they pause, but test so we don’t cut them off mid-sentence.

5. **Keep answers short for voice** — Shorter prompts and answers mean less time for both thinking and speaking.

6. **Use the knowledge base shortcut when possible** — When the question clearly matches a stored question-and-answer pair, answer directly without a long model step.

7. **Speed up the opening greeting** — Cache or pre-build the hello message so the first sound isn’t delayed by the same slow path.

8. **Silence vs sensitivity** — For this tenant, **500** is already **`vad_silence_timeout_ms`** (half a second of quiet to end a turn). If you ever change behaviour, don’t confuse that with **`vad_energy_threshold`**, which is about how “loud” speech must be.

---

*This file was produced from a line-by-line review of `docs/Streaming call.json` and the current codebase. Re-run the same grep on logs after deploying fixes.*
