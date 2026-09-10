# Inbound & Outbound Calls — No Audio (Silence) — Log Analysis & Fix Guide

**Date:** 2026-07-08  
**Customer ID:** `ead34d8f-de23-452c-9091-85b2af98ac82`  
**Campaign ID:** `69309f58-f195-4542-8936-e8074762596d` (outbound test)  
**Symptom:** **Both inbound and outbound** calls connect, but caller hears **no greeting, no script, no bot replies**  
**Priority:** Critical — shared TTS pipeline failure (Cartesia)

---

## 1. Executive Summary

**Inbound and outbound failing together confirms one shared root cause: Cartesia TTS is not producing audio.**

Both call types use the same `speakToExotel()` → `cartesiaTts.speakIncremental()` path whenever `customer_settings.tts_provider = 'cartesia'`. Outbound logs already show `Cartesia TTS yielded 0 bytes`. Inbound calls hit the **same code** for:

- **Greeting** (plays immediately on `start` — no wait-for-speech)
- **Every RAG/LLM reply** after STT

So if Cartesia is broken, inbound callers hear **silence on pickup** and **silence on every bot response**, even though STT and LLM may still run in the background.

The outbound call **did reach your server and was correctly identified as a campaign call**. Speech detection and STT worked. The system **attempted to play the campaign script**, but **Cartesia TTS returned zero audio bytes** on every synthesis attempt.

This is **not** a missing script, Exotel routing failure, or outbound-only session-matching problem. **Audio generation failed silently at the TTS layer for all call directions.**

| Layer | Status in this call |
|-------|---------------------|
| Campaign trigger (`POST /outbound/campaigns/.../trigger`) | ✅ 200 OK |
| Exotel WebSocket connect | ✅ Connected + `start` event |
| Outbound session matching | ✅ Matched (`868fc4f6-2e2a-4c7c-a8a8-a778a38a1d82`) |
| Campaign mode detection | ✅ `outbound_campaign` |
| Wait-for-speech gate | ✅ Working as designed |
| STT (Sarvam) | ⚠️ WS timeout → HTTP fallback still produced transcripts |
| **Campaign script TTS (Cartesia)** | ❌ **`yielded 0 bytes`** — root cause of silence |
| Pre-rendered campaign WAV playback | ❌ Not used (dead code path) |
| **Inbound greeting TTS (Cartesia)** | ❌ Same failure expected — no `pipeline.tts.first_chunk` |
| **Inbound reply TTS (Cartesia)** | ❌ Same failure expected — silence after every STT/LLM turn |

---

## 1b. Why inbound fails the same way (code path)

| Call type | When TTS runs | Cartesia path |
|-----------|---------------|---------------|
| **Inbound** | Immediately on connect (`greeting.sending` → `speakToExotel`) | `cartesia-tts-ws.ts` WebSocket |
| **Inbound** | After each user utterance (RAG reply) | Same |
| **Outbound campaign** | After first confirmed STT (campaign script) | Same |
| **Outbound campaign** | After script (conversational replies) | Same |

**Inbound-specific note:** `voiceTtsCanRun()` in `exotel-voicebot.ts` only checks `SARVAM_API_KEY` when `tts_provider` is not ElevenLabs — it does **not** verify `CARTESIA_API_KEY`. So the greeting is **not skipped** even when Cartesia is misconfigured; it attempts Cartesia and fails with 0 bytes instead of logging `greeting audio skipped`.

**What to look for on an inbound test call:**

```text
greeting.sending
voicebot stage: tts.start          (tts_provider: cartesia)
voicebot Cartesia TTS yielded 0 bytes   ← same as outbound
greeting.tts_failed                  ← may appear if 0 bytes
```

If you see `greeting.sending` + `tts.start` but **no** `pipeline.tts.first_chunk`, inbound is broken for the same reason as outbound.

---

## 2. Call Timeline (outbound — from your logs)

