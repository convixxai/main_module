# Cartesia STT Call Log Interpretation — 2026-06-26 23:14 IST

**Call:** `stream_sid=1bb8522f9937b1588298b6f7d2591a6q`  
**Customer:** `ead34d8f-de23-452c-9091-85b2af98ac82` (Chhavani Resort)  
**Caller:** `08898442005` → Exotel `02048555864`  
**Symptom:** Caller speech is detected (~5 s / ~4 s PCM), but **Cartesia STT returns garbage** — turn 1: `"."` only; turn 2: broken English (`"Yes, I that this a 6-10 resort."`) instead of Hindi/Marathi. Bot replies are generic and unrelated to what the caller likely said.

---

## Timeline (what happened)

| Time | Event | Meaning |
|------|--------|---------|
| 23:14:43 | Exotel `start` | 8 kHz telephony stream; `encoding=base64` (transport only) |
| 23:14:43 | `cartesia_stream_connected` | Persistent Cartesia STT WS opened **without language param** |
| 23:14:43–44 | Greeting TTS + `mark_1` ack @ 23:14:46 | Bot speaks first; inbound STT blocked until playback done |
| 23:14:51 | Turn 1: VAD 84160 B (~5.26 s) | Real caller audio buffered |
| 23:14:52 | STT → `"."` (1 char) | **Not treated as empty** → RAG + LLM ran on noise |
| 23:14:54 | LLM: *"Is there something specific you'd like to know?"* | Generic fallback to meaningless input |
| 23:15:02 | Turn 2: VAD 65920 B (~4.12 s) | Caller speaks again |
| 23:15:02 | `cartesia_stream_fallback` | Streaming STT empty → batch retry |
| 23:15:03 | STT → `"Yes, I that this a 6-10 resort."` | Garbled English (likely misheard Hindi/Marathi or brand name) |
| 23:15:05 | LLM: *"Chhavani Resort offers a luxurious experience…"* | KB match on broken text, not caller intent |
| 23:15:10 | Exotel `stop` | Call ended |

---

## Root causes — why Hindi/Marathi fail

### 1. `VOICEBOT_CARTESIA_STT_FULL_AUTO=true` (primary)

Log shows:

```json
"cartesia_stt_full_auto": true,
"language_code_sent": "auto"
```

When full-auto is on, **no `language=hi` or `language=mr`** is sent to ink-whisper. At **8 kHz narrowband telephony**, open language detection strongly biases toward **English**. Hindi and Marathi Devanagari speech is often transcribed as:

- punctuation only (`"."`)
- broken English fragments
- wrong language tag `en-IN`

**Fix:** Set `VOICEBOT_CARTESIA_STT_FULL_AUTO=false` in production `.env` and restart `convixx-api`.

---

### 2. Streaming WebSocket connected without language at call start

At `23:14:43`:

```
pipeline.stt.cartesia_stream_connected  sample_rate=8000  (no language field)
```

The persistent STT socket was opened once per call with **no language hint**. All inbound PCM during turn 1 was streamed on that English-biased connection.

For **multilingual tenants** (en-IN + hi-IN + mr-IN), streaming cannot reliably switch language mid-call.

**Fix (code):** Multilingual Cartesia STT now uses **per-utterance batch WebSocket** with explicit `language` on each connect. Streaming is kept only for **single-language** tenants.

---

### 3. Session language stuck at `en-IN`

Throughout the call:

```
current_language_code: en-IN
default_language_code: en-IN
```

Even after the caller spoke (likely Hindi/Marathi), STT was not re-biased to `hi` or `mr` because:

- full-auto omitted language hints
- transcript `"."` has no Devanagari → script-based language override never runs
- turn 2 garbled English is Latin script → inferred as `en-IN`

**Fix:** With full-auto off, pass `language=hi|mr|en` from `session.currentLanguageCode` / default. After a good Devanagari transcript, script inference updates the session for the next turn.

---

### 4. Punctuation-only transcript treated as valid speech (turn 1)

Turn 1 returned `transcript: "."` with `transcript_chars: 1`. Pipeline continued to RAG because only **empty string** was rejected — not noise punctuation.

**Fix (code):** `isEffectivelyEmptySttTranscript()` treats `.`, `?`, `…`, etc. as empty → skip RAG, wait for real speech.

---

### 5. Streaming STT still unreliable on turn 2

Turn 2 log:

```
pipeline.stt.cartesia_stream_fallback  empty_transcript: true
pipeline.stt.script_language_override  transcript_preview: "Yes, I that this a 6-10 resort."
```

Streaming returned empty; batch fallback produced text but **still with `language=auto`** (full-auto). Batch took **1227 ms STT** vs **475 ms** on turn 1 — extra latency without fixing language.

**Fix (code):** Batch path retries with **`hi` then `mr`** when the first result is noise/empty and those languages are in the tenant allow-list.

---

## What was working correctly

| Component | Status |
|-----------|--------|
| Exotel WebSocket / media | OK |
| VAD + utterance buffering | OK (263 / 206 chunks) |
| Greeting TTS + mark ack | OK |
| Cartesia TTS outbound | OK |
| RAG / LLM pipeline | OK (but fed bad STT input) |
| `flush_done` early-resolve bug | Fixed in earlier deploy (see 11:47 doc) |

---

## Configuration snapshot (from log)

