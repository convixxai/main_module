# Vodafone Campaign API (VI OBD)

Vodafone outbound campaigns run on Vodafone's own OBD Campaign API, never the Exotel per-lead method:

1. The engine creates the campaign on VI.
2. It uploads the numbers.
3. It starts the campaign.
4. VI dials the numbers inside the date/time window.

Every answered call reaches the bot on the tenant's Vodafone WebSocket (`/telephony/vodafone/voicebot/{customerId}`) with `call_type=outbound` and `campaign_id`. The bot opens with the campaign script, spoken live in the agent's voice.

The engine never falls back to Exotel and never renders an audio file.

- **Base URL:** `https://convixx.in`
- **Auth:** header `x-api-key: <company production key>`
- **Swagger:** https://convixx.in/docs, tag **"Vodafone Campaigns (VI OBD)"**
- **Code:** `apps/api/src/routes/vodafone-campaigns.ts`

## One-time setup per customer

`PUT /customers/{customerId}/vodafone-settings` (header `x-admin-token`) with:

- `credentials`: `{ "username": "...", "password": "...", "dni": "91XXXXXXXXXX" }`. `dni` is optional.
- `vi_flow_id`: the Flow built in VI's portal, with a Streaming node pointed at the tenant's Vodafone WebSocket. The Flow's base variables must include `call_type` and `campaign_id`.

The provider must be `vodafone` and enabled.

## How numbers are sent to VI

- **10 digits for both `dni` and `msisdn`.** That is VI's own format (`"9112002517"`). With a `91` prefix, VI silently drops the record and the portal shows "Campaign Active: Base not loaded".
- **The DNI must be an active DNI on the Flow** (VI `getActiveDNIList`). The engine picks the DNI in this order:
  1. The campaign's `phone_number_id`, if VI lists it. If VI doesn't list it, the request fails with `400`, which names the active DNIs.
  2. Otherwise, the tenant `dni` or primary number, if VI lists it.
  3. Otherwise, the Flow's first active DNI.
- **Only the Flow's base variables are sent.** VI reports them through `getsampleBaseHeads`, for example only `msisdn`. When the Flow forwards no `campaign_id`, the bot recognises a campaign call by matching the dialled number to a pending number of a live campaign. It then speaks that campaign's script with the campaign's agent.
- **Check VI's count.** The create response's `dni` field shows the DNI used, and `vi_status.baseDetails.totalBaseReceived` shows what VI actually loaded.
- **Retries never dial anyone twice.** `/leads` skips numbers already in the campaign (`already_in_campaign`). The exception is when VI reports an empty base: then everything is uploaded again.
- **Status uses VI's numeric campaign ID.** The engine reads VI status with `campaign_Ref_ID` (the "ID" shown in VI's portal). VI rejects the `campainKey` for status.
- **A refused start can still count as started.** VI may refuse a start for a With-Flow campaign it already runs on its window. The engine then reads VI's status: any live state counts as started (`already_active: true`).

## Endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/vodafone/campaigns` | Create, upload the numbers and start, in one call |
| GET | `/vodafone/campaigns` | List Vodafone campaigns |
| GET | `/vodafone/active-dnis` | Calling numbers Vodafone accepts on the Flow, with matching `phone_number_id` |
| GET | `/vodafone/campaigns/{id}` | Status: local lead counts and VI's live counts |
| POST | `/vodafone/campaigns/{id}/leads` | Add numbers: `{ "phone_numbers": [...] }` |
| POST | `/vodafone/campaigns/{id}/start` | Start, or resume after a pause |
| POST | `/vodafone/campaigns/{id}/pause` | Pause (the status goes back to `ready`, and the response has `paused: true`) |
| DELETE | `/vodafone/campaigns/{id}` | Pause on VI, then soft-delete |

## Trigger a campaign

```http
POST https://convixx.in/vodafone/campaigns
x-api-key: <company production key>
Content-Type: application/json

{
  "name": "AMC renewal - Nov",
  "script_text": "नमस्कार, मी Aqua Home कडून बोलत आहे...",
  "language_code": "mr-IN",
  "agent_id": "<engine agent uuid>",
  "phone_number_id": "<company phone number uuid>",
  "phone_numbers": ["+919876500001", "9876500002"],
  "fromdate": "2026-11-07",
  "todate": "2026-11-09",
  "fromtime": "10:00:00",
  "totime": "19:00:00",
  "dial_timeout_seconds": 20,
  "retry_interval_type": "0",
  "retry_interval_value": 30,
  "retry_count": 1,
  "start": true
}
```

| Field | Required | Default / notes |
|---|---|---|
| `name` | yes | Max 200 chars |
| `script_text` | yes | First line the bot speaks. Max 4000 chars |
| `language_code` | no | `en-IN`. Applies to the whole call |
| `phone_numbers` | no | Up to 50,000 per request, in any format. Duplicates are removed by their last 10 digits; invalid numbers are skipped |
| `phone_number_id` | no | The outbound DNI. Default: the tenant `dni`, else the primary number |
| `agent_id` | no | Default: the DNI number's default agent, else the oldest active agent |
| `fromdate` / `todate` | no | Today (IST) / `fromdate` |
| `fromtime` / `totime` | no | `09:00:00` / `21:00:00` IST |
| `dial_timeout_seconds` | no | 15 (5-120) |
| `retry_interval_type` | no | `"0"` minutes, `"1"` days (default `"0"`) |
| `retry_interval_value` | no | 60 |
| `retry_count` | no | 0 (0-10) |
| `start` | no | `true`. Set `false` to create and upload only |

### Response `201`

```json
{
  "message": "Vodafone campaign started; VI dials the numbers inside the window",
  "started": true,
  "window": { "fromdate": "2026-11-07", "todate": "2026-11-09", "fromtime": "10:00:00", "totime": "19:00:00" },
  "leads": { "received": 2, "valid": 2, "invalid": 0, "duplicates": 0, "pushed": 2 },
  "campaign": { "id": "<uuid>", "status": "running", "provider": "vodafone", "vi_campaign_id": "...", "...": "..." }
}
```

Save `campaign.id` and use it for status, leads, start, pause and delete.

### Errors

- `400`:
  - not on Vodafone
  - credentials or `vi_flow_id` missing
  - bad window
  - no valid numbers
  - `agent_id` or `phone_number_id` doesn't belong to this customer
- `401`: missing or invalid `x-api-key`.
- `404`: no Vodafone campaign with that id.
- `502`: VI rejected the request.
  - If the campaign already exists on VI, the body still carries `campaign` and `leads`.
  - Retry the remaining numbers with `/leads`, then call `/start`.
  - A number is saved locally only after VI accepts it.

## Status response (`GET /vodafone/campaigns/{id}`)

```json
{
  "campaign": { "id": "<uuid>", "status": "running", "...": "..." },
  "leads": { "total": 2, "pending": 1, "calling": 0, "completed": 1, "failed": 0 },
  "vi_status": {
    "currentStatus": "Running",
    "baseDetails": {
      "totalBaseReceived": 2, "totalCallInitiated": 1, "totalCallsConnected": 1,
      "totalCallsNotConnected": 0, "remainingNumbersInQueue": 1, "successRatePercentage": 100
    }
  },
  "vi_status_error": null
}
```

The older shared `/outbound/campaigns*` endpoints still work for Vodafone, for existing clients. New integrations should use the API above.
