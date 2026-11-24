# Engine reply to the SaaS requests (2026-11-24)

Reply to "Requests from the Convixx SaaS to the voice engine (2026-11-24)". Branch `New-2.0`.

**Nothing here changes how a call runs, or adds a step a live call waits for.**
- On the call path, only these change:
  - one extra column in the Exotel session insert;
  - two extra fields in the agent query `/ask` already runs on each turn;
  - the lead's variables, read inside the campaign query a Vodafone call already runs at start, and only when the script has `{{`.
- Everything else is either new endpoints, or work done after the call (a separate worker process), or answers computed when asked, from existing tables or log files.

**Tests.**
- 59 end-to-end checks against a throwaway copy of the schema (all migrations), including real provider calls for voices, health and the post-call analysis.
- 14 checks of the same code on a database *without* migration 028: calls and existing routes work unchanged, and new write features answer `503 migration_pending`.
- A simulated VI campaign call through the real Vodafone route:
  - greeting with the lead's placeholder filled, 759 ms after connect;
  - caller turn transcribed in 197 ms and answered;
  - call row with agent and campaign.

| Item | Status | Latency impact |
|---|---|---|
| A1 Agent on every call | Built | None (one more column in the existing Exotel INSERT/UPDATE) |
| A2 Link call to recording | Partly | None |
| A3 Call states and timing | Partly | None |
| A4 Disposition | Built | None (separate process, after the call) |
| A5 Voicemail flag | Built | None (from A4) |
| A6 Sentiment | Built | None (same job as A4) |
| A7 Markers | Built (optional, off by default) | None (same job as A4) |
| A8 Post-call rating (CSAT) | Not built | n/a |
| A9 Per-lead variables | Built (Vodafone) / Partly (Exotel) | None (read in the existing campaign query at call start) |
| A10 Recurring campaigns | Not built | n/a |
| B1 Temperature / max tokens per agent | Built | None (read in the existing agent query) |
| B2 Voice accent and tone | Built | None |
| B3 Voice preview with tuning | Built | None |
| B4 Phone number type | Built | None |
| B5 KB source and archive | Built | None (archived entries leave `kb_entries`; the KB search is unchanged) |
| C1 API key request log | Built | None (in-memory push; batched write every 5 s) |
| C2 Usage counters | Built | None |
| C3 Dependency health | Built | None (admin only, cached 60 s) |
| C4 Engine timings | Built | None (from existing log lines) |
| C5 Event feed | Built | None (from existing log lines) |

---

## A. Calls

### A1. Agent on every call
Status: Built

What changed:
- Vodafone calls already saved the agent on every row (519/519 on production).
- Exotel's session insert (`createCallSession`) never wrote it. It now writes the agent the call actually uses: in the same INSERT for inbound calls, and in the existing UPDATE when an outbound call's stream starts.

Migration: none (`exotel_call_sessions.agent_id` exists).

Endpoint / table / field:
- `exotel_call_sessions.agent_id`.
- `agent {id, name}` in `GET /vodafone/reports/history`, as today.

Backfill: `apps/api/scripts/backfill-call-session-agents.ts`.
- It fills a row only from that call's own chat session (`chat_sessions.agent_id`) and never guesses.
- Dry run by default; `--apply` to write. Not run automatically.
- Dry run on production today: 236 rows without an agent. 142 can be filled; 94 stay NULL (81 have no chat session; 13 had no active agent).

Nullable / edge cases (`agent_id` stays NULL when):
- the call ended before the bot started, so no chat session exists (all of these are Exotel rows from April–September);
- the customer had no active agent at the time (customer `ee1aa6b2…` has 0 agents).

### A2. Link a call to its recording
Status: Partly

