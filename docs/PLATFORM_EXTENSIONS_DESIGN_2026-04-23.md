# Convixx Platform Extensions — Design Document

**Date:** 2026-04-23
**Status:** Design only (no implementation yet)
**Companion doc:** [`SETTINGS_AND_FEATURES_CATALOG.md`](./SETTINGS_AND_FEATURES_CATALOG.md)

This document proposes four coordinated additions to the Convixx multi-tenant
voice-calling platform, aligned with the existing real-time Exotel Voicebot
pipeline:

1. A centralized **`customer_settings`** table (every per-tenant toggle in one place).
2. An **`avatars`** table + `agents.avatar_id` link so each agent can wear a reusable voice/visual persona.
3. **Multilingual call tracking** — persist the caller's language per call session, with a safe **mid-call language switch** (opt-in per customer).
4. An opt-in **IVR system** with dedicated tables (`ivr_menus`, `ivr_menu_options`, `ivr_session_state`), active only when the customer turns it on.

Each section lists:

- Why it is needed
- Proposed schema
- How it plugs into the existing runtime (`exotel-voicebot.ts`, `voicebot-session.ts`, `ask` pipeline, `agents` routes)
- Admin API surface
- Open questions / decisions

---

## 0. System snapshot (what exists today)

Multi-tenant shape:

```
customers ─┬─ api_keys           (auth)
           ├─ agents             (system_prompt, greeting_text, error_text,
           │                     tts_pace/model/speaker/sample_rate,
           │                     no_kb_fallback_instruction)
           ├─ kb_entries         (Q/A + pgvector embedding)
           ├─ chat_sessions ──── chat_messages (encrypted, source, openai_cost_usd,
           │                                   exotel_call_session_id FK)
           ├─ customer_exotel_settings (Exotel creds, numbers, WSS URL,
           │                            is_enabled, use_sandbox)
           └─ exotel_call_sessions (one row per call: call_sid, stream_sid,
                                    direction, from/to, status, chat_session_id,
                                    agent_id, started_at, ended_at, metadata)
```

Real-time voice flow (`apps/api/src/routes/exotel-voicebot.ts`):

```
Exotel WS event          Server action
─────────────────        ───────────────────────────────────────────────────
connected                log only
start                    bootstrap chat_sessions row, insert exotel_call_sessions,
                         load first active agent (greeting_text, TTS params),
                         speak greeting via Sarvam TTS
media (base64 PCM)       energy-VAD buffer → silence timeout →
                         processUtterance():
                           Sarvam STT (saaras:v3)  →
                           KB vector search (top 3) + history →
                           OpenAI chat (150 tok) →
                           Sarvam TTS (bulbul) → base64 media back
mark                     playback-done ack; clear inbound buffer
dtmf                     logged only (not routed anywhere yet)
stop                     endCallSession(), removeSession()
```

Settings that already exist (scattered):

| Key                                       | Where                                  |
|-------------------------------------------|----------------------------------------|
| `rag_use_openai_only`                     | `customers`                            |
| `default_no_kb_fallback_instruction`      | `customers`                            |
| `system_prompt` (tenant default)          | `customers`                            |
| `is_enabled`, `use_sandbox`               | `customer_exotel_settings`             |
| Per-agent TTS + greeting/error text       | `agents`                               |
| `VOICEBOT_MULTILINGUAL`                   | **global `.env`** — not per tenant     |
| `VAD_SILENCE_TIMEOUT_MS`, energy, etc.    | **hard-coded** in `exotel-voicebot.ts` |
| Sarvam TTS model/speaker/pace/sample_rate | `.env` fallback + per-agent override   |

The gaps this design targets:

- No single place to read/write per-tenant behaviour flags.
- Multilingual, IVR, and mid-call language switch have no DB footprint at all.
- No concept of reusable voice/visual "avatars" — voice settings live directly on agents and cannot be shared.
- Language of a call is never persisted; it exists only as a local variable in one STT response.

---

## 1. `customer_settings` — the single source of truth for tenant behaviour

### 1.1 Why one table (not a column bag on `customers`)

- `customers` should stay a small "who is this tenant" table.
- Settings grow over time; we don't want to migrate `customers` every sprint.
- Many fields are nullable defaults that agents can override; keeping them in a dedicated table matches that shape.
- A **1-to-1 row per customer** (unique FK) keeps lookups `O(1)` in the voicebot hot path.

### 1.2 Table shape (high level; full catalog in companion doc)

Conventions:

- One row per customer; `customer_id` is `UNIQUE NOT NULL REFERENCES customers(id) ON DELETE CASCADE`.
- Every column is either `NOT NULL DEFAULT …` or **explicitly nullable to mean "inherit global default"**. The code that reads them applies a clear resolution chain (see §1.4).
- All booleans default to the safe/off value (e.g. `ivr_enabled DEFAULT FALSE`).
- An `extra_settings JSONB NOT NULL DEFAULT '{}'::jsonb` escape hatch is included for experimental flags that don't deserve a column yet.

Grouped columns (non-exhaustive — see companion doc for the full catalog):

