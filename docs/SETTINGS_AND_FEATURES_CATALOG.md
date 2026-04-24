# Convixx — Settings Catalog & Feature Roadmap

**Date:** 2026-04-24
**Status:** Code-aligned defaults snapshot (companion to [`PLATFORM_EXTENSIONS_DESIGN_2026-04-23.md`](./PLATFORM_EXTENSIONS_DESIGN_2026-04-23.md))

This document is the **reference list** of every setting we propose to put on the
new `customer_settings` table, with defaults aligned to current code where
implemented. For roadmap-only settings, defaults remain design defaults.

Each entry has:

- **Key** — proposed column name
- **Type** — SQL type
- **Default** — safe default
- **Scope** — `tenant-editable` (via api-key) or `admin-only` (admin token)
- **Notes** — what it controls / where it is read in code

**Out of scope for this table (deliberate):**

- `greeting_text`, `error_text` → live on `agents` (per-agent override).
- Call recording → handled entirely by Exotel; Convixx does not store raw audio.
- `stt_mode` → not a setting; derived from `voicebot_multilingual`.
- IVR cancel digit → replaced by `stop_words` (speech).

---

## A. Voicebot runtime

| Key                          | Type        | Default  | Scope           | Notes |
|------------------------------|-------------|----------|-----------------|-------|
| `voicebot_enabled`           | BOOLEAN     | FALSE    | admin-only      | Master switch; mirrors `customer_exotel_settings.is_enabled`. |
| `voicebot_multilingual`      | BOOLEAN     | FALSE    | tenant-editable | Replaces global `VOICEBOT_MULTILINGUAL` env. Also drives STT mode: `FALSE` → STT pinned to `currentLanguageCode`; `TRUE` → auto-detect (no `language_code` hint). |
| `default_language_code`      | TEXT        | 'en-IN'  | tenant-editable | Fallback pre-first-detection and when detection fails. |
| `allowed_language_codes`     | TEXT[]      | `{en-IN}`| tenant-editable | BCP-47 list; also the pool used by the mid-call switch menu. |

## B. STT (speech-to-text)

| Key                          | Type        | Default     | Scope           | Notes |
|------------------------------|-------------|-------------|-----------------|-------|
| `stt_provider`               | TEXT        | 'sarvam'    | tenant-editable | Current code uses Sarvam STT only; provider switching is roadmap. |
| `stt_model`                  | TEXT        | 'saaras:v3' | admin-only      | Provider-specific model id (Sarvam `saaras:v3`, ElevenLabs `scribe_v1`, etc.). |
| `stt_streaming_enabled`      | BOOLEAN     | FALSE       | tenant-editable | When `TRUE` and provider supports it, use streaming STT (partial transcripts) instead of batch WAV upload. |

## C. TTS (text-to-speech)

| Key                          | Type          | Default     | Scope           | Notes |
|------------------------------|---------------|-------------|-----------------|-------|
| `tts_provider`               | TEXT          | 'sarvam'    | tenant-editable | Current code uses Sarvam TTS only; provider switching is roadmap. |
| `tts_model`                  | TEXT          | 'bulbul:v2' | admin-only      | Effective default comes from `SARVAM_TTS_MODEL` in code (`env.ts`), fallback chain in voicebot path still ends at `bulbul:v3`. |
| `tts_default_speaker`        | TEXT          | NULL        | tenant-editable | Sarvam speaker id or ElevenLabs voice id. Agent / avatar override wins. |
| `tts_default_pace`           | NUMERIC(3,2)  | NULL        | tenant-editable | Current runtime sends pace only when explicitly set (agent/env). |
| `tts_default_pitch`          | NUMERIC(3,2)  | NULL        | tenant-editable |  |
| `tts_default_loudness`       | NUMERIC(3,2)  | NULL        | tenant-editable |  |
| `tts_default_sample_rate`    | INT           | 22050       | admin-only      | Effective default comes from `SARVAM_TTS_SPEECH_SAMPLE_RATE` in code (`env.ts`). |
| `tts_output_codec`           | TEXT          | 'wav'       | admin-only      | Rarely changes. |
| `tts_streaming_enabled`      | BOOLEAN       | FALSE       | tenant-editable | Stream PCM chunks to Exotel as they are synthesized; reduces time-to-first-audio. |

## D. RAG / LLM

