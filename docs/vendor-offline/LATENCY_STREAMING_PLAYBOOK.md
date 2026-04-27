# Sub–2 s voicebot responses + streaming — playbook (Convixx)

**Audience:** Engineers integrating **Exotel Voicebot** with **Sarvam** (STT/TTS) and our **RAG+LLM** path in `apps/api`.

**What “&lt; 2 s” should mean:** **Time to first audio (TTFA)** from **end of caller speech** (or from **VAD commit** / start of `processUtterance`) until the **first** outbound PCM we send to Exotel — *not* “AI finished the whole reply.”

See also: [`../VOICEBOT_STREAMING_LOG_ANALYSIS.md`](../VOICEBOT_STREAMING_LOG_ANALYSIS.md), [`../VOICEBOT_LATENCY_SUB_2S_PLAN.md`](../VOICEBOT_LATENCY_SUB_2S_PLAN.md).

---

## 1. What each vendor is good for (latency)

| Layer | Exotel (Voicebot) | Sarvam STT (streaming API) | Sarvam TTS |
|--------|-------------------|----------------------------|------------|
| **Role** | Real-time 8/16 kHz **PCM in/out** over WebSocket; **chunking rules** for stable audio | **WebSocket** STT: partial/final text **while audio is sent** if you **stream** frames | **HTTP stream** = binary pipe; **WebSocket TTS** = **base64 audio chunks** + config once |
| **Latency lever** | Send outbound **`media` in valid chunks** (min 3.2 KB, max 100 KB, **multiple of 320 B**) so playout starts quickly without gaps | **Do not** wait for full utterance WAV if you want low TTFA: **feed** PCM/frames continuously | **Do not** `arrayBuffer()` the full HTTP body before first decode: **read stream**; or use **TTS WebSocket** + pipe chunks to resampler/Exotel |
| **Docs** | [exotel-stream-voicebot-applet.md](./exotel-stream-voicebot-applet.md) | [sarvam-stt-streaming.md](./sarvam-stt-streaming.md) | [sarvam-tts-http-stream.md](./sarvam-tts-http-stream.md), [sarvam-tts-websocket.md](./sarvam-tts-websocket.md) |

**Key insight:** Exotel is already “streaming” **in both directions** at the transport level. **Perceived** latency is dominated by **our** batching: STT after full buffer, TTS after full body, and optional **double TTS** when stream decode fails (see log analysis doc).

---

## 2. Target architecture for &lt; 2 s TTFA (strawman)

1. **Inbound (caller → us)**  
   - Open **Sarvam STT streaming** WebSocket **once per call** (or pool).  
   - Forward Exotel `media` **decoded PCM** in **windows** (e.g. 100–200 ms) matching Sarvam’s expected streaming pattern — not one giant WAV at end of turn.  
   - Combine with **our** VAD/endpointing: `vad_silence_timeout_ms` (e.g. 500) decides **when** to **flush** STT and move to the LLM; optional Sarvam `flush_signal` / `vad_signals` to align.  

2. **Brain (LLM)**  
   - Keep **`rag_streaming_enabled` + `tts_streaming_enabled`** so tokens hit TTS in **sentence** chunks (already in `exotel-voicebot.ts` via `streamChatOpenAI` + `createStreamingVoiceTts`).

3. **Outbound (us → caller)**  
   - **Option A — Sarvam TTS WebSocket (recommended for lowest TTFB):** one persistent connection per call: `config` (codec/sample rate that you can resample to 8 kHz) → `text` / `convert` for each **sentence** → decode base64 chunks → resample to Exotel rate → `sendAudioToExotel` in **≥3.2 KB** aligned chunks.  
   - **Option B — HTTP `/text-to-speech/stream`:** use **`response.body` as a ReadableStream** (or reader), buffer until you can **decode a WAV frame or PCM**, then emit PCM in Exotel-sized chunks — **never** `arrayBuffer()` if you want streaming.  
   - **Fix** stream decode to avoid **REST fallback** on every line (log: `stream_body_not_decodable`).

4. **Exotel**  
   - No change to protocol: obey **320-byte** alignment and min chunk size; send **`mark`** after each logical playout for turn-taking.

---

## 3. Quick wins (minimal architecture change)

| Action | Why |
|--------|-----|
| Fix or bypass **TTS stream decode** (or use **REST** only for now) | Avoids **double** Sarvam round trip per sentence |
| Use **`fetch` stream reader** for HTTP TTS or switch to **TTS WebSocket** | First **audio** leaves server sooner |
| Shorter system prompt / **direct-KB** path when vector distance is low | Cuts first-token and total LLM time |
| Keep **`vad_silence_timeout_ms`** in ~**500–800 ms** with QA | Reduces post-speech wait for endpointing (tenant already at 500 ms) |
| Pre-cache or pre-generate **greeting** | Removes cold path on first `tts` |

---

## 4. Where this lives in code (reference)

- `apps/api/src/routes/exotel-voicebot.ts` — VAD, `processUtterance`, `speakToExotel`, `createStreamingVoiceTts`, RAG stream path  
- `apps/api/src/services/sarvam.ts` — `sarvamTextToSpeechStream`, `sarvamSpeechToTextWebsocket` (current STT is **one-shot** WAV)  
- `apps/api/src/services/pcm-audio.ts` — `PcmChunkBuffer`, Exotel alignment  
- `customer_settings` — `rag_streaming_enabled`, `tts_streaming_enabled`, `stt_streaming_enabled`, VAD fields  

---

## 5. “Streaming to the user” — three layers

1. **LLM streaming** — partial text → TTS in sentence slices (**already** when RAG+TTS flags on).  
2. **Sarvam TTS streaming** — **HTTP stream read** or **TTS WebSocket** chunks (vendor supports; we must **consume** incrementally and decode).  
3. **Exotel** — many small **`media`** messages (**already** once we have PCM: `sendAudioToExotel`).

The **gap** is mostly **#2 and STT** — until those stream, the caller still waits for large buffers.

---

## 6. Refreshing offline docs in this folder

- Sarvam: re-fetch `llms-full.txt` or add `.md` to doc URLs (per Sarvam header on each page).  
- Exotel: re-read the [support article](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet) and update [exotel-stream-voicebot-applet.md](./exotel-stream-voicebot-applet.md) if chunk rules or event names change.

---

*Internal playbook — not a commitment of SLA. Measure TTFA in production with structured logs (see `VOICEBOT_STREAMING_LOG_ANALYSIS.md`).*
