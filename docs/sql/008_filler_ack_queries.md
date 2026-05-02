# Filler Ack — SQL Queries

**Date:** 2026-05-02  
**Migration:** `008_filler_ack_customer_setting.sql`

---

## 1. Migration — Add Columns

Run this in pgAdmin against your Convixx database **after** migration 005 has been applied:

```sql
-- Add filler ack columns to customer_settings
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS filler_ack_enabled    BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS filler_ack_threshold  INT     NOT NULL DEFAULT 2
    CHECK (filler_ack_threshold >= 1 AND filler_ack_threshold <= 10);

-- Column comments
COMMENT ON COLUMN customer_settings.filler_ack_enabled IS
  'When TRUE, filler-only utterances (hmm, um, uh, …) are acknowledged with a short phrase instead of going through RAG/LLM. Disabled by default.';

COMMENT ON COLUMN customer_settings.filler_ack_threshold IS
  'Number of consecutive filler-only utterances before the bot responds with an acknowledgment. Default 2 means the bot waits on the first filler and responds on the second consecutive filler. Resets after each ack or after any real speech.';
```

---

## 2. Enable Filler Ack for a Specific Customer

```sql
-- Enable with default threshold (2 consecutive fillers)
UPDATE customer_settings
SET filler_ack_enabled   = TRUE,
    filler_ack_threshold = 2
WHERE customer_id = '<CUSTOMER_UUID>';
```

---

## 3. Enable Filler Ack for ALL Voicebot Customers

```sql
UPDATE customer_settings
SET filler_ack_enabled = TRUE
WHERE voicebot_enabled = TRUE;
```

---

## 4. Change Threshold (e.g., respond after 3rd filler)

```sql
UPDATE customer_settings
SET filler_ack_threshold = 3
WHERE customer_id = '<CUSTOMER_UUID>';
```

---

## 5. Disable Filler Ack for a Customer

```sql
UPDATE customer_settings
SET filler_ack_enabled = FALSE
WHERE customer_id = '<CUSTOMER_UUID>';
```

---

## 6. Check Current Filler Settings for All Customers

```sql
SELECT
  cs.customer_id,
  c.name AS customer_name,
  cs.filler_ack_enabled,
  cs.filler_ack_threshold,
  cs.voicebot_enabled
FROM customer_settings cs
JOIN customers c ON c.id = cs.customer_id
ORDER BY cs.filler_ack_enabled DESC, c.name;
```