```
-- identity
id UUID PK
customer_id UUID UNIQUE FK → customers(id) ON DELETE CASCADE

-- Voicebot runtime
voicebot_enabled             BOOLEAN  DEFAULT FALSE
voicebot_multilingual        BOOLEAN  DEFAULT FALSE   -- replaces VOICEBOT_MULTILINGUAL env
                                                      -- drives STT mode too:
                                                      --   FALSE → STT forced to default_language_code
                                                      --   TRUE  → STT auto-detect (language_code hint omitted)
default_language_code        TEXT     DEFAULT 'en-IN'
allowed_language_codes       TEXT[]   DEFAULT ARRAY['en-IN']

-- STT provider (switchable per tenant)
stt_provider                 TEXT     DEFAULT 'sarvam'
                             CHECK (stt_provider IN ('sarvam','elevenlabs'))
stt_model                    TEXT     DEFAULT 'saaras:v3'
                                                      -- Sarvam: saaras:v3
                                                      -- ElevenLabs: scribe_v1 (or provider-specific)
stt_streaming_enabled        BOOLEAN  DEFAULT FALSE
                                                      -- When TRUE and provider supports it, stream partials
                                                      -- instead of batching full utterance through STT.

-- TTS provider (switchable per tenant; independent from STT)
tts_provider                 TEXT     DEFAULT 'sarvam'
                             CHECK (tts_provider IN ('sarvam','elevenlabs'))
tts_model                    TEXT     DEFAULT 'bulbul:v3'
                                                      -- Sarvam: bulbul:v3 / bulbul:v2
                                                      -- ElevenLabs: eleven_multilingual_v2 / eleven_flash_v2_5
tts_default_speaker          TEXT                     -- Sarvam speaker id or ElevenLabs voice id
tts_default_pace             NUMERIC(3,2) DEFAULT 1.00
tts_default_pitch            NUMERIC(3,2)
tts_default_loudness         NUMERIC(3,2)
tts_default_sample_rate      INT      DEFAULT 8000
tts_streaming_enabled        BOOLEAN  DEFAULT FALSE
                                                      -- Stream PCM chunks to Exotel as they are
                                                      -- synthesized; reduces time-to-first-audio.
tts_output_codec             TEXT     DEFAULT 'wav'

-- RAG streaming (LLM token stream)
rag_streaming_enabled        BOOLEAN  DEFAULT FALSE
                                                      -- Stream LLM tokens; combine with
                                                      -- tts_streaming_enabled for sentence-level
                                                      -- incremental TTS.

-- Note: greeting_text and error_text are NOT stored here.
-- They live on the `agents` table (already implemented) — per-agent override.
-- Customers with no per-agent text fall back to a hard-coded default in code.

no_kb_fallback_instruction   TEXT     -- migrated from customers.default_no_kb_fallback_instruction

-- VAD / audio
vad_silence_timeout_ms       INT      DEFAULT 1500
vad_energy_threshold         INT      DEFAULT 200
max_utterance_buffer_bytes   INT      DEFAULT 5242880   -- 5 MB

-- Barge-in (interruptible TTS; see §5)
barge_in_enabled             BOOLEAN  DEFAULT FALSE
barge_in_mode                TEXT     DEFAULT 'finish_then_answer'
                             CHECK (barge_in_mode IN
                               ('immediate','finish_then_answer','finish_turn'))
barge_in_min_speech_ms       INT      DEFAULT 400    -- ignore blips / coughs
barge_in_energy_threshold    INT      DEFAULT 250    -- usually > vad_energy_threshold

-- Mid-call language switch (menu-style confirmation flow; see §3)
allow_language_switch             BOOLEAN DEFAULT FALSE
language_switch_trigger_keywords  TEXT[]  DEFAULT
  ARRAY['change language','switch language','भाषा बदलो','भाषा बदलें']
language_switch_confirm_prompt    TEXT    DEFAULT
  'Would you like to change the language? Please say yes or no.'
language_switch_options_prompt    TEXT    DEFAULT
  'Please say one of: {LANGUAGE_LIST}.'
                                           -- {LANGUAGE_LIST} is filled at runtime
                                           -- from allowed_language_codes.
language_switch_yes_words         TEXT[]  DEFAULT ARRAY['yes','haan','हाँ','ho','हो']
language_switch_no_words          TEXT[]  DEFAULT ARRAY['no','nahi','नहीं']
language_switch_timeout_ms        INT     DEFAULT 6000
language_switch_max_attempts      INT     DEFAULT 2

-- Stop words (global conversational commands; replace cancel digit)
stop_words                        TEXT[]  DEFAULT
  ARRAY['stop','operator','main menu','go back','cancel']

-- IVR
ivr_enabled                 BOOLEAN DEFAULT FALSE
ivr_welcome_menu_id         UUID    REFERENCES ivr_menus(id) ON DELETE SET NULL
ivr_input_timeout_ms        INT     DEFAULT 5000
ivr_max_retries             INT     DEFAULT 3
ivr_speech_input_enabled    BOOLEAN DEFAULT TRUE
ivr_fallback_to_agent       BOOLEAN DEFAULT TRUE
-- No cancel digit. Escape from IVR uses `stop_words` (speech).

-- RAG / LLM
rag_use_openai_only         BOOLEAN DEFAULT FALSE   -- migrated from customers
rag_top_k                   INT     DEFAULT 3
rag_use_history             BOOLEAN DEFAULT TRUE
rag_history_max_turns       INT     DEFAULT 10
llm_max_tokens              INT     DEFAULT 150
llm_temperature             NUMERIC(3,2) DEFAULT 0.25
llm_top_p                   NUMERIC(3,2)
llm_verification_enabled    BOOLEAN DEFAULT FALSE
llm_fallback_to_openai      BOOLEAN DEFAULT TRUE
openai_model                TEXT    DEFAULT 'gpt-4o-mini'

-- Call handling
max_call_duration_seconds   INT     -- NULL = unlimited (no auto-hangup safety)
max_concurrent_calls        INT     DEFAULT 10
call_transcript_enabled     BOOLEAN DEFAULT TRUE
                                    -- When FALSE, do not insert chat_messages rows
                                    -- for this tenant's voice calls.
end_call_keywords           TEXT[]  DEFAULT ARRAY['goodbye','bye','hang up']
end_call_silence_timeout_sec INT    DEFAULT 20
handoff_to_human_enabled    BOOLEAN DEFAULT FALSE
human_agent_transfer_number TEXT

-- Outbound (dialer / campaigns; implementation roadmap)
outbound_enabled            BOOLEAN DEFAULT FALSE

-- Webhooks / notifications
webhook_url_call_start      TEXT
webhook_url_call_end        TEXT
webhook_url_transcript      TEXT
webhook_secret              TEXT                 -- HMAC signing
email_notify_call_end       BOOLEAN DEFAULT FALSE
email_recipients            TEXT[]  DEFAULT ARRAY[]::TEXT[]

-- Audit
created_at TIMESTAMP NOT NULL DEFAULT NOW()
updated_at TIMESTAMP NOT NULL DEFAULT NOW()
```

Call recording is handled entirely by Exotel (their platform stores the audio);
Convixx does not persist raw audio and therefore has no `call_recording_*` settings.

Trigger: `updated_at` auto-refresh via `BEFORE UPDATE` trigger.

Index:

```
CREATE UNIQUE INDEX idx_customer_settings_customer ON customer_settings(customer_id);
```

### 1.3 Migration plan from existing columns

- Create `customer_settings` with one row **auto-inserted per existing customer** (via `INSERT … SELECT` in the migration).
- Back-fill:
  - `rag_use_openai_only` → copy from `customers.rag_use_openai_only`
  - `no_kb_fallback_instruction` → copy from `customers.default_no_kb_fallback_instruction`
  - `voicebot_enabled` → copy from `customer_exotel_settings.is_enabled`
  - `voicebot_multilingual` → seeded from current env default (`FALSE`)
  - Greeting / error text are **not** stored on `customer_settings`; they remain on the `agents` table exactly as today.
- Keep the old columns on `customers` for one release cycle; application reads from the new table first. Drop deprecated columns after verification.

### 1.4 Resolution order (hot path)

