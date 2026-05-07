# New Outbound Call Process Implementation Plan

This document outlines the plan to implement a new outbound call campaign process using the Exotel Stream and Voicebot Applet. This implementation replaces the current outbound call logic and focuses on a campaign-based approach with pre-rendered script audio.

## 1. Database Schema Changes

We will introduce two new tables to manage campaigns and their leads. We will use plain SQL queries for these changes.

### SQL Queries

```sql
-- 1. Outbound Campaigns Table
-- Stores the campaign configuration and the path to the pre-rendered script audio.
CREATE TABLE IF NOT EXISTS outbound_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  script_text TEXT NOT NULL,
  language_code TEXT NOT NULL DEFAULT 'en-IN',
  audio_file_path TEXT, -- Internal path to the generated audio file
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'running', 'completed', 'deleted')),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 2. Outbound Campaign Leads Table
-- Stores the phone numbers to be called for each campaign.
CREATE TABLE IF NOT EXISTS outbound_campaign_leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES outbound_campaigns(id) ON DELETE CASCADE,
  phone_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'calling', 'completed', 'failed')),
  call_sid TEXT, -- Exotel Call SID
  session_id UUID REFERENCES exotel_call_sessions(id) ON DELETE SET NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_outbound_campaigns_customer ON outbound_campaigns(customer_id);
CREATE INDEX IF NOT EXISTS idx_outbound_leads_campaign ON outbound_campaign_leads(campaign_id, status);
```

---

## 2. Process Flow

> [!IMPORTANT]
> The current inbound call flow will remain unchanged. The new "wait for speech" and campaign script logic will ONLY be triggered when a call is identified as part of an outbound campaign (via the `campaign_id` parameter).

### Phase A: Campaign Setup
1.  **API Endpoint**: `POST /api/outbound/campaign`
2.  **Action**:
    *   Receive `script_text`, `language_code`, and `name`.
    *   Convert `script_text` to audio using the existing TTS service (Sarvam/ElevenLabs).
    *   Save the audio file to a temporary storage (e.g., `uploads/campaigns/{campaign_id}.wav`).
    *   Insert a record into `outbound_campaigns` with the file path.
    *   Mark status as `ready`.

### Phase B: Triggering Calls
1.  **API Endpoint**: `POST /api/outbound/campaign/{id}/trigger`
2.  **Action**:
    *   Fetch `pending` leads for the campaign.
    *   Iterate through leads and initiate calls via Exotel's Call API.
    *   **Exotel Applet Configuration**: The call will be directed to an Exotel flow using the **Voicebot Applet**.
    *   **Custom Parameters**: Pass `campaign_id` and `lead_id` in the `custom_parameters` of the Voicebot Applet.

### Phase C: Voicebot WebSocket Logic (The "Wait for Speech" Flow)
The WebSocket handler in `apps/api/src/routes/exotel-voicebot.ts` will be updated:

1.  **Detecting Call Direction**:
    *   In the `start` event, inspect `custom_parameters`.
    *   **Outbound Campaign**: If `campaign_id` is present in `custom_parameters`.
    *   **General Outbound**: If `direction=outbound` is present or if the `call_sid` already exists in `exotel_call_sessions` with `direction='outbound'`.
    *   **Inbound**: If none of the above are true, and the `to` number matches the tenant's configured inbound number.

2.  **`start` Event Processing**:
    *   Extract `campaign_id` from `custom_parameters`.
    *   If `campaign_id` is present, set a flag: `session.mode = 'outbound_campaign'` and `session.waitingForFirstSpeech = true`.
    *   **SKIP** sending the default greeting. The bot remains silent initially.

2.  **`media` Event (Inbound Audio)**:
    *   If `session.waitingForFirstSpeech` is `true`:
        *   Monitor audio energy. If `energy > threshold` (customer started speaking):
            *   Set `session.waitingForFirstSpeech = false`.
            *   Load the pre-rendered audio file for the campaign.
            *   Stream the campaign script audio to the customer.
            *   Once streaming is finished, the session transitions to the **"Regular Flow"**.

3.  **"Regular Flow"**:
    *   The bot waits for the next customer query.
    *   Processes it via the standard RAG pipeline (STT -> KB Search -> LLM -> TTS).

### Phase D: Cleanup
1.  Once all leads in a campaign are processed (status `completed` or `failed`), the campaign status is updated to `completed`.
2.  A cleanup job deletes the script audio file from the filesystem.

---

## 3. Key Requirements Implementation

### Single API for Triggering
A single endpoint `POST /api/outbound/campaign/{id}/trigger` will handle the orchestration. It will ensure that calls are only counted as "started" once the customer picks up (handled by Exotel's Applet logic).

### Customer Speaks First
This is handled in the WebSocket logic by deferring the script audio until the first energy-positive media chunk is received from the customer.

### Audio Conversion
We will use the existing `sarvamTextToSpeech` or `elevenLabsTextToSpeech` services to generate the script audio during campaign creation.

---

## 4. Summary of Database Changes
No migrations will be used. The SQL provided above should be executed directly against the PostgreSQL database.
