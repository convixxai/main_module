# Cartesia STT — Voicebot Integration Plan

**Date:** 2026-06-26  
**Goal:** Add **Cartesia Ink STT** as the **third STT provider** (alongside Sarvam and ElevenLabs Scribe) for the Exotel voicebot, using **`ink-whisper-2025-06-04`** for English, Hindi, and Marathi.  
**Status:** Implemented (2026-06-26)

> **Model decision (locked):** We will use **`ink-whisper-2025-06-04` only** — not `ink-2`. Ink 2 is English-only and does not support Hindi or Marathi; Convixx tenants routinely need **en / hi / mr**, so a single multilingual model avoids split code paths and misconfiguration.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Language Support: Hindi, English, Marathi](#2-language-support-hindi-english-marathi)
3. [PCM / Audio Format Compatibility (Exotel ↔ Cartesia)](#3-pcm--audio-format-compatibility-exotel--cartesia)
4. [Current STT Audit (Codebase)](#4-current-stt-audit-codebase)
5. [Cartesia STT — Model & Endpoint (locked)](#5-cartesia-stt--model--endpoint-locked)
6. [Recommended Architecture](#6-recommended-architecture)
7. [Latency Strategy (Faster Than Sarvam / ElevenLabs)](#7-latency-strategy-faster-than-sarvam--elevenlabs)
8. [Language Detection & Multilingual Policy](#8-language-detection--multilingual-policy)
9. [Configuration Model](#9-configuration-model)
10. [Database Changes (SQL — run manually)](#10-database-changes-sql--run-manually)
11. [Code Changes (When Approved)](#11-code-changes-when-approved)
12. [Implementation Phases](#12-implementation-phases)
13. [Risks & Mitigations](#13-risks--mitigations)
14. [Testing Checklist](#14-testing-checklist)
15. [Reference Links](#15-reference-links)

---

## 1. Executive Summary

Convixx today supports **two STT providers**, selected per tenant via `customer_settings.stt_provider`:

| Provider | Default model | Transport | Turn detection |
|----------|---------------|-----------|----------------|
| **Sarvam** (default) | `saaras:v3` | REST + optional WebSocket | **Our VAD** → batch WAV per utterance |
| **ElevenLabs** | `scribe_v2` | REST (multipart upload) | **Our VAD** → batch WAV per utterance |

Cartesia would be the **third option** (`stt_provider = 'cartesia'`). The same `CARTESIA_API_KEY` already used for Cartesia TTS can power STT.

### Key findings

| Question | Answer |
|----------|--------|
| Does Cartesia support **English**? | **Yes** — via **`ink-whisper-2025-06-04`** |
| Does Cartesia support **Hindi**? | **Yes** — via **`ink-whisper-2025-06-04`** (`hi` in language list) |
| Does Cartesia support **Marathi**? | **Yes** — via **`ink-whisper-2025-06-04`** (`mr` in language list) |
| Which model will Convixx use? | **`ink-whisper-2025-06-04` only** — covers en / hi / mr in one integration |
| Why not `ink-2`? | **English only** per [Ink 2 docs](https://docs.cartesia.ai/build-with-cartesia/stt/latest); Auto turn-detection endpoint does not support Hindi or Marathi |
| Exotel PCM compatible with Cartesia? | **Yes** — both use **signed 16-bit LE mono PCM** (`pcm_s16le`). No μ-law/A-law on the Exotel voicebot path. |
| Can we skip WAV wrapping? | **Yes** — send raw PCM binary over WebSocket. Sarvam/ElevenLabs still need WAV/container. |
| Cartesia endpoint for ink-whisper? | **Realtime STT (Manual)** `/stt/websocket` — our VAD + `finalize`, or ink-whisper `min_volume` / `max_silence_duration_secs` tuning |

### Chosen model & endpoint (all tenants)

| Setting | Value |
|---------|-------|
| **Model** | **`ink-whisper-2025-06-04`** |
| **Endpoint** | **`/stt/websocket`** (Manual) |
| **Turn end** | Existing Convixx VAD → send `"finalize"` (Phase 1); optional ink-whisper auto-silence params |
| **Languages** | English, Hindi, Marathi (and 90+ others if needed later) |

> **Note on `ink-2`:** Documented for reference only — we are **not** integrating it. Revisit only if Cartesia adds Hindi/Marathi to Ink 2 and the Auto endpoint.

---

## 2. Language Support: Hindi, English, Marathi

### Cartesia model we will use

| Model | English | Hindi (`hi`) | Marathi (`mr`) | Endpoint | Convixx usage |
|-------|---------|--------------|----------------|----------|---------------|
| **`ink-whisper-2025-06-04`** | ✅ | ✅ | ✅ | Manual `/stt/websocket` | **Yes — sole Cartesia STT model** |

| Model (not used) | English | Hindi | Marathi | Why excluded |
|------------------|---------|-------|---------|--------------|
| **`ink-2`** | ✅ | ❌ | ❌ | English-only; Auto endpoint cannot serve hi/mr tenants |

Per [Older Models](https://docs.cartesia.ai/build-with-cartesia/stt/older-models), `ink-whisper-2025-06-04` supports 90+ languages including `en`, `hi`, and `mr`.

### Comparison with current providers (for hi/mr/en)

| Provider | English | Hindi | Marathi | Language metadata in response |
|----------|---------|-------|---------|-------------------------------|
| Sarvam `saaras:v3` | ✅ | ✅ | ✅ | `language_code` + `language_probability` |
| ElevenLabs `scribe_v2` | ✅ | ✅ | ✅ | Inferred from response; mapped via `elevenLabsSttToSarvamShape()` |
| Cartesia **`ink-whisper-2025-06-04`** | ✅ | ✅ | ✅ | **No BCP-47 language tag on events** — use script inference (existing `inferLanguageFromTranscript()`) |

### Product implication

When `stt_provider = 'cartesia'`, **`stt_model` defaults to and should stay `ink-whisper-2025-06-04`**. Reject or ignore any other Cartesia STT model id (including `ink-2`) at settings PATCH time.

---

## 3. PCM / Audio Format Compatibility (Exotel ↔ Cartesia)

### Exotel inbound (current production path)

From `apps/api/src/types/exotel-ws.ts` and `docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`:

| Property | Value |
|----------|-------|
| Encoding | `raw` / `slin` — **signed 16-bit little-endian mono PCM** |
| Sample rate | **8000**, **16000**, or **24000 Hz** (negotiated in `start.media_format`) |
| Transport | Base64 in `media.payload` |
| Codec conversion | **None** — `decodeBase64Pcm()` decodes directly |

**μ-law / A-law:** Used in Sarvam/ElevenLabs **TTS output** options and some simulators. **Not used** on the Exotel voicebot STT inbound path.

### Cartesia STT input (from [Audio Input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input))

| Property | Cartesia value | Match with Exotel? |
|----------|----------------|-------------------|
| Encoding | `pcm_s16le` | ✅ **Exact match** (slin = s16le) |
| Sample rate | Must declare actual rate (8000–48000 for s16le) | ✅ **8000 / 16000 / 24000 all supported** |
| Channels | Mono | ✅ Exotel is mono |
| Chunk size | ~100 ms recommended | ✅ Forward Exotel media chunks or re-chunk |

### What we can eliminate for Cartesia STT

| Step (current Sarvam/ElevenLabs) | Cartesia STT |
|----------------------------------|--------------|
| `Buffer.concat(inboundPcm)` | Keep (or stream incrementally in Phase 2) |
| `createWavBuffer()` — 44-byte WAV header | **Skip** — send raw PCM binary on WS |
| REST multipart upload | **Skip** — persistent or per-utterance WebSocket |
| μ-law ↔ linear conversion | **Not needed** — neither side uses companded telephony on this path |

### Recommended Cartesia connection URL (example)

```
wss://api.cartesia.ai/stt/websocket
  ?model=ink-whisper-2025-06-04
  &encoding=pcm_s16le
  &sample_rate=8000
  &language=hi
  &cartesia_version=2026-03-01
```

(`language` = ISO-639-1 from `session.currentLanguageCode`: `en`, `hi`, or `mr`; omit for open detect when policy allows.)

Use `session.mediaFormat.sample_rate` dynamically (same pattern as Cartesia TTS in `cartesia-tts-ws.ts` which already uses `CARTESIA_VERSION = "2026-03-01"`).

### Silence handling (Cartesia requirement)

Per [Turn Detection — Edge cases](https://docs.cartesia.ai/use-the-api/stt/turns): Cartesia expects a **continuous audio stream**. If the caller is silent, send **zero-filled PCM chunks** (silence), not gaps. Our Exotel media stream already sends continuous chunks during the call; when implementing persistent WS (Phase 2), forward silence frames during TTS playback / hold rather than stopping sends.

---

## 4. Current STT Audit (Codebase)

### Provider selection

- **DB:** `customer_settings.stt_provider` — CHECK `('sarvam','elevenlabs')`
- **TypeScript:** `SttProvider = "sarvam" | "elevenlabs"` in `customer-settings.ts`
- **API:** `PATCH /settings` — `z.enum(["sarvam", "elevenlabs"])`
- **Default:** `sarvam`

### Call sites that must gain a Cartesia branch

| File | Function / route | Role |
|------|------------------|------|
| `apps/api/src/routes/exotel-voicebot.ts` | `processUtterance()` ~L2738–3050 | **Primary production path** |
| `apps/api/src/routes/voice-simulator.ts` | `runSimulatorStt()` | TTS simulators that record mic audio |
| `apps/api/src/routes/ask.ts` | `POST /ask/voice` | HTTP voice ask |
| `apps/api/src/services/customer-settings.ts` | `SttProvider` type | Type safety |
| `apps/api/src/routes/settings.ts` | PATCH schema + response | Admin API |
| `apps/api/src/config/swagger.ts` | OpenAPI | Docs |

**Not in scope for v1:** `POST /voice/speech-to-text` (`voice.ts`) — Sarvam-only test route; can add Cartesia later if needed.

### Current utterance pipeline (all providers)

```
Exotel media (base64 PCM s16le)
  → decodeBase64Pcm()
  → RMS energy VAD (vad_energy_threshold, vad_silence_timeout_ms)
  → buffer inboundPcm until silence
  → processUtterance()
  → createWavBuffer(combinedPcm, sample_rate)   ← eliminable for Cartesia
  → STT provider REST/WS
  → { transcript, language_code, language_probability? }
  → stt_domain_words replace
  → inferLanguageFromTranscript() (multilingual)
  → language switch policy
  → LLM / RAG
```

### Existing Cartesia infrastructure to reuse

| Asset | Path | Reuse for STT |
|-------|------|---------------|
| API key | `env.cartesia.apiKey` / `CARTESIA_API_KEY` | ✅ Same key |
| API version | `CARTESIA_VERSION = "2026-03-01"` in `cartesia.ts` | ✅ Same header/query param |
| WS auth pattern | `cartesia-tts-ws.ts` — `Cartesia-Version` header + `?cartesia_version=` | ✅ Mirror for STT WS |
| BCP-47 → ISO-639-1 | Can add `bcp47ToCartesiaSttLanguage()` near TTS helpers in `cartesia.ts` | For ink-whisper `language` query param |

### Environment variables (existing vs new)

| Variable | Status | Purpose |
|----------|--------|---------|
| `CARTESIA_API_KEY` | **Exists** | Auth |
| `VOICEBOT_CARTESIA_STT_FULL_AUTO` | **Proposed** | Skip language hint for ink-whisper (mirror Sarvam/ElevenLabs flags) |
| `CARTESIA_STT_WS_HARD_TIMEOUT_MS` | **Proposed** | Per-utterance WS timeout (default 28000, match Sarvam) |
| `CARTESIA_STT_MIN_VOLUME` | **Proposed** | ink-whisper silence threshold (default tune per telephony) |
| `CARTESIA_STT_MAX_SILENCE_SECS` | **Proposed** | ink-whisper auto-finalize silence cap (align with VAD) |

---

## 5. Cartesia STT — Model & Endpoint (locked)

Per [Compare Endpoints](https://docs.cartesia.ai/use-the-api/stt/compare-endpoints):

| Endpoint | Used? | Model | VAD / turn end |
|----------|-------|-------|----------------|
| **`/stt/websocket`** (Manual) | **Yes** | **`ink-whisper-2025-06-04`** | **Our VAD** + send `"finalize"` (or ink-whisper silence params) |
| **`/stt/turns/websocket`** (Auto) | **No** | `ink-2` only | Not used — English-only model |
| **`POST /stt`** (Batch) | Debug only | `ink-whisper` | Offline replay — **not for live telephony** |

### Integration path (single branch)

```
stt_provider == 'cartesia'
  → model: ink-whisper-2025-06-04  (always)
  → endpoint: /stt/websocket (Manual)
  → encoding: pcm_s16le @ session.mediaFormat.sample_rate
  → language hint: en | hi | mr (from session / multilingual policy)
  → Phase 1: VAD silence → send buffered PCM → finalize
  → Phase 2: persistent WS, stream PCM per Exotel media chunk, finalize on VAD
```

### ink-whisper Manual-only tuning params

From [Manual STT API](https://docs.cartesia.ai/api-reference/stt/websocket):

| Param | Purpose | Suggested starting value (8 kHz telephony) |
|-------|---------|---------------------------------------------|
| `min_volume` | Silence vs speech threshold (0–1) | `0.02`–`0.05` (tune with recorded calls) |
| `max_silence_duration_secs` | Auto-finalize after silence | `0.4`–`0.6` (align with `vad_silence_timeout_ms`) |
| `language` | ISO-639-1 hint | Map from `session.currentLanguageCode`: `en`, `hi`, `mr` |

---

## 6. Recommended Architecture

### Phase 1 — MVP (minimal risk, ship third provider)

**Goal:** Add Cartesia without restructuring the voicebot session loop.

```
VAD silence → combined PCM buffer (unchanged)
  → open Cartesia STT WebSocket (Manual, ink-whisper-2025-06-04)
  → send raw PCM binary (no WAV)
  → send "finalize" → wait for is_final transcript chunks
  → cartesiaSttToSarvamShape() → { transcript, language_code }
  → existing downstream (domain words, language policy, LLM)
```

**New service file:** `apps/api/src/services/cartesia-stt-ws.ts` (mirror `cartesia-tts-ws.ts` structure)

**Functions:**

```typescript
// Normalized output — same shape downstream expects
cartesiaSttToSarvamShape(transcript: string, languageHint?: string): {
  transcript: string;
  language_code: string;
}

// Phase 1 — per-utterance Manual WS (called from processUtterance)
cartesiaSpeechToTextWebsocket(params: {
  pcmBuffer: Buffer;
  sampleRate: number;
  model?: string;           // default ink-whisper-2025-06-04
  language?: string;        // ISO-639-1: en | hi | mr
  minVolume?: number;
  maxSilenceDurationSecs?: number;
  shouldAbort?: () => boolean;
}): Promise<{ status: number; body: unknown }>

resolveCartesiaSttModel(settings): string  // always returns ink-whisper-2025-06-04
bcp47ToCartesiaSttLanguage(bcp47: string): 'en' | 'hi' | 'mr' | string
```

### Phase 2 — Streaming (maximum latency win)

**Goal:** Match Cartesia's recommended voice-agent pattern — one WS per call, stream PCM as Exotel media arrives.

```
Call start
  → open Cartesia STT Manual WS (ink-whisper-2025-06-04)
  → on each Exotel media chunk: decodeBase64Pcm → ws.send(binary)
  → on VAD silence: ws.send("finalize") → collect is_final transcript deltas
  → optional: tune min_volume / max_silence_duration_secs to reduce finalize latency
```

**Session fields (VoicebotSession):**

```typescript
cartesiaStt?: CartesiaSttSession | null;
```

This aligns with `docs/OPUS_SUGGESTED_STEPS.md` §2.2 (persistent STT WebSocket) but uses Cartesia ink-whisper instead of Sarvam.

### Out of scope: Ink 2 Auto / `turn.eager_end`

The Auto endpoint (`/stt/turns/websocket`) and `turn.eager_end` speculative LLM are **not planned** — they require `ink-2`, which is English-only. Revisit if Cartesia ships multilingual Ink 2 on the Auto endpoint.

---

## 7. Latency Strategy (Faster Than Sarvam / ElevenLabs)

### Current latency budget (typical)

| Stage | Sarvam REST | Sarvam WS | ElevenLabs Scribe |
|-------|-------------|-----------|-------------------|
| VAD wait | `vad_silence_timeout_ms` (~500 ms) | same | same |
| WAV build | ~1 ms | ~1 ms | ~1 ms |
| Connect + upload | 200–800 ms | 100–300 ms (new WS/utterance) | 300–1000 ms |
| Transcription | 800–2500 ms | 400–1500 ms (+ idle settle) | 1000–3000 ms |
| **Total post-VAD STT** | **~1.5–3.5 s** | **~0.5–2 s** | **~1.5–4 s** |

### Cartesia targets (ink-whisper Manual)

| Phase | Expected post-VAD STT | How |
|-------|----------------------|-----|
| **Phase 1** (batch PCM, no WAV) | **~0.4–1.5 s** | Skip WAV + REST overhead; Manual WS + `finalize` |
| **Phase 2** (persistent WS + stream PCM) | **~0.2–0.8 s** | Audio already at Cartesia when VAD fires; `finalize` only flushes tail |

### Additional wins (no new dependencies)

1. **Skip `createWavBuffer()`** for Cartesia — saves alloc + 44 bytes/header processing (small but clean).
2. **Reuse WS per call** — avoid TLS handshake per utterance (same lesson as Cartesia TTS).
3. **Prefer 16 kHz Exotel negotiation** where Exotel account allows — Cartesia docs note recognition gains little above 16 kHz but 16 kHz > 8 kHz for consonants; test with your Exotel account.
4. **Do not add second STT pass** — keep single-request policy from `docs/VOICEBOT_STT_QUALITY_AND_TUNING.md`.

---

## 8. Language Detection & Multilingual Policy

Cartesia STT events **do not return** Sarvam-style `language_probability`. Integration must reuse existing Convixx logic:

| Step | Existing helper | Cartesia behavior |
|------|-----------------|-------------------|
| Language hint to STT | `sttLanguageHint` / `clampLanguageToAllowed()` | Pass `language=en|hi|mr` query param on Manual WS |
| Post-STT language tag | `inferLanguageFromTranscript()` | **Primary** for Cartesia multilingual |
| Allowlist enforcement | `clampLanguageToAllowed()` | Unchanged |
| Switch policy | `discrepantLanguageCount` flow in `exotel-voicebot.ts` | Unchanged; no `language_probability` — rely on script detection |
| Domain words | `stt_domain_words` JSONB | Unchanged |

### Hint strategy (mirror Sarvam/ElevenLabs)

| Query # | Multilingual + Cartesia ink-whisper |
|---------|-------------------------------------|
| 1–2 | Open detect — omit `language` param OR pass default only |
| 3+ | Pass `language` from `session.currentLanguageCode` mapped to `hi`/`mr`/`en` |
| Full-auto env | `VOICEBOT_CARTESIA_STT_FULL_AUTO=true` → always omit hint |

### English-only tenants

Still use **`ink-whisper-2025-06-04`** with `language=en` hint (or open detect per policy). Same code path as multilingual — no separate English model.

---

## 9. Configuration Model

### Tenant settings (existing columns — no new columns required for MVP)

| Column | Cartesia usage |
|--------|----------------|
| `stt_provider` | Add value `'cartesia'` |
| `stt_model` | **`ink-whisper-2025-06-04`** (default and only supported Cartesia STT model) |
| `stt_streaming_enabled` | Phase 1: per-utterance WS; Phase 2: persistent WS per call |
| `stt_domain_words` | Unchanged |
| `voicebot_multilingual` | Drives language hint strategy (open detect vs biased hint) |
| `allowed_language_codes` | Maps to `language` query param (`en`, `hi`, `mr`) |
| `default_language_code` | Default ink-whisper `language` hint |

### Proposed model constants (in `cartesia.ts` or new `cartesia-stt.ts`)

```typescript
export const CARTESIA_STT_MODEL = "ink-whisper-2025-06-04" as const;

export const CARTESIA_STT_MODELS = [
  {
    id: CARTESIA_STT_MODEL,
    label: "Ink Whisper (en / hi / mr + 90 languages, manual finalize)",
  },
] as const;
```

### Admin validation rules (settings PATCH)

1. If `stt_provider = 'cartesia'` → `stt_model` must be **`ink-whisper-2025-06-04`** (or empty → default to it). Reject `ink-2` and any other id.
2. If `stt_streaming_enabled = false` → Phase 1 still works (WS per utterance); recommend enabling for Cartesia tenants.
3. `stt_model` remains **admin-only** (same as today).

---

## 10. Database Changes (SQL — run manually)

> **Do not use migration files.** Run these manually against your Postgres instance. Adjust schema/table names if yours differ.

### 10.1 Extend `stt_provider` CHECK constraint

```sql
-- Inspect current constraint name (may vary)
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'customer_settings'::regclass
  AND contype = 'c'
  AND pg_get_constraintdef(oid) LIKE '%stt_provider%';

-- Drop old CHECK and add cartesia (replace constraint name if different)
ALTER TABLE customer_settings
  DROP CONSTRAINT IF EXISTS customer_settings_stt_provider_check;

ALTER TABLE customer_settings
  ADD CONSTRAINT customer_settings_stt_provider_check
  CHECK (stt_provider IN ('sarvam', 'elevenlabs', 'cartesia'));
```

### 10.2 Optional — document valid Cartesia models (application-enforced; no DB enum)

No column change needed. Optionally add a comment for operators:

```sql
COMMENT ON COLUMN customer_settings.stt_model IS
  'STT model id. Sarvam: saaras:v3, saarika:*. ElevenLabs: scribe_v2. Cartesia: ink-whisper-2025-06-04 only (en, hi, mr).';
```

### 10.3 Example — set a tenant to Cartesia STT (English-only)

```sql
UPDATE customer_settings
SET
  stt_provider = 'cartesia',
  stt_model = 'ink-whisper-2025-06-04',
  stt_streaming_enabled = TRUE,
  default_language_code = 'en-IN',
  allowed_language_codes = ARRAY['en-IN']::TEXT[]
WHERE customer_id = 'YOUR-CUSTOMER-UUID-HERE';
```

### 10.4 Example — set a tenant to Cartesia STT (en + hi + mr)

```sql
UPDATE customer_settings
SET
  stt_provider = 'cartesia',
  stt_model = 'ink-whisper-2025-06-04',
  stt_streaming_enabled = TRUE,
  voicebot_multilingual = TRUE,
  allowed_language_codes = ARRAY['en-IN', 'hi-IN', 'mr-IN']::TEXT[]
WHERE customer_id = 'YOUR-CUSTOMER-UUID-HERE';
```

### 10.5 Rollback

```sql
-- Revert tenants on cartesia before dropping CHECK value
UPDATE customer_settings
SET stt_provider = 'sarvam', stt_model = 'saaras:v3'
WHERE stt_provider = 'cartesia';

ALTER TABLE customer_settings
  DROP CONSTRAINT IF EXISTS customer_settings_stt_provider_check;

ALTER TABLE customer_settings
  ADD CONSTRAINT customer_settings_stt_provider_check
  CHECK (stt_provider IN ('sarvam', 'elevenlabs'));
```

### 10.6 Verify

```sql
SELECT customer_id, stt_provider, stt_model, stt_streaming_enabled,
       voicebot_multilingual, allowed_language_codes
FROM customer_settings
WHERE stt_provider = 'cartesia';
```

---

## 11. Code Changes (When Approved)

### New files

| File | Purpose |
|------|---------|
| `apps/api/src/services/cartesia-stt-ws.ts` | Manual WebSocket client (`ink-whisper-2025-06-04`) |
| `docs/vendor-offline/cartesia-stt-manual.md` | Offline mirror of Manual STT docs (optional) |

### Modified files

| File | Change |
|------|--------|
| `apps/api/src/services/cartesia.ts` | STT model constants, `bcp47ToCartesiaSttLanguage()`, `resolveCartesiaSttModel()` |
| `apps/api/src/services/customer-settings.ts` | `SttProvider` add `"cartesia"` |
| `apps/api/src/config/env.ts` | Cartesia STT env flags + timeouts |
| `apps/api/src/routes/exotel-voicebot.ts` | `processUtterance()` Cartesia branch; Phase 2: stream PCM on media |
| `apps/api/src/routes/voice-simulator.ts` | `runSimulatorStt()` Cartesia branch |
| `apps/api/src/routes/ask.ts` | `/ask/voice` Cartesia branch |
| `apps/api/src/routes/settings.ts` | Zod enum + model validation |
| `apps/api/src/services/voicebot-session.ts` | Optional `cartesiaStt` session (Phase 2) |
| `apps/api/src/config/swagger.ts` | Document `cartesia` STT provider |

### Pattern to follow

Copy the **ElevenLabs STT branch** structure in `processUtterance()`:

1. Check `env.cartesia.apiKey`
2. Use model `ink-whisper-2025-06-04` + Manual `/stt/websocket`
3. Call `cartesiaSpeechToTextWebsocket()` (returns `{ status, body }`)
4. Normalize via `cartesiaSttToSarvamShape()`
5. Existing transcript / language / LLM pipeline unchanged

---

## 12. Implementation Phases

| Phase | Scope | Deliverable | Depends on |
|-------|-------|-------------|------------|
| **0** | This document + SQL | Plan approved | — |
| **1a** | `cartesia-stt-ws.ts` Manual path | `ink-whisper-2025-06-04` en/hi/mr on Exotel | SQL 10.1 |
| **1b** | Wire simulators + ask + settings | End-to-end selectable provider | 1a |
| **2** | Persistent WS + stream Exotel PCM | Latency reduction vs per-utterance connect | 1b stable |

**Suggested first production tenant:** Internal test line with `ink-whisper-2025-06-04`, `stt_streaming_enabled = true`, and `allowed_language_codes = ['en-IN','hi-IN','mr-IN']`.

---

## 13. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Wrong `stt_model` configured** | Broken STT if someone sets `ink-2` | PATCH validation: only `ink-whisper-2025-06-04` allowed for Cartesia |
| **No `language_probability` from Cartesia** | Weaker language-switch policy | Keep `inferLanguageFromTranscript()`; document reduced confidence vs Sarvam |
| **Manual finalize vs Auto turn detection** | Slightly higher latency vs ink-2 Auto | Persistent WS (Phase 2); tune `max_silence_duration_secs`; accept trade-off for hi/mr support |
| **Continuous audio requirement** | Missed final words if WS starved during TTS | Phase 2: send silence PCM during bot speech |
| **8 kHz telephony quality** | Same mishears as Sarvam/ElevenLabs | Tune VAD; consider 16 kHz Exotel negotiation; keep `stt_domain_words` |
| **Single vendor for TTS+STT** | Cartesia outage hits both legs | Tenant can mix providers (Cartesia TTS + Sarvam STT) — already supported independently |

---

## 14. Testing Checklist

### Unit / integration

- [ ] `cartesiaSttToSarvamShape()` with empty, partial, and full transcripts
- [ ] `resolveCartesiaSttModel()` always returns `ink-whisper-2025-06-04`
- [ ] `bcp47ToCartesiaSttLanguage('hi-IN')` → `'hi'`
- [ ] WS connects with `pcm_s16le` @ 8000 and @ 16000
- [ ] Manual finalize returns transcript for recorded 8 kHz PCM fixture

### Voicebot (Exotel)

- [ ] English utterance with `ink-whisper-2025-06-04` + `language=en`
- [ ] Hindi utterance with `ink-whisper-2025-06-04` + `language=hi`
- [ ] Marathi utterance with `ink-whisper-2025-06-04` + `language=mr`
- [ ] Code-mixed en/hi — compare vs Sarvam baseline
- [ ] `stt_domain_words` replacement still applied
- [ ] Language switch flow (multilingual tenant)
- [ ] Barge-in during bot speech (existing Exotel VAD path unchanged)
- [ ] Call end — WS closed cleanly with `{ type: "close" }`

### Regression

- [ ] Sarvam and ElevenLabs tenants unchanged
- [ ] Simulators (`runSimulatorStt`) with `stt_provider=cartesia`
- [ ] Missing `CARTESIA_API_KEY` → graceful error TTS message

### Offline replay script (recommended before prod)

1. Capture raw PCM from Exotel logs (existing tooling).
2. Replay through Cartesia Manual endpoint (`ink-whisper-2025-06-04`) with `ffplay -f s16le -ar 8000 -ac 1` validation per [Audio Input docs](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input).
3. Compare WER/latency vs Sarvam WS on same files.

---

## 15. Reference Links

### Cartesia STT (attached by user)

- [Ink 2 (latest model)](https://docs.cartesia.ai/build-with-cartesia/stt/latest)
- [Turn Detection](https://docs.cartesia.ai/use-the-api/stt/turns)
- [Compare Endpoints](https://docs.cartesia.ai/use-the-api/stt/compare-endpoints)
- [Audio Input](https://docs.cartesia.ai/build-with-cartesia/stt/audio-input)
- [Troubleshooting](https://docs.cartesia.ai/use-the-api/stt/troubleshooting/index)
- [Older Models (ink-whisper languages)](https://docs.cartesia.ai/build-with-cartesia/stt/older-models)
- [Realtime STT (Auto) API](https://docs.cartesia.ai/api-reference/stt/turns/websocket)
- [Realtime STT (Manual) API](https://docs.cartesia.ai/api-reference/stt/websocket)
- [Auto WS example](https://docs.cartesia.ai/examples/stt-auto-finalize-websocket)
- [Manual WS example](https://docs.cartesia.ai/examples/stt-manual-finalize-websocket)

### Convixx internal

- `docs/CARTESIA_TTS_VOICEBOT_INTEGRATION_PLAN.md` — TTS integration (mirror patterns)
- `docs/VOICEBOT_STT_QUALITY_AND_TUNING.md` — STT quality policy
- `docs/EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md` — language switch behaviour
- `docs/OPUS_SUGGESTED_STEPS.md` — streaming STT latency ideas
- `apps/api/src/routes/exotel-voicebot.ts` — `processUtterance()`
- `apps/api/src/services/cartesia-tts-ws.ts` — WS client pattern to copy

---

## Decision Log (for approval)

| # | Decision | Recommendation |
|---|----------|----------------|
| 1 | Cartesia STT model | **`ink-whisper-2025-06-04` only** (en / hi / mr) — **not `ink-2`** |
| 2 | Endpoint | **Manual** `/stt/websocket` + VAD + `finalize` |
| 3 | Skip WAV for Cartesia | **Yes** — raw `pcm_s16le` |
| 4 | Ink 2 / Auto turn detection | **Out of scope** — English-only model |
| 5 | New DB columns | **None for MVP** — reuse `stt_provider`, `stt_model`, `stt_streaming_enabled` |
| 6 | Separate API key | **No** — reuse `CARTESIA_API_KEY` |

**Awaiting approval before any implementation.**
