# Customer settings: VAD, buffer, echo, and barge-in

This document describes the **`customer_settings`** columns that control **how the voicebot listens** (speech vs silence), **how much audio it can store per turn**, and **whether the caller can interrupt** the bot. It matches the fields shown in your admin/UI table (e.g. two tenants: **1500 ms** vs **500 ms** silence timeout, same energy/min-speech/buffer, **echo off**, **barge-in false**).

For a shorter catalog of all tenant settings, see [SETTINGS_AND_FEATURES_CATALOG.md](./SETTINGS_AND_FEATURES_CATALOG.md).

---

## Where these values live

- **Database:** `customer_settings` (see migration `infra/postgres/migrations/005_customer_settings_and_avatars.sql`).
- **API types & loading:** `apps/api/src/services/customer-settings.ts`.
- **Voicebot behavior:** `apps/api/src/routes/exotel-voicebot.ts` (helpers near the top of the file: `vadSilenceTimeoutMs`, `vadEnergyThresholdForListening`, `maxInboundBufferBytes`, `minUtterancePcmBytes`, `tryImmediateBargeInReset`).
- **Defaults if a value is missing or out of range:** the route falls back to constants such as **1500 ms** silence, **200** energy threshold, **5 MiB** buffer (see `VAD_SILENCE_TIMEOUT_MS`, `VAD_ENERGY_THRESHOLD`, `MAX_INBOUND_BUFFER_BYTES` in the same file).

**Access:** Most VAD/buffer/echo fields are **admin-only** on the tenant self-service API; **`barge_in_enabled`** (and related barge fields) may be exposed to tenants depending on your product rules—see OpenAPI and `settings.ts` validators.

---

## Quick reference: used in code today?

| Column | Used in voicebot code? | Notes |
|--------|-------------------------|--------|
| `vad_silence_timeout_ms` | **Yes** | End-of-utterance timer after speech drops in energy. |
| `vad_energy_threshold` | **Yes** | RMS threshold: above = speech, below = silence for VAD. |
| `vad_min_speech_ms` | **Yes** | Minimum audio length to run STT; shorter clips skipped. |
| `max_utterance_buffer_bytes` | **Yes** | Hard cap; forces processing when buffer reaches this size. |
| `max_utterance_seconds` | **No** | Stored and validated; **not read** in `exotel-voicebot.ts`. Byte cap is what actually limits length. |
| `echo_cancel_level` | **No** | Stored and validated; **no DSP** applies this flag in the current pipeline. |
| `barge_in_enabled` | **Partially** | Only **`barge_in_mode === "immediate"`** has behavior wired; with **`false`**, inbound audio during TTS is discarded unless immediate barge-in fires. |

---

## 1. `vad_silence_timeout_ms` (integer)

### In plain language

After you finish speaking, the line is rarely perfectly silent (noise, room tone). The bot waits for **this many milliseconds of “quiet”** (below the energy threshold) before it decides you have **finished your sentence** and sends the audio to speech-to-text. **Smaller values** (e.g. **500**) react faster but may cut you off if you pause mid-sentence; **larger values** (e.g. **1500**) wait longer after each pause, which feels slower but is safer on noisy lines.

### Technical

- **Unit:** milliseconds.
- **Mechanism:** In the `media` handler, when the last frames were classified as non-speech (`energy <= vad_energy_threshold`) but there is buffered speech, a **single** `setTimeout` is scheduled for `vadSilenceTimeoutMs(session)` ms. When it fires, `processUtterance` runs. The timer is **not** reset on every silent chunk—silence duration accumulates from when silence **first** started after speech.
- **Clamping:** Effective value is clamped to **[300, 30_000]** ms in code; invalid values fall back to **1500** ms.

---

## 2. `vad_energy_threshold` (integer)

### In plain language

This is how **loud** the incoming audio must be for the system to count it as **“you are talking”** instead of **silence**. Turn it **up** if background noise keeps triggering speech; turn it **down** if soft speakers are ignored.

### Technical

- **Mechanism:** Each inbound PCM chunk is scored with **`pcmRmsEnergy`** (RMS energy). If `energy > vadEnergyThresholdForListening(session)`, the chunk is treated as **speech** and appended to the utterance buffer; otherwise it may still be appended during a **pause within speech** (to preserve natural gaps), and it drives the **silence timer** described above.
- **Clamping:** **[50, 5000]** in code; invalid values fall back to **200**.

---

## 3. `vad_min_speech_ms` (integer)

### In plain language

Very short noises (clicks, pops, a cough) should not waste an STT call. If the captured audio is **shorter than this**, the bot **drops** the utterance and waits for the next one.

### Technical