```
10:45:37  Campaign trigger → Exotel call initiated (streamUrl wss://convixx.in/exotel/voicebot/...)
10:45:40  WebSocket req-16 opens (Leg 1 / inverted match, from===to 02048555864)
          → campaign mode: "waiting for first customer speech before playing script"
10:45:41  Exotel statusCallback: answered (CallSid 0d03b908...)
10:45:42  VAD fires → STT request (Sarvam WS → 504 timeout → HTTP fallback)
10:45:48  WebSocket req-19 opens (Leg 2, matched by CallSid after callee answered)
          → same campaign, also waiting for first speech
10:45:49  req-16 STT result: "ठीक है।" (hi-IN)
          → "customer speech confirmed via STT — playing campaign script"
          → acquired script lock on stream 176e51e5...
          → synthesizing realtime TTS (478 chars)
          → tts.start (Cartesia sonic-3.5, voice 5c32dce6..., 8kHz PCM)
          → ⚠️ "Cartesia TTS yielded 0 bytes"  ← NO AUDIO SENT
10:45:55  Disallowed-language path also tries TTS (89 chars) → again 0 bytes
10:45:58  Echo detection matches "Hello" against script text in buffer (text only, not audio)
10:46:00  req-19 also confirms speech → script skipped (duplicate lock held by req-16)
10:46:09  Call ends (stream stop: "canceled or call ended")
```

**What you experience on the phone:** silence after pickup, because **no PCM was ever streamed to Exotel**.

---

## 3. Root Cause

### Primary: Cartesia TTS produces no audio

The definitive failure lines:

```text
voicebot stage: tts.start
  tts_provider: cartesia
  tts_model: sonic-3.5
  tts_voice_id: 5c32dce6-936a-4892-b131-bafe474afe5f
  output_format: { sample_rate: 8000, encoding: pcm_s16le }

voicebot Cartesia TTS yielded 0 bytes   ← repeated 3 times in this call
```

**What this means in code** (`apps/api/src/routes/exotel-voicebot.ts`):

- `speakToExotel()` starts Cartesia synthesis via WebSocket (`cartesiaTts.speakIncremental()`).
- The async generator completed **without yielding any PCM chunks**.
- There is **no** `pipeline.tts.first_chunk` log (that only appears when the first audio chunk arrives).
- No `Cartesia TTS failed` exception was thrown — Cartesia likely returned a `done` event with an **empty chunk set** (silent failure).

**Cartesia worked for this same customer on 2026-06-25** (see `docs/CARTESIA_CALL_LOG_ANALYSIS_2026-06-25.md`, same voice ID, 37 KB greeting audio). Something changed in the **runtime environment or Cartesia account**, not in your outbound campaign wiring.

### Likely causes (check in this order)

1. **Cartesia API key invalid, expired, or rotated** — `CARTESIA_API_KEY` on `convixx-ai-main`
2. **Cartesia credits exhausted** — account may accept WS connect but return empty synthesis
3. **Voice ID `5c32dce6-936a-4892-b131-bafe474afe5f` deleted, revoked, or not on current plan**
4. **Cartesia service outage / regional latency** — WS connects but never sends chunks before implicit completion
5. **Network/firewall from app server to `wss://api.cartesia.ai`** — intermittent; Sarvam STT WS also timed out in this call

### Secondary (not the silence cause, but worth fixing)

| Issue | Evidence | Impact |
|-------|----------|--------|
| Sarvam STT WebSocket timeout | `pipeline.stt.websocket_fallback`, status 504 | STT still works via HTTP fallback; adds ~6s latency |
| Dual-leg streams (`from===to`) | req-16 + req-19, two `stream_sid` | Expected for Exotel Connect Two Numbers; coordination logic ran correctly |
| Echo buffer before TTS success | Script text added to `recentTTSTexts` before `speakToExotel` | False echo match on "Hello" even though audio never played |
| Pre-rendered WAV unused | `loadCampaignAudio()` exists but is never called | Campaign audio generated with Sarvam at create-time is ignored at playback |

---

## 4. Why it looks like "script is not being read"

Three separate behaviors can confuse debugging:

### A. Intentional silence until customer speaks

For `outbound_campaign` mode, the voicebot **does not greet immediately**. It logs:

```text
voicebot: campaign mode — waiting for first customer speech before playing script
```

This is **by design** (`exotel-voicebot.ts` ~5158). The script plays only after STT confirms real speech (not just VAD noise).

### B. Script trigger did fire in your call

At `10:45:49` the system logged:

```text
voicebot: customer speech confirmed via STT — playing campaign script
voicebot: synthesizing realtime TTS for campaign script (478 chars)
```

So the script **was** loaded from DB and synthesis **was** attempted.

### C. TTS returned nothing

Immediately after `tts.start`, Cartesia yielded **0 bytes** — so Exotel received **no `media` frames** to play. From the caller's perspective: dead silence.

---

## 5. Current Outbound Configuration (from codebase)

### 5.1 Campaign API (`apps/api/src/routes/outbound-campaigns.ts`)

| Step | Endpoint | Behavior |
|------|----------|----------|
| Create campaign | `POST /outbound/campaigns` | Sarvam TTS → saves `uploads/campaigns/{id}.wav` + `script_text` in DB |
| Add leads | `POST /outbound/campaigns/:id/leads` | Inserts phone numbers |
| Trigger | `POST /outbound/campaigns/:id/trigger` | Exotel Connect Two Numbers per pending lead |

**Trigger parameters (current):**

```text
streamUrl:        wss://convixx.in/exotel/voicebot/{customerId}
streamBegin:      atLeg2connect
statusCallback:   https://convixx.in/exotel-callback/status
statusCallbackEvents: ["answered", "terminal"]
customField:      campaign_id={id}|ccs={pendingSessionId}
```

### 5.2 Voicebot campaign flow (`apps/api/src/routes/exotel-voicebot.ts`)

1. Match outbound session (by `ccs` in custom field, CallSid, or inverted `from===to` recent session).
2. Set `session.mode = "outbound_campaign"`, `session.waitingForFirstSpeech = true`.
3. Skip inbound greeting.
4. On first **confirmed STT transcript** → atomic DB lock `script_played_by_stream`.
5. Load `script_text` from `outbound_campaigns` table.
6. **`speakToExotel()` with tenant `tts_provider`** (Cartesia in your logs) — **not** pre-rendered WAV.
7. After script, normal RAG conversational flow.

### 5.3 Tenant TTS/STT settings (from your logs)

| Setting | Value in this call |
|---------|-------------------|
| `tts_provider` | `cartesia` |
| `tts_model` | `sonic-3.5` |
| `tts_voice_id` | `5c32dce6-936a-4892-b131-bafe474afe5f` |
| `stt_provider` | `sarvam` |
| `stt_streaming_enabled` | `true` |
| Exotel media | 8 kHz, base64 PCM |
| `generation_config` | speed 1.05, volume 1.75, emotion neutral |
| Allowed languages | `en-IN`, `hi-IN`, `mr-IN` |

### 5.4 Environment flags (outbound echo / dual-leg)

From `apps/api/src/config/env.ts` (defaults unless env overrides):

| Variable | Default | Purpose |
|----------|---------|---------|
| `OUTBOUND_ECHO_SUPPRESSION_ENABLED` | `true` | Suppress STT matching recent TTS text |
| `OUTBOUND_CROSS_LEG_ECHO_ENABLED` | `true` | Shared DB TTS buffer + script lock across legs |
| `OUTBOUND_ECHO_SIMILARITY_THRESHOLD` | `0.6` | Echo text match threshold |
| `OUTBOUND_STT_SUPPRESSION_MULTIPLIER` | `1.5` | Secondary leg STT mute during script |
| `OUTBOUND_STT_SUPPRESSION_BUFFER_MS` | `5000` | Extra suppression after script |

### 5.5 Architectural gap: create vs playback TTS mismatch

| Phase | TTS engine | Output |
|-------|------------|--------|
| Campaign **create** | Sarvam (`sarvamTextToSpeechStream`) | WAV file on disk |
| Campaign **playback** | Tenant setting (`customer_settings.tts_provider` = Cartesia) | Realtime WS synthesis |