Voice config (TTS pace, speaker, model, provider, sample rate):

```
1. session-level override (set mid-call, e.g. admin API)
2. agent row               (agents.tts_pace / tts_speaker / ...)
3. avatar row              (avatars.tts_pace, via agents.avatar_id)  ← §2
4. customer_settings       (tts_provider, tts_default_pace, ...)
5. .env fallback           (env.sarvam.ttsPace)
6. hard-coded default
```

Conversational text (greeting, error):

```
1. agent row               (agents.greeting_text / agents.error_text)  ← primary source
2. hard-coded default in code
```

Greeting and error text **never** fall through to `customer_settings` — they are
a per-agent concern. If a tenant wants a single greeting across all agents they
set it identically on every agent (or we can later add a small
`customer_agents_default` helper if it becomes a pain point).

This chain is implemented as a `resolveVoiceConfig(customerId, agentId)` helper so every call site (TTS, STT, VAD, LLM) shares the same logic. The resolved object is cached on `VoicebotSession` at `start` and refreshed only on explicit invalidation.

### 1.5 Admin API surface

```
GET    /customers/:customerId/settings         (admin token)
PUT    /customers/:customerId/settings         (admin token) full or partial
PATCH  /customers/:customerId/settings         (admin token) sparse JSON patch
POST   /customers/:customerId/settings/reset   (admin token) restore defaults

GET    /settings                              (api-key)     read-only view for tenant
PATCH  /settings                              (api-key)     tenant-editable subset only
```

Which fields the tenant can self-edit vs which require admin is enforced in the route via a hard-coded allow-list (e.g. `greeting_text` editable by tenant, `max_concurrent_calls` admin-only).

### 1.6 Touch points in existing code

| File                                   | Change                                                           |
|----------------------------------------|------------------------------------------------------------------|
| `src/routes/exotel-voicebot.ts`        | On `start`, load `customer_settings` + avatar into session.      |
| `src/services/voicebot-session.ts`     | Extend `VoicebotSession` with resolved config object.            |
| `src/routes/settings.ts`               | Expand from one `rag_use_openai_only` endpoint to full settings. |
| `src/routes/customers.ts`              | Stop reading `rag_use_openai_only` / `default_no_kb_fallback_instruction` from here. |
| `src/services/exotel-settings.ts`      | `is_enabled` stays there for routing; mirror to `voicebot_enabled` in settings via trigger. |

### 1.7 Decisions to confirm

- [ ] Keep per-tenant `voicebot_multilingual` in `customer_settings` and also keep the `.env` flag as a global kill-switch? (Recommendation: both — env wins when set to hard-false.)
- [ ] Should per-agent settings still override customer settings, or should we move agent-level flags into a sibling `agent_settings` table? (Recommendation: keep per-agent overrides as columns on `agents`; nullable = inherit.)
- [ ] Do we add per-environment seed rows (prod/sandbox) or use a single row gated by `customer_exotel_settings.use_sandbox`?
- [ ] STT/TTS provider sets — confirmed to start with `sarvam` and `elevenlabs`; anything else we want in the `CHECK` list today (e.g. `deepgram`, `google`, `azure`)?
- [ ] When `stt_provider` and `tts_provider` differ (e.g. ElevenLabs STT + Sarvam TTS), do we also keep per-language provider overrides? (Recommendation: defer — add `language_provider_map JSONB` to `avatars` only if needed.)

---

## 2. `avatars` — reusable voice/visual personas

### 2.1 Why a new table instead of more columns on `agents`

- An avatar (voice + image + persona) is reusable: one "Asha – warm Hindi female" avatar can power many agents (Sales, Support, Collections) of one customer, or be shared as a system-owned avatar across tenants.
- Today, every agent duplicates `tts_model / tts_speaker / tts_pace / tts_sample_rate`. Extracting this into a persona table eliminates drift when a customer wants to standardize.
- The avatar is also the right home for **per-language voice overrides** (`language_voice_map`) — a single persona can specify different Sarvam `speaker`s for `hi-IN` vs `ta-IN`.

### 2.2 Table shape

```
CREATE TABLE avatars (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id               UUID REFERENCES customers(id) ON DELETE CASCADE,
                            -- NULL = system / global avatar available to all tenants
  name                      TEXT NOT NULL,
  description               TEXT NOT NULL DEFAULT '',

  -- visual
  image_url                 TEXT,
  thumbnail_url             TEXT,
  video_loop_url            TEXT,       -- future talking-head avatar
  gender                    TEXT CHECK (gender IN ('male','female','neutral','other')),
  age_group                 TEXT,       -- 'young' | 'adult' | 'elder'

  -- voice (primary / default language)
  default_language_code     TEXT NOT NULL DEFAULT 'en-IN',
  tts_provider              TEXT CHECK (tts_provider IN ('sarvam','elevenlabs')),
                            -- NULL = inherit from customer_settings.tts_provider
  tts_model                 TEXT,       -- Sarvam: 'bulbul:v3' | ElevenLabs: 'eleven_multilingual_v2'
  tts_speaker               TEXT,       -- Sarvam speaker id OR ElevenLabs voice id
  tts_pace                  NUMERIC(3,2),
  tts_pitch                 NUMERIC(3,2),
  tts_loudness              NUMERIC(3,2),
  tts_sample_rate           INT,

  -- per-language voice map (optional; each entry may also specify its own provider)
  --   example:
  --   {
  --     "hi-IN": {"tts_provider":"sarvam","tts_model":"bulbul:v3",
  --               "tts_speaker":"asha","tts_pace":0.95},
  --     "en-IN": {"tts_provider":"elevenlabs",
  --               "tts_model":"eleven_multilingual_v2",
  --               "tts_speaker":"21m00Tcm4TlvDq8ikWAM"}
  --   }
  language_voice_map        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- persona (LLM prompt nudges)
  persona_traits            JSONB NOT NULL DEFAULT '{}'::jsonb,
                            -- {"style":"friendly","formality":"casual",
                            --  "tagline":"Always end with a warm question."}
  persona_prompt_snippet    TEXT,       -- prepended to agent.system_prompt

  is_active                 BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at                TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_avatars_customer ON avatars(customer_id)
  WHERE customer_id IS NOT NULL;

-- agents.avatar_id:
ALTER TABLE agents
  ADD COLUMN avatar_id UUID REFERENCES avatars(id) ON DELETE SET NULL;
CREATE INDEX idx_agents_avatar ON agents(avatar_id) WHERE avatar_id IS NOT NULL;
```

