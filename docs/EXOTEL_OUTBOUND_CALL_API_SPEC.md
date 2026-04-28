# Exotel outbound call — Make a Call API (design spec)

This document specifies how Convixx exposes **one HTTP API** that triggers an **outbound PSTN call** via Exotel’s **Connect Two Numbers** endpoint.

**Official reference:** [Connect Two Numbers \| Make a Call API](https://developer.exotel.com/api/make-a-call-api)

---

## 1. What Exotel does

Exotel connects **two** phone numbers in sequence:

1. **`From`** — dialed **first**. When that party answers, Exotel proceeds.
2. **`To`** — dialed **second** and bridged with the first leg.

So “who gets called first” is controlled by **`From`**, not **`To`**. Typical outbound flows:

- **Agent/agent identity first:** set **`From`** to your agent’s desk/mobile (or another PSTN identity Exotel should ring first), and **`To`** to the customer.
- **Customer-centric wording in product:** keep UX labels clear that **`From`** / **`To`** map to Exotel’s semantics above.

All requests must include **`CallerId`** — your **ExoPhone / virtual number** presented as CLI where applicable.

---

## 2. HTTP contract (Exotel)

| Item | Value |
|------|--------|
| Method | `POST` |
| Path | `/v1/Accounts/{AccountSid}/Calls/connect` |
| Content | `application/x-www-form-urlencoded` (typical for Exotel REST examples) |

### 2.1 Regional base URLs

Exotel documents different hosts by region (see their table on the doc page):

| Region | Host (pattern) |
|--------|-------------------|
| Singapore | `https://api.exotel.com` |
| Mumbai | `https://api.in.exotel.com` |

**Convixx:** derive the correct base URL from tenant configuration (see Section 5). The repo already stores `exotel_subdomain` and related fields in `customer_exotel_settings`; implementation must pick the same **account region** Exotel expects for that tenant (Singapore vs India cluster).

### 2.2 Authentication

Per Exotel’s examples, credentials are passed in the URL:

`https://<api_key>:<api_token>@<host>/v1/Accounts/<AccountSid>/Calls/connect`

**Security note for implementation:** prefer building the request in code with explicit Basic auth or HTTPS URL construction **without logging** secrets; avoid copying secrets into logs or error payloads.

---

## 3. Request parameters (Exotel)

Summary from Exotel — required vs optional:

| Parameter | Required | Notes |
|-----------|----------|--------|
| `From` | Yes | E.164 preferred. Dialed **first**. |
| `To` | Yes | E.164 preferred. Customer / second party. |
| `CallerId` | Yes | Your ExoPhone / virtual number. |
| `CallType` | No | e.g. `trans` for transactional calls (subject to Exotel/account rules). |
| `TimeLimit` | No | Max duration (seconds); max documented `14400`. |
| `TimeOut` | No | Ring timeout (seconds). |
| `WaitUrl` | No | WAV while waiting; size recommendations in Exotel docs. |
| `Record` | No | `true` to record. |
| `RecordingChannels` | No | `single` (default) or `dual`. |
| `RecordingFormat` | No | `mp3` (default) or `mp3-hq`. |
| `StreamUrl` | No | WebSocket URL for real-time streaming. |
| `StreamBegin` | No | `at Leg1Connect` or `at Leg2Connect`. |
| `CustomField` | No | Metadata (max 128 chars); forwarded to callbacks/applets. |
| `StartPlaybackToNew` | No | `Callee` (default) or `Both`. |
| `StartPlaybackValueNew` | No | Audio URL for pre-call playback. |
| `StatusCallback` | No | Webhook for status updates. |
| `StatusCallbackEvents` | No | e.g. `terminal`, `answered`, or both per Exotel. |
| `StatusCallbackContentType` | No | `multipart/form-data` or `application/json`. |

**Rate limiting:** Exotel documents **429** when exceeded (example message mentions **200 requests per minute** — treat as documentation; verify current limits for your account).

---

## 4. Response and status (Exotel)

### 4.1 Success body (shape)

Response includes a **`Call`** object with fields such as:

- **`Sid`** — unique call identifier (use for correlation, call details APIs, webhooks).
- **`Status`** — e.g. `queued`, `in-progress`, `completed`, `failed`, `busy`, `no-answer`.
- **`From`**, **`To`**, **`Direction`** (e.g. `outbound-api`), **`DateCreated`**, **`Uri`**, etc.

**Note:** `Duration`, `Price`, and `EndTime` may update **asynchronously** after the call ends; use **StatusCallback** or Call Details APIs for final values.

### 4.2 Errors

Structured error body with **`RestException`**, e.g.:

- **400** — missing/invalid parameters.
- **401** — authentication failure.
- **429** — rate limit.

See Exotel’s [Error Code Dictionary](https://developer.exotel.com/docs/references/error-codes) for the full list.

---

## 5. Convixx tenant model (existing)

Outbound calls must respect **multi-tenant** settings already modeled in `customer_exotel_settings` (see `apps/api/src/services/exotel-settings.ts`):

| Field (conceptual) | Use for outbound |
|--------------------|------------------|
| `exotel_account_sid` | `{AccountSid}` in path |
| `exotel_api_key` / `exotel_api_token` | Authenticate Exotel REST request |
| `inbound_phone_number` | Often aligns with purchased ExoPhone; may map to **`CallerId`** when appropriate |
| `default_outbound_caller_id` | **Default `CallerId`** when the API consumer does not override |
| `is_enabled` | Reject outbound if disabled |
| Region / cluster | Determines **`api.exotel.com`** vs **`api.in.exotel.com`** (and any subdomain nuances per Exotel account setup) |

**Sandbox:** respect `use_sandbox` if Exotel provides distinct endpoints or numbers for sandbox (confirm against current Exotel docs for the tenant’s account type).

---

## 6. Proposed Convixx API (single trigger endpoint)

**Goal:** One authenticated Convixx endpoint that accepts **`customer_id`** (tenant) plus **`From`**, **`To`**, optional overrides and passthrough flags, then calls Exotel **`Calls/connect`** with that tenant’s credentials.

### 6.1 Suggested route shape

Align with tenant-scoped routes (`x-api-key`), path includes `customerId` for clarity:

- **`POST`** `/customers/:customerId/exotel/outbound-call`  
  **or** nested under voice if product prefers (`/voice/...`): choose **one** consistent prefix when implementing.

**Authorization:** tenant **`x-api-key`** — the key’s customer must match **`customerId`** in the path (same pattern as KB/agents/voice). Do not expose this route without authentication.

### 6.2 Suggested JSON body (MVP)

Minimum viable request body:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `from` | string | yes | Maps to Exotel **`From`** (E.164 preferred). |
| `to` | string | yes | Maps to Exotel **`To`** (E.164 preferred). |
| `callerId` | string | no | Maps to **`CallerId`**. If omitted, use `default_outbound_caller_id` from settings; if still missing, return **400** with a clear message. |

Optional fields (pass through only when present; validate length/types per Exotel):

- `callType`, `timeLimit`, `timeOut`, `record`, `recordingChannels`, `recordingFormat`
- `statusCallback` (full URL or a server-side-built URL from env base + route — decide in implementation)
- `customField` (ensure ≤ 128 chars if Exotel limit still applies)
- Future: `streamUrl`, `streamBegin`, `waitUrl`, playback fields — only if product needs them for AgentStream/voicebot bridging.

### 6.3 Suggested response

- **200** — JSON containing at least Exotel **`Sid`**, **`Status`**, and optionally the raw **`Call`** object for debugging (strip secrets).
- **4xx** — validation or tenant misconfiguration (missing credentials, disabled Exotel).
- **502 / 424** — upstream Exotel failure; surface **`RestException.Status`** / **`Message`** when safe.

---

## 7. Integration with voicebot / streaming (later)

Inbound voice hits **`exotel-voicebot`** WebSocket bootstrap. **Outbound Connect + Voicebot:** Exotel defaults **`StreamBegin`** such that audio can start on **Leg 1** (caller/agent side first). That causes the Convixx greeting to run **before** the callee answers. Set **`StreamBegin=at Leg2Connect`** on the Connect API (Convixx outbound handler defaults this whenever a **`streamUrl`** is present, including auto-filled Voicebot URLs) so the **`start`** event aligns with the customer leg.

**Recommendation:** Phase B wiring for **`StreamUrl`**, **`StreamBegin`**, and `exotel_call_sessions` — outbound dial path now sends Voicebot **`streamUrl`** (tenant `wss://…/exotel/voicebot/{customerId}` when not overridden) with **`at Leg2Connect`** unless you pass **`voicebot_stream: false`** or override **`streamBegin`** (see `docs/EXOTEL_VOICE_INTEGRATION.md`).

---

## 8. Operational and compliance notes

- **Transactional vs promotional:** where applicable, set **`CallType`** and follow DND/consent rules for the jurisdiction and Exotel account.
- **Logging:** log **`Sid`**, **`customer_id`**, sanitized numbers (hash or last-four policy per company policy); never log API tokens.
- **Idempotency:** Exotel creates a **new** call per successful request; callers who need deduplication must implement client-side keys or internal guards.

---

## 9. Implementation checklist (when coding)

1. Add route module + register in `app.ts`.
2. Load **`getExotelSettings(customerId)`**; validate enabled + credentials + default caller ID fallback.
3. Build **`POST`** to `{base}/v1/Accounts/{sid}/Calls/connect` with form body matching Exotel’s parameter names (`From`, `To`, `CallerId`, …).
4. Map errors from Exotel to HTTP responses without leaking secrets.
5. (Optional) Insert/update **`exotel_call_sessions`** with `direction` consistent with Exotel (`outbound-api`) and store **`exotel_call_sid`** for observability.
6. Unit/integration tests with mocked Exotel HTTP (no real PSTN in CI).

---

## 10. References

- [Make a Call API — Connect Two Numbers](https://developer.exotel.com/api/make-a-call-api)
- `docs/EXOTEL_VOICE_INTEGRATION.md` — broader inbound/outbound + AgentStream context
- `apps/api/src/services/exotel-settings.ts` — tenant credential loading