The function `loadCampaignAudio()` in `exotel-voicebot.ts` can read the pre-rendered WAV but **is never invoked**. Playback always goes through realtime TTS. If Cartesia fails, the Sarvam-generated fallback file is never used.

---

## 6. Fixes (restores **both** inbound and outbound)

### 6.1 Immediate ops (no code deploy) — do these first

#### Step 1: Verify Cartesia on the server

On `convixx-ai-main`:

```bash
# Confirm key is set (do not paste value in tickets)
grep -c CARTESIA_API_KEY /path/to/.env

# PM2 env
pm2 env convixx-api | grep CARTESIA
```

#### Step 2: Test Cartesia TTS directly

Use the Cartesia simulator in your admin UI (`/cartesia-simulator`) or curl the REST API with the same voice ID and 8 kHz output. If that also returns empty audio, the issue is **account/key/voice/credits**, not outbound logic.

#### Step 3: Check Cartesia dashboard

- Remaining credits / billing status
- Voice `5c32dce6-936a-4892-b131-bafe474afe5f` still exists and is API-accessible
- Any rate limits or errors around `2026-07-08 10:45 UTC`

#### Step 4: Quick workaround — switch tenant TTS to Sarvam (**fixes inbound + outbound**)

Since **both** call directions are silent, this is almost certainly Cartesia. Switching TTS provider restores greeting (inbound), replies (inbound), and campaign script (outbound) in one change.

```sql
-- Verify current setting
SELECT customer_id, tts_provider, tts_default_speaker, tts_model,
       stt_provider, default_language_code
FROM customer_settings
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';

-- Temporary workaround (only if SARVAM_API_KEY is set on server)
UPDATE customer_settings
SET tts_provider = 'sarvam'
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';
```

After update:

1. Place an **inbound** test call → should hear greeting within a few seconds.
2. Place an **outbound** campaign test → should hear script after you speak.

Restart PM2 only if settings appear cached (`pm2 restart convixx-api`).

**Alternative:** Fix `CARTESIA_API_KEY` / credits / voice ID and keep `tts_provider = 'cartesia'` if you prefer Cartesia voices.

#### Step 5: Confirm Sarvam API key (fallback path)

```bash
grep -c SARVAM_API_KEY /path/to/.env
```

Campaign **creation** already uses Sarvam; if that still works, Sarvam is healthy and Cartesia is the isolated failure.

### 6.2 Recommended code changes (next deploy)

These are **not applied in this document** — listed for engineering follow-up:

1. **Use pre-rendered campaign WAV as primary playback**
   - Call `loadCampaignAudio(campaignId)` before realtime TTS.
   - Resample WAV to Exotel 8 kHz if needed, stream via `sendAudioToExotel`.
   - Fall back to realtime TTS only if file missing.
   - Aligns with original plan in `docs/outbound_campaign_process_plan.md`.

2. **Fail loudly when Cartesia yields 0 bytes**
   - Log Cartesia WS last inbound message / `status_code`.
   - Auto-fallback to Sarvam TTS or pre-rendered WAV on zero-byte result.

3. **Pre-connect Cartesia WS for outbound campaigns**
   - Inbound greeting already pre-connects (`getOrCreateCartesiaTtsSession().connect()`).
   - Outbound campaign path skips this — add pre-connect at `call.started` for campaign mode.

4. **Add echo buffer only after successful TTS**
   - Move `addToRecentTTSBuffer()` to after `speakToExotel` returns `true`.
   - Prevents false echo suppression when TTS fails (your log at 10:45:58).

5. **Pass `cartesiaSpeakRaw: true` for campaign scripts**
   - Greeting uses this flag; campaign script does not.
   - Prevents accidental stripping if script contains bracket tags.

### 6.3 Optional outbound behavior tuning

If you want the script to play **immediately on answer** (no wait-for-speech):

- That would be a product change to `waitingForFirstSpeech` logic.
- Current design intentionally waits to avoid noise-triggered playback on dual-leg setups.
- **Not recommended** until TTS is fixed — you would hear nothing either way right now.