| Key                          | Type          | Default       | Scope           | Notes |
|------------------------------|---------------|---------------|-----------------|-------|
| `rag_use_openai_only`        | BOOLEAN       | FALSE         | tenant-editable | Migrated from `customers`. |
| `rag_top_k`                  | INT           | 3             | tenant-editable | Voice: 3; chat may override higher. |
| `rag_use_history`            | BOOLEAN       | TRUE          | tenant-editable | Current code always includes chat history in RAG prompt. |
| `rag_history_max_turns`      | INT           | NULL          | tenant-editable | Not enforced in current code (no turn cap applied yet). |
| `rag_distance_threshold`     | NUMERIC(4,3)  | NULL          | tenant-editable | Drop matches with distance above this. |
| `rag_streaming_enabled`      | BOOLEAN       | FALSE         | tenant-editable | Stream LLM tokens. Combined with `tts_streaming_enabled`, enables sentence-level incremental TTS. |
| `llm_model_override`         | TEXT          | NULL          | admin-only      | Force a specific self-hosted model. |
| `llm_max_tokens`             | INT           | 150           | tenant-editable | 150 good for voice; chat can go higher. |
| `llm_temperature`            | NUMERIC(3,2)  | 0.25          | tenant-editable |  |
| `llm_top_p`                  | NUMERIC(3,2)  | NULL          | tenant-editable | Sent only when non-null. |
| `llm_verification_enabled`   | BOOLEAN       | FALSE         | tenant-editable | 2nd-pass self-check before returning. |
| `llm_verification_threshold` | NUMERIC(3,2)  | 0.80          | tenant-editable |  |
| `llm_fallback_to_openai`     | BOOLEAN       | TRUE          | tenant-editable | Use OpenAI when verification fails. |
| `openai_model`               | TEXT          | 'gpt-4o-mini' | admin-only      |  |
| `no_kb_fallback_instruction` | TEXT          | (long default)| tenant-editable | Prepended to RAG prompt when KB has 0 hits. Migrated from `customers`. |

## E. VAD / audio handling

| Key                             | Type    | Default   | Scope           | Notes |
|---------------------------------|---------|-----------|-----------------|-------|
| `vad_silence_timeout_ms`        | INT     | 1500      | admin-only      | End-of-utterance detection window. |
| `vad_energy_threshold`          | INT     | 200       | admin-only      | RMS threshold separating speech from silence. |
| `vad_min_speech_ms`             | INT     | 200       | admin-only      | Reject ultra-short chunks (clicks, coughs). |
| `max_utterance_buffer_bytes`    | INT     | 5242880   | admin-only      | Hard ceiling before forced STT (5 MB). |
| `max_utterance_seconds`         | INT     | NULL      | admin-only      | Not implemented in current code path; buffer-byte ceiling is enforced instead. |
| `echo_cancel_level`             | TEXT    | 'off'     | admin-only      | `off` \| `soft` \| `aggressive`. Roadmap. |

## F. Barge-in (interruptible TTS, see design doc §5)

Today the voicebot deliberately drops any inbound audio while the agent is
speaking — the caller literally cannot interrupt. These settings opt a tenant
into interruption and pick the flavour of UX.

| Key                          | Type    | Default              | Scope           | Notes |
|------------------------------|---------|----------------------|-----------------|-------|
| `barge_in_enabled`           | BOOLEAN | FALSE                | tenant-editable | When `FALSE`, the agent cannot be interrupted (current behaviour). When `TRUE`, caller speech during TTS is buffered, and sustained speech triggers the `barge_in_mode` flow. |
| `barge_in_mode`              | TEXT    | 'finish_then_answer' | tenant-editable | `immediate` → stop TTS at next chunk boundary, answer new command only. `finish_then_answer` → stop TTS, capture user's new prompt, **first complete the interrupted sentence**, then answer the new command. `finish_turn` → don't stop TTS at all, just buffer inbound audio in parallel and process as next turn. |
| `barge_in_min_speech_ms`     | INT     | 400                  | admin-only      | Minimum sustained inbound speech duration before barge-in fires. Guards against coughs / single-word echo. |
| `barge_in_energy_threshold`  | INT     | 250                  | admin-only      | RMS floor for "caller is speaking" during TTS. Usually set higher than `vad_energy_threshold` because telephony echo keeps the line warmer during playback. |

## G. Mid-call language switch (menu flow, see design doc §3)