- **Unit:** milliseconds of audio at the stream sample rate.
- **Mechanism:** Converted to a minimum byte length: `sample_rate * 2 * (ms/1000)`, with a **floor of 320 bytes** after conversion, and `ms` clamped to **[50, 10_000]** before that. `processUtterance` compares `combinedPcm.length` to this minimum and may log `pipeline.skip_short_utterance` and return without STT.

---

## 4. `max_utterance_buffer_bytes` (integer)

### In plain language

This is the **maximum size of one recording chunk** the bot will hold before it **must** process it—like a safety cap so a single “turn” cannot grow forever (very long monologue, stuck state, etc.). Your screenshot shows **5,242,880** bytes (**5 MiB**), which is a typical default.

### Technical

- **Mechanism:** After each buffered `media` chunk, if `session.inboundBytes >= maxInboundBufferBytes(session)`, any pending VAD timer is cleared and **`processUtterance`** is invoked immediately (if not already processing).
- **Clamping:** **[64_000, 50 * 1024 * 1024]** bytes; invalid values fall back to **5 MiB**.

---

## 5. `max_utterance_seconds` (integer, nullable)

### In plain language

**Idea:** “Stop buffering after N seconds even if the user keeps talking.” In the UI, **`null`** often means “no explicit second limit in the database row.”

### Technical

- **Persisted** in `customer_settings` and accepted by the settings API.
- **Not enforced** in `exotel-voicebot.ts`: there is **no** read of this field in the voice route. End-of-turn is driven by **VAD silence** and **`max_utterance_buffer_bytes`** only. OpenAPI documents this as not enforced on the current code path.

---

## 6. `echo_cancel_level` (text: `off` | `soft` | `aggressive`)

### In plain language

**Idea:** Reduce **echo** so the bot does not hear **its own voice** coming back from the phone line and mistake it for the user. Your screenshot shows **`off`**, meaning no software echo cancellation is applied from this setting.

### Technical

- **Stored** with a DB check constraint; validated in `settings.ts`.
- **Not applied:** No branch in the Exotel voicebot pipeline reads `echo_cancel_level` to filter PCM. Telephony echo behavior today depends on the carrier/Exotel path and energy/VAD tuning, not this flag. Treat **`soft` / `aggressive`** as **reserved for future** DSP or integration work unless another module is added.

---

## 7. `barge_in_enabled` (boolean)

### In plain language

- **`false` (your screenshot):** While the bot is **speaking**, incoming audio is generally **ignored** for starting a new reply—the caller **cannot interrupt** in the product sense (unless immediate barge-in is enabled with the right mode).
- **`true`:** Enables **interruption** behavior when combined with **`barge_in_mode === "immediate"`** and sufficient energy: the bot can **stop** treating playback as in progress, clear buffers, and listen again.

### Technical

- During TTS / until Exotel **mark** ack, `media` handling does: if `ttsInProgress || pendingMarks.size > 0`, **`tryImmediateBargeInReset`** runs; it returns **`true`** only when `barge_in_enabled && barge_in_mode === "immediate"` **and** `energy` exceeds **`barge_in_energy_threshold`** (separate column). If reset does not happen, the chunk is **dropped** (`break`).
- Other `barge_in_mode` values (`finish_then_answer`, `finish_turn`) are defined in schema/docs but **not** implemented in this route beyond the immediate path.
- Related: **`processUtterance`** returns early if `ttsInProgress || pendingMarks.size > 0` (no queued utterance during playback unless immediate barge-in cleared state first).

---

## How the seven columns work together (one sentence each)

1. **`vad_energy_threshold`** — decides **speech vs silence** per chunk.  
2. **`vad_silence_timeout_ms`** — after speech, **how long** “silence” must last to **end the turn**.  
3. **`vad_min_speech_ms`** — **drops** turns that are **too short** to be real speech.  
4. **`max_utterance_buffer_bytes`** — **forces** a turn to process if the buffer gets **too big**.  
5. **`max_utterance_seconds`** — **placeholder in DB**; **not** used in the live voicebot path.  
6. **`echo_cancel_level`** — **placeholder for product**; **not** wired to audio processing today.  
7. **`barge_in_enabled`** — with **`immediate`** mode, allows **high-energy** inbound during playback to **reset** and listen; otherwise playback window **blocks** new utterances.

---

## See also

- [VOICEBOT_STREAMING_LOG_ANALYSIS.md](./VOICEBOT_STREAMING_LOG_ANALYSIS.md) — example interpretation of VAD vs buffer duration in logs.
- [VOICEBOT_LATENCY_SUB_2S_PLAN.md](./VOICEBOT_LATENCY_SUB_2S_PLAN.md) — latency impact of `vad_silence_timeout_ms`.
