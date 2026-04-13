# Exotel Stream & Voicebot WebSocket — design spec (Convixx)

**Status:** Design-only — iterate here before implementation.  
**Primary reference:** [Working with the Stream and Voicebot Applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet) (Exotel Support).  
**Related internal doc:** [EXOTEL_VOICE_INTEGRATION.md](./EXOTEL_VOICE_INTEGRATION.md) (AgentStream product context, rollout checklist).

This document describes how Convixx will host a **WebSocket endpoint** that **Exotel connects to** for telephony media, how that maps to a **voice call agent** (STT → RAG/agent → TTS), and how **each tenant (customer)** gets **isolated** handling. It also records **latency** considerations for **bidirectional** calls.

**Convixx product decisions (this doc):**

| Decision | Choice |
|----------|--------|
| Applet | **Voicebot** — **bidirectional** voice agent (caller audio in, bot audio out). |
| Tenancy | **One WebSocket endpoint per Convixx tenant** — each `customer_id` has a **dedicated** `wss://` URL (path or host) used in that tenant’s Exotel flow. No shared global WSS URL across tenants for production. |

---

## 1. Connection direction (important)

- Exotel does **not** receive an arbitrary WebSocket opened by your browser app for PSTN. For the **Voicebot** (bidirectional) applet, **Exotel’s platform opens an outbound WebSocket connection** from their side to **your** public `wss://` URL.
- **Your server** accepts that connection and then:
  - **Receives** JSON messages (`connected`, `start`, `media`, `dtmf`, `stop`, `mark` from Exotel).
  - **Sends** JSON messages **to Exotel** on the **same** socket (`media`, `mark`, `clear`) so audio is played to the caller.

So “submitting to Exotel” in product terms means **sending** `media` / `mark` / `clear` **frames on the established WebSocket** per Exotel’s protocol — not opening a separate client socket toward Exotel for media.

---

## 2. Stream applet vs Voicebot applet (from Exotel)

| Applet | Direction | Typical use in Convixx |
|--------|-------------|-------------------------|
| **Stream** | **Unidirectional** — Exotel → your endpoint only | Live transcription, monitoring, coaching (no TTS back on the same stream). Configure **Action** (start/stop), **URL**, **Next applet**. |
| **Voicebot** | **Bidirectional** — Exotel ↔ your endpoint | **Voice call agent**: caller audio in, your bot audio out. This is the primary target for a conversational agent. |

For a **voice agent** that speaks back to the caller, the design baseline is the **Voicebot** applet and a **bidirectional** WebSocket handler on Convixx.

### One WebSocket endpoint per tenant vs one TCP connection per call

These two statements are both true:

1. **Per Convixx tenant:** Register **exactly one** Voicebot **WebSocket URL** for that tenant (e.g. `wss://api.convixx.com/exotel/voicebot/<customer_uuid>` or `wss://<tenant-slug>.voice.convixx.com/media`). That URL is stored in Convixx (see §12.1) and pasted into **that tenant’s** Exotel app/flow. **Other tenants use different URLs** — clean isolation at the edge and in config.

2. **Per phone call (Exotel behaviour):** When a call hits the Voicebot applet, Exotel **opens a new WebSocket connection** to your URL for that stream. **Two concurrent calls** for the same tenant ⇒ **two concurrent WebSocket connections** to the **same tenant endpoint**; the server tells them apart using `stream_sid` / `call_sid` in the `start` message.

Convixx does **not** aim for a single long-lived TCP connection carrying all tenants or all calls; Exotel’s protocol is **one connection per stream**. The **tenant** boundary is **which URL** Exotel is configured to dial for that customer’s numbers — **one such URL per tenant**.

---

## 3. URL configuration: static `wss://` vs HTTPS bootstrap

Exotel allows:

1. **Static:** Configure a fixed `wss://host/path?...` in the applet (same URL for every call on that flow).
2. **Dynamic:** Configure an **HTTPS** URL that returns JSON: `{ "url": "wss://..." }`. Exotel then connects to that WebSocket. Use this for **per-call or per-tenant routing**, signed tokens, or environment-specific hosts.

**Convixx implication:** With **one WSS URL per tenant**, the path (or host) often **embeds or implies `customer_id`**, so the upgrade handler can load **API keys, agents, KB** without extra query params. If you still use **HTTPS bootstrap**, that HTTPS URL can also be **per-tenant** (stored next to the WSS URL). Use bootstrap when you need **signed short-lived tokens** or **dynamic hosts** while keeping the **same tenant routing** story.

---

## 4. Authentication options for WSS (Exotel)

Per Exotel’s article:

- **IP whitelisting** — allow only Exotel egress IPs (contact Exotel for ranges).
- **Basic auth** — URL form `wss://<API_KEY>:<API_TOKEN>@stream.yourdomain.com/...`; Exotel sends `Authorization: Basic base64(API_KEY:API_TOKEN)`.

Convixx should **verify** incoming connections (Basic header and/or token in path/query from HTTPS bootstrap) and **never** rely on secrets in logs.

---

## 5. Sample rate query parameter

Exotel can append e.g. `?sample-rate=8000`, `16000`, or `24000`. **Default is 8 kHz** if omitted.

- **8 kHz** — PSTN-typical, least bandwidth.
- **16 kHz** — Exotel’s **recommended balance** for many voicebot integrations (quality vs bandwidth).
- **24 kHz** — Higher quality / more bandwidth.

**Media format (from Exotel):** Payloads are **raw/slin** — 16-bit PCM, mono, little-endian — **base64** in JSON `media.payload`. Bidirectional: **you send the same format back** for playback.

**Convixx note:** Today’s HTTP demo pipeline `POST /ask/voice` uses **Sarvam** with configurable `speech_sample_rate` (e.g. 24000) and file-based STT/TTS — **not** streaming PCM. The Exotel path will need **resampling** and eventually **streaming** STT/TTS or chunked synthesis aligned to **Exotel’s negotiated rate** (see §10).

---

## 6. Custom parameters (hard limit)

Exotel allows **at most 3** custom query parameters on the WSS URL; **total length of the query parameter string** (the `param1=value1&...` part) **≤ 256 characters**.

**Design impact:**

- You **cannot** encode unlimited tenant metadata in the URL.
- Prefer **HTTPS bootstrap** → return `wss://...?token=<short-signed-jwt>` or `wss://.../sessions/<opaque-id>` where `<opaque-id>` maps server-side to `customer_id` + optional `agent_id`.
- Put **only** what must be visible to Exotel’s config in those three slots (e.g. `t=<tenant-token>` or `c=<customer_uuid>` if length allows).

---

## 7. Chunk sizing (bidirectional)

Per Exotel:

- **Minimum** chunk size **~3.2 KB** (~100 ms of data) — smaller chunks may cause audio issues under jitter.
- **Maximum** **100 KB** — larger may cause timeouts.
- Chunk size should be a **multiple of 320 bytes**. Non-multiples can cause extra delay (e.g. 20 ms wait) and **gaps**.

The Convixx media loop should **buffer outbound PCM** to respect these rules.

---

## 8. WebSocket message protocol (summary)

All messages are **JSON strings** on the WebSocket.

### 8.1 From Exotel (inbound to Convixx)

| Event | Purpose |
|-------|---------|
| `connected` | Sent once after the socket is up. |
| `start` | Once, after `connected`. Carries `stream_sid`, `call_sid`, `account_sid`, `from`, `to`, `custom_parameters`, `media_format` (encoding, sample_rate, bit_rate). |
| `media` | Caller audio chunks: `chunk`, `timestamp`, `payload` (base64 PCM). |
| `dtmf` | Digits pressed (bidirectional / Voicebot). |
| `stop` | Stream/call ended; includes reason. |
| `mark` | (Bidirectional) Acknowledgement that audio you sent has been processed (matches a `mark` you sent). |