| Setting | Value | Impact |
|---------|--------|--------|
| `stt_provider` | `cartesia` | ink-whisper |
| `stt_streaming_enabled` | `true` | Used streaming on turn 1 |
| `multilingual` | `true` | en-IN, hi-IN, mr-IN allowed |
| `cartesia_stt_full_auto` | **`true`** | **Always `language=auto` — main Hindi/Marathi issue** |
| `current_language_code` | `en-IN` | English bias entire call |
| Exotel sample rate | 8000 Hz | Narrowband — needs explicit language |
| TTS | Cartesia sonic-3.5 | Unrelated to STT issue |

---

## Recommended fixes (priority order)

### Immediate — ops / env (no code deploy)

1. **Set `VOICEBOT_CARTESIA_STT_FULL_AUTO=false`** in `.env` on `convixx-ai-main`.
2. **Restart** `convixx-api` (`pm2 restart convixx-api`).
3. If callers are **Hindi-first**, set tenant `default_language_code` to `hi-IN` in customer settings (or keep `en-IN` but expect first Hindi utterance to trigger indic retry when full-auto is off).
4. **Retest** with clear Hindi: *"क्या यह रिसॉर्ट बच्चों के लिए सही है?"*

### After code deploy (this repo)

| Change | File | Effect |
|--------|------|--------|
| Treat `"."` as empty STT | `voice-language-infer.ts` | Turn 1 no longer triggers nonsense RAG |
| Explicit `language` when not full-auto | `exotel-voicebot.ts` | Sends `hi`/`mr`/`en` to ink-whisper |
| Multilingual → batch STT only | `exotel-voicebot.ts` | Language set on every utterance connect |
| Indic retry (`hi`, `mr`) on noise | `exotel-voicebot.ts` | Helps when full-auto or English bias returns empty |
| Streaming WS with language (single-lang only) | `exotel-voicebot.ts` | English-only tenants keep low-latency stream |

### Optional tuning

| Option | When to use |
|--------|-------------|
| `stt_streaming_enabled=false` | Simplest debug path; force batch every utterance |
| Switch STT to **Sarvam** for this tenant | Best telephony Hindi/Marathi quality today |
| Add `stt_domain_words` | Fix brand names: `"Chhavani"`, `"Chavni Lohagad"`, etc. |
| Raise `vad_silence_timeout_ms` slightly | If utterances cut off mid-sentence |

---

## Expected logs after fix

**Hindi caller, full-auto off, default hi-IN:**

```
voicebot:pipeline.stt.cartesia_language_hint   language_code_sent: "hi"
voicebot stage: stt.done                        transcript_chars: >10, Devanagari in transcript
voicebot:pipeline.stt.script_language_override  script_inferred: hi-IN
voicebot:pipeline.rag.*                         question_preview: <actual Hindi question>
```

**If first attempt is noise with full-auto on:**

```
voicebot:pipeline.stt.cartesia_indic_language_retry   language_tried: "hi"
voicebot stage: stt.done                              transcript: <Hindi text>
```

**Punctuation-only (silence/noise):**

```
voicebot:pipeline.stt.empty_transcript   transcript_preview: "."
(no pipeline.rag.start)
```

---

## Comparison with 11:47 call (earlier same day)

| | 11:47 call | 23:14 call |
|---|------------|------------|
| STT result | Empty `""` | `"."` or garbled English |
| RAG ran? | No | Yes (turn 1 — bad) |
| Primary bug | `flush_done` too early | **Language auto + 8 kHz English bias** |
| Streaming | Empty finalize | Fallback on turn 2 only |

Both calls share: Cartesia STT, multilingual tenant, 8 kHz Exotel, `cartesia_stt_full_auto: true`.

---

## Why not ElevenLabs/Sarvam behavior?

- **Sarvam** sends explicit `language_code` (or `unknown`) per utterance on Indian telephony models tuned for 8 kHz.
- **ElevenLabs** multilingual path sends language hints after an open-detect window.
- **Cartesia ink-whisper** with `language=auto` at 8 kHz behaves like an English-first model unless you pass `hi` or `mr`.

For production Hindi/Marathi voicebots on Exotel, **Sarvam STT remains the recommended default**. Cartesia STT is viable after full-auto is disabled and explicit language hints + indic retry are enabled.

---

## Related files

- `apps/api/src/routes/exotel-voicebot.ts` — Cartesia STT language, batch vs stream, indic retry
- `apps/api/src/services/voice-language-infer.ts` — `isEffectivelyEmptySttTranscript()`
- `apps/api/src/services/cartesia-stt-ws.ts` — Manual STT WebSocket
- `apps/api/src/config/env.ts` — `VOICEBOT_CARTESIA_STT_FULL_AUTO`
- `docs/CARTESIA_STT_CALL_LOG_INTERPRETATION_2026-06-26_1147.md` — empty transcript bug
- `docs/CARTESIA_STT_VOICEBOT_INTEGRATION_PLAN.md` — integration design
- `docs/sql/cartesia_stt_setup.sql` — DB enablement

---

## Quick action checklist

- [ ] Set `VOICEBOT_CARTESIA_STT_FULL_AUTO=false`
- [ ] Deploy latest API (punctuation filter + multilingual batch + indic retry)
- [ ] Restart `convixx-api`
- [ ] Test Hindi and Marathi utterances on same tenant
- [ ] If quality still poor, switch tenant `stt_provider` to `sarvam` or disable `stt_streaming_enabled`
