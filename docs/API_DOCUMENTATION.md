# Convixx API Documentation

**Base URL (Production):** `https://convixx.in`  
**Base URL (Local):** `http://localhost:8080`

Use the production URL for all API calls when the app is deployed. Replace the base in examples below with the appropriate URL.

### Swagger UI

Interactive API documentation is available at a separate path from the API:

- **Production:** `https://convixx.in/docs`
- **Local:** `http://localhost:8080/docs`

Use the **Authorize** button in Swagger UI to set `x-admin-token` (for customer/admin endpoints) or `x-api-key` (for KB, agents, ask, chat). You can try out endpoints directly from the browser.

**Tip:** If "Try it out" shows "Failed to fetch", ensure the server dropdown at the top is set to **"Current host"** so requests go to the same host as the docs. CORS is enabled to allow browser requests.

---

## Table of Contents

1. [Health Endpoints](#1-health-endpoints)
2. [Customer Endpoints](#2-customer-endpoints)
3. [Agent Endpoints](#3-agent-endpoints)
4. [Knowledgebase Endpoints](#4-knowledgebase-endpoints)
5. [Ask Endpoint](#5-ask-endpoint)
6. [Chat Endpoints](#6-chat-endpoints)
7. [Voice Endpoints (Sarvam AI)](#7-voice-endpoints-sarvam-ai)
8. [Authentication](#8-authentication)
9. [Error Responses](#9-error-responses)
10. [Security - Chat Encryption](#10-security---chat-encryption)

---

## 6. Chat Endpoints

### GET /chat/sessions (requires `x-api-key`)

List all chat sessions for the authenticated customer, ordered by most recently active.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**Example Request:**

```bash
curl https://convixx.in/chat/sessions \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
[
  {
    "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "created_at": "2026-02-22T10:00:00.000Z",
    "updated_at": "2026-02-22T10:05:30.000Z",
    "message_count": 6
  },
  {
    "session_id": "f9e8d7c6-b5a4-3210-abcd-ef1234567890",
    "created_at": "2026-02-22T09:30:00.000Z",
    "updated_at": "2026-02-22T09:35:00.000Z",
    "message_count": 2
  }
]
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| session_id | UUID | Session identifier |
| created_at | timestamp | When session was created |
| updated_at | timestamp | When last message was sent |
| message_count | number | Total messages in session |

---

### GET /chat/sessions/:session_id/messages (requires `x-api-key`)

Get all messages for a specific chat session. Messages are decrypted and returned in chronological order. The session must belong to the authenticated customer.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| session_id | UUID | Chat session ID |

**Example Request:**

```bash
curl https://convixx.in/chat/sessions/a1b2c3d4-e5f6-7890-abcd-ef1234567890/messages \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
[
  {
    "id": "msg-uuid-1",
    "role": "user",
    "content": "What rooms are available?",
    "source": null,
    "openai_cost_usd": null,
    "created_at": "2026-02-22T10:00:00.000Z"
  },
  {
    "id": "msg-uuid-2",
    "role": "assistant",
    "content": "We offer Sarja Raja Mini Carts, Rahuti Tents, Royal Rahuti Tents, Royal Carts, and Yashwantrao Wada with a private pool.",
    "source": "self-hosted",
    "openai_cost_usd": null,
    "created_at": "2026-02-22T10:00:05.000Z"
  },
  {
    "id": "msg-uuid-3",
    "role": "user",
    "content": "Which one has a private pool?",
    "source": null,
    "openai_cost_usd": null,
    "created_at": "2026-02-22T10:01:00.000Z"
  },
  {
    "id": "msg-uuid-4",
    "role": "assistant",
    "content": "Yashwantrao Wada comes with a private swimming pool.",
    "source": "self-hosted",
    "openai_cost_usd": null,
    "created_at": "2026-02-22T10:01:06.000Z"
  }
]
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| id | UUID | Message ID |
| role | string | `"user"` or `"assistant"` |
| content | string | Decrypted message text |
| source | string or null | `"self-hosted"`, `"openai"`, `"kb-direct"`, `"none"`, or null (for user messages) |
| openai_cost_usd | number or null | Cost if OpenAI was used for this response |
| created_at | timestamp | When the message was created |

**Response 404:**

```json
{
  "error": "Session not found or does not belong to this customer"
}
```

---

## 7. Voice Endpoints (Sarvam AI)

Speech-to-text and text-to-speech are powered by [Sarvam AI](https://www.sarvam.ai/) (Saaras STT, Bulbul TTS).  
The server must have `SARVAM_API_KEY` set in `apps/api/.env` (from the [Sarvam dashboard](https://dashboard.sarvam.ai/)).

All voice routes require the same `x-api-key` header as KB, ask, agents, and chat.

### GET /voice/test-ui (no auth)

Temporary page for manual STT/TTS checks: upload audio for transcription, synthesize text and play audio from Sarvam’s JSON `audios[0]` (base64) or from `?response_format=binary`. Paste your `x-api-key` in the page. Open `http://localhost:<PORT>/voice/test-ui` (use your server port, default `8080`).

### GET /voice/capabilities (requires `x-api-key`)

Returns supported STT modes, TTS language codes, speaker lists, pace/sample-rate limits, and codec options.  
Does not call Sarvam; safe for clients to cache.

**Response 200:** JSON object with `speech_to_text` and `text_to_speech` metadata (see route implementation or Swagger `/docs`).

---

### POST /voice/speech-to-text (requires `x-api-key`)

Transcribes short audio (~30 seconds max for the REST API). Send **multipart/form-data** with:

| Field | Required | Description |
|--------|----------|-------------|
| file | Yes | Audio file (WAV, MP3, AAC, FLAC, OGG) |
| mode | No | `transcribe` (default), `translate`, `verbatim`, `translit`, `codemix` |
| language_code | No | BCP-47 hint, e.g. `hi-IN` |
| model | No | Default `saaras:v3` |

**Example (curl):**

```bash
curl -X POST https://convixx.in/voice/speech-to-text \
  -H "x-api-key: cvx_your_key" \
  -F "file=@recording.wav;type=audio/wav" \
  -F "mode=transcribe"
```

**Response 200:** Sarvam shape: `request_id`, `transcript`, `language_code`.

**Response 503:** `{ "error": "Sarvam is not configured (SARVAM_API_KEY)" }`

---

### POST /voice/text-to-speech (requires `x-api-key`)

Synthesizes natural speech (Bulbul v3 by default). JSON body:

| Field | Required | Description |
|--------|----------|-------------|
| text | Yes | Up to 2500 characters (1500 for `bulbul:v2`) |
| target_language_code | Yes | One of: `bn-IN`, `en-IN`, `gu-IN`, `hi-IN`, `kn-IN`, `ml-IN`, `mr-IN`, `od-IN`, `pa-IN`, `ta-IN`, `te-IN` |
| speaker | No | Lowercase voice id (e.g. `shubh`, `ritu`, `priya`). Defaults per Sarvam model. |
| model | No | `bulbul:v3` (default) or `bulbul:v2` |
| pace | No | Speed: **v3** 0.5–2.0, **v2** 0.3–3.0 (default 1.0) |
| speech_sample_rate | No | `8000`, `16000`, `22050`, `24000`, `32000`, `44100`, `48000` (Hz as string) |
| output_audio_codec | No | `wav`, `mp3`, `linear16`, `mulaw`, `alaw`, `opus`, `flac`, `aac` |
| temperature | No | **v3 only** expressiveness 0.01–2.0 (default ~0.6) |
| pitch, loudness | No | **v2 only** |
| enable_preprocessing | No | **v2** normalization |
| dict_id | No | **v3** pronunciation dictionary id |

**Example request:**

```json
{
  "text": "नमस्ते, आप कैसे हैं?",
  "target_language_code": "hi-IN",
  "speaker": "ritu",
  "model": "bulbul:v3",
  "pace": 1.0,
  "speech_sample_rate": "24000",
  "output_audio_codec": "wav",
  "temperature": 0.65
}
```

**Response 200:** `{ "request_id", "audios": ["<base64>"] }` — Sarvam returns WAV bytes as base64; the first string is often very long. That is normal, not an error.

**Downloadable file (Postman / Swagger):** Same `POST`, with any of:

- `response_format=binary` or `download=1` — raw audio bytes with `Content-Disposition: attachment` (choose filename in browser, or in Postman use **Save Response** / **Send and Download**).
- Header **`Accept: audio/wav`** (or `audio/mpeg` when using `output_audio_codec: mp3`) — same as binary mode, without query params.
- `response_format=json` — force JSON even if you send an `Accept: audio/*` header.

Optional `filename=myclip` — safe basename for the file; extension matches `output_audio_codec` (e.g. `speech.wav` by default).

Example: `POST /voice/text-to-speech?response_format=binary&filename=demo` with the same JSON body.

---

## 8. Authentication

### Customer APIs (Admin Token)

All customer endpoints require a fixed admin token passed via the `x-admin-token` header.  
Without this token, no one can create customers, list them, update them, or generate API keys.

| Header | Required | Description |
|--------|----------|-------------|
| x-admin-token | Yes | Fixed admin token (set in server `.env` as `ADMIN_TOKEN`) |

### KB / Ask / Agents / Chat / Voice APIs (API Key)

These endpoints require a customer API key passed via the `x-api-key` header: `/agents`, `/kb/*`, `/ask`, `/chat/*`, `/voice/*`.  
The key is generated per customer (via POST `/customers/:id/api-key`) and scopes all data access to that customer only.

```
x-api-key: cvx_abc123...
```

Endpoints that require authentication are marked with a lock icon below.

---

## 1. Health Endpoints

These endpoints verify that all external services are reachable. No authentication required.

### GET /health

Returns API status.

**Response 200:**

```json
{
  "status": "ok",
  "timestamp": "2026-02-22T09:14:54.432Z"
}
```

---

### GET /health/db

Checks PostgreSQL connection (Server 2).

**Response 200:**

```json
{
  "status": "ok",
  "time": "2026-02-22T09:16:46.689Z"
}
```

**Response 503:**

```json
{
  "status": "error",
  "message": "connection refused"
}
```

---

### GET /health/vector

Checks pgvector extension on PostgreSQL.

**Response 200:**

```json
{
  "status": "ok",
  "pgvector_version": "0.8.1"
}
```

**Response 503:**

```json
{
  "status": "error",
  "message": "pgvector extension not found"
}
```

---

### GET /health/llm

Checks self-hosted LLM at ai.convixx.in.

**Response 200:**

```json
{
  "status": "ok",
  "response": "Hello!"
}
```

**Response 503:**

```json
{
  "status": "error",
  "message": "connect ECONNREFUSED"
}
```

---

### GET /health/embedding

Checks embedding generation via self-hosted model.

**Response 200:**

```json
{
  "status": "ok",
  "dimensions": 384
}
```

**Response 503:**

```json
{
  "status": "error",
  "message": "model not found"
}
```

---

## 2. Customer Endpoints

All customer endpoints require the `x-admin-token` header. Without it, requests return 401.

### POST /customers (requires `x-admin-token`)

Create a new customer.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-admin-token | Yes | Admin token (from server `ADMIN_TOKEN`) |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Customer name |
| system_prompt | string | No | Custom system prompt for LLM (default: "You are a helpful assistant.") |

**Example Request:**

```bash
curl -X POST https://convixx.in/customers \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your_admin_token_here" \
  -d '{
    "name": "MarriageWale",
    "system_prompt": "You are MarriageWale support agent. Answer in short and polite manner."
  }'
```

**Response 201:**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "MarriageWale",
  "system_prompt": "You are MarriageWale support agent. Answer in short and polite manner.",
  "created_at": "2026-02-22T09:20:00.000Z"
}
```

**Response 400:**

```json
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "name": ["String must contain at least 1 character(s)"]
    }
  }
}
```

**Response 401:**

```json
{
  "error": "Missing or invalid x-admin-token"
}
```

---

### GET /customers (requires `x-admin-token`)

List all customers.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-admin-token | Yes | Admin token |

**Example Request:**

```bash
curl https://convixx.in/customers \
  -H "x-admin-token: your_admin_token_here"
```

**Response 200:**

```json
[
  {
    "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    "name": "MarriageWale",
    "system_prompt": "You are MarriageWale support agent. Answer in short and polite manner.",
    "created_at": "2026-02-22T09:20:00.000Z"
  }
]
```

---

### GET /customers/:id (requires `x-admin-token`)

Get a single customer by ID.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-admin-token | Yes | Admin token |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Customer ID |

**Example Request:**

```bash
curl https://convixx.in/customers/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "x-admin-token: your_admin_token_here"
```

**Response 200:**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "MarriageWale",
  "system_prompt": "You are MarriageWale support agent. Answer in short and polite manner.",
  "created_at": "2026-02-22T09:20:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "Customer not found"
}
```

---

### PUT /customers/:id (requires `x-admin-token`)

Update a customer. You can update name, system_prompt, or both.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-admin-token | Yes | Admin token |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Customer ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | No | Updated customer name |
| system_prompt | string | No | Updated default system prompt |

At least one field must be provided.

**Example Request (update system prompt):**

```bash
curl -X PUT https://convixx.in/customers/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your_admin_token_here" \
  -d '{
    "system_prompt": "You are a premium support agent. Be professional and helpful."
  }'
```

**Example Request (update both):**

```bash
curl -X PUT https://convixx.in/customers/a1b2c3d4-e5f6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "x-admin-token: your_admin_token_here" \
  -d '{
    "name": "MarriageWale Premium",
    "system_prompt": "You are a premium support agent. Be professional and helpful."
  }'
```

**Response 200:**

```json
{
  "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "MarriageWale Premium",
  "system_prompt": "You are a premium support agent. Be professional and helpful.",
  "created_at": "2026-02-22T09:20:00.000Z"
}
```

**Response 400:**

```json
{
  "error": "Provide at least name or system_prompt to update"
}
```

**Response 404:**

```json
{
  "error": "Customer not found"
}
```

---

### POST /customers/:id/api-key (requires `x-admin-token`)

Generate a new API key for a customer. This key is used to authenticate all KB, Ask, Agents, and Chat requests.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-admin-token | Yes | Admin token |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Customer ID |

**Example Request:**

```bash
curl -X POST https://convixx.in/customers/a1b2c3d4-e5f6-7890-abcd-ef1234567890/api-key \
  -H "x-admin-token: your_admin_token_here"
```

**Response 201:**

```json
{
  "api_key": "cvx_8f3a1b2c4d5e6f7890abcdef12345678abcdef1234567890abcdef1234567890",
  "created_at": "2026-02-22T09:21:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "Customer not found"
}
```

---

## 3. Agent Endpoints

Each customer can have multiple agents. Each agent has its own name, description, and system prompt. When hitting `/ask`, you can either pass an `agent_id` to use a specific agent, or let the LLM auto-select the best agent based on the user's question.

### POST /agents (requires `x-api-key`)

Create a new agent for the authenticated customer.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-api-key | Yes | Customer API key |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | Yes | Agent name |
| description | string | No | What this agent handles (used for auto-routing) |
| system_prompt | string | No | Custom system prompt (default: "You are a helpful assistant.") |

**Example Request:**

```bash
curl -X POST https://convixx.in/agents \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "name": "Sales Agent",
    "description": "Handles pricing, booking, and availability queries",
    "system_prompt": "You are a sales agent. Answer concisely about pricing and bookings."
  }'
```

**Response 201:**

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "customer_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "name": "Sales Agent",
  "description": "Handles pricing, booking, and availability queries",
  "system_prompt": "You are a sales agent. Answer concisely about pricing and bookings.",
  "is_active": true,
  "created_at": "2026-02-22T10:00:00.000Z",
  "updated_at": "2026-02-22T10:00:00.000Z"
}
```

---

### GET /agents (requires `x-api-key`)

List all agents for the authenticated customer.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**Example Request:**

```bash
curl https://convixx.in/agents \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
[
  {
    "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
    "name": "Sales Agent",
    "description": "Handles pricing, booking, and availability queries",
    "system_prompt": "You are a sales agent. Answer concisely about pricing and bookings.",
    "is_active": true,
    "created_at": "2026-02-22T10:00:00.000Z",
    "updated_at": "2026-02-22T10:00:00.000Z"
  },
  {
    "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
    "name": "Support Agent",
    "description": "Handles general support and FAQ queries",
    "system_prompt": "You are a helpful support agent. Be polite and thorough.",
    "is_active": true,
    "created_at": "2026-02-22T09:30:00.000Z",
    "updated_at": "2026-02-22T09:30:00.000Z"
  }
]
```

---

### GET /agents/:id (requires `x-api-key`)

Get a single agent by its ID.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Agent ID |

**Example Request:**

```bash
curl https://convixx.in/agents/b2c3d4e5-f6a7-8901-bcde-f12345678901 \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "name": "Sales Agent",
  "description": "Handles pricing, booking, and availability queries",
  "system_prompt": "You are a sales agent. Answer concisely about pricing and bookings.",
  "is_active": true,
  "created_at": "2026-02-22T10:00:00.000Z",
  "updated_at": "2026-02-22T10:00:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "Agent not found"
}
```

---

### PUT /agents/:id (requires `x-api-key`)

Update an agent. You can update name, description, system_prompt, or any combination.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Agent ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| name | string | No | Updated agent name |
| description | string | No | Updated description |
| system_prompt | string | No | Updated system prompt |

At least one field must be provided.

**Example Request (update system prompt only):**

```bash
curl -X PUT https://convixx.in/agents/b2c3d4e5-f6a7-8901-bcde-f12345678901 \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "system_prompt": "You are a premium sales agent. Be professional and mention exclusive offers."
  }'
```

**Example Request (update all fields):**

```bash
curl -X PUT https://convixx.in/agents/b2c3d4e5-f6a7-8901-bcde-f12345678901 \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "name": "Premium Sales Agent",
    "description": "Handles VIP pricing and premium booking queries",
    "system_prompt": "You are a premium sales agent. Be professional and mention exclusive offers."
  }'
```

**Response 200:**

```json
{
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "name": "Premium Sales Agent",
  "description": "Handles VIP pricing and premium booking queries",
  "system_prompt": "You are a premium sales agent. Be professional and mention exclusive offers.",
  "is_active": true,
  "created_at": "2026-02-22T10:00:00.000Z",
  "updated_at": "2026-02-22T10:15:00.000Z"
}
```

**Response 400:**

```json
{
  "error": "Provide at least one field to update"
}
```

**Response 404:**

```json
{
  "error": "Agent not found"
}
```

---

### DELETE /agents/:id (requires `x-api-key`)

Delete an agent.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | Agent ID |

**Example Request:**

```bash
curl -X DELETE https://convixx.in/agents/b2c3d4e5-f6a7-8901-bcde-f12345678901 \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
{
  "message": "Agent deleted",
  "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
}
```

**Response 404:**

```json
{
  "error": "Agent not found"
}
```

---

## 4. Knowledgebase Endpoints

### POST /kb/upload (requires `x-api-key`)

Upload one or more Q&A pairs to the customer's knowledgebase. Each question is embedded and stored as a vector for semantic search.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-api-key | Yes | Customer API key |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| entries | array | Yes | Array of Q&A objects (minimum 1) |
| entries[].question | string | Yes | The question |
| entries[].answer | string | Yes | The answer |

**Example Request:**

```bash
curl -X POST https://convixx.in/kb/upload \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "entries": [
      {
        "question": "What is MarriageWale?",
        "answer": "MarriageWale is a matrimonial app based in Kolhapur, Maharashtra."
      },
      {
        "question": "Where is MarriageWale located?",
        "answer": "MarriageWale is headquartered in Kolhapur, Maharashtra, India."
      },
      {
        "question": "What services does MarriageWale provide?",
        "answer": "MarriageWale provides matchmaking and matrimonial services."
      },
      {
        "question": "How to contact MarriageWale?",
        "answer": "You can contact MarriageWale through their app or email at support@marriagewale.com."
      }
    ]
  }'
```

**Response 201:**

```json
{
  "message": "4 Q&A entries uploaded",
  "customer_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
}
```

**Response 400:**

```json
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "entries": ["Array must contain at least 1 element(s)"]
    }
  }
}
```

**Response 401:**

```json
{
  "error": "Missing x-api-key header"
}
```

---

### GET /kb/entries (requires `x-api-key`)

List all KB entries for the authenticated customer.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**Example Request:**

```bash
curl https://convixx.in/kb/entries \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
[
  {
    "id": "f1e2d3c4-b5a6-7890-abcd-ef1234567890",
    "question": "What is MarriageWale?",
    "answer": "MarriageWale is a matrimonial app based in Kolhapur, Maharashtra.",
    "created_at": "2026-02-22T09:25:00.000Z"
  },
  {
    "id": "a9b8c7d6-e5f4-3210-abcd-ef1234567890",
    "question": "Where is MarriageWale located?",
    "answer": "MarriageWale is headquartered in Kolhapur, Maharashtra, India.",
    "created_at": "2026-02-22T09:25:00.000Z"
  }
]
```

---

### GET /kb/entries/:id (requires `x-api-key`)

Get a single KB entry by its ID.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | KB entry ID |

**Example Request:**

```bash
curl https://convixx.in/kb/entries/f1e2d3c4-b5a6-7890-abcd-ef1234567890 \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
{
  "id": "f1e2d3c4-b5a6-7890-abcd-ef1234567890",
  "question": "What is MarriageWale?",
  "answer": "MarriageWale is a matrimonial app based in Kolhapur, Maharashtra.",
  "created_at": "2026-02-22T09:25:00.000Z"
}
```

**Response 404:**

```json
{
  "error": "KB entry not found"
}
```

---

### PUT /kb/entries/:id (requires `x-api-key`)

Update a specific KB entry. You can update the question, the answer, or both. If the question is changed, the embedding is automatically re-generated.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | KB entry ID |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| question | string | No | Updated question (re-generates embedding) |
| answer | string | No | Updated answer |

At least one of `question` or `answer` must be provided.

**Example Request (update answer only):**

```bash
curl -X PUT https://convixx.in/kb/entries/f1e2d3c4-b5a6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "answer": "MarriageWale is a premium matrimonial app based in Kolhapur, Maharashtra."
  }'
