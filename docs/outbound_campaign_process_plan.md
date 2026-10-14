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

---

## 5. Vodafone (VI) Variant (added 2026-10-14)

Everything above is Exotel-specific. For a customer whose `company_telephony_settings` resolves to `provider_id='vodafone'`, the same `/outbound/campaigns*` endpoints branch internally to drive VI's **OBD Campaign API — With Flow** instead (vendor doc: "CPaaS-API Documentation (1.0.211)", OBD CAMPAIGN section). See `apps/api/src/services/vodafone-obd.ts` for the full design rationale; summary:

- **Why "With Flow"**: it references a `flowid` built once in VI's portal, which is expected to already contain a Streaming node bound to this tenant's existing `/telephony/vodafone/voicebot/:customerId` WS endpoint — the same mechanism inbound Vodafone calls already use. This avoids needing VI's still-undocumented outbound-call-origination REST contract and general call-status callback shape (see `services/vodafone-adapter.ts`'s `triggerOutboundCall` stub). "Without Flow" OBD campaigns (the classic prerecorded-prompt + DTMF broadcast model, driven by a `pingback_URL`) were deliberately **not** implemented — we don't have the pingback payload shape, and guessing it would repeat the exact mistake `vodafone-adapter.ts` already refuses to make elsewhere.
- **One-time manual prerequisite**: someone with VI portal access must build (or reuse) a Flow with a Streaming node pointed at the tenant's Vodafone WS endpoint, whose base schema includes at least `call_type` and `campaign_id` variables bound into that node's `custom_parameters` (VI allows at most 3). This is **not** something this codebase can configure — it's done in VI's portal UI. The resulting `flowid` is then set **once per tenant** via `PUT /customers/:customerId/vodafone-settings` (`vi_flow_id`, merged into `metadata.vi_flow_id`) — **not** passed when creating a campaign, since the Flow is tied to the tenant's WS/Streaming Object wiring, not to any individual campaign.
- **Identifying an outbound call in `vodafone-voicebot.ts`**: VI's Flow forwards the base record's extra variables as `start.custom_parameters` on the WS `start` event (already modeled in `types/vodafone-ws.ts`). `routes/vodafone-voicebot.ts` checks `customParameters.call_type === "outbound"` + `customParameters.campaign_id`, sets `session.mode = "outbound"`, and speaks the campaign's `script_text` instead of the tenant's default greeting — no dual-leg/wait-for-speech state machine (that was removed from the Exotel side 2026-09 as purposeless without a second leg to coordinate with). The rest of the call proceeds exactly like any inbound call.
- **Endpoint behavior differences** (same `/outbound/campaigns*` paths, by design):
  - `POST /outbound/campaigns`: also calls VI's `createCampaign` (requires `fromdate`/`todate`/`fromtime`/`totime` in the request, plus `vi_flow_id` already configured on the tenant's Vodafone settings) and caches the Flow's expected base variable names via `getsampleBaseHeads`.
  - `POST /outbound/campaigns/:id/leads`: also pushes the base to VI via `staticCampaignDataIngestion`, keyed by the cached variable names.
  - `POST /outbound/campaigns/:id/trigger`: calls VI's `StartorStop(S)` once — VI dials the whole base itself, there's no per-lead REST loop like Exotel's `Calls/connect`.
  - `POST /outbound/campaigns/:id/pause` (new, Vodafone-only) and `GET /outbound/campaigns/:id/status` (new, Vodafone-only): wrap VI's `StartorStop(P)` and `campaignstatus`.
- **Credentials**: VI's OBD username/password + the server CLI (`dni`) used to dial out are stored via the existing generic `credentials` blob on `PUT /customers/:customerId/vodafone-settings` — see `VodafoneObdCredentials` in `services/telephony-settings.ts`.
- **Schema**: migration `018_vodafone_obd_campaign.sql` adds `telephony_provider_id`, `vi_flow_id`, `vi_campaign_id`, `vi_campaign_ref_id`, `vi_base_variable_names` to `outbound_campaigns`, and `vi_call_id` to `outbound_campaign_leads`. Unlike `012`'s precedent, this one **is** a real migration file — run it via `apps/api/scripts/run-sql-file.ts infra/postgres/migrations/018_vodafone_obd_campaign.sql`.
