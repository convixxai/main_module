# Voicebot — Filler Acknowledgment Logic

**Date:** 2026-05-02  
**Status:** Implemented (Migration 008)

---

## Overview

Filler-only utterances are short, non-substantive sounds a caller makes while
thinking — "hmm", "um", "uh", "ah", "er", "oh", etc. When the voicebot detects
a filler-only STT transcript, instead of sending it through the full
RAG → Embedding → LLM → TTS pipeline (which would generate an irrelevant
sales-pitch answer), the bot either **waits silently** or **acknowledges** with
a short phrase like "Go ahead, I'm listening."

## How It Works

### 1. Per-Customer Toggle

Filler acknowledgment is controlled **per customer** via `customer_settings`:

| Column                 | Type    | Default | Description                                      |
|------------------------|---------|---------|--------------------------------------------------|
| `filler_ack_enabled`   | BOOLEAN | FALSE   | Master switch for filler ack on this tenant.     |
| `filler_ack_threshold` | INT     | 2       | Consecutive fillers before the bot responds.     |

The global env flag `VOICEBOT_FILLER_ACK_ENABLED` acts as a **kill-switch** — 
when set to `false`, fillers are never handled regardless of the DB setting.

### 2. Consecutive Filler Counting (N-th Filler Logic)

The bot does **not** respond to the first filler word. Instead, it counts
consecutive filler-only utterances and only responds when the count reaches
the `filler_ack_threshold` (default: 2).

**Example flow with `filler_ack_threshold = 2`:**

```
AI Bot : "Hello, how can I help you today?"
Customer: "ummmm"           → filler #1 — bot stays SILENT, waits
Customer: "ahhhh"           → filler #2 — threshold reached! Bot responds:
AI Bot : "Go ahead, I'm listening."   (counter resets to 0)
Customer: "ummmm"           → filler #1 — bot stays SILENT again
Customer: "I want to book"  → real speech — counter resets to 0, normal RAG flow
```

**Example flow with `filler_ack_threshold = 3`:**

```
AI Bot : "Hello, how can I help you today?"
Customer: "umm"             → filler #1 — bot SILENT
Customer: "hmm"             → filler #2 — bot SILENT
Customer: "uh"              → filler #3 — threshold reached! Bot responds:
AI Bot : "Yes, please continue."   (counter resets to 0)
```

### 3. Counter Reset Rules

The `fillerConsecutiveCount` on the session resets to 0 in two cases:

1. **After the bot acknowledges** — threshold reached, ack played, reset.
2. **When real speech arrives** — any non-filler transcript resets the counter.

### 4. Filler Detection

A transcript is considered "filler-only" when it matches only these words
(with optional punctuation): `hmm`, `hmmm`, `hm`, `mmm`, `mm`, `mhm`, `um`,
`umm`, `uhm`, `uh`, `ah`, `oh`, `er`, `huh`.

See `isFillerOnlyTranscript()` in `apps/api/src/services/voice-filler-acks.ts`.

### 5. Filler Acknowledgment Phrases

Ack phrases are per-language (BCP-47) and defined in
`apps/api/src/services/voice-filler-acks.ts`. A random phrase is picked from
the pool for the call's active language. An optional env-var
`VOICEBOT_FILLER_ACK_TEXT` can add an extra English phrase to the pool.

---

## Database Migration

**File:** `infra/postgres/migrations/008_filler_ack_customer_setting.sql`

```sql
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS filler_ack_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS filler_ack_threshold  INT     NOT NULL DEFAULT 2
    CHECK (filler_ack_threshold >= 1 AND filler_ack_threshold <= 10);
```

### Enable for a specific customer

```sql
UPDATE customer_settings
SET filler_ack_enabled   = TRUE,
    filler_ack_threshold = 2
WHERE customer_id = '<CUSTOMER_UUID>';
```

### Enable for all voicebot customers

```sql
UPDATE customer_settings
SET filler_ack_enabled = TRUE
WHERE voicebot_enabled = TRUE;
```

---

## Configuration Reference

| Layer            | Setting                          | Controls                                     |
|------------------|----------------------------------|----------------------------------------------|
| `.env` (global)  | `VOICEBOT_FILLER_ACK_ENABLED`    | Global kill-switch. `false` = feature off for ALL tenants. Default: `true`. |
| `.env` (global)  | `VOICEBOT_FILLER_ACK_TEXT`       | Extra English ack phrase merged into en-IN pool. |
| DB (per-tenant)  | `filler_ack_enabled`             | Per-customer toggle. Default: `FALSE`.        |
| DB (per-tenant)  | `filler_ack_threshold`           | Consecutive filler count before ack. Default: `2`. Range: 1–10. |

**Resolution order:** env kill-switch → `customer_settings.filler_ack_enabled` → feature active.

---

## Log Events

| Event                             | When                                 |
|-----------------------------------|--------------------------------------|
| `pipeline.stt.filler_detected`    | Every filler utterance (includes consecutive count and threshold). |
| `stt.filler_wait`                 | Filler detected but below threshold — bot stays silent.            |
| `pipeline.stt.filler_only`        | Threshold reached — bot is about to speak the ack.                 |
| `stt.filler_skip_rag`             | RAG/LLM skipped for filler ack.                                   |

---

## Files Changed

| File | Change |
|------|--------|
| `infra/postgres/migrations/008_filler_ack_customer_setting.sql` | New migration: adds `filler_ack_enabled`, `filler_ack_threshold` columns. |
| `apps/api/src/services/customer-settings.ts` | Added fields to `CustomerSettings` interface, `ALL_SETTINGS_FIELDS`, `ADMIN_ONLY_FIELDS`. |
| `apps/api/src/services/voicebot-session.ts`  | Added `fillerConsecutiveCount` to `VoicebotSession`. |
| `apps/api/src/routes/exotel-voicebot.ts`     | Replaced global env check with per-customer + consecutive-count logic. |
| `docs/VOICEBOT_FILLER_ACK_LOGIC.md`          | This document. |
