# Exotel Voicebot Debug Report (2026-04-14)

## Scope

This report explains why you are not hearing greeting/response on Exotel, using:

- Runtime log: `C:/Users/dhira/Downloads/convixx-2026-04-14 (2).log`
- Current server flow in `apps/api/src/routes/exotel-voicebot.ts`
- Exotel Agent Stream references:
  - <https://github.com/exotel/Agent-Stream>
  - <https://github.com/exotel/Agent-Stream-echobot>
  - <https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet>

---

## Final Conclusion (Short)

Greeting **is being sent from our system to Exotel**.

The immediate issue is **not "greeting not sent"**.  
The issue is that our barge-in logic is triggering almost instantly and sending `clear`, while inbound media continues continuously, so utterance processing never reaches STT/RAG/TTS response before call stop.

---

## Evidence Timeline From Log

### 1) Stream starts correctly
- `L8`: Exotel `start` event received.
- `L10`: `voicebotStage":"call.started"`.

### 2) Greeting TTS pipeline runs correctly
- `L12`: `voicebotStage":"greeting.sending"`.
- `L13`: `voicebotStage":"tts.start"`.
- `L14`: `pipeline.tts.request` with text `"Hello! How can I help you today?"`.
- `L57`: `pipeline.tts.response` with `wav_b64_chars: 36468`.

### 3) Greeting audio is sent to Exotel
- `L58`: `exotel.out.media_batch` with `pcm_in_bytes:27306`, `media_chunks:5`.
- `L59`: outbound `mark` sent (`mark_1`).
- `L60`: `voicebotStage":"tts.sent_to_exotel"`.
- `L61`: `voicebotStage":"greeting.sent"`.

This confirms app-side send path is working.

### 4) Greeting is interrupted immediately
- `L62`: inbound media continues.
- `L63`: outbound `clear` sent to Exotel.
- `L64`: `voicebot: barge-in detected` with `pcm_chunk:320`.

So greeting playback is likely cut by our own clear/barge-in path almost instantly.

### 5) No STT/RAG response cycle occurs
- No `vad.timeout_triggered`
- No `stt.done`
- No `rag.embedding.done`
- No `rag.llm.done`
- No second `tts.start` for user response

This means inbound audio never reached a completed utterance turn.

### 6) Call ends with unprocessed audio
- `L938`: Exotel `stop` (`reason: canceled or call ended`).
- `L940`: warning with `pending_bytes:292800`.

This is strong evidence that audio buffered but turn processing did not complete before termination.

---

## Why This Happens (Most Likely Root Cause)

## P1 (Highest): Over-aggressive barge-in trigger

Current logic in `exotel-voicebot.ts`:
- If `session.isSpeaking` and inbound chunk length `> 32`, send `clear`.

In this call, first interrupting chunk is `320` bytes (a normal 20ms frame), which is enough to trigger clear immediately (`L64`).

Impact:
- Greeting gets canceled before user can hear meaningful audio.
- Conversation turn state becomes unstable during early call phase.

## P2: Continuous inbound stream prevents VAD timeout path

Inbound media arrives every ~20ms continuously.  
If silence timer keeps resetting, `vad.timeout_triggered` never fires, so STT/RAG is never called.

Impact:
- No response speech generated after caller speaks.
- Large `pending_bytes` until call stop.

## P3: Exotel side call termination timing

`stop` arrives with reason `canceled or call ended` and WebSocket closes (`1006` logged after).  
Even if buffering exists, turn cannot finish if call ends first.

Impact:
- You hear no reply because call closes before utterance completion.

---

## What Is NOT Broken (Based on This Log)

- WebSocket connection upgrade and start event
- Greeting text generation
- TTS API request/response for greeting
- PCM chunk packaging and outbound media batch
- Mark event sending
- Call/session DB initialization

So the statement "greeting is not sent to Exotel" is **not supported** by this log; it is sent.

---

## Cross-check Against Exotel References

Exotel sample echo-bot patterns emphasize:
- listen -> silence detect -> respond
- clear handling for intentional interruption

In our trace, clear is firing too early (effectively on first small inbound frame while speaking), which can suppress audible greeting and break natural turn-taking.

---

## Immediate Debug Checklist (No Code Change in This Report)

1. Run one controlled call where caller stays fully silent for first 3 seconds.
   - Expected if healthy: hear greeting completely.
2. In same call, verify whether `clear` is emitted before first `mark` ack from Exotel.
3. Verify whether inbound 320-byte frames are present even during pure silence (they usually are in telephony streams).
4. Verify if any `vad.timeout_triggered` appears in logs after caller speaks then pauses.
5. Check if call is being ended by flow/app configuration on Exotel side (reason `canceled or call ended` suggests upstream flow end).

---

## Recommended Fix Direction (Next Engineering Step)

Priority order:

1. Harden barge-in detection (do not treat every 320-byte inbound frame as speech interruption).
2. Protect greeting window so it is not immediately cleared by baseline/noise frames.
3. Ensure utterance finalization works under continuous media conditions (silence/energy or max-window turn cut).
4. Add explicit logs for:
   - barge-in decision inputs (energy/rms, speaking state, mark state)
   - VAD timer arm/reset/fire counters
   - reason for `processUtterance` not firing

---

## One-line Diagnosis

Your system **does send greeting to Exotel**, but it is **almost immediately cleared by aggressive barge-in handling**, and then the call ends with unprocessed buffered audio before STT->RAG->TTS response can complete.

