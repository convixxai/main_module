# Convixx Backend — Deep Security Audit Report

**Repository:** `Convixx/nodejs_main`
**Scope:** `apps/api` (Fastify + TypeScript Node.js backend)
**Audit date:** 2026-04-18
**Audit type:** Static source review, dependency audit, configuration review, architecture review
**Auditor deliverable:** Findings + severity + affected code + recommendation (no code changes applied — review-only engagement).

---

## 1. Executive Summary

The Convixx API is a multi-tenant RAG platform that integrates PostgreSQL + pgvector, a self-hosted LLM, OpenAI, Sarvam STT/TTS and Exotel Voicebot over WebSocket. Overall code quality is reasonable (parameterised SQL, Zod validation, per-tenant scoping of most queries, symmetric encryption of chat content).

However, the current security posture has several **critical** gaps that should be remediated before any real production rollout or penetration test:

| # | Severity  | Issue                                                                           |
|---|-----------|---------------------------------------------------------------------------------|
| 1 | CRITICAL  | Secrets (DB password, admin token, encryption key, OpenAI key, LLM key, Sarvam key) stored in plaintext `.env` on disk; second file `check_schema.js` hardcodes prod DB credentials |
| 2 | CRITICAL  | Exotel Voicebot WebSocket (`/exotel/voicebot/:customerId`) has **no authentication** — anyone with the tenant UUID can open a call, drive STT/LLM/TTS billing and inject audio |
| 3 | CRITICAL  | Exotel Voicebot bootstrap endpoint (`/exotel/voicebot/bootstrap/:customerId`) is unauthenticated and usable for tenant enumeration |
| 4 | HIGH      | `cors({ origin: true })` reflects any origin (full allow); combined with Swagger UI served publicly and no `@fastify/helmet`, the API has no baseline web security headers |
| 5 | HIGH      | No rate limiting anywhere (`/ask`, `/kb/upload`, `/customers/:id/api-key`, admin login brute force, Sarvam STT/TTS abuse) |
| 6 | HIGH      | 6 vulnerable dependencies including Fastify `<=5.8.4` (body-schema bypass, X-Forwarded spoofing), minimatch (ReDoS), picomatch (ReDoS), `@fastify/static` (path traversal), brace-expansion, yaml |
| 7 | HIGH      | API keys stored in plaintext in `api_keys.key`; a DB dump compromises every tenant key immediately |
| 8 | HIGH      | Admin authentication is a single shared static token, compared with non-timing-safe `!==`, with no rotation, no audit trail, no MFA, no per-admin identity |
| 9 | MEDIUM    | IDOR in `resolveAgentFromSession` — `chat_sessions.id` lookup is not filtered by `customer_id`; a tenant can read another tenant's agent `system_prompt` by supplying their session UUID |
|10 | MEDIUM    | Sensitive data written to disk logs unencrypted: STT transcripts, LLM full payloads, KB Q/A, full chat messages (`voicebotTrace`, `ragTrace`). The same logs are downloadable via `/admin/logs/*` |
|11 | MEDIUM    | `DELETE /admin/logs/:date` allows deletion of audit logs with no confirmation, no tamper-evidence |
|12 | MEDIUM    | `openai_usage.question` is stored in plaintext, bypassing the AES-256-GCM protection used for `chat_messages.content` |
|13 | MEDIUM    | No `trustProxy` / `trust_proxy` configured on Fastify — `request.ip`, `request.hostname` and `request.protocol` are spoofable via `X-Forwarded-*` headers (directly related to Fastify CVE above) |
|14 | MEDIUM    | No bodyLimit / connection cap — `/kb/upload` accepts arbitrary JSON; Exotel WS accepts 5 MB per-call audio with no total concurrent-call cap |
|15 | MEDIUM    | Unauthenticated HTML pages `/voice/test-ui`, `/voice/stream` allow third parties to drive STT/TTS via user-supplied API key (phishing/XS-leak vector) |
|16 | MEDIUM    | Swagger `/docs` exposed publicly; discloses the entire API surface and admin routes |
|17 | MEDIUM    | `initialization vector` length is 16 instead of the NIST-recommended 12 for AES-GCM (functional but non-standard) |
|18 | LOW       | Prompt injection surface — user input concatenated verbatim into the LLM system prompt; `ANSWER_NOT_FOUND` guardrail easily bypassable |
|19 | LOW       | `api_keys.key` comparison performs exact-match SQL lookup; combined with plaintext storage, a side-channel timing leak is theoretically observable |
|20 | LOW       | `LOG_DB_QUERIES=true` captures SQL text (2000 chars) including query params indirectly; currently enabled in `.env` |
|21 | LOW       | Self-hosted LLM endpoint (`LLM_BASE_URL`) and any outbound host come from env with no allow-list → SSRF risk if env is attacker-controlled in future |
|22 | LOW       | `/health/llm` and `/health/embedding` require no auth and trigger real upstream LLM calls — cheap DoS / cost-abuse |
|23 | LOW       | Error responses include raw upstream messages (`err.message` from Sarvam, OpenAI, pg) — potential info disclosure |
|24 | LOW       | Voicebot greeting / error text, TTS config fetched from DB and used directly — no output encoding (currently low risk since it only reaches TTS, not HTML) |
|25 | INFO      | No structured audit log of admin actions (customer created, API key generated, Exotel settings changed) |
|26 | INFO      | No automated SAST / dependency scanning in CI; no `SECURITY.md`; no documented disclosure channel |