```

**Example Request (update both):**

```bash
curl -X PUT https://convixx.in/kb/entries/f1e2d3c4-b5a6-7890-abcd-ef1234567890 \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "question": "What exactly is MarriageWale?",
    "answer": "MarriageWale is a premium matrimonial app based in Kolhapur, Maharashtra."
  }'
```

**Response 200:**

```json
{
  "id": "f1e2d3c4-b5a6-7890-abcd-ef1234567890",
  "question": "What exactly is MarriageWale?",
  "answer": "MarriageWale is a premium matrimonial app based in Kolhapur, Maharashtra.",
  "created_at": "2026-02-22T09:25:00.000Z"
}
```

**Response 400:**

```json
{
  "error": "Provide at least question or answer to update"
}
```

**Response 404:**

```json
{
  "error": "KB entry not found"
}
```

---

### DELETE /kb/entries/:id (requires `x-api-key`)

Delete a KB entry.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| x-api-key | Yes | Customer API key |

**URL Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| id | UUID | KB entry ID |

**Example Request:**

```bash
curl -X DELETE https://convixx.in/kb/entries/f1e2d3c4-b5a6-7890-abcd-ef1234567890 \
  -H "x-api-key: cvx_your_api_key_here"
```

**Response 200:**

```json
{
  "message": "KB entry deleted",
  "id": "f1e2d3c4-b5a6-7890-abcd-ef1234567890"
}
```

**Response 404:**

```json
{
  "error": "KB entry not found"
}
```

---

## 5. Ask Endpoint

### POST /ask (requires `x-api-key`)

Ask a question against the customer's knowledgebase with optional chat session and agent support.

**Pipeline:**

1. Resolve agent (explicit `agent_id` or auto-route via LLM) and embed question in parallel
2. Vector search for top 3 relevant Q&A pairs (scoped to customer via API key)
3. Load chat history from session (if session_id provided)
4. Build RAG prompt with agent's system_prompt + KB context + chat history + question
5. Call self-hosted LLM and OpenAI in parallel
6. If self-hosted answers from KB, return it (discard OpenAI)
7. If self-hosted fails, return OpenAI result with fallback details

**Agent Selection:**
- If `agent_id` is provided, that agent's system prompt is used
- If `agent_id` is omitted and the customer has multiple agents, the self-hosted LLM classifies the question and picks the best agent
- If the customer has exactly one agent, it is used automatically
- If the customer has no agents, the customer-level default system prompt is used

All chat messages (user and assistant) are encrypted with AES-256-GCM before storage.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| Content-Type | Yes | application/json |
| x-api-key | Yes | Customer API key |

**Request Body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| question | string | Yes | The question to ask |
| session_id | UUID string | No | Session ID to continue a conversation. If blank/null, a new session is created. |
| agent_id | UUID string | No | Agent ID to use. If omitted, LLM auto-selects the best agent. |

**Example Request (new session, auto-route agent):**

```bash
curl -X POST https://convixx.in/ask \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "question": "What rooms are available?"
  }'