**Tenant isolation rule (enforced in code):** an agent may reference either
(a) an avatar owned by its own customer, or
(b) an avatar with `customer_id IS NULL` (system avatar). The API rejects
cross-tenant avatar IDs with 403.

### 2.3 Voice config resolution

The earlier chain becomes:

```
agent row → avatar row (primary fields) → avatar.language_voice_map[current_lang]
          → customer_settings defaults → env fallback
```

The avatar row is fetched once during `bootstrapVoicebotChatSession` using a
`LEFT JOIN avatars a ON a.id = agents.avatar_id` on the existing agent query.
When a mid-call language switch happens (§3), the session re-resolves TTS
params using `avatar.language_voice_map[new_language_code]`.

### 2.4 Admin API surface

```
-- system avatars (admin token, customer_id IS NULL)
POST   /admin/avatars
GET    /admin/avatars
PUT    /admin/avatars/:id
DELETE /admin/avatars/:id

-- per-tenant avatars (api-key)
POST   /avatars
GET    /avatars                     (tenant + system avatars visible)
GET    /avatars/:id
PUT    /avatars/:id
DELETE /avatars/:id

-- link / unlink avatar on an agent
PATCH  /agents/:id    { "avatar_id": "..." }  or  { "avatar_id": null }
```

### 2.5 Touch points in existing code

| File                                        | Change                                                              |
|---------------------------------------------|---------------------------------------------------------------------|
| `src/routes/agents.ts`                      | Accept/return `avatar_id`; validate tenant scope.                   |
| `src/routes/exotel-voicebot.ts` (bootstrap) | Replace `SELECT … FROM agents` with `agents LEFT JOIN avatars`.     |
| `src/services/voicebot-session.ts`          | Add `avatarId`, `avatarLanguageVoiceMap`, `avatarPersonaSnippet` to `VoicebotSession`. |
| RAG prompt builder inside `runVoicebotAskPipeline` | Prepend `persona_prompt_snippet` to the agent `system_prompt` if present. |
| New file `src/routes/avatars.ts`            | CRUD routes.                                                        |

### 2.6 Decisions to confirm

- [ ] Should system-owned avatars (NULL `customer_id`) be exposed to every tenant by default, or gated via an `is_public` flag on `avatars`? (Recommendation: `is_public BOOLEAN DEFAULT TRUE` for NULL-owner rows, so we can also have admin-only draft avatars.)
- [ ] Video/lip-sync avatars: in scope now (just store URL) or future phase?
- [ ] Asset storage: image URL stored as plain text today, or do we want a `media_assets` table with signed-URL rotation?

---

## 3. Multilingual call tracking + mid-call language switch

### 3.1 Why it needs DB support

Today:

- Sarvam STT returns `language_code` per utterance.
- `exotel-voicebot.ts` uses that value only for the TTS language on the same turn.
- It is **never persisted** — neither "what language was this caller speaking" nor "did they switch mid-call".

We need:

- Know the caller's language on the first non-empty STT result, so analytics and later turns know what to render in.
- Allow mid-call language change (opt-in) and **audit** when/why it happened.
- Ensure TTS, RAG prompt, and IVR prompts all follow the current call language.

### 3.2 Schema changes

#### 3.2.1 Extend `exotel_call_sessions`

```
ALTER TABLE exotel_call_sessions
  ADD COLUMN initial_language_code    TEXT,
  ADD COLUMN current_language_code    TEXT,
  ADD COLUMN language_switch_count    INT NOT NULL DEFAULT 0,
  ADD COLUMN language_last_confidence NUMERIC(4,3);
```

Semantics:

- `initial_language_code` — set **once**, on the first `processUtterance()` call where Sarvam returned a non-empty transcript. Never updated after that.
- `current_language_code` — equals `initial_language_code` at first, then can change via the mid-call switch flow.
- `language_switch_count` — incremented each time `current_language_code` is changed after `initial_language_code` is set.
- `language_last_confidence` — Sarvam STT confidence on the last turn (if provided).

#### 3.2.2 Extend `chat_messages` (optional, high value for analytics)

```
ALTER TABLE chat_messages
  ADD COLUMN language_code TEXT;
```

Populated at insert time with the language the turn was spoken/generated in.

#### 3.2.3 New audit table `call_language_events`

```
CREATE TABLE call_language_events (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exotel_call_session_id  UUID NOT NULL REFERENCES exotel_call_sessions(id)
                          ON DELETE CASCADE,
  from_language_code      TEXT,                          -- NULL for first_detection
  to_language_code        TEXT NOT NULL,
  trigger                 TEXT NOT NULL CHECK (trigger IN (
                            'first_detection',
                            'auto_detected',
                            'keyword',
                            'dtmf',
                            'admin_override',
                            'agent_handoff'
                          )),
  confidence              NUMERIC(4,3),
  transcript_snippet      TEXT,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_call_lang_events_call
  ON call_language_events (exotel_call_session_id, created_at);
```

### 3.3 Runtime flow

First-detection (unchanged in intent, always runs even when `allow_language_switch = FALSE`):

```
At the top of processUtterance(), after STT returns {transcript, detectedLanguage, confidence}:

if (!session.initialLanguageCode && transcript.trim()) {
  session.initialLanguageCode = detectedLanguage;
  session.currentLanguageCode = detectedLanguage;
  persistInitialLanguage(session, detectedLanguage, confidence);
  // UPDATE exotel_call_sessions SET initial_language_code, current_language_code
  // INSERT INTO call_language_events (trigger='first_detection', ...)
}
```

Mid-call switch — **menu-style, user-initiated** (only runs when
`customer_settings.allow_language_switch = TRUE`):

```
Trigger:
  - The STT transcript of any turn contains one of
    customer_settings.language_switch_trigger_keywords
    (matched case-insensitively, substring match against normalized text).

When triggered, session enters "language_switch" sub-mode and skips the normal
RAG pipeline for that turn. The agent drives a tiny 2-step dialog:

  Step 1 (confirm):
    Bot speaks: customer_settings.language_switch_confirm_prompt
                  → "Would you like to change the language?
                     Please say yes or no."
    Wait for next utterance (timeout: language_switch_timeout_ms).
    STT the answer.
      - If transcript matches language_switch_yes_words  → go to Step 2
      - If transcript matches language_switch_no_words   → exit switch mode,
                                                            return to normal
                                                            RAG on next turn.
      - Unrecognized / timeout → retry Step 1 up to
        language_switch_max_attempts. On final failure,
        exit switch mode.

  Step 2 (choose):
    Bot speaks: customer_settings.language_switch_options_prompt
                  with {LANGUAGE_LIST} = human-readable names of
                  customer_settings.allowed_language_codes
                  (e.g. "Please say one of: Hindi, English, Marathi.")
    Wait for next utterance.
    STT the answer.
    Match the transcript to a code via a built-in
    <language-name -> BCP-47 code> map
    (includes English names AND native-script names:
       "hindi"/"हिंदी" → hi-IN,
       "english"/"अंग्रेज़ी" → en-IN,
       "marathi"/"मराठी" → mr-IN, ...
    ) AND verify the matched code is in allowed_language_codes.
      - Match → commitLanguageSwitch(session, targetCode,
                                      trigger='keyword',
                                      confidence=STT.confidence)
                  - UPDATE exotel_call_sessions SET current_language_code,
                      language_switch_count = language_switch_count + 1
                  - INSERT INTO call_language_events(from, to, trigger, ...)
                  - Reset per-language voice config from avatar.language_voice_map
                  - Bot speaks a short confirmation in the NEW language
                    (e.g. "Okay, continuing in Hindi.")
      - No match / timeout → retry Step 2 up to
        language_switch_max_attempts. On final failure,
        exit switch mode (no change).
```