---

## 2. Methodology

The following was performed against the repository state:

1. Static review of all TypeScript source under `apps/api/src/**` (routes, middleware, services, plugins, config).
2. Configuration review — `.env`, `package.json`, `ecosystem.config.cjs`, `tsconfig.json`, `.gitignore`.
3. Dependency audit — `npm audit` in `apps/api`.
4. Cross-checks against OWASP API Security Top 10 (2023) and OWASP Top 10 (2021).
5. Threat modelling of the multi-tenant + Voicebot architecture.
6. No dynamic testing / exploit execution — this was a read-only review.

---

## 3. Findings in Detail

### 3.1 CRITICAL — Secrets on disk and in repo

**Affected files:** `apps/api/.env`, `apps/api/check_schema.js`

`apps/api/.env` holds the live values used by the server at runtime:

```
ADMIN_TOKEN=convixx_admin_22c04440afb420c33aed2ae0e976fba55dd0074be9184295
PG_HOST=20.219.26.128
PG_PASS="P@ssw0rd#2026"
LLM_API_KEY=849f49126fb69331fe5bd0326f171560757db80ea86de567ca4dcc060432499d
OPENAI_API_KEY=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
ENCRYPTION_KEY=b0b8d649faca5a3970cba2cc7c6e2315f9088cd925ce5f6b9a107633948ba5e4
SARVAM_API_KEY=sk_r7a9gfek_IGD9fXbkkfNKiiCSpJ2i146r
```

`.env` is ignored by `.gitignore`, but it is still present on every developer machine, every backup, every log stream and every deployment image. `git log --all -- apps/api/.env` confirms it has not been committed — but there is no rotation plan.

Additionally `apps/api/check_schema.js` is **committed to the repo** and hardcodes the production DB host, user and password. This file is trivially grep-able in the repo and in build artefacts.

**Impact:**
- Full control of the database (`convixx_kb`), including `chat_messages` ciphertexts, API keys table, customers.
- ENCRYPTION_KEY + DB access = full plaintext chat_messages.
- OpenAI key allows arbitrary spend on Convixx's billing.
- Admin token grants full access to customers, agents, Exotel settings and log files.

**Recommendations:**
- Treat all values above as **already compromised** — rotate every single one (DB password, admin token, encryption key rotation with dual-read migration, OpenAI key, LLM key, Sarvam key) before the next deployment.
- Delete `check_schema.js` or move it to a `/tools/` folder that reads from `.env`.
- Move secrets to a secret store (AWS SSM Parameter Store / Secrets Manager, HashiCorp Vault, GCP Secret Manager, or Docker secret). Do not rely on `.env` on disk in production.
- Add a `pre-commit` hook using `gitleaks` / `trufflehog` to block future secret leaks.
- Verify backups, CI logs and PM2 logs do not contain these values.

