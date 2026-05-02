# ElevenLabs v3 / Telephony Improvements — Implementation Report

**Plan reference:** [elevenlabs_v3_voice_improvement_plan.md](./elevenlabs_v3_voice_improvement_plan.md)  
**Excluded (per plan):** **Step 1** — forcing customers off `eleven_v3` in code remains **not implemented** (model stays configurable in `customer_settings.tts_model` only).

---

## 1. What you should do in the database (optional operations)

There are **no new migrations or columns** required for this rollout. Behaviour is driven by existing fields.

| Goal | Why | SQL sketch |
|------|-----|------------|
| Use a faster model for latency | Matches plan §1 “SQL only” recommendation | `UPDATE customer_settings SET tts_model = 'eleven_turbo_v2_5' WHERE customer_id = '<UUID>' AND tts_provider = 'elevenlabs';` or `eleven_flash_v2_5` |
| Prefer one-shot TTS (smoothest, no streamed chunks) | Optional; plan §7 notes disabling streaming | `UPDATE customer_settings SET tts_streaming_enabled = FALSE WHERE tts_provider = 'elevenlabs' AND customer_id = '<UUID>';` |

**Note:** Avatar-level `voice_settings` JSON (`elevenlabs_avatars`) still overrides merged defaults field-by-field — no DB change unless you want to tune stability/speed/etc. explicitly per persona.

---

## 2. Code changes (what was implemented)

### 2.1 `apps/api/src/services/elevenlabs.ts`

- **Step 2 — output format:** `elevenLabsTtsOutputFormatForTelephony()` now targets the negotiated Exotel PCM rate (`pcm_*` / `wav_*` via existing helpers). For **`eleven_v3`** with trunk **≤ 8 kHz**, it requests **`pcm_16000`** (16 kHz → 8 kHz resample) instead of always **`pcm_22050`**. Streaming keeps **`pcm_*`** only (ElevenLabs stream API rejects `wav_*`).
- **Step 3 — model-aware defaults:** Replaced single global defaults with **`ELEVENLABS_V3_VOICE_SETTINGS`** and **`ELEVENLABS_TURBO_FLASH_VOICE_SETTINGS`**. **`normalizeVoiceSettingsForApi(raw, modelId)`** merges customer/avatar overrides on top and caps **`speed`** at **1.0** for v3 and **1.2** for non‑v3. Wired into **`elevenLabsTextToSpeech`** and stream helpers via **`params.modelId`**.
- **Step 4A — LLM hint (non‑v3):** Replaced **`ELEVENLABS_RAG_AUDIO_TAGS_RULE`** text with the “natural phone speech” block from the plan (no markdown, no brackets, short sentences).
- **Step 4B — tag leak:** **`buildElevenLabsRagAudioTagHintForProvider()`** uses only **`customerTtsModelRaw`** (tenant `tts_model`): v3 ⇒ strict sentence tags; everything else ⇒ non‑tag phone prompt. **`resolveElevenLabsTtsModelId()` fallback to env default no longer layers v3 “audio delivery” hints onto non‑v3 tenants.
- **Step 6 — true stream read:** **`elevenLabsOpenTtsStreamResponse()`** shared by **`elevenLabsTextToSpeechStreamIncremental()`** (`AsyncGenerator`) and **`elevenLabsTextToSpeechStream()`** (concatenates the same incremental iterator for **`/ask`** compatibility).

### 2.2 `apps/api/src/routes/exotel-voicebot.ts`

- **Step 5:** **`findNextSpeakCutElevenLabs()`** — splits only on **`.!?`** and **danda (`।`)**; comma cuts removed; force-cut threshold increased to **220** chars (was 140).
- **Step 6:** When **`tts_streaming_enabled`** and ElevenLabs output sample rate **matches Exotel**, audio is **`sendAudioToExotel`**’d **`omitMark: true`** per chunk as PCM arrives, then **`sendExotelPlaybackMark`** once **`schedulePlaybackMarkFallback`** unchanged. Buffered path unchanged when **resampling** is still required (**first PCM still TTFA-aligned with network stream but final send batch is after decode/resample**).
- Retry behaviour preserved: retry without **`voice_settings`**, then premade voice on payment/library errors — using discriminated **`{ ok }`** results instead of brittle “last buffered” bookkeeping.

### 2.3 `apps/api/src/routes/ask.ts`

- **`elevenLabsAskTtsOutputFormat()`** for non‑MP3 codecs delegates to **`elevenLabsTtsOutputFormatForTelephony()`** so **`/ask/voice`** stays aligned with the telephony sampling strategy (still supports MP3 branch locally).

---

## 3. Verification

- **`cd apps/api && npm run build`** — TypeScript **`tsc`** completes with **exit code 0**.

---

## 4. Follow-up (outside this change set)

- Real **phone-call** regressions should follow plan §6 (TTFA logs, pronunciation, multilingual).
- If **`pcm_16000`** for v3@8 kHz is ever rejected by ElevenLabs for a specific workspace, fallback logic could retry **`pcm_22050`** — not added here to avoid extra latency without evidence.
