# CRM Tool Calling — Native CRM + Custom CRM APIs (Plan, 2026-11-05)

**Status:** Plan only. Nothing in this document is built yet.
**Repos:** engine `nodejs_main` (call pipeline, LLM, Vodafone/Exotel) and SaaS `Saas Wireframe` (CRM UI, native CRM data, custom tool definitions). Both share the Postgres database `convixx_kb`.
**Related:** SaaS `docs/25-crm.md` (CRM module, open questions Q1/Q2), SaaS `docs/29-telecom-providers-and-outbound-api.md`, engine `routes/ask.ts` (`runAskPipeline`), `routes/vodafone-voicebot.ts`, `routes/exotel-voicebot.ts`.

---

## 1. Goal

During a live call (Vodafone or Exotel, inbound or outbound campaign) the AI agent should be able to:

1. **Know who is calling:** look the caller up in the CRM the moment the call starts and use what it finds ("Hi Neha, calling about your order from Tuesday?").
2. **Fetch data mid-conversation:** order status, booking, balance, ticket, anything the CRM or the customer's own API holds, when the conversation needs it.
3. **Sense leads and write them to the CRM:** capture name, need, budget, callback time and similar details from the conversation, then create or update the lead (native CRM) or send it to the customer's own CRM (custom CRM).

It has to work for both CRM options a workspace can choose (`crm_settings.provider`):