```

**Example Request (explicit agent):**

```bash
curl -X POST https://convixx.in/ask \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "question": "What rooms are available?",
    "agent_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901"
  }'
```

**Example Request (continue session):**

```bash
curl -X POST https://convixx.in/ask \
  -H "Content-Type: application/json" \
  -H "x-api-key: cvx_your_api_key_here" \
  -d '{
    "question": "Which one has a private pool?",
    "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890"
  }'
```

**Response 200 (answered by self-hosted LLM):**

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agent_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "agent_name": "Sales Agent",
  "answer": "MarriageWale is located in Kolhapur, Maharashtra, India.",
  "source": "self-hosted",
  "openai_cost_usd": null,
  "response_time_ms": 5200
}
```

**Response 200 (fallback to OpenAI):**

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agent_id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
  "agent_name": "Sales Agent",
  "answer": "MarriageWale is headquartered in Kolhapur, Maharashtra, India.",
  "source": "openai",
  "self_hosted_answer": "ANSWER_NOT_FOUND",
  "fallback_reason": "Self-hosted LLM could not answer from knowledgebase",
  "openai_cost_usd": 0.000342,
  "response_time_ms": 7800
}
```

**Response 200 (no KB entries found):**

```json
{
  "session_id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
  "agent_id": null,
  "agent_name": null,
  "answer": "No knowledgebase entries found for this customer.",
  "source": "none",
  "openai_cost_usd": null,
  "response_time_ms": 3100
}
```

**Response Fields:**

| Field | Type | Description |
|-------|------|-------------|
| session_id | UUID | Session ID (newly created or existing) |
| agent_id | UUID or null | ID of the agent that handled the query (null if no agents configured) |
| agent_name | string or null | Name of the agent (null if no agents configured) |
| answer | string | The generated answer |
| source | string | `"self-hosted"`, `"openai"`, `"kb-direct"`, or `"none"` |
| self_hosted_answer | string or null | Included only on OpenAI fallback, shows what self-hosted returned |
| fallback_reason | string or null | Included only on fallback, explains why OpenAI was used |
| openai_cost_usd | number or null | Cost in USD if OpenAI was used, null otherwise |
| response_time_ms | number | Total response time in milliseconds |

**Response 400:**

```json
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "question": ["String must contain at least 1 character(s)"]
    }
  }
}
```

**Response 401:**

```json
{
  "error": "Missing x-api-key header"
}
```

---

## 9. Error Responses

All endpoints may return these common errors:

### 401 Unauthorized

**Customer endpoints** – when `x-admin-token` is missing or invalid:

```json
{
  "error": "Missing or invalid x-admin-token"
}
```

**KB / Ask / Agents / Chat endpoints** – when `x-api-key` is missing or invalid:

```json
{
  "error": "Missing x-api-key header"
}
```

```json
{
  "error": "Invalid or inactive API key"
}
```

### 400 Bad Request

Returned when request body fails validation.

```json
{
  "error": {
    "formErrors": [],
    "fieldErrors": {
      "field_name": ["Error message"]
    }
  }
}
```

### 404 Not Found

Returned when a resource does not exist.

```json
{
  "error": "Customer not found"
}
```

### 503 Service Unavailable

Returned by health endpoints when an external service is unreachable.

```json
{
  "status": "error",
  "message": "Error description"
}
```

---

## 10. Security - Chat Encryption

All chat messages (both user questions and assistant answers) are encrypted at the application layer before being stored in the database.

**Encryption Details:**

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM |
| Key size | 256 bits (32 bytes) |
| IV | Random 16 bytes per message |
| Auth tag | 16 bytes (tamper detection) |
| Storage format | base64(IV + AuthTag + Ciphertext) |

**How it works:**

- Every message is encrypted with a unique random IV before INSERT
- On SELECT (loading chat history), messages are decrypted in the application
- The encryption key is stored in the `.env` file as `ENCRYPTION_KEY` (64 hex characters)
- The database `chat_messages.content` column contains only encrypted ciphertext -- raw text is never stored
- AES-GCM provides both confidentiality and integrity (tamper-proof via auth tag)

**What is encrypted:**

| Data | Encrypted |
|------|-----------|
| chat_messages.content | Yes (AES-256-GCM) |
| KB entries (question/answer) | No (needed for vector search) |
| API keys | No (needed for lookup) |
| OpenAI usage logs | No (metadata only) |

---

## API Summary

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | /health | No | API status |
| GET | /health/db | No | PostgreSQL connection check |
| GET | /health/vector | No | pgvector extension check |
| GET | /health/llm | No | Self-hosted LLM check |
| GET | /health/embedding | No | Embedding model check |
| POST | /customers | Yes (x-admin-token) | Create customer |
| GET | /customers | Yes (x-admin-token) | List customers |
| GET | /customers/:id | Yes (x-admin-token) | Get single customer |
| PUT | /customers/:id | Yes (x-admin-token) | Update customer (name, system_prompt) |
| POST | /customers/:id/api-key | Yes (x-admin-token) | Generate API key |
| POST | /agents | Yes | Create agent |
| GET | /agents | Yes | List agents for customer |
| GET | /agents/:id | Yes | Get single agent |
| PUT | /agents/:id | Yes | Update agent (name, description, system_prompt) |
| DELETE | /agents/:id | Yes | Delete agent |
| POST | /kb/upload | Yes | Upload Q&A pairs |
| GET | /kb/entries | Yes | List all KB entries |
| GET | /kb/entries/:id | Yes | Get single KB entry |
| PUT | /kb/entries/:id | Yes | Update KB entry (re-embeds if question changes) |
| DELETE | /kb/entries/:id | Yes | Delete KB entry |
| POST | /ask | Yes | Ask a question (RAG + agent + session + encrypted chat) |
| GET | /chat/sessions | Yes | List chat sessions for customer |
| GET | /chat/sessions/:session_id/messages | Yes | Get decrypted messages for a session |