| Key                                  | Type   | Default | Scope           | Notes |
|--------------------------------------|--------|---------|-----------------|-------|
| `allow_language_switch`              | BOOLEAN| FALSE   | tenant-editable | Gate for the whole feature. |
| `language_switch_trigger_keywords`   | TEXT[] | `{'change language','switch language','भाषा बदलो','भाषा बदलें'}` | tenant-editable | Phrases in the STT transcript that put the session into the 2-step switch menu. |
| `language_switch_confirm_prompt`     | TEXT   | `'Would you like to change the language? Please say yes or no.'` | tenant-editable | Spoken in Step 1. |
| `language_switch_options_prompt`     | TEXT   | `'Please say one of: {LANGUAGE_LIST}.'` | tenant-editable | Spoken in Step 2. `{LANGUAGE_LIST}` is substituted at runtime from `allowed_language_codes`. |
| `language_switch_yes_words`          | TEXT[] | `{'yes','haan','हाँ','ho','हो'}` | tenant-editable | Accepted in Step 1. |
| `language_switch_no_words`           | TEXT[] | `{'no','nahi','नहीं'}` | tenant-editable | Accepted in Step 1 to abort. |
| `language_switch_timeout_ms`         | INT    | 6000    | admin-only      | Wait for each step's reply. |
| `language_switch_max_attempts`       | INT    | 2       | admin-only      | Retries per step before silently exiting switch mode. |

## H. Stop words (global voice commands)

| Key           | Type   | Default                                              | Scope           | Notes |
|---------------|--------|------------------------------------------------------|-----------------|-------|
| `stop_words`  | TEXT[] | `{'stop','operator','main menu','go back','cancel'}` | tenant-editable | Hit at any time; inside IVR → pop/exit; outside IVR → no-op (or end-call if the phrase also matches `end_call_keywords`). Replaces the old IVR cancel digit. |

## I. IVR (see design doc §4)

| Key                         | Type    | Default | Scope           | Notes |
|-----------------------------|---------|---------|-----------------|-------|
| `ivr_enabled`               | BOOLEAN | FALSE   | tenant-editable | Master switch. |
| `ivr_welcome_menu_id`       | UUID    | NULL    | tenant-editable | FK → `ivr_menus.id`. Required when enabled. |
| `ivr_input_timeout_ms`      | INT     | 5000    | tenant-editable | Wait for DTMF / speech. |
| `ivr_max_retries`           | INT     | 3       | tenant-editable | Invalid-input retries before escalation. |
| `ivr_speech_input_enabled`  | BOOLEAN | TRUE    | tenant-editable | Allow saying the option name. |
| `ivr_fallback_to_agent`     | BOOLEAN | TRUE    | tenant-editable | After retries, hand off to RAG agent. |

## J. Call lifecycle

| Key                             | Type    | Default | Scope           | Notes |
|---------------------------------|---------|---------|-----------------|-------|
| `max_call_duration_seconds`     | INT     | NULL    | admin-only      | **NULL = unlimited** (no auto-hangup). Set a number to cap. |
| `max_concurrent_calls`          | INT     | 10      | admin-only      | Per-tenant throttle. |
| `call_transcript_enabled`       | BOOLEAN | TRUE    | tenant-editable | When `FALSE`, skip writing `chat_messages` rows for voice calls. |
| `end_call_keywords`             | TEXT[]  | `{'goodbye','bye'}` | tenant-editable | Trigger graceful end-call. |
| `end_call_silence_timeout_sec`  | INT     | 20      | admin-only      | No-response hangup. |
| `handoff_to_human_enabled`      | BOOLEAN | FALSE   | tenant-editable | Enable human transfer. |
| `human_agent_transfer_number`   | TEXT    | NULL    | tenant-editable | E.164. |
| `business_hours`                | JSONB   | `{}`    | tenant-editable | `{ "tz":"Asia/Kolkata", "mon":["09:00","18:00"], ... }` — route outside hours to voicemail/handoff. |
| `holiday_calendar`              | JSONB   | `[]`    | tenant-editable | `[{"date":"2026-10-02","text":"Closed for Gandhi Jayanti"}]`. |

**Not in this table (by decision):** `call_recording_enabled`,
`call_recording_storage_bucket` — recording is Exotel's responsibility.

## K. Outbound

| Key                | Type    | Default | Scope      | Notes |
|--------------------|---------|---------|------------|-------|
| `outbound_enabled` | BOOLEAN | FALSE   | admin-only | Master switch for outbound dialing. Implementation is roadmap. |

## L. Webhooks & notifications