| Provider | Read (get data) | Write (add/update lead) |
|---|---|---|
| **native** (Convixx CRM) | `crm_records` + custom fields + custom tables + activities, same DB | Create/update `crm_records`, notes, activities, field values, through the SaaS's own service layer |
| **custom** (customer's own CRM API) | `crm_tools` the customer defined (URL, auth, sample response, mapping, condition) | `crm_tools` that write (POST/PUT), **plus** the existing Custom CRM webhook (`call.completed` …), now carrying the extracted lead |

Non-goals: Zoho/Salesforce (still "coming soon", Q3). The same tool interface is designed so they can plug in later as one more provider adapter.

---

## 2. What exists today (verified 2026-11-05)

### 2.1 SaaS (`Saas Wireframe`)

| Piece | Where | State |
|---|---|---|
| Native CRM data model, 21 tables | migrations `2026_08_12_1000xx_*` | Built. `crm_records` (name, phone, `phone_e164`, email, city, stage, status, score, owner, `preferred_language`, `last_call_at`…), `crm_fields`/`crm_field_values` (custom fields), `crm_tables`/`crm_table_rows` (repeating rows such as orders), `crm_notes`, `crm_activities` (has `engine_session_id`), `crm_modules` (segments), `crm_pipeline_stages`. |
| Record writes | `app/Services/Crm/RecordService.php` | `create()` requires a `User $actor` and runs workflows (`record.created`) and webhooks (`lead.created`). There's no system or engine actor yet. |
| Phone normalisation | `CrmRecord::normalisePhone()` | Digits only, keeps a leading `+`; does **not** add a country code. Calls are matched on the **last 10 digits** (`CallSync::recordFor`). |
| Custom CRM tool definitions | `crm_tools` + `app/Services/Crm/ToolService.php` + `CrmToolController` | Built (screens p7–p20): `title`, `description`, `condition` ("when should the AI call this"), `method`, `url`, `headers`, `body_template` with `{{placeholders}}`, `auth_type` (none/bearer/api_key/basic), `secret` (**Laravel `encrypted` cast**), `sample_response`, `param_map` (placeholder → source: `caller_phone` / `conversation` / `record_field` / `static`), `response_map` (JSON path → label), `status` draft/verified/failed, `is_active`, `engine_tool_id` (**empty, reserved for this work**). |
| Tool test runs | `crm_tool_runs` | Only the SaaS's "Hit once & verify". No live-call runs are ever recorded. |
| Custom CRM "receive every call" | `crm_settings.custom_webhook_id` → `crm_webhooks`; `CallSync` (`crm:calls:sync`, every minute) | Live: `call.started` / `call.completed` / `call.failed`, signed, retried, optional transcript. |
| Webhook events | `config/crm.php` | Includes `lead.created`, `lead.updated`, `ai.tool.ran`, `appointment.booked`, `call.*`. `ai.tool.ran` exists but nothing fires it. |
| Machine API for the engine | none (`routes/web.php` only) | The SaaS exposes no endpoint the engine could call. |
| Design doc | `docs/25-crm.md` | Q1 ("engine has no tool-calling API") and Q2 ("how does the AI read the native CRM") are **still open**. This plan answers both. |

**Live data:** the CRM tables exist in the shared DB but are **empty**: 0 `crm_records`, 0 `crm_tools`, 0 `crm_webhooks`; one company has `crm_settings.provider = 'native'`. Everything below is designed against the schema plus the sample shapes the SaaS already stores (`sample_response`, `param_map`, `response_map`). The first real tool a customer defines becomes the acceptance test (§11).

### 2.2 Engine (`nodejs_main`)

| Piece | State |
|---|---|
| LLM | OpenAI only (`gpt-5-mini`, verbosity low, priority tier), never self-hosted. `runAskPipeline` forces `ragOpenaiOnly = true`. |
| Tool / function calling | **None.** `chatOpenAI` / `streamChatOpenAI` send no `tools`. |
| Answer paths | Vodafone → `runAskPipeline` (streaming by default). Exotel → its **own** RAG/LLM code in `exotel-voicebot.ts` (`streamChatOpenAI…` around line 4094). Tool calling must be added to **both**, through one shared module. |
| Answer cache / `kb_direct` | Answers can be served from a per-tenant cache or straight from the KB **across calls**. The speed simulation showed an inbound call answered from an outbound call's cache. **A CRM-personalised answer must never enter or be served from this cache** (§9). |
| Call records | Exotel writes `exotel_call_sessions`. **Vodafone writes none.** So Vodafone calls never reach SaaS call history, the native CRM timeline or Custom CRM `call.*` webhooks. |
| Transcripts | `chat_messages.content` is AES-encrypted by the engine (`services/crypto.ts`). The SaaS reads it raw (`CallHistory::transcript`), so the call history screen and Custom CRM `include_transcript` payloads currently carry **ciphertext**. |
| Latency today (simulation, 800 ms VAD) | Server time from end of speech to first reply audio is about 1.3–1.6 s; the caller waits about 2.1–2.4 s. The LLM is about 1.0–1.3 s of that. |

---

## 3. Gaps to close first (Phase 0, prerequisites)

These are bugs or missing plumbing that block CRM features regardless of tool calling:

1. **Vodafone calls are invisible to the CRM.** The Vodafone WS start handler must create a call row (same table the SaaS reads, `exotel_call_sessions`, provider-tagged, or a generic `call_sessions` view over both) with `direction`, `from/to`, `agent_id`, `chat_session_id`, `campaign_id`, `started_at/ended_at`, `outcome`. Without this, nothing in this plan works for Vodafone, which is the main carrier now.
2. **Transcripts reach the SaaS as ciphertext.** Add an engine endpoint `GET /customers/:customerId/calls/:callId/transcript` (admin token) that returns decrypted turns. Switch `CallHistory::transcript()` and the Custom CRM `include_transcript` path to use it. Never share the engine's AES key with PHP.
3. **No engine actor for CRM writes.** `RecordService::create()` needs a `User`. Add a per-company **system user** ("Convixx AI", no login) or make `actor` nullable with `owner_id` falling back to the company's default owner, so workflows and webhooks still fire for AI-created leads.
4. **Phone matching is inconsistent.** Engine numbers arrive as `9812345678`, `919812345678` or `+919812345678`. Every CRM lookup or write matches on the **last 10 digits** (the convention `CallSync` and the engine's phone routing already use), and new records store `phone_e164` with `+91` when the input has exactly 10 digits.

---

## 4. Architecture decision: who executes what

### 4.1 The engine is the tool runtime

The LLM loop runs in the engine, inside a live call with roughly a 2 s budget. Sending every tool call through the SaaS (PHP request → outbound HTTP → back) adds a hop and a PHP worker to the hottest path. So:

- **The engine executes all tool calls during calls** (native reads, custom CRM API calls).
- **The SaaS stays the place where tools are defined, verified and monitored** (existing screens p7–p20), and the owner of native-CRM business rules for writes.

This answers `docs/25-crm.md` Q1: *the engine executes; the SaaS registers tools with the engine*.

### 4.2 Native CRM: read directly, write through the SaaS

| Operation | Path | Why |
|---|---|---|
| **Read** (lookup by phone, fields, table rows, recent activity) | Engine queries a **read-only SQL view** owned by a SaaS migration, e.g. `crm_engine_contacts_v` (company → `engine_customer_id`, last-10-digit phone key, core fields, custom fields as JSON, last N activities). | About 5–20 ms on the shared DB, no HTTP hop. The view is the contract: SaaS can refactor tables without breaking the engine. |
| **Write** (create/update lead, note, stage, activity, callback) | Engine calls a new **SaaS internal API** (`/internal/engine/crm/*`, §7.2), **asynchronously from an outbox**, never blocking speech. | Keeps reference numbering, owner rules, segments, workflows (`record.created`) and webhooks (`lead.created`) in one place, the SaaS `RecordService`. Writing the tables directly from Node would silently bypass all of that. |

Answer to Q2: the AI reads the native CRM from the view and writes through the SaaS API, both authenticated server-side. Nothing is exposed publicly.

### 4.3 Custom CRM tools: the SaaS pushes definitions, the engine stores and executes them

- When a tool becomes **verified + active** (or is edited, paused or deleted), the SaaS calls the engine admin API `PUT /customers/:customerId/crm-tools/:saasToolId` with the full spec **including the plaintext secret** (TLS, admin token), the same pattern the Exotel and Vodafone credentials already follow (doc 24 §3, `vodafone-settings` credentials).
- The engine stores it encrypted with **its own** key (`services/crypto.ts`) and returns `engine_tool_id`, which the SaaS saves into `crm_tools.engine_tool_id`.
- Per `docs/25-crm.md` §2.5, the SaaS can then stop keeping the secret (drop `crm_tools.secret`, keep `has_secret`/`secret_last_four`) once "Hit once & verify" is proxied through the engine (`POST /customers/:id/crm-tools/:toolId/test`). That's optional: keeping the SaaS copy for the verify button is acceptable short term.
- **Rejected alternative:** the SaaS executes tools on the engine's behalf. It would reuse `ToolService`, but it puts PHP plus an extra network hop into every tool turn, and the SaaS would need a synchronous low-latency API it doesn't have.

### 4.4 Component diagram

```
                ┌──────────────────────── SaaS (Laravel) ────────────────────────┐
                │ CRM screens · Tool builder p7-p20 · Lead-capture settings       │
                │ RecordService / workflows / webhooks (single owner of writes)   │
                │  ├─ PUT engine /customers/:id/crm-tools/:toolId  (on verify/edit)│
                │  └─ /internal/engine/crm/*  ◄──────────── writes (async outbox) ─┼──┐
                └───────────────▲─────────────────────────────────────────────────┘  │
                                │ crm_engine_contacts_v (read-only view, shared DB)   │
┌──────────── Engine (Node) ────┴─────────────────────────────────────────────────┐  │
│ Call start ──► CRM context loader ──► system prompt "CALLER CONTEXT" block       │  │
│ Each turn  ──► LLM (OpenAI tools) ──► tool executor ──► native adapter (view) ───┼──┘
│                                        │            └► custom adapter (HTTP, SSRF │
│                                        │               guard, timeout, response_map)
│ Call end   ──► lead extractor (OpenAI structured output) ──► outbox ──► SaaS API  │
│                                        └► tool_runs log (SaaS reads, like calls)  │
└───────────────────────────────────────────────────────────────────────────────────┘
                                         │ custom tools / custom CRM webhook
                                         ▼
                                Customer's own CRM API
```

---

## 5. When CRM calls happen: the three moments

Each custom tool gets an explicit **trigger** (new column, §7.1). The free-text `condition` stays as guidance for the LLM.

### T1: Call start ("pull on ring")

- **What:** caller lookup. Native: the view, matched on the caller's last 10 digits (for outbound campaigns, the lead's number). Custom: every active tool with `trigger = call_start`, with params bound from `caller_phone`, campaign or static values. No LLM is involved.
- **When:** fired in `handleStart` (Vodafone) / the `start` event (Exotel), **in parallel with the greeting TTS**, so it adds no wait.
- **Budget:** 800 ms. If the lookup is late, the greeting still plays and the context is injected for the first turn as soon as it arrives. If it fails, the call continues with no context (logged).
- **Output:** a compact `CALLER CONTEXT` block appended to the system prompt for the whole call (only `response_map`ped fields for custom tools, about 600 characters max), for example:
  ```
  CALLER CONTEXT (from CRM, use naturally, do not read out IDs):
  - Name: Neha Kapoor · Lead · Stage: Interested · Score 72 · Preferred language: hi-IN
  - Last call: 2 days ago (outbound, Diwali offer campaign), note: "wants 2BHK, budget 80L"
  - Open order: ORD-1042, status Dispatched, ETA 7 Nov
  ```
- **Greeting personalisation (optional, per tenant):** if the context arrives within the budget, `{{first_name}}` in the agent's greeting or the campaign script is filled; otherwise a neutral greeting is used.

### T2: In conversation (function calling)

- **What:** the LLM gets a `tools` list: native built-ins (§6.1) plus custom tools with `trigger = in_conversation` (§6.2), scoped to the agent. It decides from the tool `description` + `condition` when to call one.
- **Flow per turn:**
  1. STT → `runAskPipeline` / Exotel path → OpenAI chat **with tools**, streaming.
  2. If the model answers with text, it's spoken exactly as today (no added latency).
  3. If it returns a `tool_call`, the engine immediately speaks a short filler in the call language and voice ("Ek second, main check karti hoon" / "One moment, let me check"). Tenant-overridable via the tool's `filler_text`; reuses the existing filler-ack machinery and the call's locked voice.
  4. Execute the tool (timeout `timeout_ms`, default 2500 ms; max 2 tool calls per turn; tools without dependencies run in parallel).
  5. Send the tool result (mapped fields only) back to OpenAI and stream the final answer through TTS.
- **Write tools in conversation** (`crm_save_lead`, `crm_schedule_callback`, custom POST tools): the model must **confirm first** ("Shall I book a callback for 5 pm tomorrow?") before calling them. The system prompt enforces this, and writes are idempotent per call (§9).

### T3: Call end ("push on wrap"): lead sensing

- **What:** after `stop` / hang-up, a background job runs **lead extraction** over the full transcript with OpenAI **structured output** (strict JSON schema, §8.3), then:
  - **native:** upsert the lead through the SaaS API (match on last-10 phone; create if new, update only empty or explicitly changed fields; add a call note with the summary; set stage/score if the extraction says so; schedule a callback activity if one was agreed);
  - **custom:** enrich the existing Custom CRM `call.completed` webhook payload with `lead` and `summary` objects (no new delivery path), **and** run any custom tools with `trigger = call_end` (for example "Create lead in our CRM": POST with `{{lead.name}}`, `{{lead.need}}`, …).
- **Why after the call and not only in the conversation:** zero latency for the caller, sees the whole conversation (people give their name at the end), and is retryable. The in-call `crm_save_lead` tool only exists for things that must happen *now* (a booked callback the caller is waiting to hear confirmed).
- **Lead "sensing" rule:** a lead is written only when `is_lead = true` and `confidence ≥ lead_min_confidence` (default 0.6), or when the caller's number already exists in the CRM (then it's an update plus a note, never a duplicate).