`customer_settings.voicebot_multilingual` still gates whether STT passes a
`language_code` hint to the provider:

- `FALSE` → STT is pinned to `session.currentLanguageCode` (or
  `default_language_code` pre-first-detection). This is the safe, stable mode.
- `TRUE` → STT runs in auto-detect. The mid-call switch menu is still the
  **only** way `current_language_code` changes — we do not auto-commit on
  language drift in transcripts, because 8 kHz telephony audio is noisy enough
  that Sarvam often mis-detects single words.

Admin override (out-of-band, e.g. for QA during a live call):

- `POST /calls/:callId/language-override { language_code }` forces the switch
  and logs `trigger='admin_override'` without running the menu.

No longer supported in this design:

- ~~Silent auto-commit on detected-language drift~~ (replaced by explicit menu).
- ~~`language_switch_dtmf_digit`~~ (we're not using a DTMF digit for this; the menu flow is speech-driven).
- ~~`language_switch_confirm_required`~~ (confirmation is always on; it's the whole flow).
- ~~`language_switch_confidence_min`~~ / ~~`language_switch_debounce_turns`~~ (not needed when a user explicitly asks to switch).

### 3.4 TTS / STT integration

- **TTS language:** always `session.currentLanguageCode`. The existing
  `ttsLanguage = env.voicebotMultilingual ? mapToTtsLanguage(detectedLanguage) : "en-IN"`
  block becomes `ttsLanguage = mapToTtsLanguage(session.currentLanguageCode)`.
- **STT language hint:** when `voicebot_multilingual = TRUE`, don't pass
  `language_code` (let the provider auto-detect). When `FALSE`, pass
  `session.currentLanguageCode` (or `default_language_code` pre-first-detection).
  This is also the only reason `stt_mode` is not a separate setting — it is
  derived from `voicebot_multilingual`.
- **Provider selection:** `stt_provider` and `tts_provider` are independent.
  `resolveVoiceConfig` picks the right client module (Sarvam vs ElevenLabs) for
  each leg, so a tenant can run, say, ElevenLabs STT + Sarvam TTS without code
  forks elsewhere.
- **Streaming:** if `stt_streaming_enabled = TRUE` and the chosen provider
  supports it, we stream partials instead of batch-sending the whole WAV; if
  `tts_streaming_enabled = TRUE`, we forward PCM chunks to Exotel as they
  arrive from the provider; if `rag_streaming_enabled = TRUE`, the LLM is called
  in streaming mode and TTS is fed sentence-by-sentence.
- **Avatar per-language voice:** on each commit of a language switch, re-resolve
  TTS params (including `tts_provider`) using `avatar.language_voice_map[newLang]`.
- **RAG prompt:** add a soft instruction to the system prompt:
  `"Respond in <language-name> (BCP-47: <code>)."`. This replaces today's hard-coded
  English-only line in the `languageRule` block.

### 3.5 Admin API surface

```
GET   /calls/:callId/language-events            (admin)
POST  /calls/:callId/language-override          (admin)  body: { language_code }
      -- Forces current_language_code on an in-flight call; logs trigger='admin_override'.
```

### 3.6 Touch points in existing code

| File                                   | Change                                                                             |
|----------------------------------------|------------------------------------------------------------------------------------|
| `src/routes/exotel-voicebot.ts`        | First-detection block + switch detection + switch commit inside `processUtterance`. |
| `src/services/voicebot-session.ts`     | Add `initialLanguageCode`, `currentLanguageCode`, `pendingLanguageSwitch`, `switchCount`. |
| `src/services/voicebot-session.ts`     | Helper `commitLanguageSwitch(session, target, trigger, confidence)`.               |
| Migration `005_multilingual.sql`        | Schema changes above.                                                              |

### 3.7 Decisions to confirm

- [ ] Ship default `language_switch_trigger_keywords` in 2–3 languages (English, Hindi, Marathi) out of the box, and let tenants extend? (Recommendation: yes.)
- [ ] Built-in language-name ↔ BCP-47 map: ship English + native script aliases for all 11 Sarvam-supported languages in code (not in DB)? (Recommendation: yes, keep in code.)
- [ ] Should the confirmation speech in Step 1 / Step 2 be played in the **current** language, in **all** `allowed_language_codes`, or a bilingual mix? (Recommendation: current language only; the user has already understood the prompt well enough to trigger it.)
- [ ] When `voicebot_multilingual = TRUE`, do we still forbid silent auto-switch, or expose a separate `auto_commit_on_language_drift` opt-in for advanced tenants later?

---

## 4. IVR voice menu system

### 4.1 Why opt-in

IVR is only useful for customers that want structured routing ("press 1 for sales, 2 for support"). Many conversational agents should **not** have IVR on top. So the whole IVR code path runs **only** when `customer_settings.ivr_enabled = TRUE` and `customer_settings.ivr_welcome_menu_id IS NOT NULL`.

Escape from IVR is handled by `customer_settings.stop_words` (speech) — a
caller saying "operator" or "main menu" pops the IVR stack. There is **no**
cancel digit.

### 4.2 Schema

#### 4.2.1 `ivr_menus`

```
CREATE TABLE ivr_menus (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id           UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name                  TEXT NOT NULL,
  description           TEXT NOT NULL DEFAULT '',

  -- Prompt played when this menu is entered
  prompt_text           TEXT NOT NULL,
  prompt_audio_url      TEXT,
  prompt_language_code  TEXT NOT NULL DEFAULT 'en-IN',

  -- Input behaviour for this menu
  input_mode            TEXT NOT NULL DEFAULT 'both'
                        CHECK (input_mode IN ('dtmf','speech','both')),
  timeout_ms            INT  NOT NULL DEFAULT 5000,
  max_retries           INT  NOT NULL DEFAULT 3,

  invalid_input_text    TEXT NOT NULL DEFAULT 'Sorry, I did not get that.',
  no_input_text         TEXT NOT NULL DEFAULT 'I did not hear anything.',
  on_max_retries_action TEXT NOT NULL DEFAULT 'fallback_to_agent'
                        CHECK (on_max_retries_action IN
                          ('fallback_to_agent','end_call','handoff_human')),

  is_active             BOOLEAN NOT NULL DEFAULT TRUE,
  created_at            TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ivr_menus_customer ON ivr_menus(customer_id);
```

#### 4.2.2 `ivr_menu_options`

```
CREATE TABLE ivr_menu_options (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id           UUID NOT NULL REFERENCES ivr_menus(id) ON DELETE CASCADE,
  label             TEXT NOT NULL,            -- "Sales"

  dtmf_digit        TEXT CHECK (dtmf_digit ~ '^[0-9*#]$'),  -- '1' | '*' | '#'
  speech_keywords   TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
                    -- any of these phrases triggers this branch

  action_type       TEXT NOT NULL CHECK (action_type IN (
                      'goto_menu',
                      'route_to_agent',
                      'play_message',
                      'collect_input',
                      'handoff_human',
                      'end_call',
                      'trigger_webhook'
                    )),

  -- Shape depends on action_type, for example:
  --   goto_menu:       {"next_menu_id":"<uuid>"}
  --   route_to_agent:  {"agent_id":"<uuid>"}
  --   play_message:    {"text":"Our hours are 9 to 6.","after":"return"|"end"}
  --   collect_input:   {"var_name":"booking_id","prompt":"Say your booking id",
  --                     "input_mode":"speech","next_menu_id":"<uuid>"}
  --   handoff_human:   {"phone_number":"+91...","whisper_text":"..."}
  --   trigger_webhook: {"url":"https://...","method":"POST",
  --                     "pass_call_context":true,"next_menu_id":"<uuid>"}
  action_payload    JSONB NOT NULL DEFAULT '{}'::jsonb,

  sort_order        INT  NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ivr_options_menu ON ivr_menu_options(menu_id);
```

Validation rules enforced in application:

- Exactly one of `dtmf_digit` / `speech_keywords` must be non-empty (or both if menu `input_mode='both'`).
- `goto_menu.next_menu_id` must reference a menu in the same `customer_id`.
- `route_to_agent.agent_id` must be same-customer and active.

#### 4.2.3 `ivr_session_state` (persisted so we can resume if WS drops)

```
CREATE TABLE ivr_session_state (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exotel_call_session_id  UUID UNIQUE NOT NULL
                          REFERENCES exotel_call_sessions(id) ON DELETE CASCADE,
  current_menu_id         UUID REFERENCES ivr_menus(id) ON DELETE SET NULL,
  history_menu_ids        UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  retries_on_current      INT  NOT NULL DEFAULT 0,
  collected_inputs        JSONB NOT NULL DEFAULT '{}'::jsonb,
  exited_at               TIMESTAMP,
  exit_reason             TEXT,
  created_at              TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMP NOT NULL DEFAULT NOW()
);
```

### 4.3 Runtime flow

Extension of the Exotel WS handler:

```
start event:
  load customer_settings
  if ivr_enabled and ivr_welcome_menu_id:
    session.mode = 'ivr'
    session.ivrMenuId = customer_settings.ivr_welcome_menu_id
    insert ivr_session_state row
    play menu.prompt_text via TTS (in prompt_language_code)
  else:
    session.mode = 'agent'    # existing behaviour
    play greeting, etc.

media event (when session.mode === 'ivr'):
  buffer PCM as today
  on silence-timeout → processIvrInput(session)

processIvrInput:
  STT the buffered PCM
  // Stop-word check runs first — it always wins over option matching.
  if transcript matches any of customer_settings.stop_words:
    if ivr_session_state.history_menu_ids is non-empty:
      pop to parent menu, replay its prompt
    else:
      if ivr_fallback_to_agent: exit IVR → agent mode
      else: end_call
    return
  match transcript against menu.options[].speech_keywords
  if no match → invalid_input → replay prompt, retries_on_current++
    if retries_on_current >= max_retries → on_max_retries_action
  on match → executeAction(option)

dtmf event (when session.mode === 'ivr'):
  match digit against menu.options[].dtmf_digit
  same match → executeAction flow

executeAction:
  goto_menu:       push current to history, set current_menu_id, play new prompt
  route_to_agent:  session.agentId = payload.agent_id; session.mode='agent';
                   speak handoff_text (optional); continue as standard RAG call
  play_message:    TTS payload.text; after='return' → re-enter current menu;
                                     after='end'    → end_call
  collect_input:   STT next utterance, store under payload.var_name in
                   ivr_session_state.collected_inputs,
                   then goto_menu(payload.next_menu_id)
  handoff_human:   use Exotel Connect / SIP bridge to payload.phone_number
                   (stub for v1; record intent)
  trigger_webhook: POST to payload.url with {customer_id, call_sid,
                   collected_inputs}; respect returned {next_menu_id} or {say}
  end_call:        farewell TTS, socket.close
```

`stop` / WS close writes `exited_at` + `exit_reason` on `ivr_session_state`.

### 4.4 Interaction with §3 (multilingual)

- The IVR prompt is played in `ivr_menus.prompt_language_code`.
- Post-IVR (agent mode), `session.currentLanguageCode` is still whatever was
  detected from the user's first IVR utterance (via §3).
- A `language_switch` DTMF/keyword inside the IVR simply updates
  `current_language_code` and replays the **same** menu in the new language — for this to work, menus either:
  - store translations in `prompt_text` as JSONB `{lang: text}`, or
  - are duplicated per language and linked via a new table (`ivr_menu_translations`).

  **Recommendation:** use JSONB translations on `ivr_menus.prompt_text` (backwards compatible — plain string is treated as `{'default': '…'}`). Decision for later.

### 4.5 Admin API surface

```
-- menus
POST   /ivr/menus                          (api-key)
GET    /ivr/menus                          (api-key)
GET    /ivr/menus/:id                      (api-key)
PUT    /ivr/menus/:id
DELETE /ivr/menus/:id

-- options
POST   /ivr/menus/:menuId/options
PUT    /ivr/options/:id
DELETE /ivr/options/:id
POST   /ivr/options/:id/reorder            { sort_order: N }

-- test / simulate
POST   /ivr/menus/:id/simulate
        body: { input: "2" | "sales" }
        returns the action that would fire (dev tool)

-- visual helpers
GET    /ivr/tree                           returns the customer's full menu graph
```

### 4.6 Touch points in existing code

| File                                | Change                                                                       |
|-------------------------------------|------------------------------------------------------------------------------|
| `src/routes/exotel-voicebot.ts`     | Mode branch on `start`; `processIvrInput()` when mode is `ivr`.              |
| `src/services/voicebot-session.ts`  | Add `mode: 'ivr'\|'agent'`, `ivrMenuId`, `ivrRetries`, `collectedInputs`.    |
| `src/services/ivr.ts` (new)         | All IVR logic: load menu, match input, execute action.                       |
| `src/routes/ivr.ts` (new)           | Admin CRUD.                                                                  |
| Migration `006_ivr.sql`              | Tables above.                                                                |

### 4.7 Decisions to confirm

- [ ] Should IVR state be DB-backed (`ivr_session_state`) or purely in-memory like the current `VoicebotSession`? (Recommendation: both — in-memory for speed, DB for recovery + reporting.)
- [ ] `handoff_human` — does our Exotel plan support call bridging/transfer, or do we only model the intent for v1?
- [ ] Do we expose a visual IVR builder in the admin UI in phase 1, or JSON-only to start?

---

## 5. Barge-in (interruptible TTS)

### 5.1 Why it needs DB support

Today the Voicebot deliberately discards any inbound audio while TTS is in
flight or while Exotel has not yet acked all `mark` frames:

```
// apps/api/src/routes/exotel-voicebot.ts (current behaviour, around `case "media"`)
if (session.ttsInProgress || session.pendingMarks.size > 0) {
  break;          // <-- caller audio dropped, cannot interrupt
}
```

That's the safe default but it makes long agent responses frustrating — the
caller has to wait for the agent to finish before they can say anything.
Barge-in opt-in inverts this, and we want three flavours so tenants can pick
the UX they're comfortable with.

### 5.2 Settings recap

| Key                          | Type    | Default               |
|------------------------------|---------|-----------------------|
| `barge_in_enabled`           | BOOLEAN | `FALSE`               |
| `barge_in_mode`              | TEXT    | `'finish_then_answer'` |
| `barge_in_min_speech_ms`     | INT     | `400`                 |
| `barge_in_energy_threshold`  | INT     | `250`                 |

`barge_in_mode` values:

| Mode                 | Behaviour when caller speaks during TTS                                                                                      |
|----------------------|------------------------------------------------------------------------------------------------------------------------------|
| `immediate`          | Agent stops speaking **immediately** at the next audio chunk boundary, drains pending marks, then listens for the user's utterance. No resumption of the interrupted reply. |
| `finish_then_answer` | **Default / what the user requested.** Agent stops queuing new audio, captures the user's new utterance, then **first completes the sentence that was interrupted** and only after that addresses the new question. |
| `finish_turn`        | Agent keeps playing its full current reply (no interruption), buffers the caller's speech in parallel, and processes it as the next turn. Effectively "record but don't stop". |

When `barge_in_enabled = FALSE`, the current behaviour is preserved: inbound
audio during TTS / pending marks is dropped, caller cannot interrupt.

### 5.3 Runtime flow (the `finish_then_answer` mode)

State added to `VoicebotSession`:

```
interruptedAssistantTail?: string   // text that was queued but not yet played
                                    // when barge-in fired (typically the tail of
                                    // the current sentence, or any un-played
                                    // sentences of the current turn).
bargeInActive: boolean              // we have seen sustained speech during TTS
                                    // and are now collecting the caller's utterance
bargeInSpeechStartedAt: number | null
```

When `barge_in_enabled = TRUE`, the `media` handler no longer short-circuits on
`session.ttsInProgress || session.pendingMarks.size > 0`. Instead:

```
on media event during TTS playback:
  energy = pcmRmsEnergy(pcm)
  if energy >= barge_in_energy_threshold:
    if !session.bargeInActive:
      // first loud chunk — remember when it started
      session.bargeInSpeechStartedAt = now
      session.inboundPcm.push(pcm)       // start buffering
      session.inboundBytes += pcm.length
    else:
      session.inboundPcm.push(pcm)
      session.inboundBytes += pcm.length

    // Trigger barge-in only after sustained speech
    if (now - session.bargeInSpeechStartedAt) >= barge_in_min_speech_ms:
      if !session.bargeInActive:
        session.bargeInActive = true
        triggerBargeIn(session, mode='finish_then_answer')
  else:
    // silent frame during TTS
    if session.bargeInActive:
      session.inboundPcm.push(pcm)   // keep buffering through pauses
      // normal VAD silence timer runs now to end the utterance
```

`triggerBargeIn(session, 'finish_then_answer')`:

```
1. Stop queuing further TTS media frames for this assistant turn.
   - Mark the TTS generator as cancelled so any remaining PCM chunks from
     Sarvam/ElevenLabs are dropped on arrival.
2. Send `event: "clear"` to Exotel on the WebSocket so it discards any media
   it has buffered but not yet played out to the caller. (This is the same
   "clear" frame we send today when we need to flush playback.)
3. Preserve `session.interruptedAssistantTail` — the portion of the assistant's
   text that hadn't been TTS-streamed yet when we cancelled. Source of this
   tail depends on streaming mode:
     - `rag_streaming_enabled = TRUE` + `tts_streaming_enabled = TRUE`:
         tail = concatenation of LLM tokens that hadn't yet been flushed
                to TTS. We track this via a "pending sentence" buffer.
     - Non-streaming:
         tail = the remainder of the assistant text from the first word that
                was queued to TTS but not yet ack'd by a `mark`. We keep a
                word-offset estimate via play-time alignment (pcmDurationMs).
4. Log voiceTrace("barge_in.triggered", {...}).
```

Then the normal VAD path takes over: the caller finishes their utterance,
silence timer fires, `processUtterance()` runs.

Inside `processUtterance()`, when `session.interruptedAssistantTail` is set:

```
transcript = STT(...)
...
answerToNewCommand = runVoicebotAskPipeline(session, transcript, ...)

// "first complete the past sentence, then continue with new command"
finalAssistantText =
    trimIncompleteSuffix(session.interruptedAssistantTail)    // end at a sentence boundary
  + ' '
  + answerToNewCommand.answer

session.interruptedAssistantTail = undefined
session.bargeInActive = false

await speakToExotel(ws, session, finalAssistantText, ttsLanguage, log)
appendVoiceTurnToChat(session, transcript, finalAssistantText, ...)
```

`trimIncompleteSuffix` cuts off at the last `.`, `?`, `!`, `।` (Devanagari) so
we don't read half a word. If the tail is empty or has no sentence boundary,
we drop it silently (nothing to resume).

### 5.4 Runtime flow (the other two modes)

- **`immediate`:** same as above but `triggerBargeIn` discards
  `interruptedAssistantTail` (we don't resume anything). The assistant simply
  addresses the new user question on the next turn.
- **`finish_turn`:** the `media` handler buffers inbound audio during playback
  but does **not** cancel TTS. When Exotel acks the final mark (or the
  playback fallback timer fires), `processUtterance()` runs on the already-buffered
  caller audio exactly as it does today for a normal VAD cycle. This is the
  closest thing to "record but don't stop" and is useful for very short
  confirmations from the caller.

### 5.5 Echo / false-trigger protection

Telephony audio has some echo of our own TTS coming back through the caller's
handset; that's why `barge_in_energy_threshold` defaults higher than
`vad_energy_threshold` and `barge_in_min_speech_ms` exists. Additionally:

- We ignore inbound energy during the first `150 ms` of any TTS playback
  (hard-coded guard) — that is the window where Exotel's own buffering
  most often bounces our audio back.
- If an inbound chunk is received **between** the last outbound media frame
  and Exotel's `mark` ack, and its energy profile closely matches the last
  outbound chunk, we treat it as echo and do not count it toward
  `barge_in_min_speech_ms`. (Future enhancement — start without it and
  calibrate with pilot data.)

### 5.6 Touch points in existing code

| File                                   | Change                                                                                                  |
|----------------------------------------|---------------------------------------------------------------------------------------------------------|
| `src/routes/exotel-voicebot.ts`        | Remove the hard drop during TTS when `barge_in_enabled=TRUE`; run the energy check above; on trigger, send Exotel `clear` frame and short-circuit TTS generator. |
| `src/services/voicebot-session.ts`     | Add `bargeInActive`, `bargeInSpeechStartedAt`, `interruptedAssistantTail`.                              |
| `src/services/sarvam.ts` / new `elevenlabs.ts` | TTS client must expose a cancel / abort handle so we can stop synthesis midway (especially in streaming). |
| `src/routes/exotel-voicebot.ts` — `sendAudioToExotel` | Split into a queue that can be cancelled; current implementation sends all chunks synchronously inside the function. |
| Trace log                              | Add `voicebot:barge_in.triggered`, `voicebot:barge_in.completed`, `voicebot:barge_in.resumed_tail`.     |

### 5.7 Decisions to confirm

- [ ] `barge_in_mode` default: the user asked for the "finish past sentence, then answer new command" behaviour, so default = `finish_then_answer`. Agree?
- [ ] Should `interruptedAssistantTail` be stored in `chat_messages` as a separate turn (so audit trail shows what the agent *tried* to say) or kept in-memory only? (Recommendation: store only when we actually resume it — append to the resumed message.)
- [ ] Do we expose a per-agent override of `barge_in_mode` (some bots benefit from `immediate`, some from `finish_turn`)? (Recommendation: add `agents.barge_in_mode` nullable; `NULL` inherits from `customer_settings`.)
- [ ] Echo-suppression: ship with the simple energy-threshold guard first, or integrate a real AEC (acoustic echo cancellation) library up front? (Recommendation: simple guard first.)

---

## 6. Cross-cutting concerns

### 6.1 Migrations order

1. `005_customer_settings.sql` — create `customer_settings`, back-fill from `customers` + `customer_exotel_settings`, keep old columns.
2. `006_avatars.sql` — create `avatars`, add `agents.avatar_id`, seed a few system avatars.
3. `007_multilingual.sql` — extend `exotel_call_sessions`, `chat_messages`, create `call_language_events`.
4. `008_ivr.sql` — create `ivr_menus`, `ivr_menu_options`, `ivr_session_state`, add `customer_settings.ivr_welcome_menu_id` FK (was declared nullable in step 1).
5. `009_cleanup.sql` (after one release of dual-read) — drop deprecated `customers.rag_use_openai_only` and `customers.default_no_kb_fallback_instruction`.

(Barge-in needs no new table — all its state is in-memory on `VoicebotSession`; its four settings columns are added in step 1.)

### 6.2 Performance / caching

- `customer_settings` should be cached in-process for `CACHE_TTL_MS` (same pattern as `getExotelSettings`).
- Avatars cached per-customer; invalidate on `PUT /avatars/:id` or `PATCH /agents/:id`.
- IVR menus cached per-customer; invalidate on any menu/option mutation.
- Language events are append-only and never read in the hot path.

### 6.3 Backwards compatibility

- Every new column has a safe default; every new table is opt-in (IVR only loads if enabled, barge-in only activates if enabled).
- Existing calls without an `avatar_id` continue to use the per-agent TTS columns.
- Existing calls without a `customer_settings` row (shouldn't happen after back-fill) fall back to env defaults.
- Existing tenants keep `barge_in_enabled = FALSE` → the voicebot behaves exactly as today (inbound audio during TTS is dropped).

### 6.4 Security

- Admin token required for system avatars, IVR tree edits beyond a "tenant-editable" subset, and webhook URLs.
- Webhook delivery signs payloads with `customer_settings.webhook_secret` (HMAC-SHA256).
- `call_transcript_enabled = FALSE` short-circuits all `chat_messages` inserts for that tenant's voice calls (`appendVoiceTurnToChat` / `appendAssistantChatLine` become no-ops). Message encryption remains on by default for the rows that are written.

### 6.5 Observability

Add to `voiceTrace` / `logVoiceStage`:

- `language.first_detection { language, confidence }`
- `language.switch { from, to, trigger, confidence }`
- `ivr.menu_entered { menu_id, attempt }`
- `ivr.option_matched { option_id, input_kind: 'dtmf'|'speech' }`
- `ivr.action_executed { action_type, payload_summary }`
- `barge_in.triggered { mode, speech_ms, tail_chars }`
- `barge_in.resumed_tail { tail_preview }`
- `settings.resolved { cache_hit, keys_used[] }`

---

## 7. Out of scope for this document

- Video avatars (lip-sync), WhatsApp/SMS channels, outbound dialer — listed in the companion catalog as roadmap items.
- Billing / metering implementation.
- Admin UI wireframes.

Once you sign off on the schema and flow in this document, we'll move on to:

1. Writing the actual SQL migrations.
2. Updating `exotel-voicebot.ts`, `voicebot-session.ts`, and introducing `src/services/ivr.ts` + `src/services/customer-settings.ts` + `src/services/avatars.ts`.
3. Admin routes.
4. Tests.