---

## 7. Verification Checklist (after fix)

### Inbound test call

- [ ] `greeting.sending`
- [ ] `voicebot stage: tts.start` (sarvam or cartesia)
- [ ] **`pipeline.tts.first_chunk`** with `chunk_bytes > 0`
- [ ] `greeting.sent` (not `greeting.tts_failed`)
- [ ] Caller hears greeting audio
- [ ] After speaking, bot reply TTS also has `pipeline.tts.first_chunk`

### Outbound campaign test call

Run one test outbound call and confirm these logs appear **in order**:

- [ ] `voicebot: identified as outbound campaign call`
- [ ] `voicebot: customer speech confirmed via STT — playing campaign script` *(or immediate play if you change wait behavior)*
- [ ] `voicebot stage: tts.start` with correct provider
- [ ] **`voicebot:pipeline.tts.first_chunk`** with `chunk_bytes > 0` ← critical
- [ ] **`voicebot stage: tts.sent_to_exotel`** with `pcm_bytes > 0`
- [ ] Exotel inbound `mark` ack after playback (or `playback_mark_fallback` if mark missing)
- [ ] Caller audibly hears Chhavani Resort script

**Red flags if still broken:**

```text
voicebot Cartesia TTS yielded 0 bytes
pipeline.stt.websocket_fallback (504) on every utterance
no pipeline.tts.first_chunk after tts.start
```

---

## 8. Comparison: working inbound (2026-06-25) vs broken outbound (2026-07-08)

| Signal | 2026-06-25 inbound | 2026-07-08 outbound |
|--------|-------------------|---------------------|
| Cartesia `tts.start` | ✅ | ✅ |
| `pipeline.tts.first_chunk` | ✅ 2274 bytes | ❌ missing |
| `tts.sent_to_exotel` | ✅ 37120 bytes | ❌ missing |
| Same voice ID | `5c32dce6-...` | `5c32dce6-...` |
| Same sample rate | 8000 Hz | 8000 Hz |

**Conclusion:** Outbound plumbing is fine; **Cartesia synthesis regressed** between those dates for this deployment.

---

## 9. SQL diagnostics for this campaign

```sql
-- Campaign script present?
SELECT id, name, status, language_code,
       length(script_text) AS script_chars,
       audio_file_path,
       left(script_text, 120) AS script_preview
FROM outbound_campaigns
WHERE id = '69309f58-f195-4542-8936-e8074762596d';

-- Session from this call
SELECT id, exotel_call_sid, direction, from_number, to_number,
       metadata->>'campaign_id' AS campaign_id,
       metadata->>'script_played_by_stream' AS script_stream,
       started_at
FROM exotel_call_sessions
WHERE id = '868fc4f6-2e2a-4c7c-a8a8-a778a38a1d82';

-- Tenant voice settings
SELECT tts_provider, tts_model, tts_default_speaker,
       stt_provider, stt_streaming_enabled, default_language_code
FROM customer_settings
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';
```

---

## 10. Summary for stakeholders

| Question | Answer |
|----------|--------|
| Why are **inbound and outbound** both silent? | **Same Cartesia TTS** — greeting, replies, and campaign script all use `speakToExotel()` |
| Is the outbound script missing? | **No** — 478 chars loaded from DB |
| Is Exotel connecting? | **Yes** — WebSocket streams, media received |
| Is the campaign recognized? | **Yes** — `outbound_campaign` mode |
| Why no audio? | **Cartesia TTS returned 0 bytes** on every synthesis |
| Did outbound code break? | **No** — path works; **TTS provider (Cartesia) is failing at runtime** |
| Fastest fix for both directions? | Restore Cartesia (key/credits/voice) **or** `UPDATE customer_settings SET tts_provider = 'sarvam'` |
| Best long-term fix? | TTS fallback chain (Cartesia → Sarvam) + pre-rendered campaign WAV |

---

*Generated from log analysis and codebase review of `apps/api/src/routes/exotel-voicebot.ts`, `outbound-campaigns.ts`, and related services.*