---

## 6. Tool catalogue

### 6.1 Native CRM built-in tools (engine-defined, available when `provider = native`)

| Function name | Kind | Args the LLM fills | Engine fills | Returns to LLM |
|---|---|---|---|---|
| `crm_lookup_contact` | read | `phone?` (only when the caller gives a different number) | caller phone | name, type, stage, status, score, city, preferred language, custom fields (labels), last 3 activities |
| `crm_get_table_rows` | read | `table` (enum of this company's `crm_tables.key`, e.g. `orders`), `query?` | record id | up to 5 rows, mapped columns |
| `crm_save_lead` | write (confirm first) | `full_name`, `email?`, `city?`, `need`, `budget?`, `notes?`, `fields{}` (enum of `crm_fields.key`) | phone, source=`ai_call`, agent, campaign | `{ok, reference}` |
| `crm_add_note` | write | `text` | record id, call id | `{ok}` |
| `crm_update_stage` | write (confirm first) | `stage` (enum of `crm_pipeline_stages.key`) | record id | `{ok, stage}` |
| `crm_schedule_callback` | write (confirm first) | `when` (ISO datetime, caller's timezone), `reason` | record id | `{ok, when_spoken}` |

Enums are built per company at call start from `crm_fields`, `crm_tables` and `crm_pipeline_stages`, so the model can only name things that exist.

### 6.2 Custom CRM tool → OpenAI function

Mapping from a `crm_tools` row:

| `crm_tools` | OpenAI function |
|---|---|
| `title` "Fetch order status" | `name`: `custom_fetch_order_status` (slug, unique per company, max 64) |
| `description` + `condition` | `description`: "Looks up an order by phone or id. Call when: the caller asks where their order is." |
| `{{placeholders}}` whose `param_map` source is `conversation` | `parameters.properties` (strings), `required` |
| placeholders with source `caller_phone` / `record_field` / `static` | **hidden from the LLM**, filled by the engine (`caller_phone` = caller number; `record_field` = value from the T1 native or custom context; `static` = fixed value) |
| `response_map` (`$.data.status` → "Order status") | only these paths are returned to the LLM, as `{ "Order status": "Dispatched" }`; unmapped responses are cut to the `sample_response` shape, max 2 KB |
| `auth_type` + secret | headers built by the engine exactly as `ToolService::authHeaders()` does today (bearer / `X-API-Key` / basic) |
| `trigger` (new) | `call_start` → T1 only, `in_conversation` → in `tools`, `call_end` → T3 only (also gets `{{lead.*}}`, `{{summary}}`, `{{call.*}}` placeholders) |

Worked example. Customer tool "Fetch order status": `GET https://api.acme.in/orders?phone={{phone}}&order={{order_id}}`, `param_map = {phone: caller_phone, order_id: conversation}`, `response_map = {"$.order.status": "Order status", "$.order.eta": "Delivery date"}`. The LLM sees:

```json
{
  "type": "function",
  "function": {
    "name": "custom_fetch_order_status",
    "description": "Looks up order by phone or id. Call when: caller asks about an order, delivery or tracking.",
    "parameters": {
      "type": "object",
      "properties": { "order_id": { "type": "string", "description": "Order number if the caller said one, else empty" } },
      "required": [],
      "additionalProperties": false
    }
  }
}
```

The engine sends `GET …?phone=919812345678&order=ORD-1042` with `Authorization: Bearer ••••` and returns `{"Order status":"Dispatched","Delivery date":"7 Nov"}` to the model.

---

## 7. Data model and API changes

### 7.1 SaaS schema (additive migrations)

`crm_tools`:

| Column | Type | Purpose |
|---|---|---|
| `trigger` | varchar(16), default `in_conversation` | `call_start` · `in_conversation` · `call_end`: **at what point it hits** |
| `agent_ids` | json, null | Restrict to specific engine agents (null = all agents of the company) |
| `filler_text` | varchar(200), null | What the bot says while this tool runs |
| `timeout_ms` | smallint, default 2500 | Per-tool cap (max 5000) |
| `requires_confirmation` | boolean, default true for non-GET | Ask the caller before a write |

`crm_settings` (lead capture):

| Column | Type | Purpose |
|---|---|---|
| `lead_capture_enabled` | boolean, default true | T3 on/off |
| `lead_capture_fields` | json | Which `crm_fields.key` to extract, in addition to the core fields |
| `lead_target_module_id` | fk `crm_modules`, null | Segment new AI leads land in (default: Leads) |
| `lead_min_confidence` | numeric(3,2), default 0.60 | Below this, no record is created |
| `ai_actor_user_id` | fk `users`, null | System user for AI-created records (§3.3) |

New view `crm_engine_contacts_v` (SaaS migration): `customer_id` (= `companies.engine_customer_id`), `phone_last10`, `record_public_id`, `reference`, `type`, `full_name`, `email`, `city`, `stage`, `status`, `score`, `preferred_language`, `last_call_at`, `fields` (json label→value), `recent_activities` (json, last 3). Index: `crm_records (company_id, right(regexp_replace(phone_e164,'\D','','g'),10))`.

### 7.2 New SaaS internal API (engine → SaaS)

Auth: `Authorization: Bearer ${ENGINE_CALLBACK_TOKEN}` (shared secret in both `.env` files) **and** HMAC-SHA256 of the body with a timestamp header (replay window 5 min). Only reachable from the engine host (firewall/nginx allow-list).

| Method & path | Body | Does |
|---|---|---|
| `POST /internal/engine/crm/leads` | `{customer_id, idempotency_key, phone, full_name?, email?, city?, need?, budget?, fields{}, source, call_id, agent_id, campaign_id?, summary, confidence}` | Upsert by last-10 phone through `RecordService` (create or patch empty fields), add note + call activity, fire workflows/webhooks |
| `POST /internal/engine/crm/records/{public_id}/notes` | `{idempotency_key, text, call_id}` | `RecordService::addNote` |
| `PATCH /internal/engine/crm/records/{public_id}/stage` | `{idempotency_key, stage}` | Stage change (workflows `record.stage_changed`) |
| `POST /internal/engine/crm/records/{public_id}/callbacks` | `{idempotency_key, when, reason}` | Activity/task, fires `appointment.booked` |

Every call returns `{ok, reference, record_public_id}`. `idempotency_key` = `sha256(call_id + tool + normalized_args)`, stored, so a retried write never duplicates.

### 7.3 New engine admin API (SaaS → engine)

| Method & path | Purpose |
|---|---|
| `PUT /customers/:customerId/crm-tools/:saasToolId` | Upsert a tool spec (all `crm_tools` fields + plaintext secret once). Returns `{engine_tool_id, version}` |
| `DELETE /customers/:customerId/crm-tools/:saasToolId` | Remove (SaaS calls on delete/pause) |
| `POST /customers/:customerId/crm-tools/:saasToolId/test` | Run once with test values (replaces the SaaS-side execution of "Hit once & verify" later) |
| `GET /customers/:customerId/tool-runs?since=` | Live-call tool executions for the SaaS logs screen (p18) |
| `GET /customers/:customerId/calls/:callId/transcript` | Decrypted transcript (§3.2) |
| `GET /customers/:customerId/calls/:callId/lead` | The T3 extraction result, for the call detail screen |

### 7.4 New engine tables (migration 024+)

```
crm_tool_specs   (id uuid, customer_id, saas_tool_id text, name text, trigger text,
                  spec jsonb, secret_enc text, agent_ids uuid[], is_active bool,
                  version int, updated_at)                     UNIQUE(customer_id, saas_tool_id)
crm_tool_runs_e  (id, customer_id, tool_spec_id, call_session_id, chat_session_id,
                  trigger, status ok|err|timeout|skipped, http_status, latency_ms,
                  request_redacted jsonb, response_mapped jsonb, error, created_at)
call_lead_extractions (call_session_id pk, customer_id, extraction jsonb, confidence,
                  is_lead bool, pushed_native_at, pushed_custom_at, error, created_at)
crm_outbox       (id, customer_id, kind, payload jsonb, idempotency_key unique,
                  attempts, next_attempt_at, done_at, last_error)
```

---

## 8. Engine implementation outline

### 8.1 Shared module `apps/api/src/services/crm-tools/`

| File | Responsibility |
|---|---|
| `registry.ts` | Load per call: company CRM provider, built-in native tools (with per-company enums), custom tool specs for this agent. Cached 60 s per tenant, invalidated by the admin API. |
| `context-loader.ts` | T1: native view lookup + `call_start` custom tools in parallel → `CALLER CONTEXT` block. |
| `executor.ts` | Run one tool call: bind params (`caller_phone`, `conversation`, `record_field`, `static`), SSRF guard (port `SsrfGuard`: block private/loopback/link-local, resolve DNS once, https only), timeout, auth headers, `response_map`, redaction, log to `crm_tool_runs_e`, fire `ai.tool.ran` through the outbox. |
| `native-adapter.ts` | Reads from `crm_engine_contacts_v`; writes enqueue to `crm_outbox` → SaaS API. |
| `custom-adapter.ts` | HTTP execution of custom specs. |
| `llm-tool-loop.ts` | OpenAI streaming with `tools`: detect `tool_calls`, speak filler, execute, second streaming call. Used by **both** `runAskPipeline` (Vodafone, `/ask`) and `exotel-voicebot.ts`. |
| `lead-extractor.ts` | T3 structured-output extraction + push (native outbox / custom webhook enrichment / `call_end` tools). |
| `outbox-worker.ts` | Every 5 s: send pending outbox rows, exponential backoff, max 8 attempts, dead-letter. |

### 8.2 Integration points

- `runAskPipeline`: new optional params `tools`, `onToolCall`, `toolContext`. When the registry returns no tools (CRM not configured), the code path is **byte-identical to today**, so tenants without a CRM see no latency change.
- `vodafone-voicebot.ts handleStart`: start `context-loader` in parallel with the greeting, store on `VodafoneCallState`; on `stop`, enqueue lead extraction.
- `exotel-voicebot.ts`: same three hooks in its start, utterance and stop handlers.
- `answer cache` / `kb_direct`: **bypassed** for any turn in a call that has CRM context or used a tool (§9).

### 8.3 Lead extraction schema (OpenAI structured output, `strict: true`)

```json
{
  "is_lead": true,
  "confidence": 0.82,
  "full_name": "Neha Kapoor",
  "email": null,
  "city": "Pune",
  "language": "hi-IN",
  "need": "2BHK flat near Hinjewadi",
  "budget": "80 lakh",
  "timeline": "within 3 months",
  "callback": { "agreed": true, "when": "2026-11-06T17:00:00+05:30", "reason": "site visit details" },
  "sentiment": "positive",
  "stage_suggestion": "interested",
  "fields": { "loyalty_tier": null, "property_type": "2BHK" },
  "summary": "Caller interested in 2BHK near Hinjewadi, budget 80L, wants a callback tomorrow 5 pm."
}
```

`fields` keys are generated from `crm_settings.lead_capture_fields` per company. Model: `gpt-5-mini`, `reasoning_effort: minimal`, off the call path, so latency doesn't matter here.

### 8.4 Custom CRM webhook enrichment

The existing `call.completed` payload (`CallSync::payload`) gains:

```json
{
  "call": { "...existing...": "..." },
  "contact": { "...existing...": "..." },
  "lead":    { "is_lead": true, "confidence": 0.82, "full_name": "Neha Kapoor", "need": "...", "callback": { "...": "..." } },
  "summary": "Caller interested in 2BHK ...",
  "tools_used": [ { "tool": "Fetch order status", "status": "ok", "latency_ms": 412 } ],
  "transcript": [ "...decrypted, only when include_transcript..." ]
}
```

Because `CallSync` runs every minute while the extraction finishes about 3–10 s after hang-up, `CallSync` reads the extraction through `GET …/calls/:id/lead` (or holds a call for up to 2 minutes until `call_lead_extractions` has a row).

---

## 9. Guardrails

| Risk | Rule |
|---|---|
| Cross-caller data leak through caches | Never write or read the per-tenant answer cache / `kb_direct` shortcut for a turn in a call with CRM context or tool use. Cache keys never include CRM data. |
| Wrong person's data | Lookup only by the **caller's own number** (T1) unless the caller states another number, and even then only for read tools marked `allow_other_phone`. Never read out IDs, full phone numbers or email unless asked. |
| Unwanted writes | Write tools require caller confirmation in the conversation (`requires_confirmation`); T3 writes require `confidence ≥ threshold`; all writes are idempotent per call. |
| SSRF / abuse | Engine-side port of `SsrfGuard` on every execution (not only on save): https only, no private, loopback or link-local ranges, DNS pinned per request, redirects off, response cap 64 KB. |
| Secrets | Plaintext only in transit SaaS→engine; engine stores AES-GCM; never logged (`request_redacted` strips `Authorization` / `X-API-Key` / basic). |
| Latency | Max 2 tool calls per turn; per-tool timeout; filler speech at tool start; T1 parallel to greeting; T3 off the call path; tenants without tools unchanged. |
| Failure | Tool error/timeout → the model gets `{"error":"unavailable"}` and says it will follow up; logged; `ai.tool.ran` webhook with `status=err`. |
| Prompt injection from API responses | Tool output goes in a `tool` message, never into the system prompt; strings capped at 300 characters; the system prompt says tool output is data, not instructions. |
| Consent / DND | Leads from outbound campaign calls inherit the campaign's consent basis; T3 stores the transcript reference, not raw audio. Respect a `do_not_call` field if the company defines one. |
| Cost | One extra LLM call only on tool turns; one extraction per call (about 2–4k tokens). Logged with `openai_cost_usd`. |

---

## 10. Latency budget (voice)

| Turn type | Today | With this plan |
|---|---|---|
| Normal answer, no tool | ~1.3–1.6 s server, ~2.1–2.4 s caller wait | **Same.** Tools are sent to OpenAI only when the tenant has any; tool schemas add about 300–600 prompt tokens (≈ +50–100 ms first token, measured in Phase 2) |
| Turn that calls a tool | n/a | Filler starts at about the first LLM token (~1.0 s); then tool latency (CRM view ~20 ms; custom API typically 200–800 ms) plus a second LLM first token (~0.8 s). The caller hears the filler immediately and the answer about 1.5–2.5 s after it |
| Call start | Greeting at ~0.8–1.5 s | Same; T1 runs in parallel and is ready before the caller's first question in the normal case |
| Call end | n/a | Extraction ~2–5 s **after** hang-up, invisible to the caller |

---

## 11. Phases

| Phase | Scope | Repo | Done when |
|---|---|---|---|
| **0. Prerequisites** | Vodafone call rows (§3.1); decrypted transcript API + SaaS switch (§3.2); AI system user (§3.3); phone last-10 index | both | Vodafone calls show in SaaS call history and CRM timeline; Custom CRM webhook transcript is readable text |
| **1. Caller context (T1, native)** | `crm_engine_contacts_v`; `context-loader`; prompt block; greeting `{{first_name}}` | both | Simulation: known caller → bot uses their name/stage; unknown caller → unchanged latency |
| **2. Lead sensing (T3)** | `lead-extractor`, `crm_outbox`, SaaS `POST /internal/engine/crm/leads`, enriched `call.completed`, lead-capture settings UI | both | Simulated call with name/need/callback → native lead created once (re-run = no duplicate), workflow + `lead.created` fired; custom webhook carries `lead` |
| **3. Custom tools sync + in-call execution (T2)** | `trigger`/`agent_ids`/`filler_text`/`timeout_ms` columns + UI; SaaS → engine `PUT crm-tools`; executor + SSRF; `llm-tool-loop` in `runAskPipeline` | both | Mock customer API: "where is my order" → filler → correct mapped answer; auth header present upstream, absent in logs; timeout path spoken gracefully |
| **4. Native in-call tools** | `crm_lookup_contact`, `crm_get_table_rows`, `crm_save_lead`, `crm_add_note`, `crm_update_stage`, `crm_schedule_callback` | engine (+ SaaS API) | Confirm-before-write enforced; callback appears on the record timeline |
| **5. Exotel parity** | Same hooks in `exotel-voicebot.ts` through the shared module | engine | Exotel simulation passes the Phase 1–4 tests |
| **6. Observability** | `GET tool-runs` → SaaS p18 logs; `ai.tool.ran` webhook; per-call "CRM" panel (context used, tools run, lead written) | both | Every live tool run visible in the SaaS with latency and redacted request |
| **later** | Zoho / Salesforce as a third adapter behind the same `registry`/`executor` interface (after Q3) | both | n/a |

**Suggested order:** 0 → 2 → 1 → 3 → 4 → 5 → 6. Lead sensing (2) delivers value without touching per-turn latency, so it goes before the riskier in-call work.

---

## 12. Testing plan

- **Simulation (extend `speed-sim.ts` / `obd-sim.ts` style):** throwaway customer + SaaS company link + native records + a **mock customer CRM API** (local HTTP server with a `sample_response` shape). Scripted caller audio (Sarvam TTS) for: known caller lookup, order-status tool turn, tool timeout, write with confirmation, lead given at the end of the call, outbound campaign call. Report per-iteration STT / LLM / tool / first-audio timings as in the current speed runs.
- **Unit:** param binding (`caller_phone`/`conversation`/`record_field`/`static`), `response_map` JSON paths, SSRF cases (private IP, DNS rebinding, redirect), redaction, idempotency keys, phone last-10 matching, extraction schema validation.
- **Contract:** SaaS `/internal/engine/crm/*` with HMAC (good, bad, replayed); engine `PUT crm-tools` round trip sets `engine_tool_id`.
- **Regression:** tenants with no CRM / no tools: latency within ±50 ms of today's speed simulation; existing outbound campaign (25 checks) and inbound simulations still pass.
- **Security:** a cached-answer leak test (caller A's order status must never be answered to caller B).

---

## 13. Decisions needed from you

1. **Write path for the native CRM:** through the SaaS internal API (recommended, keeps workflows/webhooks) vs. the engine writing tables directly (faster to build, bypasses SaaS rules).
2. **Secret ownership for custom tools:** move fully to the engine (drop `crm_tools.secret`, verify proxied through the engine), or keep a copy in the SaaS for the "Hit once & verify" button.
3. **Lead creation threshold:** auto-create at confidence ≥ 0.6, or only update existing records and leave new ones as "suggested leads" for a human to approve.
4. **Greeting personalisation:** allowed to say the caller's name in the first sentence (needs T1 within ~800 ms), or only after the caller speaks.
5. **Where the SaaS is hosted relative to the engine** (same server or not): this decides whether the internal API is private-network only and how far reads via the shared DB view are safe.
6. **Data retention:** how long `crm_tool_runs_e` and `call_lead_extractions` keep (redacted) payloads.
