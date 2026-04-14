# Exotel voice integration — planning guide

This document describes how Convixx connects to [Exotel](https://exotel.com/) for **inbound** and **outbound** calling with real-time audio into your stack (STT → LLM/agent → TTS). It is **planning and design only** — no application code here.

**Replaces:** earlier draft titled around StreamKit only; content below reflects **product choice** and **where multi-tenancy lives**.

---

## Product decision: AgentStream (primary) — not StreamKit as the core

| Product | Role in our architecture |
|---------|---------------------------|
| **[AgentStream](https://exotel.com/products/agentstream-voice-streaming/) (voice streaming)** | **Use this** as the **primary** Exotel surface for PSTN + **real-time bidirectional voice streaming** to a WebSocket endpoint you host. Matches “your bot, our number,” inbound/outbound, and PCM/WebSocket audio to an external AI pipeline. |
| **StreamKit** | **Do not treat as the core integration name** for v1. Exotel positions StreamKit separately (“Voice meets AI”); it may appear as SDK, applet, or companion tooling. **Revisit StreamKit** only if Exotel’s developer docs require it for a specific capability (e.g. a mandatory SDK) that AgentStream APIs alone do not expose. **Implementation workstreams should refer to AgentStream + official Voice/API docs**, not “StreamKit” by default. |

**Recorded decision:** Convixx standardizes on **AgentStream** for the telephony + streaming contract. **StreamKit** is optional later, per Exotel documentation—not a parallel first-class fork in our design doc.

---

## Official documentation & sample code (AgentStream)

Use these as the **source of truth** for applet names, WebSocket URL shape, and APIs. Convixx will implement equivalent behaviour in Node.js; the Python sample is **reference only**.

### Exotel Support — AgentStream solution folder

**[AgentStream — Exotel Support Center](https://support.exotel.com/support/solutions/folders/3000023566)** (folder index)

Articles there include (titles may be updated by Exotel):

| Topic (typical) | Why it matters for Convixx |
|-----------------|----------------------------|
| Quick guide to streaming (Voicebot / Stream applet) | End-to-end enablement in dashboard. |
| Stream vs Voicebot applet — unidirectional vs bidirectional | Choose **bidirectional** for talk-and-listen bot flows. |
| Passthru applet (beta) | Sends call/metadata to your server from flows. |
| Legs APIs — start bot stream, optional greeting | Outbound / leg control and lower perceived latency. |
| Integration guides (e.g. LiveKit, ElevenLabs SIP) | Optional patterns; not required for a minimal Convixx+AgentStream stack. |

**Implementation:** Read these before locking WebSocket message formats and HTTP callbacks.

### GitHub sample — `exotel/Agent-Stream`

**[github.com/exotel/Agent-Stream](https://github.com/exotel/Agent-Stream)** — official sample **Python** bot: WebSocket server bridging Exotel streaming to an AI engine (example uses OpenAI Realtime-style usage).

| Takeaway | Detail |
|----------|--------|
| **WebSocket URL** | Exotel Voicebot applet points at your public `wss://` URL (e.g. `wss://convixx.in/exotel/voicebot/<customer-uuid>?sample-rate=24000`). |
| **Audio** | Raw/slin PCM, **24 kHz** recommended in sample; chunk/buffer sizing in repo (`AUDIO_CHUNK_SIZE`, etc.). |
| **Bidirectional** | Enable in applet when you need duplex streaming. |
| **Local dev** | Tunnel (ngrok) to expose `wss://` — same requirement for Convixx dev/staging. |

Convixx production: replace the sample’s Python stack with your **Fastify/WebSocket** service and your **Sarvam + LLM** pipeline; keep the **same Exotel-side applet configuration** concepts.

---

## Who owns “multi-vendor” — Convixx, not Exotel

- **Exotel does not** implement your SaaS multi-tenancy. Each Exotel **account / app / number** is configured in Exotel’s dashboard; that is **their** product boundary.
- **Convixx owns** tenant isolation: which **end-customer** (`customer_id`) owns which credentials, numbers, and routing logic. You map **DID / metadata / API key** → `customer_id` **in your database and application layer**.
- Exotel sees **your** WebSocket URLs and webhooks; you decide whether each tenant gets a **dedicated Exotel account**, a **dedicated number + applet**, or a **path/query token** on a shared infrastructure—still **your** policy, stored in `customer_exotel_settings` (see SQL below).

---

## 1. Goals

- **Inbound:** Caller dials a number → Exotel (AgentStream) → stream to Convixx → agent/KB/LLM → audio back.
- **Outbound:** Convixx initiates call via Exotel APIs → same streaming pipeline after connect.
- **Audio pipeline:** Align with Sarvam (or other STT/TTS) around the streamed PCM where applicable.

---

## 2. Bigger picture architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Exotel (per tenant config you store: accounts, numbers, secrets)        │
│  PSTN / virtual numbers ──► AgentStream app / applet ──► your HTTPS/WSS   │
└─────────────────────────────────────────────────────────────────────────┘
                                      │
                    Webhooks & streams hit YOUR public URLs
                    (must be HTTPS / WSS in production)
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  Convixx (multi-tenant — all logic here)                                 │
│  • Resolve customer_id from called number / signed token / internal API   │
│  • Load tenant Exotel row from DB                                       │
│  • Inbound: stream → STT → LLM/agent → TTS → stream back                 │
│  • Outbound: Exotel originate using that tenant’s credentials          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Principles**

1. **Tenant isolation in Convixx:** Credentials and number→customer mapping live in **our** DB; Exotel is a **downstream** provider.
2. **Single source of truth:** `customers.id` links tenant data (`api_keys`, `agents`, `kb_entries`, `customer_exotel_settings`).
3. **Secrets:** Encrypt at rest or use a secrets manager; never log raw tokens.
4. **Contracts first:** Lock webhook payloads and stream framing from **AgentStream / Voice API** docs before building.

---

## 3. What to clarify with Exotel (AgentStream / Voice API docs)

- Authentication (API key, token, subdomain, etc.).
- How an **inbound** call attaches to your **WebSocket URL** (voicebot applet flow).
- **Outbound** originate API and when the media stream starts.
- **PCM format** (e.g. 16 kHz default, 24 kHz options) and frame sizes.
- Regional base URLs and sandbox vs production.

Map generic DB fields below to these docs when implementing.

---

## 4. Per-customer configuration (Convixx side)

Each **customer** can have **one** Exotel profile row (`UNIQUE(customer_id)`) to start.

| Category | Examples |
|----------|----------|
| Identity | Account / app / subdomain identifiers Exotel gives you |
| API access | Key, token (encrypted in DB or vault) |
| Numbers | Inbound DID; default outbound CLI |
| Webhook security | Shared secret for signed callbacks |
| Flags | `is_enabled`, sandbox |

---

## 5. Inbound calling — logical steps

1. Tenant obtains number and AgentStream / applet config in Exotel (their process).
2. Tenant (or you) saves credentials in Convixx → `customer_id` row.
3. Exotel points traffic to **your** webhook / **your** WebSocket URL (possibly **one URL with tenant id in path** if you consolidate infrastructure).
4. On call: resolve `customer_id` → load settings + agent/KB → run pipeline.
5. Log sessions in `exotel_call_sessions` when you add it.

---

## 6. Outbound calling — logical steps

1. Authenticated request in context of a **customer** (e.g. `x-api-key`).
2. Load that customer’s Exotel credentials from DB.
3. Call Exotel **outbound** API per AgentStream/Voice docs.
4. Attach same media pipeline when stream is up.
5. Map errors to your API.

---

## 7. Integration touchpoints with Convixx (implementation phase)

| Area | Role |
|------|------|
| `customers` | Tenant root |
| `api_keys` | Identify customer on APIs |
| `agents` / `kb_entries` | Conversation brain after STT |
| Voice (e.g. Sarvam) | STT/TTS around streamed audio |
| `customer_exotel_settings` | Per-tenant Exotel credentials |

---

## 8. Security and operations

- HTTPS/WSS for public endpoints; verify webhooks.
- Rate limits and idempotency for Exotel retries.
- Key rotation and audit (optional).

---

## 9. Phased rollout checklist (no code)

| Phase | Actions |
|-------|---------|
| **Discovery** | [Exotel Support AgentStream folder](https://support.exotel.com/support/solutions/folders/3000023566) + [exotel/Agent-Stream](https://github.com/exotel/Agent-Stream); list env vars and URLs. |
| **DB** | Apply SQL below; adjust names to match Exotel fields. |
| **Contracts** | Webhook + stream message shapes documented. |
| **Network** | DNS, TLS, firewall for callback host. |
| **Sandbox** | One Exotel sandbox + one Convixx test customer; inbound + outbound. |
| **Production** | Onboarding runbook per tenant; monitoring. |

**StreamKit follow-up:** Only add a phase if Exotel mandates StreamKit SDK for a feature AgentStream docs do not cover.

---

## 10. SQL — per-customer Exotel settings

Same relational intent as before: **one row per customer**, Exotel-specific fields filled from **AgentStream / Voice API** onboarding.

```sql
-- ============================================================
-- Exotel integration (one profile per Convixx customer)
-- Run after customers table exists. Align column names with Exotel AgentStream / Voice API.
-- ============================================================

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

  is_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  use_sandbox BOOLEAN NOT NULL DEFAULT FALSE,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exotel_inbound_number
  ON customer_exotel_settings (inbound_phone_number)
  WHERE inbound_phone_number IS NOT NULL;

COMMENT ON TABLE customer_exotel_settings IS 'Per-tenant Exotel (AgentStream) credentials and numbers — multi-tenancy enforced in Convixx';
```

**Optional — call sessions**

```sql
CREATE TABLE IF NOT EXISTS exotel_call_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  exotel_call_sid TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  from_number TEXT,
  to_number TEXT,
  status TEXT,
  started_at TIMESTAMP DEFAULT NOW(),
  ended_at TIMESTAMP,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_exotel_sessions_customer
  ON exotel_call_sessions (customer_id, started_at DESC);
```

---

## 11. Summary

- **Multi-tenant / multi-vendor semantics:** Owned by **Convixx** (DB + routing). Exotel provides **telephony + AgentStream streaming**; it does not model your end-customers.
- **Product:** **AgentStream** is the **chosen** primary integration; **StreamKit** only if docs or a hard requirement demand it later.
- **Inbound / outbound:** Same Convixx pipeline; credentials per `customer_id`.

Implement only after AgentStream webhook and stream contracts are fixed against Exotel’s current documentation.