What we found (checked against VI's Pull Report for UCB, 7–9 Nov):
- The engine's `vi_call_id` **is** VI's CALL ID, but it sits in VI's **inbound** report (`calltype 1`), also for campaign calls. The stream leg is reported as its own inbound call. That is why 0 of 118 matched against the campaign report: those rows have different CALL IDs.
- In VI's inbound report, **all 122 of our bot calls have `RECORD = "No Voice"`**. VI does not record the streamed (bot) leg.
- The campaign report's "Connected" rows do have recording links. But they carry other CALL IDs and their times do not match our calls: the same number connected about an hour later, with no bot session. So they cannot be linked to a bot call reliably, and I did not build a guess.

What changed:
- `GET /vodafone/reports/history` and `/history/{id}` now return `vi_report: {type: "inbound", call_id, date_ist}`, so the SaaS can fetch VI's own row for the call. That row has CLI, start/end, duration and "DISCONNECTED BY".
- Exotel: the status callback now stores `RecordingUrl` (when Exotel sends one) as `metadata.exotel_recording_url`, with `exotel_status`, `exotel_terminal_at` and `exotel_conversation_seconds`. Nothing is downloaded.

Migration: none.

Request example:
```
GET /vodafone/reports/calls?type=inbound&call_id=49251052&from=2026-11-07&to=2026-11-07
```

Response example (part of a history row):
```json
"vi_call_id": "49251052",
"vi_report": { "type": "inbound", "call_id": "49251052", "date_ist": "2026-11-07" }
```

Auth: x-api-key | x-admin-token + x-customer-id

Not built because: VI has no recording of the bot leg to link to. To get bot-call recordings, recording has to be switched on for the Streaming flow on VI's side (a question for VI).

### A3. Call states and timing
Status: Partly

What changed:
- Each call in `GET /vodafone/reports/history` and `/history/{id}` has a `timing` object, computed from the existing row. Nothing new is written during the call.
- Exotel: the final state from Exotel's status callback is stored (see A2).

Migration: none.

Endpoint / field: `timing {ringing_at, answered_at, ended_at, wait_seconds, end_reason}`.

Response example:
```json
"timing": {
  "ringing_at": null,
  "answered_at": "2026-11-07T10:21:24.940Z",
  "ended_at": "2026-11-07T10:21:40.274Z",
  "wait_seconds": null,
  "end_reason": "hangup"
}
```

Auth: x-api-key | x-admin-token + x-customer-id

Nullable / edge cases:
- `end_reason` is one of:
  - `hangup`: VI closed the stream normally;
  - `connection_lost`: abnormal close (1006);
  - `ended_by_provider`: VI sent a stop;
  - `not_recorded`: the end was never logged;
  - `other`;
  - null while the call is live.
- Who hung up is in VI's row ("DISCONNECTED BY", via `vi_report`).
- Exotel metadata: `callee_answered_at` (existing), `exotel_status` and `exotel_terminal_at` (new).

Not built because:
- VI connects the stream only **after** the call is answered and sends no ringing event, so `ringing_at` and `wait_seconds` are null for Vodafone.
- No provider reports "On hold", so it is skipped.

### A4. Outcome / disposition per call
Status: Built

What changed:
- A new **separate process**, `jobs/call-insights-worker.ts` (PM2 `convixx-call-insights`), analyses calls that have ended. It never runs inside the API process that handles calls.
- Every 60 s it takes up to 10 ended calls from the last 3 days.
- It makes one OpenAI request per call, with the customer's own model (`llm_model_override`, else `openai_model`).
- A call where the caller never spoke is saved as `no_conversation` without any LLM request.
- Failures are retried up to 3 times, 10 minutes apart.

Migration: `028_saas_requests.sql`. Tables: `call_insights` (one row per call) and `call_insight_settings`.

Endpoint / table / field:
- `GET /calls/{id}/insights`, for any provider.
- `insights` in `GET /vodafone/reports/history` and `/history/{id}`.
- Table `call_insights`: `disposition`, `disposition_confidence`, `sentiment`, `sentiment_score`, `is_voicemail`, `markers`, `model`, `cost_usd`.

Request example:
```
GET /calls/3b0c7f2e-1e4b-4c55-8a6e-1f0d6f1b2c3d/insights
```

Response example (a real result from the test):
```json
{
  "call_id": "3b0c7f2e-1e4b-4c55-8a6e-1f0d6f1b2c3d",
  "status": "done",
  "insights": {
    "disposition": "callback", "disposition_confidence": 0.99,
    "sentiment": "positive", "sentiment_score": 0.5, "is_voicemail": false,
    "markers": [
      {"at_seconds": 1, "label": "Diwali Offer"}, {"at_seconds": 8, "label": "Discount Inquiry"},
      {"at_seconds": 12, "label": "Discount Offered"}, {"at_seconds": 30, "label": "Callback Request"}
    ],
    "model": "gpt-6-luna", "analysed_at": "2026-11-24T08:19:44.000Z"
  },
  "error": null
}
```

Auth: x-api-key | x-admin-token + x-customer-id

Nullable / edge cases:
- `status` is `pending` (ended, not analysed yet), `call_in_progress`, `done` or `error`.
- Calls older than `CALL_INSIGHTS_LOOKBACK_DAYS` (3) are not picked up. Set it higher once to analyse older calls.
- Cost: about 350 prompt tokens per short call, about $0.0001 on gpt-6-luna. It is stored in `call_insights.cost_usd`.
- It is **not** written to `openai_usage`, so it is not billed to the tenant as AI usage. Tell us if it should be.

How to switch on (if optional): on for every customer once the worker runs. Per customer: `PUT /settings/call-insights {"enabled": false}`.

### A5. Voicemail flag
Status: Built

What changed: neither provider reports an answering machine, so `is_voicemail` comes from the same post-call analysis. A call classified as `voicemail` always has `is_voicemail = true`. Nothing was added to the live audio path.

Migration: 028

Endpoint / field: `call_insights.is_voicemail`; `insights.is_voicemail` (in A4's response example).

Auth: as A4.

Nullable / edge cases: null until the call is analysed. The flag is kept in `call_insights`, not on `exotel_call_sessions`, so the busy calls table is not written to after the call.

### A6. Sentiment
Status: Built

What changed: in the same request as A4. `sentiment` is `positive` / `neutral` / `negative`, and `sentiment_score` runs from −1 to 1.

Migration: 028

Endpoint / field: `call_insights.sentiment`, `sentiment_score`; `insights.sentiment*` (in A4's response example).

Auth: as A4.

Nullable / edge cases: `neutral` / 0 for `no_conversation`.

### A7. Markers (topics in a call)
Status: Built (optional, off by default)

What changed: when on, the same post-call request also returns up to 8 `{at_seconds, label}` markers, made from the transcript's timestamps. `at_seconds` is clamped to the call length.

Migration: 028

Endpoint / table / field:
- `GET` / `PUT /settings/call-insights` (`enabled`, `markers_enabled`).
- `insights.markers`.

Request example:
```
PUT /settings/call-insights
{"markers_enabled": true}
```

Response example:
```json
{
  "enabled": true, "markers_enabled": true, "updated_at": "2026-11-24T08:18:02.114Z",
  "note": "Calls are analysed after they end by the call-insights worker (one LLM request per call with a conversation). Markers add a little to that request."
}
```

Auth: x-api-key | x-admin-token + x-customer-id

Nullable / edge cases: `markers` is null when off, and `[]` for a call with no conversation.

How to switch on (if optional): `PUT /settings/call-insights {"markers_enabled": true}`.

### A8. Post-call rating (CSAT)
Status: Not built

Not built because: there is no post-call rating flow today (no IVR "press 1-5", no SMS), so there is nothing stored. Not available. As asked, no IVR flow was built.

### A9. Per-lead variables in campaigns
Status: Built for Vodafone; Partly for Exotel

What changed:
- `POST /outbound/campaigns/{id}/leads`, `POST /vodafone/campaigns/{id}/leads` and `POST /vodafone/campaigns` accept each lead as a number (as before) or as `{phone_number, variables}`.
- Variables are stored with the lead.
- When the lead's Vodafone call starts, `{{name}}` placeholders in the script are filled before the opening line is synthesized. The lead's variables come back in the campaign query the call already runs, and that query reads them only when the script contains `{{`.
- The filled text is also what is saved as the first line of the call's chat history.

Migration: 028 (`outbound_campaign_leads.variables`)

Request example:
```json
POST /vodafone/campaigns/{id}/leads
{"phone_numbers": ["9876500001", {"phone_number": "9876500002", "variables": {"first_name": "Asha", "city": "Pune", "callback_slot": "6 pm"}}]}
```

Response example: unchanged (`{"message": "1 numbers added to the Vodafone campaign", "leads": {...}}`).

Auth: x-api-key (as today)

Nullable / edge cases:
- **Limits:** max 20 variables per lead; names `[A-Za-z_][A-Za-z0-9_]{0,39}`; values up to 300 characters (numbers and booleans are turned into text); 2 KB per lead. Anything else is rejected with 400.
- **Unknown or missing placeholder:** left empty, as you suggested, and the spacing is tidied: "Hello {{first_name}}, …" with no name becomes "Hello, …".
- **Numbers already in a campaign:** re-sending them with variables updates the variables. They are not uploaded to VI again, so they are never dialed twice.
- **Before migration 028:** numbers are stored as before, without variables.

Not built because (Exotel part): Exotel campaigns play a recording of the script that is made once, when the campaign is created. Filling placeholders per lead would need a speech synthesis before each call can speak. That adds delay, so for Exotel the variables are stored but not spoken.

### A10. Recurring campaigns
Status: Not built

Not built because: the engine has no repeat schedule (VI campaigns have one dialing window from `fromdate` to `todate`). Not available: the SaaS can schedule re-runs itself.

---

## B. Agents, voices, numbers, knowledge base

### B1. Creativity and response length per agent
Status: Built

What changed:
- `temperature` (0–1.5) and `max_tokens` (80–2000) on `POST /agents`, `PUT /agents/{id}`, `GET /agents` and `GET /agents/{id}`.
- `/ask` reads them in the agent query it already runs on every turn, so there is no extra request. They replace the customer's `llm_temperature` / `llm_max_tokens` for that agent's answers. Null means the current behaviour.

Migration: 028 (`agents.llm_temperature`, `agents.llm_max_tokens`)

Request example:
```json
PUT /agents/{id}
{"temperature": 0.7, "max_tokens": 300}
```

Response example: the agent, with `"temperature": 0.7, "max_tokens": 300`.

Auth: x-api-key (as today)

Nullable / edge cases:
- GPT-5 models accept only their default temperature, so `temperature` has no effect on them (as with the customer setting today).
- A larger `max_tokens` does not slow the first word, but it allows longer answers, and longer answers take longer to speak.
- Exotel's own streaming answer path keeps using the customer's settings. Vodafone calls and text chat use the agent's.
- Before migration 028, `PUT` with these fields answers 503 `migration_pending`. Other fields work as before.

### B2. Voice catalog: accent and tone
Status: Built

What changed:
- `GET /voices` items have `accent` and `tone` (null when not known).
- New filters `?accent=` and `?tone=`.

Where the values come from:
- Sarvam voices are Indian.
- ElevenLabs: from its voice labels.
- Cartesia: from its country and description keywords.
- A static override map (`VOICE_TRAIT_OVERRIDES` in `services/voice-catalog.ts`) can pin values for specific voices.
- Nothing is guessed from a voice's name.

Coverage today: every Sarvam voice is `indian` (tone null). Most ElevenLabs and Cartesia voices have an accent, and many have a tone.

Migration: none

Request example:
```
GET /voices?accent=indian&tone=warm
```

Response example:
```json
{"voices": [{"provider": "cartesia", "voice_id": "…", "name": "…", "language": "hi", "gender": "feminine", "model": "sonic-3.5", "sample_url": "/voices/sample?…", "accent": "indian", "tone": "warm"}]}
```

Auth: x-api-key (as today)

Nullable / edge cases:
- tone values: `warm`, `calm`, `energetic`, `professional`.
- accent values: `indian`, `us`, `uk`, `au`, … (ElevenLabs may also give labels such as `standard`).

### B3. Voice preview with tuning
Status: Built

What changed: `GET /voices/sample` takes `speed`, `pitch`, `emotion` and `volume`, and applies them the way calls apply an agent's voice settings. Options a provider ignores are listed in the `X-Voice-Options-Ignored` response header.

| Provider | Applied | Ignored |
|---|---|---|
| Sarvam | speed (pace), pitch, volume (loudness) | emotion |
| ElevenLabs | speed | pitch, volume, emotion |
| Cartesia | speed, volume, emotion (with the call path's limits) | pitch |

Migration: none

Request example:
```
GET /voices/sample?provider=sarvam&voice_id=shubh&language=hi-IN&speed=1.2&pitch=0.1&emotion=happy
```

Response example: audio, with the header `X-Voice-Options-Ignored: emotion`.

Auth: x-api-key (as today)

### B4. Phone number type
Status: Built

What changed: `type` (`did` | `virtual` | null) on `POST` and `PUT /customers/{customerId}/phone-numbers[/{id}]`, and returned on every number, in lists too.

Migration: 028 (`company_phone_numbers.number_type`; the API field is `type`)

Request example:
```json
PUT /customers/{customerId}/phone-numbers/{id}
{"type": "virtual"}
```

Response example: the number, with `"type": "virtual"`.

Auth: x-admin-token (as today for these routes)

Nullable / edge cases:
- null for existing numbers.
- Before migration 028, sending `type` answers 503 `migration_pending`.

### B5. Knowledge base source and archive
Status: Built

What changed:
- **source:** `source` on KB entries (`manual` | `json_upload` | `csv_upload` | `api`).
  - Set on create: `POST /kb/upload` takes an optional `source` (default `api`), and `POST /kb/upload-file` takes `?source=` (default `json_upload`; send `csv_upload` when you converted a CSV).
  - Null for older entries.
  - Returned by `GET /kb/entries`, and filterable with `?source=`.
- **archive:** `PATCH /kb/entries/{id}` with `{"archived": true|false}`.
  - Archiving **moves** the entry, with its translations, to `kb_entries_archived`. Unarchiving moves it back with the same id.
  - Answers only read `kb_entries`, so archived entries are never used. The KB search on `/ask` is not changed at all (no extra filter).
  - `GET /kb/entries` hides archived entries by default; `?status=archived` or `?status=all` shows them.
  - `GET /kb/entries/{id}` finds either kind, and `DELETE` deletes either.

Migration: 028 (`kb_entries.source`, table `kb_entries_archived`)

Request example:
```json
PATCH /kb/entries/6f1c2a3e-1111-4c1e-9d41-5b2f0d9e7a10
{"archived": true}
```

Response example:
```json
{"id": "6f1c2a3e-1111-4c1e-9d41-5b2f0d9e7a10", "status": "archived", "changed": true}
```

Auth: x-api-key (as today)

Nullable / edge cases:
- `GET /kb/entries` stays a plain array. New keys per item: `source`, `status`, `archived_at`.
- Optional `limit` / `offset`. Without `limit`, every entry is returned, as before.
- To edit an archived entry, unarchive it first (`PUT` only edits active entries).

---

## C. Usage, health and monitoring

### C1. API key request log
Status: Built

What changed:
- Every request made with a customer `x-api-key` is logged: method, path without the query string, status, duration in ms, time and key id. Never bodies or headers.
- The response hook only pushes the row into memory. A timer writes rows every 5 s as one batch, and deletes rows older than 30 days every hour.
- If the database is slow or the table is missing, rows are dropped and the API is unaffected.
- The key id comes from the key lookup every request already does.

Migration: 028 (`api_request_log`)

Endpoint: `GET /customers/{id}/api-keys/{keyId}/requests?limit=&before=`, newest first.

Request example:
```
GET /customers/4c9a8c38-…/api-keys/9a1d7e40-…/requests?limit=2
```

Response example:
```json
{
  "key_id": "9a1d7e40-5c2b-4f0e-8d3a-2b6c1e9f0a11", "retention_days": 30, "limit": 2,
  "next_before": "2026-11-24T08:20:03.512Z",
  "requests": [
    {"method": "GET", "path": "/vodafone/reports/history", "status": 200, "duration_ms": 41, "at": "2026-11-24T08:20:05.118Z"},
    {"method": "PUT", "path": "/agents/2f4e6a1c-8b9d-4c3e-a1f2-7d5e9b0c3a64", "status": 200, "duration_ms": 12, "at": "2026-11-24T08:20:03.512Z"}
  ]
}
```

Auth: x-api-key | x-admin-token + x-customer-id. `{id}` must be that customer, and `{keyId}` one of its keys.

Nullable / edge cases:
- Requests made with the admin token are not logged (there is no customer key).
- For the next page, pass `before=<next_before>`.
- Off switch: `API_REQUEST_LOG_ENABLED=false`.

### C2. Usage counters per customer
Status: Built

What changed: `GET /customers/{id}/usage?from=&to=` (IST dates; default the last 30 days; at most 366). Counted from existing tables when asked.

Migration: none (`api_requests` needs 028)

Response example:
```json
{
  "customer_id": "4c9a8c38-4949-4af2-917f-d248c9d50c86",
  "period": {"from": "2026-10-26", "to": "2026-11-24", "timezone": "Asia/Kolkata"},
  "api_requests": 1840, "api_requests_note": "Requests made with this customer's API keys (kept 30 days)",
  "kb_entries": {"active": 96, "archived": 3},
  "storage": {"campaign_audio_bytes": 0, "campaign_audio_files": 0, "recordings_bytes": 0, "total_bytes": 0,
              "note": "Call recordings are not stored by the engine (Vodafone keeps its own; Exotel links are kept by Exotel)."},
  "calls": {"calls": 519, "vodafone": 519, "exotel": 0, "talk_seconds": 21233}
}
```

Auth: x-api-key | x-admin-token + x-customer-id

Nullable / edge cases:
- `api_requests` is null before migration 028. It counts only from the day the log starts.
- The only files the engine stores per customer are Exotel campaign script audio files.

### C3. Dependency health
Status: Built

What changed: new admin-only health endpoints. Each check is one light request, cached 60 s, and never run on the call path:

| Service | Check |
|---|---|
| Sarvam | an empty request that answers 400 for a valid key, 403 for a bad one, and is not billed |
| Cartesia | list one voice |
| ElevenLabs | models list |
| OpenAI | model lookup |
| Google TTS | reachability only (no engine-wide key) |
| VI | CPaaS API host |
| Exotel | API host |
| Redis | `ok: null` (not used) |

Migration: none

Endpoints:
- `GET /health/dependencies` (all);
- `GET /health/dep/{name}`;
- `GET /health/stt`, `/health/tts`, `/health/telephony`, `/health/redis`.

Response example (`/health/dep/sarvam`):
```json
{"ok": true, "latency_ms": 375, "checked_at": "2026-11-24T08:21:00.000Z", "http_status": 400, "detail": "reachable, key accepted", "cached": true}
```

Auth: x-admin-token

Nullable / edge cases:
- `ok` is true (reachable, key accepted), false (down, or key refused), or null (not configured or not used).
- Groups: `ok` = every configured member is ok; `latency_ms` = the slowest.
- Telephony credentials are per customer, so VI and Exotel only check that the API host answers. VI calls arrive as WebSockets from VI.
- There is no SIP in the engine.

### C4. Engine timings
Status: Built

What changed: `GET /admin/metrics?minutes=15` (1–1440). It is computed when asked from the log lines the engine already writes, and cached 15 s:
- `http.out` gives per-route count, p50/p95/p99/max, and 4xx/5xx counts.
- The voicebot timing lines give per-turn `stt`, `ask_kb_and_llm`, `llm_first_token_since_caller_stopped`, `tts`, `first_audio_since_caller_stopped` and `total_since_caller_stopped`.

Not even an in-memory histogram is added: nothing new runs per request.

Migration: none

Response example:
```json
{
  "minutes": 15, "from": "2026-11-24T08:06:00.000Z", "to": "2026-11-24T08:21:00.000Z",
  "source": "server log files (http.out and voicebot timing lines)",
  "requests": {
    "count": 412, "p50_ms": 38, "p95_ms": 210, "p99_ms": 640, "max_ms": 1180,
    "routes": [{"method": "GET", "route": "/vodafone/reports/history", "count": 120, "p50_ms": 41, "p95_ms": 95, "p99_ms": 180, "max_ms": 230, "errors_4xx": 0, "errors_5xx": 0}]
  },
  "call_turns": {
    "turns": 37,
    "stt": {"count": 37, "p50_ms": 230, "p95_ms": 610, "p99_ms": 900, "max_ms": 1960},
    "ask_kb_and_llm": {"count": 37, "p50_ms": 1150, "p95_ms": 1900, "p99_ms": 2400, "max_ms": 2600},
    "llm_first_token_since_caller_stopped": {"count": 30, "p50_ms": 1400, "p95_ms": 2100, "p99_ms": 2500, "max_ms": 2700},
    "tts": {"count": 7, "p50_ms": 300, "p95_ms": 520, "p99_ms": 600, "max_ms": 600},
    "first_audio_since_caller_stopped": {"count": 30, "p50_ms": 1700, "p95_ms": 2500, "p99_ms": 2900, "max_ms": 3100},
    "total_since_caller_stopped": {"count": 37, "p50_ms": 2900, "p95_ms": 4300, "p99_ms": 5200, "max_ms": 5600}
  }
}
```

Auth: x-admin-token

Nullable / edge cases:
- Paths are grouped (`/kb/entries/:id`).
- WebSocket call routes are left out, because their "duration" is a whole call.
- History is limited to the server's log retention (about 7 days).

### C5. Event feed
Status: Built

What changed: `GET /admin/events?since=&limit=&slow_ms=&types=`, newest first, built from the same log files. Nothing is written per event. Types:
- `restart`;
- `slow_request` (default 3000 ms or more);
- `server_error` (HTTP 5xx);
- `error` (level ≥ 50, for example provider errors and call errors);
- `warning`.

Secrets are masked and stack traces dropped.

Migration: none

Request example:
```
GET /admin/events?since=2026-11-23T08:00:00Z&types=slow_request,restart,error
```

Response example:
```json
{
  "since": "2026-11-23T08:00:00.000Z", "slow_ms": 3000,
  "counts": {"restart": 1, "slow_request": 2, "error": 1}, "total": 4,
  "events": [
    {"at": "2026-11-24T07:59:12.000Z", "at_ist": "2026-11-24 13:29:12", "type": "slow_request", "level": "info", "message": "http.out",
     "detail": {"method": "GET", "route": "/vodafone/reports/calls", "status": 200, "duration_ms": 4120}},
    {"at": "2026-11-24T07:30:02.000Z", "at_ist": "2026-11-24 13:00:02", "type": "restart", "level": "info",
     "message": "Server listening on http://0.0.0.0:8080", "detail": {"pid": 3970369}}
  ]
}
```

Auth: x-admin-token

Nullable / edge cases:
- `since` goes back at most 7 days.
- `counts` covers the whole range; `events` is cut to `limit`.

---

## Deployment

**Migrations to run, in order:**
1. `027_calling_events.sql` (from the previous delivery; not run yet).
2. `028_saas_requests.sql`.

Run each from `apps/api`: `npx ts-node --transpile-only scripts/run-sql-file.ts ../../infra/postgres/migrations/0NN_….sql`.

028 only adds nullable columns and new tables, with a 5 s lock timeout. If a table is busy, it stops instead of waiting, and can simply be run again. The new code also works before 028; the new features then answer `503 migration_pending`.

**Environment variables added (all optional):**
- `API_REQUEST_LOG_ENABLED`
- `CALL_INSIGHTS_INTERVAL_SECONDS`
- `CALL_INSIGHTS_BATCH`
- `CALL_INSIGHTS_LOOKBACK_DAYS`
- `CALL_INSIGHTS_MODEL`

**Jobs / processes added:**
- PM2 `convixx-call-insights`, a separate process from `convixx-api`. Every 60 s it analyses up to 10 ended calls. Start it after the build:
  ```
  pm2 start dist/jobs/call-insights-worker.js --name convixx-call-insights && pm2 save
  ```
  Stopping it stops the analysis; calls are not affected.
- Inside `convixx-api`: one timer that writes the API request log every 5 s and cleans up rows past 30 days hourly.

**One-off script (not run automatically):** `scripts/backfill-call-session-agents.ts --apply` (A1).

**What the SaaS must change on its side:**
- Recordings (A2): look up a Vodafone call's VI row with the **inbound** report and `vi_call_id`, not the campaign report. Expect no recording for bot calls until VI records the streamed leg. Exotel: read `metadata.exotel_recording_url`.
- Read the new fields: `timing`, `vi_report` and `insights` in the history endpoints; `temperature` / `max_tokens` on agents; `type` on numbers; `source` / `status` on KB entries.
- Leads: send `{phone_number, variables}` for personalised scripts (Vodafone).
- KB uploads: pass `source` (`POST /kb/upload`) or `?source=csv_upload` (`POST /kb/upload-file`).
- Monitoring: poll `/health/dependencies`, `/admin/metrics` and `/admin/events` with the admin token. They are cached (60 s / 15 s), so polling every minute is fine.