### 8.2 To Exotel (Convixx → caller playback)

| Event | Purpose |
|-------|---------|
| `media` | Send synthesized speech chunks (same structure as received). |
| `mark` | Request notification when sent audio has been played (useful for pacing and **barge-in** logic). |
| `clear` | **Clear** audio not yet played (e.g. user interrupted; cancel pending TTS). Prefer **smaller** outbound chunks so `clear` applies predictably. |

Official samples: [exotel/Agent-Stream](https://github.com/exotel/Agent-Stream), [exotel/Agent-Stream-echobot](https://github.com/exotel/Agent-Stream-echobot).

---

## 9. Tenant isolation — one endpoint per tenant, one session per call

**Endpoint level (Convixx):**

- **One bidirectional Voicebot WebSocket URL per tenant** — configure Exotel so numbers/apps for that customer point only at that tenant’s `wss://` (or that tenant’s HTTPS bootstrap). Do not reuse one URL for multiple `customer_id`s in production.

**Connection level (Exotel):**

- **One WebSocket connection per active stream/call** — each call gets its own connection to **that tenant’s** URL. Handler state: one **session object per connection**, keyed by `stream_sid` (and `call_sid`), holding optional `chat_sessions.id`, agent id, and pipeline state.

**Routing:**

- If the URL path includes `customer_id` (UUID) or an immutable tenant slug, **no extra mapping** from DID is required for tenancy (still validate IP / Basic auth / secrets).
- Alternatively, map **called number** → `customer_id` via `customer_exotel_settings.inbound_phone_number` and still accept only on the matching tenant route.

**Summary:** **One WebSocket endpoint per Convixx tenant**; **one concurrent WebSocket connection per active phone call** on that endpoint.

---

## 10. Latency (bidirectional voice agent)

Goals for **low end-to-end response latency**:

| Layer | Tactics |
|-------|---------|
| **Exotel** | Use **16 kHz** if quality/bandwidth tradeoff fits; obey **320-byte multiples** and **minimum chunk size** to avoid gaps and extra waits. |
| **Transport** | TLS termination close to users/Exotel region; keep HTTPS bootstrap fast (minimal DB round-trips; cache tenant config). |
| **STT** | Prefer **streaming** speech-to-text (today `POST /ask/voice` is **batch** WAV → Sarvam — acceptable for demos, **not** optimal for telephony latency). |
| **LLM / RAG** | Shorter answers, **streaming** LLM output to **chunked TTS**, reuse patterns like `voice_fast_llm` / sequential self-hosted first (see `runAskPipeline` in `apps/api/src/routes/ask.ts`). Avoid waiting for full paragraphs before any TTS. |
| **TTS** | Stream or **sentence-chunk** synthesis; send **small** `media` messages for faster first audible byte; use `clear` on interrupt. |
| **Barge-in** | On new caller speech while bot is speaking, send **`clear`** and cancel pending generation. |

Reference timings today are exposed on `POST /ask/voice` as `voice_timings` (multipart, STT, pipeline breakdown, TTS) — useful for regression **after** a streaming path exists.

---

## 11. Mapping to the current Convixx codebase (no implementation yet)

| Area | Current state | Exotel Voicebot integration (planned) |
|------|----------------|----------------------------------------|
| HTTP app | `apps/api/src/app.ts` registers Fastify routes; **no** `@fastify/websocket` (or equivalent) yet. | Add a **WSS** listener path(s) and optional **HTTPS** bootstrap route for `{ "url": "wss://..." }`. |
| Voice / ask | `apps/api/src/routes/ask.ts` — `POST /ask/voice`: multipart audio → Sarvam STT → `runAskPipeline` → Sarvam TTS. | Reuse **agent/KB/session** concepts (`customer_id`, `chat_sessions`, `agents`) but drive from **streaming PCM** instead of one-shot WAV. |
| Voice utilities | `apps/api/src/routes/voice.ts`, demo HTML in `voice-stream-page.ts` / `voice-test-page.ts`. | Demos remain **browser → HTTP API**; Exotel is **separate** entrypoint (PSTN → Exotel → WSS). |
| DB | `infra/postgres/init.sql` — `customers`, `api_keys`, `agents`, `kb_entries`, `chat_sessions`, `chat_messages`. **No** Exotel tables in init yet. | Add tenant Exotel profile + call/session tables (SQL below). |
| Docs | [EXOTEL_VOICE_INTEGRATION.md](./EXOTEL_VOICE_INTEGRATION.md) | This file adds **Stream/Voicebot protocol** detail, **per-tenant WSS URL**, and **per-call** connections. |

---

## 12. PostgreSQL — suggested additive schema (PostgreSQL)

Run **after** `customers` exists (see `infra/postgres/init.sql`). Aligns with [EXOTEL_VOICE_INTEGRATION.md](./EXOTEL_VOICE_INTEGRATION.md) §10; extended slightly for stream/session traceability.

### 12.1 Per-customer Exotel settings (tenant credentials & numbers)

```sql
-- One profile per Convixx customer (tenant)
CREATE TABLE IF NOT EXISTS customer_exotel_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,

  exotel_account_sid TEXT,
  exotel_app_id TEXT,
  exotel_subdomain TEXT,

  exotel_api_key TEXT,
  exotel_api_token TEXT,

  inbound_phone_number TEXT,
  default_outbound_caller_id TEXT,

  webhook_secret TEXT,

  -- Voicebot (bidirectional): canonical WSS URL for this tenant — one per customer.
  -- Exotel flow for this tenant's numbers should reference this URL (or tenant-scoped HTTPS bootstrap).
  voicebot_wss_url TEXT,
  voicebot_bootstrap_https_url TEXT,

  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  use_sandbox BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exotel_inbound_number
  ON customer_exotel_settings (inbound_phone_number)
  WHERE inbound_phone_number IS NOT NULL;

COMMENT ON TABLE customer_exotel_settings IS 'Per-tenant Exotel credentials and numbers — multi-tenancy enforced in Convixx';
```

### 12.2 Call / stream sessions (one row per call or per stream lifecycle)

```sql
CREATE TABLE IF NOT EXISTS exotel_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exotel_call_sid TEXT,
  exotel_stream_sid TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT,
  to_number TEXT,
  status TEXT,
  chat_session_id UUID REFERENCES chat_sessions(id) ON DELETE SET NULL,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_exotel_sessions_customer
  ON exotel_call_sessions (customer_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_exotel_sessions_stream
  ON exotel_call_sessions (exotel_stream_sid)
  WHERE exotel_stream_sid IS NOT NULL;
```

### 12.3 Optional — short-lived tokens for HTTPS → WSS bootstrap

If the HTTPS URL returns a signed WSS URL, persist **opaque tokens** only if you need revocation, audit, or multi-instance lookup (otherwise **stateless JWT** in the URL may suffice).

```sql
CREATE TABLE IF NOT EXISTS exotel_wss_bootstrap_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exotel_bootstrap_expires
  ON exotel_wss_bootstrap_tokens (expires_at)
  WHERE used_at IS NULL;
```

**Security:** Store **hashes** of tokens, not raw secrets, if you store them at all.

---

## 13. Open design choices (to confirm before coding)

1. ~~**Single shared WSS path vs per-tenant path**~~ — **Decided:** **per-tenant** Voicebot URL (`voicebot_wss_url`); see the subsection under §2 and §9.
2. **HTTPS bootstrap** — mandatory vs optional per tenant; where to validate Exotel IP vs Basic auth vs signed token.
3. **Streaming STT/TTS** vendor support (Sarvam streaming APIs vs alternatives) vs chunked batch calls.
4. **16 vs 24 kHz** end-to-end — match Exotel applet setting to Sarvam resampling path to minimize CPU and latency.

---

## 14. End-to-end roadmap — full working model (Exotel + Convixx coding)

Use this as the **ordered checklist** from empty repo state to **production-ready** Voicebot traffic. Skip steps already done in your environment.

### Phase A — Exotel account and telephony (no Convixx code)

1. **Enable Voicebot** (and Stream if needed) in your Exotel account — applets may require Exotel support if not visible ([article](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet)).
2. **Provision a number** (or use trial) and note **account SID**, **API key/token**, **subdomain** / regional base URLs for REST APIs.
3. **Whitelist or plan auth** for your WSS: request **Exotel egress IP ranges** if using IP allowlisting, or plan **Basic auth** on the WSS URL per Exotel docs.
4. In **App Bazaar / call flow**, build a flow that reaches the **Voicebot** applet with:
   - **Bidirectional** streaming,
   - **URL** = your final `wss://…` (per tenant) **or** HTTPS bootstrap that returns `{ "url": "wss://…" }`,
   - **Sample rate** (e.g. `?sample-rate=16000`) aligned with your pipeline,
   - **Custom parameters** only if needed (max 3, 256 chars total),
   - **Next applet** after Voicebot as required (e.g. hangup, passthru for recording URL if “Record” is enabled).
5. **Test from Exotel side** with their **simulator or test number** once your endpoint exists (Phase C).

### Phase B — Database and tenant configuration (coding + SQL)

1. **Apply migrations** in PostgreSQL: `customer_exotel_settings` (including `voicebot_wss_url`, `voicebot_bootstrap_https_url`), `exotel_call_sessions`, optional `exotel_wss_bootstrap_tokens` (§12).
2. **Add repository / DAO layer** in the API app to read/write these tables (match existing patterns for `customers`, `api_keys`).
3. **Admin or seed path**: for each Convixx tenant, insert **Exotel credentials**, **inbound DID → customer_id**, and the **canonical `voicebot_wss_url`** that will be pasted into Exotel (or returned by bootstrap).
4. **Store secrets safely** — encrypt `exotel_api_key` / `exotel_api_token` at rest or use a secrets manager; never log them.

### Phase C — Public HTTPS/WSS and Fastify WebSocket server (coding)

1. **DNS + TLS**: certificate for the API host that will serve `wss://` (same or different subdomain per tenant policy).
2. **Expose WebSocket in Fastify** — register `@fastify/websocket` (or equivalent) in `apps/api/src/app.ts` (or a dedicated plugin).
3. **Per-tenant route** — e.g. `GET wss://api…/exotel/voicebot/:customerId` (validate `customerId` UUID against DB and `customer_exotel_settings.is_enabled`).
4. **HTTPS bootstrap route** (if used) — e.g. `GET https://…/exotel/voicebot/bootstrap/:customerId` returning `{ "url": "wss://…" }` with auth (signed query, Basic, or mTLS as designed).
5. **Health** — ensure load balancers support **WebSocket upgrade** (sticky sessions optional; state is in-memory per connection or Redis if you scale out later).
6. **Local/dev**: **ngrok** (or similar) with **HTTPS** to test Exotel → your machine; update Exotel URL when tunnel changes.

### Phase D — Exotel protocol handler (coding)

1. **Parse JSON** text frames; handle **order**: `connected` → `start` → many `media` / `dtmf` → `stop`.
2. **On `start`**: read `stream_sid`, `call_sid`, `from`, `to`, `media_format` (sample rate, encoding); create an **in-memory session** keyed by `stream_sid`; insert **`exotel_call_sessions`** row; optionally create **`chat_sessions`** for this call and link `chat_session_id`.
3. **On `media`**: base64-decode **slin PCM**; buffer for STT / VAD according to §7 chunk rules (multiples of 320 bytes outbound).
4. **On `dtmf`**: route to agent logic if product requires keypad input.
5. **On `stop`**: close session, update `exotel_call_sessions.ended_at`, flush metrics.
6. **Outbound to Exotel**: build `media` messages with **base64 PCM** at negotiated rate; implement **`mark`** if you need playback-aligned logic; implement **`clear`** for barge-in.
7. **Error handling**: malformed JSON, unexpected order — log and close socket cleanly.

### Phase E — Voice agent pipeline (coding — core product)

1. **PCM ↔ sample rate**: resample if Exotel sends 8/16/24 kHz and Sarvam (or STT) expects a different rate; keep one **clear** sample-rate policy per tenant.
2. **Replace batch `/ask/voice` with a streaming path** for telephony (recommended):
   - **Streaming or chunked STT** from inbound PCM (not only full WAV upload).
   - **VAD / end-of-utterance** to know when to call **`runAskPipeline`** (or streaming LLM) — reuse `apps/api/src/routes/ask.ts` concepts: `customer_id`, `agents`, `kb_entries`, `chat_sessions`, `voice_fast_llm`-style latency flags where applicable.
   - **Chunked TTS**: synthesize sentence-sized (or smaller) segments and emit **`media`** frames quickly; use **`clear`** when user interrupts.
3. **Session continuity**: map `stream_sid` / `call_sid` → `chat_sessions.id` so multi-turn dialogue works like `/ask` + `session_id`.
4. **Failure modes**: STT empty, LLM error, TTS failure — optionally play a short canned PCM or TTS error phrase via `media`.
5. **Observability**: structured logs with `stream_sid`, `customer_id`, timings (mirror `voice_timings` fields where useful).

### Phase F — Security and compliance (coding + ops)

1. **Verify** every WSS connection: Basic auth header vs `customer_exotel_settings`, and/or signed token in path/query from bootstrap.
2. **Rate limit** bootstrap HTTPS if public.
3. **Restrict** CORS not applicable to WSS; focus on **auth** and **tenant ID** in path matching DB.
4. **Recording**: if Exotel **Record** is on, handle **passthru** / recording URL in downstream applets per Exotel docs (separate HTTP handler if needed).

### Phase G — Testing checklist

1. **Unit tests**: JSON frame parsing, PCM chunk buffer respecting 320-byte rule, resampling helpers.
2. **Integration**: mock Exotel message sequences (`connected` → `start` → `media` × N → `stop`).
3. **Staging**: real Exotel → staging `wss://`; one test tenant; inbound call; verify DB rows and audio both ways.
4. **Load**: multiple concurrent calls to **same** tenant URL (multiple sockets); ensure no cross-talk between `stream_sid`s.

### Phase H — Production go-live

1. **Runbook**: rotate Exotel keys, update `voicebot_wss_url`, rollback flow.
2. **Monitoring**: alert on WSS connection failures, spike in `stop` with error reasons, STT/TTS latency percentiles.
3. **Documentation**: for each tenant, document **Exotel flow ID**, **DID**, and **exact Voicebot URL** configured.

---

## 15. Summary

- Exotel **opens** the WebSocket to **your** `wss://` endpoint; **you send** `media` / `mark` / `clear` **to Exotel** on that socket for playback.
- Use the **Voicebot** applet for a **bidirectional** voice agent; understand **chunk** and **custom parameter** limits from [Exotel’s article](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet).
- **Per Convixx tenant:** **one dedicated Voicebot WebSocket URL** (stored in **`voicebot_wss_url`**, optional **`voicebot_bootstrap_https_url`**). **Per active call:** **one WebSocket connection** to that tenant’s URL, distinguished by **`stream_sid` / `call_sid`**.
- **Low latency** requires **streaming** pipelines and **chunked** playback, not the current **batch** `POST /ask/voice` shape alone.
- **Implementation order:** follow **§14** (Exotel setup → DB → WSS server → protocol → agent pipeline → security → tests → go-live).
