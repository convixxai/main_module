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
- **Campaign names are unique on VI.** VI refuses a reused name with `400 "Campaign already exists!"`. The engine retries with a date/time suffix, then a short random tag, so a reused SaaS name still launches.
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
| `name` | yes | Max 200 chars. VI allows only unique names of up to 50 characters, so the name sent to VI is cut to 50, and a name already used on the account gets a date/time suffix (`New Test 07 Nov 12:22`). The response field `vi_campaign_name` is the name VI shows. Convixx keeps the full name |
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

## Reports (read-only)

These endpoints are Vodafone only, read only, and never dial. Swagger tag: **"Vodafone Reports (VI)"**. Code: `apps/api/src/routes/vodafone-reports.ts`.

| Method | Endpoint | Source on VI | Purpose |
|---|---|---|---|
| GET | `/vodafone/campaigns/{id}/status` | `campaignstatus` | Live counts, flattened. Cheap to poll every 1-2 min |
| GET | `/vodafone/campaigns/{id}/report?from=&to=` | Pull Report, calltype 2 | Every call VI placed for the campaign |
| GET | `/vodafone/campaigns/{id}/summary` | Pull Report, calltype 4 | VI's totals for the whole campaign |
| GET | `/vodafone/reports/calls?type=&from=&to=` | Pull Report, calltype 1, 2 or 3 | Call history: `inbound`, `outbound` (needs `campaign_id`) or `click_to_call` |

Parameters:

- **Dates:** `from` and `to` are `YYYY-MM-DD` in IST.
  - `to` defaults to today.
  - For a campaign report, `from` defaults to the campaign's creation date. For call history it defaults to `to`.
  - The range can be at most 31 days.
- **`dni`** is optional and takes any format. It defaults to the campaign's calling number, else the tenant DNI or first active DNI.
- **`campaign_id`** (call history) takes the engine campaign uuid or VI's numeric campaign ID. Only this customer's own campaigns are accepted.
- **`call_id`** (call history) takes a VI call id and returns a single call. VI call ids also appear in the engine logs.
- **`raw=1`** also returns VI's reply exactly as received.

### Status response (`GET /vodafone/campaigns/{id}/status`)

```json
{
  "campaign": { "id": "<uuid>", "name": "New Test (copy) 2", "vi_campaign_ref_id": 771719, "...": "..." },
  "status": {
    "engine_status": "running", "vi_status": "Active",
    "window": "10:00:00 - 19:00:00", "end_date": "07-11-2026",
    "numbers_on_vi": 1, "calls_placed": 1, "connected": 1, "not_connected": 0,
    "remaining": 0, "success_rate_percent": 100,
    "retry": { "interval": "Minutes", "within": 60, "attempts": 1 }
  },
  "leads": { "total": 1, "pending": 0, "calling": 0, "completed": 1, "failed": 0 },
  "vi_status_raw": { "...": "VI campaignstatus as received" },
  "vi_status_error": null
}
```

If VI is unreachable, the endpoint still answers `200`: the VI fields are `null` and `vi_status_error` says why.

### Report response (`/report`, `/reports/calls`)

```json
{
  "period": { "from": "2026-11-06", "to": "2026-11-06" },
  "dni": "9112002517",
  "count": 2,
  "calls": [ { "...": "one row per call, VI's own fields" } ]
}
```

`/report` also returns `campaign` and `leads`. `/reports/calls` also returns `type` and `campaign` (or `null`). `/summary` returns `summary` in place of `calls`.

**Row fields:** VI's documentation shows the reply only as `{"report": "report JSON will be out"}` and does not name the row fields. The engine passes each row through unchanged. It accepts a list, an object, or a JSON string, and returns it as `calls`. Map the columns in the SaaS from a real reply, using `raw=1` once to see them.

**How it works on VI:** the Pull Report API has its own login (`pullcalldetails/authenticatepullreport`, with username, password and dni). It uses the same Vodafone credentials, and the token is cached for 24 hours per DNI. Report dates go to VI as `DD/MM/YYYY`.

Errors:

- `400`: Vodafone not enabled, bad dates or range, `type=outbound` without `campaign_id`, or the campaign isn't on VI yet.
- `401`: missing or invalid key.
- `404`: not this customer's campaign.
- `502`: VI refused the request. VI's reply is in `details`.

The older shared `/outbound/campaigns*` endpoints still work for Vodafone, for existing clients. New integrations should use the API above.
