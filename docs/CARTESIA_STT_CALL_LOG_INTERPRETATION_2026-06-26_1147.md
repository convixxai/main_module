# Cartesia STT Call Log Interpretation — 2026-06-26 11:47 IST

**Call:** `stream_sid=9d6b513e39ebd4aa3c50558c30151a6q`  
**Customer:** `ead34d8f-de23-452c-9091-85b2af98ac82`  
**Symptom:** Caller speech detected by VAD (~3.2 s PCM buffered) but **Cartesia STT returns empty transcript** → pipeline stops before RAG/LLM.

---

## Timeline (what happened)

| Time | Event | Meaning |
|------|--------|---------|
| 11:47:16 | Exotel `connected` + `start` | Call bridged; Exotel reports `sample_rate=8000`, `encoding=base64` in start JSON |
| 11:47:16 | `pipeline.stt.cartesia_stream_connected` | Persistent Cartesia Manual STT WebSocket opened @ 8 kHz |
| 11:47:16 | Greeting sent (cached PCM) | Bot speaks first; inbound STT blocked until `mark_1` ack |
| 11:47:18 | `mark_1` ack | Playback done; inbound buffer cleared; caller may speak |
| 11:47:23 | `vad.timeout_triggered` | **52160 bytes (~3.26 s)** of speech buffered — VAD worked |
| 11:47:23 | `pipeline.stt.request` | Cartesia STT, **streaming WS**, `stt_implementation=websocket` |
| 11:47:23 | `pipeline.stt.empty_transcript` | STT returned `{ transcript: "", language_code: "en-IN" }` — **RAG never ran** |
| 11:47:31+ | Same pattern repeats | 820 ms, 600 ms utterances also → empty transcript |

---

## Root cause (code bug — fixed)

### Primary: `flush_done` resolved finalize too early

Cartesia Manual STT event order after `finalize`:

```
transcript (is_final: true)  →  flush_done  →  done
```

Our handler treated **`flush_done` the same as `done`** and immediately resolved the finalize promise — often **before** the `transcript` event arrived.

**Evidence in your log:** STT request and empty transcript share the **same timestamp** (`11:47:23`) with ~52 KB of audio. Real transcription at 8 kHz would take hundreds of ms minimum. Instant empty = finalize settled without waiting for transcript events.

**Fix applied:** `apps/api/src/services/cartesia-stt-ws.ts`

- `flush_done` → schedule a short settle timer only (do **not** resolve empty immediately)
- `done` → resolve with concatenated `is_final` transcript chunks
- `transcript` + `is_final` → append text, schedule settle backup

### Secondary: no fallback when streaming returned HTTP 200 + empty text

Streaming path only fell back to per-utterance batch WS on **non-200** status. Empty transcript still returned 200 → no retry.

**Fix applied:** `exotel-voicebot.ts` — if streaming finalize is empty, close streaming session, retry `cartesiaSpeechToTextWebsocket()` with full utterance PCM, reconnect streaming WS for next turn.

---

## What was NOT the problem

| Observation | Verdict |
|-------------|---------|
| VAD / buffering | **Working** — 163 chunks, 52 KB, ~3.26 s estimated duration |
| Cartesia WS connect | **Working** — `cartesia_stream_connected` at call start |
| Greeting blocking STT | **Expected** — STT only after `mark_1` at 11:47:18 |
| `encoding: "base64"` in Exotel `start` | **Misleading label only** — Exotel uses base64 **transport** for `media.payload`; we decode to raw PCM (`decodeBase64Pcm`). Not the same as μ-law/A-law codec mismatch |
| `cartesia_stt_full_auto: true` | **OK** — omits language hint (open detect); not related to empty transcript |
| RAG / LLM | **Never reached** — `processUtterance` returns early on empty transcript at line ~3320 |

---

## Why RAG did not run

Pipeline gate in `exotel-voicebot.ts`:

```
STT → if (!transcript) return;  ← your calls stopped here
    → language policy
    → runVoicebotAskPipeline / RAG
    → TTS reply
```

Empty STT is intentional short-circuit (avoid hallucinating on silence/noise).

---

## Configuration snapshot (from log)

| Setting | Value |
|---------|--------|
| `stt_provider` | `cartesia` |
| `stt_streaming_enabled` | `true` |
| `stt_implementation` | `websocket` (persistent stream) |
| `multilingual` | `true` |
| `cartesia_stt_full_auto` | `true` (env) |
| `current_language_code` | `en-IN` |
| Exotel sample rate | 8000 Hz |

---

## Recommended actions after deploy

1. **Deploy** the `cartesia-stt-ws.ts` + `exotel-voicebot.ts` fixes and restart `convixx-api`.
2. **Retest** same tenant — expect `pipeline.stt.request` followed by non-empty transcript (or batch fallback trace `cartesia_stream_fallback` once, then text).
3. **Optional:** set `VOICEBOT_CARTESIA_STT_FULL_AUTO=false` and pass explicit `language=en|hi|mr` for narrowband accuracy once transcripts work.
4. **Optional:** set `stt_streaming_enabled=false` temporarily to force per-utterance batch WS only (simpler debug path).
5. **If still empty after fix:** capture one utterance PCM to disk and replay with Cartesia Manual WS offline; verify `CARTESIA_API_KEY` and ink-whisper quota.

---

## Expected log after fix

```
voicebot stage: vad.timeout_triggered          (buffered_bytes: 52160)
voicebot stage: utterance.received
voicebot:pipeline.stt.request                  (stt_provider: cartesia)
voicebot:pipeline.stt.cartesia_language_hint
[ optional: pipeline.stt.cartesia_stream_fallback if stream empty ]
voicebot stage: rag.* / pipeline.llm.*         ← should appear when transcript non-empty
voicebot:exotel.out.media_batch                ← bot reply audio
```

---

## Related files

- `apps/api/src/services/cartesia-stt-ws.ts` — finalize event handling
- `apps/api/src/routes/exotel-voicebot.ts` — empty-transcript batch fallback
- `docs/CARTESIA_STT_VOICEBOT_INTEGRATION_PLAN.md` — integration design
- `docs/sql/cartesia_stt_setup.sql` — DB enablement