---

### 3.2 CRITICAL — Unauthenticated Exotel Voicebot WebSocket

**Affected file:** `apps/api/src/routes/exotel-voicebot.ts`

```998:1030:apps/api/src/routes/exotel-voicebot.ts
  app.get<{ Params: { customerId: string } }>(
    "/exotel/voicebot/:customerId",
    { websocket: true },
    async (socket: WebSocket, request) => {
      const { customerId } = request.params;
      // ... only validates UUID format and `is_enabled`
      if (!settings || !settings.is_enabled) {
        // ...
      }
```

The only gate is:

1. `customerId` is a UUID
2. The tenant has `customer_exotel_settings.is_enabled = TRUE`

There is **no signature verification, no shared secret, no Exotel IP allow-list, no HMAC of the `start` frame**. Although the DB has a `webhook_secret` column, the settings route explicitly sets it to `NULL` on every PUT:

```108:110:apps/api/src/routes/exotel-settings.ts
           webhook_secret = NULL,
           voicebot_wss_url = NULL,
           voicebot_bootstrap_https_url = NULL,
```

**Impact:**
- An attacker who knows a tenant UUID (leaked from customer list, JWT, logs, referrer, or brute-forced since the tenants in the system are few and UUIDv4 enumeration is impractical — but UUID is commonly leaked) can:
  - Open a WS, send a forged `start` frame, and spoof `call_sid`, `stream_sid`, `from`, `to`, and `account_sid`.
  - Inject arbitrary audio frames which the server transcribes via Sarvam (billing attack) and submits to OpenAI (billing attack).
  - Force the server to persist fake chat and call session rows under the tenant's `chat_sessions` / `exotel_call_sessions` tables.
  - Use the agent's `system_prompt` as a prompt-injection oracle (the responses get `speakToExotel`'d back to the attacker's WS).
  - Exfiltrate the tenant's KB content by crafting probing utterances.

**Recommendations:**
- Reintroduce the `webhook_secret` concept: on PUT, generate a per-tenant 32-byte random secret and return it (or set it via dedicated endpoint). Require Exotel to authenticate by either:
  - HMAC-signed short-lived token embedded in the WSS URL (`?token=...`), verified against `webhook_secret`, OR
  - IP allow-list of the Exotel subdomain(s) configured in settings, OR
  - Mutual TLS (Exotel supports this).
- Close the WS with code `4401` on missing/invalid token.
- Validate that `start.account_sid` matches `customer_exotel_settings.exotel_account_sid` and reject otherwise.
- Same reasoning applies to `/exotel/voicebot/bootstrap/:customerId` — require the admin token or a shared HMAC before disclosing `wss://` URLs.

---

### 3.3 HIGH — Global CORS + missing security headers

**Affected file:** `apps/api/src/app.ts`

```29:29:apps/api/src/app.ts
  await app.register(cors, { origin: true }); // Allow all origins (required for Swagger UI Try it out)
```

`origin: true` echoes the request's `Origin` header in `Access-Control-Allow-Origin`. Any browser tab on any origin can call the API (subject to SOP for `x-admin-token`/`x-api-key` which are custom headers, so preflight is required — but preflight is granted). Combined with:

- No `@fastify/helmet` (no `Strict-Transport-Security`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`).
- `/docs`, `/voice/test-ui`, `/voice/stream` served as HTML from the same origin.

**Recommendations:**
- Set `origin` to an explicit allow-list (e.g. `['https://convixx.in', 'https://admin.convixx.in']`) and only allow `*` when ADMIN_TOKEN and API keys are **not** cookies.
- Register `@fastify/helmet` with sensible defaults including HSTS and a CSP for the Swagger HTML.
- Move Swagger `/docs` behind `adminAuth` OR require Basic Auth in front of it (common pattern).

---

### 3.4 HIGH — No rate limiting / abuse protection

There is no `@fastify/rate-limit` plugin registered (verified via `package.json` + full-tree grep). Endpoints that should be rate-limited:

| Endpoint                                            | Abuse                                        |
|-----------------------------------------------------|----------------------------------------------|
| `POST /ask`, `POST /ask/voice`                      | OpenAI + Sarvam cost; embedding cost         |
| `POST /kb/upload`                                   | Embeddings cost, storage abuse               |
| `POST /customers`, `POST /customers/:id/api-key`    | Admin token brute force                      |
| `GET /health/llm`, `/health/embedding`              | LLM cost abuse                               |
| `POST /voice/speech-to-text`, `/text-to-speech`     | Sarvam cost                                  |
| `WS /exotel/voicebot/:customerId`                   | Per-tenant concurrent-call cap missing       |

**Recommendations:**
- Global default: `@fastify/rate-limit` at ~100 req/min/IP.
- Stricter per-IP throttle on admin routes (10 req/min).
- Per-tenant monthly caps on OpenAI cost / Sarvam minutes, enforced in code.
- WS: cap active concurrent sessions per tenant in `voicebot-session.ts` (e.g. reject new `start` when `getActiveSessionsForCustomer(customerId).length >= N`).

---

### 3.5 HIGH — Vulnerable dependencies

`npm audit` (run 2026-04-18 in `apps/api`):

| Package            | Severity  | Advisory                                                                       |
|--------------------|-----------|--------------------------------------------------------------------------------|
| `fastify <=5.8.4`  | HIGH      | GHSA-573f-x89g-hqp9 (content-type regex bypass), GHSA-444r-cwp2-x5xf (`request.protocol`/`request.host` spoof via `X-Forwarded-*`), GHSA-247c-9743-5963 (body-schema bypass via leading space) |
| `minimatch`        | HIGH      | GHSA-7r86-cg39-jmmj, GHSA-23c5-xmqv-rm74 (ReDoS)                               |
| `picomatch <=2.3.1`| HIGH      | GHSA-3v7f-55p6-f55p (method injection), GHSA-c2c7-rcm5-vvqj (ReDoS)            |
| `@fastify/static`  | MODERATE  | GHSA-pr96-94w5-mx2h (path traversal), GHSA-x428-ghpx-8j92 (encoded `/` bypass) |
| `brace-expansion`  | MODERATE  | GHSA-f886-m6hf-6m8v (DoS)                                                      |
| `yaml 2.0–2.8.2`   | MODERATE  | GHSA-48c2-rrv3-qjmp (stack overflow)                                           |

All are auto-fixable with `npm audit fix`. The Fastify advisories in particular are directly exploitable given no `trustProxy` setting (see 3.13).

---

### 3.6 HIGH — API keys stored in plaintext

**Affected:** `apps/api/src/routes/customers.ts:137-144`, `apps/api/src/middleware/auth.ts:22-28`

```137:144:apps/api/src/routes/customers.ts
      const key = "cvx_" + crypto.randomBytes(32).toString("hex");

      const result = await pool.query(
        `INSERT INTO api_keys (customer_id, key)
         VALUES ($1, $2)
         RETURNING id, key, created_at`,
        [id, key]
      );
```

```22:28:apps/api/src/middleware/auth.ts
  const result = await pool.query(
    `SELECT ak.customer_id, c.system_prompt, c.rag_use_openai_only
     FROM api_keys ak
     JOIN customers c ON c.id = ak.customer_id
     WHERE ak.key = $1 AND ak.is_active = TRUE`,
    [apiKey]
  );
```

Keys are stored as-is in `api_keys.key`. Any DB leak → tenant compromise.

**Recommendation:**
- Store `sha256(key)` (or argon2id) in `api_keys.key_hash`, return the raw key only on creation. Also store a short prefix (`cvx_xxxx…`) plaintext for UX / last-four-style reference.
- On lookup hash the incoming key and compare.

---

### 3.7 HIGH — Weak admin authentication model

**Affected:** `apps/api/src/middleware/auth.ts:40-53`

```40:53:apps/api/src/middleware/auth.ts
export async function adminAuth(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const token = request.headers["x-admin-token"] as string | undefined;

  if (!env.adminToken) {
    return reply.status(503).send({ error: "Admin token not configured" });
  }

  if (!token || token !== env.adminToken) {
    return reply.status(401).send({ error: "Missing or invalid x-admin-token" });
  }
}
```

Problems:
1. One shared static token for every admin — no accountability.
2. Comparison uses `!==` which is not constant-time; side-channel plausible on noisy network.
3. No brute-force lockout (see 3.4).
4. Token is passed via plaintext HTTP header — relies entirely on TLS termination upstream.
5. `process.env.ADMIN_TOKEN` visible to every child process.

**Recommendations:**
- Replace with per-admin accounts backed by argon2id password hashes + TOTP / WebAuthn; issue short-lived JWT or opaque session tokens.
- Use `crypto.timingSafeEqual(Buffer.from(token), Buffer.from(env.adminToken))` where both buffers are length-padded first.
- Log every admin action (who, what, when, IP) to an append-only table.

---

### 3.8 MEDIUM — IDOR: cross-tenant `system_prompt` disclosure via `session_id`

**Affected file:** `apps/api/src/routes/ask.ts:127-143`

```127:143:apps/api/src/routes/ask.ts
async function resolveAgentFromSession(
  sessionId: string | null
): Promise<ResolvedAgent | null> {
  if (!sessionId) return null;
  const result = await pool.query(
    `SELECT a.id, a.name, a.system_prompt FROM chat_sessions cs
     JOIN agents a ON a.id = cs.agent_id AND a.is_active = TRUE
     WHERE cs.id = $1`,
    [sessionId]
  );
```

The query is **not scoped to `customer_id`**. If tenant A passes a `session_id` belonging to tenant B in their `POST /ask` body, the function resolves tenant B's agent, returns its `system_prompt` and uses it to generate the answer. `getOrCreateSession` later creates a new session under tenant A, masking the leak in responses, but the system prompt — which is the valuable IP — has already been bound to tenant A's response.

The `session_id` is a UUID and thus not trivially guessable, but it:
- Appears in `AskResponse.session_id` responses across tenants,
- Is logged in application logs,
- May be reused across environments (dev/prod),
- Propagates to anyone handling the integration.

**Recommendation:**
Change the query to:
```sql
SELECT a.id, a.name, a.system_prompt
FROM chat_sessions cs
JOIN agents a ON a.id = cs.agent_id AND a.is_active = TRUE
WHERE cs.id = $1 AND cs.customer_id = $2
```
…and pass `customerId` from the authenticated request. Apply the same fix in any other `chat_sessions` / `agents` lookup that trusts a caller-supplied id.

---

### 3.9 MEDIUM — Sensitive data written to disk logs

**Affected files:** `apps/api/src/services/voicebot-trace.ts`, `apps/api/src/services/rag-trace.ts`, `apps/api/src/config/logger-factory.ts`, `apps/api/src/routes/adminLogs.ts`.

The voicebot pipeline emits rich traces that include STT transcripts, LLM full system+user messages, KB question/answer snippets and OpenAI raw replies:

- `pipeline.stt.response` → `transcript` (full)
- `pipeline.rag.kb_hit` → distances
- `pipeline.rag.llm_request` → `user_preview` + system prompt length
- `pipeline.rag.llm_response` → `answer_preview`
- `rag_prompt_built` → `rag_messages_full` (entire chat)

These go to `stdout` **and** to `logs/convixx-YYYY-MM-DD.log`, which is served via `GET /admin/logs/:date` as a streamable download. Admin also has `DELETE /admin/logs/:date`.

Meanwhile `chat_messages.content` is AES-256-GCM-encrypted in the DB, creating a major asymmetry — the at-rest encryption is bypassed by the logs.

**Impact:**
- PII (phone numbers appear in `from`/`to` fields), medical/financial questions, tenant KB content, tenant system prompts all sit on disk in plaintext.
- Log tampering is possible because `DELETE /admin/logs/:date` is unaudited.

**Recommendations:**
- Reduce trace verbosity in production: stop logging full `rag_messages_full`, `transcript`, `answer_preview`. Only log IDs, lengths, hashes.
- If they must remain, encrypt log files at rest with the same / different KMS key.
- Make the log-delete endpoint write-once — never delete, only rotate to archive. Or require a signed confirmation.

---

### 3.10 MEDIUM — `openai_usage.question` stored in plaintext

**Affected:** `apps/api/src/routes/ask.ts:282-296`

```282:296:apps/api/src/routes/ask.ts
  pool.query(
    `INSERT INTO openai_usage
       (customer_id, question, prompt_tokens, completion_tokens, total_tokens, model, cost_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      customerId,
      question,
```

Chat messages are encrypted via `encrypt(content)` but the same question is simultaneously written to `openai_usage.question` in plaintext. DB compromise reveals every user query even if `ENCRYPTION_KEY` is safe.

**Recommendation:** encrypt `openai_usage.question` with the same helper, or store only a SHA-256 hash + prefix.

---

### 3.11 MEDIUM — `trustProxy` not set (Fastify CVE GHSA-444r-cwp2-x5xf applies)

**Affected:** `apps/api/src/app.ts`

```20:24:apps/api/src/app.ts
  const app = Fastify({
    loggerInstance: createRootLogger(),
    disableRequestLogging: true,
  }) as unknown as FastifyInstance;
```

No `trustProxy` option. Combined with the Fastify advisory (3.5), attackers can set `X-Forwarded-Proto: https` / `X-Forwarded-Host` to influence:
- `voicebotUrlsForCustomer` — returns a spoofable hostname into Exotel config responses.
- `request.ip` — logging, future rate-limit keys will believe the attacker's IP.

**Recommendation:**
Upgrade Fastify to the fixed version AND configure `Fastify({ trustProxy: ['10.0.0.0/8', '<load-balancer-cidr>'] })` explicitly. Never `trustProxy: true` in public deployments.

---

### 3.12 MEDIUM — No `bodyLimit`; multipart caps only on voice

`Fastify()` defaults `bodyLimit` to 1 MB — OK for JSON, but `/kb/upload` with thousands of entries can still cause high embedding cost. `@fastify/multipart` is set to 15 MB per file for `/voice/speech-to-text` and `/ask/voice` — reasonable. There is no per-tenant cap on active WS calls (see 3.4).

**Recommendations:**
- Enforce `maxEntries` (e.g. 1000) on `/kb/upload`.
- Cap concurrent WS calls per tenant.
- Consider lowering `fileSize` on voice endpoints to 8 MB (30 s of PCM at 16 kHz is ~1 MB).

---

### 3.13 MEDIUM — Unauthenticated HTML test pages

`/voice/test-ui` and `/voice/stream` are served without auth. A user loads them, pastes their tenant API key (stored in `localStorage`), and makes STT/TTS/RAG calls against the API. A malicious hoster can replicate the page on another origin; the current CORS policy (3.3) allows it. Also provides a phishing surface.

**Recommendation:** serve these only under `adminAuth` or behind a separate admin console; or remove them from production builds.

---

### 3.14 MEDIUM — Swagger UI publicly accessible

`/docs` exposes the full OpenAPI 3.1 spec including admin routes and Exotel routes to anyone. This is low-value for an attacker (all routes are also visible in source), but it does advertise the `x-admin-token` header name and the path of every endpoint including `/admin/logs`.

**Recommendation:** protect `/docs` behind `adminAuth` or Basic Auth in the reverse proxy.

---

### 3.15 MEDIUM — AES-GCM IV length 16 instead of 12

```6:9:apps/api/src/services/crypto.ts
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
```

NIST SP 800-38D recommends a 96-bit (12-byte) IV for AES-GCM. Longer IVs are hashed internally by the cipher and *may* increase collision risk earlier. Using `randomBytes(16)` does not break security but is non-standard. Also note the key is read from env on every call (`getKey()`) — fine; but no rotation header is stored, so rotating `ENCRYPTION_KEY` would break decryption of existing rows.

**Recommendations:**
- Switch to `IV_LENGTH = 12`.
- Prefix ciphertext with a 1-byte `key_version`; keep a small key map; document rotation procedure.

---

### 3.16 LOW — Prompt-injection exposure

In `buildRAGMessages` the user's question is appended verbatim to the conversation after the RAG rules. A crafted user question can override the `ANSWER_NOT_FOUND` / "answer only from KB" behaviour and extract the system prompt, impersonate other tenants' personae (if multiple tenants use the same base prompt structure), or steer the agent into arbitrary replies.

**Recommendations:** sanitize / sandwich the question with additional delimiters, add a final system rule after the user message, rate-limit on suspicious token patterns ("ignore previous instructions", etc.).

---

### 3.17 LOW — Verbose error messages

- `/health/db`, `/health/vector`, `/health/llm`, `/health/embedding` return raw `err.message` (`reply.status(503).send({ status: "error", message: err.message })`). `err.message` from pg can include the host/port, search_path and schema references.
- `formatOpenAIClientError` concatenates HTTP status + provider code + provider message and returns it as `openai_error` in `/ask` JSON — fine for admin visibility, but this is public to tenants.

**Recommendation:** map to stable error codes; log details server-side only.

---

### 3.18 LOW — Log-file SQL capture

`LOG_DB_QUERIES=true` in `.env` and:

```36:38:apps/api/src/config/db.ts
            sql: String(text).slice(0, 2000),
```

Query **parameters** are not logged (good), but query **text** can be large and reveal column structure, user patterns. Also with 2000-char truncation, embedding vectors would have been logged if parameters were ever inlined.

**Recommendation:** set `LOG_DB_QUERIES=false` in production and rely on DB-side `auto_explain` for diagnostics.

---

### 3.19 LOW — No SSRF allow-list on outbound base URLs

`env.llm.baseUrl`, `SARVAM_BASE`, `openaiClient` — all constructed from env with no validation. An attacker who ever gains the ability to edit the env (for example via a supply-chain compromise or a misconfigured secret-injection system) can redirect the process to an internal URL (`http://169.254.169.254/…`) and observe outbound responses.

**Recommendation:** assert at startup that `LLM_BASE_URL` hostname is in an allow-list; refuse to start otherwise.

---

### 3.20 LOW — No confirmation prompt / audit on `DELETE /admin/logs`

Already summarised in 3.9. Additionally `DELETE /admin/logs/:date` uses `fs.unlink` which is unrecoverable. Good audit practice forbids removing logs.

---

### 3.21 INFO — No SECURITY.md, no CI security gate

The repo has no:
- `SECURITY.md` / responsible-disclosure policy
- Automated `npm audit --audit-level=moderate` gate in CI
- `gitleaks`/`trufflehog` secret scan in CI
- SAST (Semgrep, CodeQL)
- Container image scanning (Trivy)

---

## 4. Risk Heat Map

```
Likelihood ↑
   HIGH  │ 3.1 Secrets on disk     3.2 WS unauth
         │ 3.6 Plaintext API keys  3.5 Vuln deps
         │ 3.4 No rate limits
   MED   │ 3.3 CORS/helmet          3.7 Admin token
         │ 3.8 IDOR session         3.9 Log PII
         │ 3.11 trustProxy          3.10 openai_usage
         │ 3.13/14 UI+Swagger       3.12 body limits
   LOW   │ 3.15 IV length           3.16 Prompt inj
         │ 3.17 Error leak          3.18 SQL log
         │ 3.19 SSRF                3.20 Log delete
         └──────────────────────────────────────────→
            LOW               MED              HIGH   Impact
```

---

## 5. Prioritised Remediation Plan

### Week 0 (Emergency, before any further deploy)
- [ ] Rotate every secret in `apps/api/.env` (DB password, admin token, encryption key with dual-read migration, OpenAI key, LLM key, Sarvam key).
- [ ] Delete `apps/api/check_schema.js` (or at least its hardcoded credentials).
- [ ] `npm audit fix` in `apps/api` and bump Fastify to the patched release.
- [ ] Add `trustProxy` configuration matching your LB / reverse proxy.
- [ ] Add authentication to `/exotel/voicebot/:customerId` and `/exotel/voicebot/bootstrap/:customerId` (HMAC / bearer / IP allow-list).
- [ ] Disable `DELETE /admin/logs/:date` until audit is designed.

### Week 1 (Core hardening)
- [ ] Register `@fastify/rate-limit` with global + per-route quotas.
- [ ] Register `@fastify/helmet`.
- [ ] Scope `resolveAgentFromSession` by `customer_id` (3.8).
- [ ] Switch API-key storage to hashed form; invalidate old keys.
- [ ] Constrain CORS to an explicit allow-list.
- [ ] Gate `/docs`, `/voice/test-ui`, `/voice/stream` behind admin auth.
- [ ] Encrypt or hash `openai_usage.question`.
- [ ] Reduce verbosity of `voicebotTrace` / `ragTrace` and/or encrypt the log directory.

### Week 2+ (Defence in depth)
- [ ] Replace admin token with per-admin accounts + TOTP/WebAuthn + audit trail.
- [ ] Move secrets to Vault / SSM / Secrets Manager.
- [ ] Add `gitleaks`, `npm audit`, `semgrep`, `trivy` to CI.
- [ ] Implement per-tenant concurrent WS caps and monthly cost caps.
- [ ] Add structured audit-log table for all admin mutations.
- [ ] Write `SECURITY.md` and a disclosure channel.
- [ ] Plan a follow-up external penetration test once items above are in place.

---

## 6. Positive Observations

Despite the above, the code gets a number of things right:

- SQL is consistently parameterised (`pool.query(text, values)`); no string concatenation seen in the reviewed routes.
- Zod schemas validate most request bodies; UUID format enforced where appropriate.
- Per-tenant scoping (`customer_id = $N`) is applied in most KB / agents / chat queries.
- AES-256-GCM is used (authenticated encryption) for chat content — the IV length aside.
- Random values (API keys, IVs) use `crypto.randomBytes`, not `Math.random`.
- Logs do redact base64 audio payloads (`redactInboundExotelForLog`).
- Strong tenant isolation in the DB schema (`customer_id` FK with `ON DELETE CASCADE`).
- Dev/prod environment separation via `env.ts` with explicit keys.
- Admin-logs path handling uses a proper `path.resolve` + prefix check to prevent path traversal.

These give a solid foundation to build on once the findings above are addressed.

---

## 7. Appendix A — Files Reviewed

```
apps/api/package.json
apps/api/.env
apps/api/.gitignore
apps/api/check_schema.js
apps/api/ecosystem.config.cjs
apps/api/src/app.ts
apps/api/src/index.ts
apps/api/src/middleware/auth.ts
apps/api/src/config/env.ts
apps/api/src/config/db.ts
apps/api/src/config/swagger.ts
apps/api/src/config/logger-factory.ts
apps/api/src/plugins/request-logging.ts
apps/api/src/plugins/swagger.ts
apps/api/src/services/crypto.ts
apps/api/src/services/llm.ts
apps/api/src/services/cache.ts
apps/api/src/services/sarvam.ts
apps/api/src/services/exotel-settings.ts
apps/api/src/services/exotel-voice-urls.ts
apps/api/src/services/voicebot-session.ts
apps/api/src/services/voicebot-trace.ts
apps/api/src/services/daily-log-file-stream.ts
apps/api/src/routes/health.ts
apps/api/src/routes/customers.ts
apps/api/src/routes/agents.ts
apps/api/src/routes/kb.ts
apps/api/src/routes/ask.ts
apps/api/src/routes/chat.ts
apps/api/src/routes/settings.ts
apps/api/src/routes/voice.ts
apps/api/src/routes/voice-test-page.ts
apps/api/src/routes/voice-stream-page.ts
apps/api/src/routes/exotel-settings.ts
apps/api/src/routes/exotel-voicebot.ts
apps/api/src/routes/adminLogs.ts
```

## 8. Appendix B — npm audit raw summary

```
@fastify/static   moderate  path-traversal + route-guard bypass
brace-expansion   moderate  DoS via zero-step sequence
fastify           high      content-type bypass, forwarded-proto spoof, body-schema bypass
minimatch         high      ReDoS x2
picomatch         high      method injection + ReDoS
yaml              moderate  stack overflow

6 vulnerabilities (3 moderate, 3 high) — all fixable with `npm audit fix`
```

---

*End of report. No code was modified during this audit. The findings are based on static review only; dynamic testing / penetration testing is recommended as a follow-up after remediation.*