| Key                          | Type    | Default | Scope           | Notes |
|------------------------------|---------|---------|-----------------|-------|
| `webhook_url_call_start`     | TEXT    | NULL    | tenant-editable | Fired on `start` WS event. |
| `webhook_url_call_end`       | TEXT    | NULL    | tenant-editable | Fired on `stop`. |
| `webhook_url_transcript`     | TEXT    | NULL    | tenant-editable | Each final transcript turn (respects `call_transcript_enabled`). |
| `webhook_url_ivr_event`      | TEXT    | NULL    | tenant-editable | Per IVR action. |
| `webhook_url_language_event` | TEXT    | NULL    | tenant-editable | Per `call_language_events` row. |
| `webhook_secret`             | TEXT    | NULL    | admin-only      | HMAC-SHA256 signing key. |
| `webhook_retry_attempts`     | INT     | 3       | admin-only      |  |
| `email_notify_call_end`      | BOOLEAN | FALSE   | tenant-editable |  |
| `email_recipients`           | TEXT[]  | `{}`    | tenant-editable |  |
| `slack_webhook_url`          | TEXT    | NULL    | tenant-editable | Roadmap. |

---

## M. Suggested platform features (roadmap)

Grouped by theme. Items marked ⚙ already have a DB/code footprint today; ⭐ are
new proposals coming out of this design pass; 🧭 are longer-term ideas.

### M.1 Core voice calling
- ⚙ Inbound Exotel Voicebot with RAG agent
- ⭐ Switchable STT/TTS providers (Sarvam ↔ ElevenLabs) — independent per leg
- ⭐ Streaming STT / streaming TTS / streaming LLM
- ⭐ Menu-style mid-call language switch
- ⭐ Per-language avatar voice map (different speaker per language, even different provider per language)
- ⭐ Barge-in (caller interrupts bot) with three modes: `immediate`, `finish_then_answer` (default — complete the interrupted sentence, then address new command), `finish_turn`
- ⭐ Configurable VAD per tenant
- ⭐ Stop words as universal conversational escape
- 🧭 Outbound dialer (campaigns, retry policy, voicemail drop) — gated by `outbound_enabled`
- 🧭 SIP trunk / non-Exotel telephony providers (Twilio, Plivo, Kaleyra)

### M.2 IVR & routing
- ⭐ IVR menus (DTMF + speech)
- ⭐ Human handoff via transfer number
- ⭐ Business-hours routing + holiday calendar
- 🧭 Skills-based routing to different agents
- 🧭 Queue + hold music + callback-request

### M.3 Knowledge base
- ⚙ Manual Q/A upload with embedding
- 🧭 URL / PDF / DOCX auto-ingestion with chunking
- 🧭 KB versioning & rollback
- 🧭 KB confidence scoring per answer

### M.4 Analytics & QA
- ⭐ Persist call language + switches (audit table)
- 🧭 Analytics dashboard (calls/day, avg duration, language mix, deflection rate)
- 🧭 Post-call sentiment + summary
- 🧭 Transcript search with highlights
- 🧭 A/B testing of system prompts / avatars
- 🧭 Auto call-quality scoring (interruptions, silence, latency)

### M.5 Admin / ops
- ⭐ Centralized `customer_settings` + per-tenant settings UI
- ⭐ Reusable avatars (including system-owned defaults)
- 🧭 Role-based access control (admin / operator / viewer)
- 🧭 Whitelabel branding on admin portal
- 🧭 Multi-region deployments

### M.6 Developer experience
- ⭐ Webhook delivery with retries + signing
- 🧭 Event stream (SSE / WebSocket) for call events
- 🧭 Sandbox mode with replayable calls
- 🧭 Import/export of agents, KB, IVR trees as JSON bundles
- 🧭 CLI for bulk tenant provisioning

---

## N. Resolution order quick reference

For any value read in the voice hot path:

| Concern                               | Chain                                                                 |
|---------------------------------------|-----------------------------------------------------------------------|
| TTS pace / speaker / model / provider | session override → `agents` → `avatars` (incl. `language_voice_map`) → `customer_settings` → `.env` → hard-coded |
| Greeting text / error text            | `agents` only → hard-coded default                                    |
| STT provider / model / streaming      | `customer_settings` → `.env` → hard-coded                             |
| RAG streaming / top_k / max_tokens    | `customer_settings` → `.env` → hard-coded                             |
| Language (current)                    | session state (`current_language_code`) → `default_language_code` → `'en-IN'` |
| IVR menu / options / stop-word escape | `ivr_menus` + `ivr_menu_options` + `customer_settings.stop_words`     |

Anything not covered by a concrete column lives in code as a hard-coded default
and can be promoted to a column later if a tenant needs it.
