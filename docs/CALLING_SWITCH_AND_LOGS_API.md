# Calling switch, calling logs, activity and daily logs (API)

All endpoints accept either `x-api-key` (the customer's own key) or `x-admin-token` together with `x-customer-id` (header) or `customer_id` (query). All dates are India (IST) dates, `YYYY-MM-DD`. The full Swagger is at `/docs`, under the **Calling** and **Logs** tags.

## Calling switch: block calls at 0 credits

The switch is `customer_settings.voicebot_enabled`. When it is **off**:
- A Vodafone call is disconnected as soon as VI connects it. No session, transcript or charge is created.
- Exotel refuses the stream.
- These endpoints answer `403` with `code: calling_disabled`:
  - `POST /vodafone/campaigns/{id}/start`
  - `POST /outbound/campaigns/{id}/trigger`
  - `POST /outbound/call`
  - `POST /customers/{id}/exotel/outbound-call`
- Calls already in progress finish normally.

The engine reads the switch fresh from the database when a call starts, not from its 1-minute cache. If that read fails, the call is allowed through, so a database glitch never drops a paying customer's calls.

**Automatic:**
- The SaaS billing job (`credits:meter`, every minute) turns calling off when the company's balance reaches 0, and back on after a top-up.
- It only turns calling back on if billing was what turned it off.

**Manual:**

| Method | Endpoint | What it does |
|---|---|---|
| GET | `/settings/calling` | `calling_enabled`, `last_change` (who, why, when) and `billing` (credits left, when billing suspended calling, pulse length) |
| PUT | `/settings/calling` | Body `{"enabled": false, "reason": "..."}` turns calling off; `{"enabled": true}` turns it back on |

Turning calling on with 0 credits or less is refused with `409` (`code: no_credits`). The admin token can override this with `"force": true`; a customer API key cannot (`403`, `code: force_admin_only`).

A forced turn-on stays on: billing only switches calling off again after a top-up has reset the 0-credit state. Until then, calls run unpaid.

## Calling logs

`GET /calling/logs?from=&to=&event=&limit=&offset=` returns events newest first. The default range is the last 30 days. `counts` gives the number of each event over the range.

| Event | When | `source` |
|---|---|---|
| `disabled` / `enabled` | The switch changed | `saas-billing` (0 credits or top-up), `api:admin`, `api:customer-key`, or `database` (a direct update) |
| `call_blocked` | A call arrived while calling was off and was disconnected | `vodafone-voicebot` or `exotel-voicebot`. `details` has the VI call ID, stream ID, direction and campaign |
| `dial_blocked` | A dial or campaign start was refused | The endpoint that was called |

Switch changes are written by a database trigger (migration `027_calling_events.sql`), so every change is logged, whoever made it. A writer can name itself inside its transaction:

```sql
SELECT set_config('convixx.calling_source', 'saas-billing', true),
       set_config('convixx.calling_reason', 'Call credits reached 0', true);
```

## Activity per hour / day / week / month

`GET /calling/activity?from=&to=&group=hour|day|week|month`

Each period gives:
- `calls`, `connected`, `outbound` and `inbound` (Vodafone and Exotel);
- `talk_seconds`;
- `credits_deducted` (Call Pulses);
- `calls_blocked` and `dials_blocked`;
- `times_disabled` and `times_enabled`.

`totals` sums the periods. Only periods with activity are listed.

| `group` | Longest range | Default range | Period label |
|---|---|---|---|
| `hour` | 7 days | today | `2026-11-07 16:00` |
| `day` | 92 days | last 30 days | `2026-11-07` |
| `week` | 366 days | last 12 weeks | `2026-W45` (ISO week) |
| `month` | 731 days | last 12 months | `2026-11` |

## Daily server logs (one customer)

| Method | Endpoint | Returns |
|---|---|---|
| GET | `/logs/dates` | IST days that still have a server log. The server keeps a limited number of days |
| GET | `/logs/daily?date=&level=&msg=&q=&hour=&order=&limit=&offset=` | This customer's log lines for one IST day, plus `summary`: lines per hour, per level, and the 30 most frequent messages |

**Which lines count as this customer's:** lines carrying the customer ID, or the stream, call or session ID of one of the customer's calls that day. Call lines carry those IDs rather than the customer ID.

**Secrets:** API keys, tokens, auth headers and passwords are shown as `[hidden]`.

**Filters:**
- `level`: that level and above;
- `msg`: the message contains this text;
- `q`: this text anywhere in the line;
- `hour`: 0–23 (IST).

The full server log for every customer stays admin-only, at `GET /admin/logs`.

## Code

| Part | Location |
|---|---|
| Switch check at call start and on dials | `isCallingEnabled` in `apps/api/src/services/customer-settings.ts`; used in `vodafone-voicebot.ts`, `vodafone-campaigns.ts`, `outbound-campaigns.ts`, `exotel-outbound-call.ts` |
| Switch on/off, billing state, blocked-call log | `apps/api/src/services/calling-switch.ts` |
| Calling endpoints | `apps/api/src/routes/calling.ts` |
| Daily log endpoints | `apps/api/src/routes/customer-logs.ts` |
| Log table and trigger | `infra/postgres/migrations/027_calling_events.sql` |
| SaaS: 0 credits turns calling off, top-up turns it on | `Saas Wireframe/app/Services/Credits/EngineCallingSwitch.php` (called from `CallMeteringService`) |
