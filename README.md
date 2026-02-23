# Convixx RAG + LLM Backend

## Project Overview

Convixx is a multi-tenant AI Voice Calling Platform backend.

This Node.js application handles knowledgebase management and intelligent
question answering with a multi-step verification pipeline. It runs locally
during development and will be deployed to its own server later.

### What is already in place (external servers)

- **Server 1 (LLM Server):** Self-hosted LLM at `https://ai.convixx.in`
  with OpenAI-compatible API (qwen2.5 for chat, embeddings endpoint for vectors)
- **Server 2 (DB Server):** PostgreSQL with pgvector extension installed

### What this project builds

- Node.js backend (runs locally, connects to both external servers)
- KB stored in question-answer (Q&A) format, linked per customer
- Each customer gets a unique API key -- all requests authenticate via this key,
  which determines which customer's KB to query
- Multi-agent support: each customer can create multiple agents, each with its
  own name, description, and system prompt
- Agent selection: pass `agent_id` explicitly or let the LLM auto-route to the
  best agent based on the user's question
- Ask API: multi-step answer pipeline with self-hosted LLM, verification,
  and OpenAI fallback
- Later: deploy this backend to its own server

## Infrastructure

```
+---------------------------+
|  LOCAL (development)      |
|  or DEPLOYED (production) |
|                           |        +---------------------+
|  This Project             +------->| Server 1 (LLM)     |
|  Node.js Backend          |        | ai.convixx.in       |
|  (Fastify)                |        | - qwen2.5 (chat)   |
|                           |        | - embeddings        |
|                           |        +---------------------+
|                           |
|                           |        +---------------------+
|                           +------->| Server 2 (DB)       |
|                           |        | PostgreSQL 15+      |
|                           |        | pgvector extension  |
|                           |        +---------------------+
|                           |
|                           |        +---------------------+
|                           +------->| OpenAI API          |
|                           |        | (fallback only)     |
+---------------------------+        +---------------------+
```

## Tech Stack

- **Runtime:** Node.js (Fastify)
- **Database:** PostgreSQL 15+ with pgvector (Server 2, already set up)
- **Self-hosted LLM:** OpenAI-compatible API at `https://ai.convixx.in` (Server 1, already set up) - qwen2.5 + embeddings
- **Fallback LLM:** OpenAI ChatGPT API (used only when self-hosted response fails verification)
- **Language:** TypeScript

## Answer Pipeline (Multi-Step)

When a user asks a question via `POST /ask`, the backend runs through these
steps to ensure response quality while minimizing OpenAI costs:

```
User Question
     |
     v
[1] Embed question via self-hosted embedding model
     |
     v
[2] Vector search: retrieve top K relevant Q&A pairs from pgvector
     |  (scoped to the customer identified by API key)
     |
     v
[3] Build RAG prompt: system_prompt + matched Q&A context + question
     |
     v
[4] Call self-hosted LLM --> get initial response
     |
     v
[5] Verification: call self-hosted LLM again to cross-check
     |  whether the response is correct given the KB context
     |
     +---> Response is CORRECT --> return response to user
     |
     +---> Response is WRONG or UNCERTAIN
              |
              v
[6] Fallback: call OpenAI ChatGPT API with the same RAG prompt
     |  (log token usage + cost to DB)
     |
     v
[7] Return OpenAI response to user (include cost info)
```

Steps 1 and 2 can run in parallel with any preparatory work. Steps 4 and 5 are
sequential (5 depends on 4). Step 6 only fires when verification fails, keeping
OpenAI costs as low as possible.

## Folder Structure

```
convixx/
  apps/
    api/
      src/
      package.json
      .env
  infra/
    postgres/
      init.sql
  docs/
  README.md
```

## Database Schema

Tables live on PostgreSQL (Server 2, already running). Use `init.sql` as
reference or run it against the DB server to bootstrap.

`infra/postgres/init.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS vector;

-- customers
CREATE TABLE IF NOT EXISTS customers (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  system_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
  created_at TIMESTAMP DEFAULT NOW()
);

-- API keys: each customer can generate a key to authenticate requests
-- the key determines which customer's KB is accessed
CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  key TEXT NOT NULL UNIQUE,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW()
);

-- agents: multiple per customer, each with its own system prompt
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT 'You are a helpful assistant.',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- knowledgebase in Q&A format (one row per question-answer pair)
-- each entry belongs to a customer
CREATE TABLE IF NOT EXISTS kb_entries (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  embedding VECTOR(768),
  created_at TIMESTAMP DEFAULT NOW()
);

-- speed up vector search scoped to a customer
CREATE INDEX IF NOT EXISTS kb_entries_embedding_idx
ON kb_entries USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- track OpenAI API usage and cost per request
CREATE TABLE IF NOT EXISTS openai_usage (
  id UUID PRIMARY KEY,
  customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  prompt_tokens INT NOT NULL DEFAULT 0,
  completion_tokens INT NOT NULL DEFAULT 0,
  total_tokens INT NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  cost_usd NUMERIC(10,6) NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Node.js Backend Setup

### Create API Project

```bash
cd apps/api
npm init -y
npm install fastify dotenv pg zod axios uuid openai
npm install -D typescript ts-node-dev @types/node
npx tsc --init
```

### Environment Variables

Create `apps/api/.env`:

```
PORT=8080

# PostgreSQL (Server 2)
PG_HOST=15.207.255.114
PG_PORT=5432
PG_USER=convixx_user
PG_PASS=P@ssw0rd#2026
PG_DB=convixx_kb

# Self-hosted LLM (Server 1) - OpenAI-compatible API
LLM_BASE_URL=https://ai.convixx.in/v1
LLM_API_KEY=849f49126fb69331fe5bd0326f171560757db80ea86de567ca4dcc060432499d
LLM_MODEL=qwen2.5:1.5b

# OpenAI (fallback only)
OPENAI_API_KEY=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
OPENAI_MODEL=gpt-4o-mini
```

### Run backend (local development)

```bash
npm run dev
```

Server starts at `http://localhost:8080`. Connects to the external LLM and DB
servers using the URLs/IPs in `.env`.

## API Endpoints

### Health Endpoints

- GET `/health` -- Returns API status
- GET `/health/db` -- Checks PostgreSQL connection (Server 2)
- GET `/health/vector` -- Checks pgvector extension (Server 2)
- GET `/health/llm` -- Checks self-hosted LLM at ai.convixx.in (Server 1)
- GET `/health/embedding` -- Checks embedding generation at ai.convixx.in (Server 1)

### Create Customer

POST `/customers`

```json
{
  "name": "MarriageWale",
  "system_prompt": "You are MarriageWale support agent. Keep replies short."
}
```

Returns the created customer with its `id`.

### Get / Update Customer

GET `/customers/:id` -- Retrieve a single customer.

PUT `/customers/:id` -- Update name, system_prompt, or both.

```json
{
  "name": "MarriageWale Premium",
  "system_prompt": "You are a premium support agent."
}
```

### Generate API Key

POST `/customers/:id/api-key`

Generates a unique API key for the customer. This key is used in all subsequent
requests to identify the customer and scope KB access.

```json
{
  "api_key": "cvx_a1b2c3d4e5f6..."
}
```

### Agents (Multi-Agent Support)

Each customer can have multiple agents. Each agent has its own system prompt, name, and description.

**Create Agent:** POST `/agents` (requires `x-api-key`)

```json
{
  "name": "Sales Agent",
  "description": "Handles pricing and booking queries",
  "system_prompt": "You are a sales agent. Answer concisely about pricing."
}
```

**List Agents:** GET `/agents` (requires `x-api-key`)

**Get Agent:** GET `/agents/:id` (requires `x-api-key`)

**Update Agent:** PUT `/agents/:id` (requires `x-api-key`) -- update name, description, system_prompt (any combination)

**Delete Agent:** DELETE `/agents/:id` (requires `x-api-key`)

### Upload Knowledgebase (Q&A format)

POST `/kb/upload`

Header: `x-api-key: <customer-api-key>`

Upload one or more Q&A pairs. The API key identifies the customer, and entries
are stored exclusively under that customer.

```json
{
  "entries": [
    {
      "question": "Where is MarriageWale located?",
      "answer": "MarriageWale is based in Kolhapur, Maharashtra."
    },
    {
      "question": "What is MarriageWale?",
      "answer": "MarriageWale is a matrimonial app."
    }
  ]
}
```

Backend will:

- validate API key and resolve customer
- for each Q&A pair, generate an embedding of the question
- store question + answer + embedding into `kb_entries` table (Server 2)

### Ask a Question (Main Feature)

POST `/ask`

Header: `x-api-key: <customer-api-key>`

The API key determines which customer's KB to search. Optionally pass an
`agent_id` to use a specific agent's system prompt, or omit it to let the LLM
auto-select the best agent.

```json
{
  "question": "Where is MarriageWale located?",
  "agent_id": "optional-agent-uuid",
  "session_id": "optional-session-uuid"
}
```

Response includes the answer, agent info, and if OpenAI was used, the cost:

```json
{
  "session_id": "...",
  "agent_id": "...",
  "agent_name": "Sales Agent",
  "answer": "MarriageWale is located in Kolhapur.",
  "source": "self-hosted",
  "openai_cost_usd": null,
  "response_time_ms": 5200
}
```

## How Retrieval Works (RAG)

Vector search finds the most similar KB questions for the current customer:

```sql
SELECT question, answer
FROM kb_entries
WHERE customer_id = $1
ORDER BY embedding <=> $2
LIMIT 5;
```

Top 5 most relevant Q&A pairs become context for the LLM prompt. The customer_id
is resolved from the API key, ensuring strict tenant isolation.

## Example Test Flow (End-to-End)

### Step 1: Start backend locally

```bash
cd apps/api
npm run dev
```

### Step 2: Health check

```bash
curl http://localhost:8080/health
curl http://localhost:8080/health/db
curl http://localhost:8080/health/llm
```

### Step 3: Create customer

```bash
curl -X POST http://localhost:8080/customers \
  -H "Content-Type: application/json" \
  -d '{"name":"DemoCustomer","system_prompt":"Answer short and polite."}'
```

### Step 4: Generate API key

```bash
curl -X POST http://localhost:8080/customers/<customer-uuid>/api-key
```

Save the returned `api_key` -- it is used for all subsequent requests.

### Step 5: Upload KB (Q&A pairs)

```bash
curl -X POST http://localhost:8080/kb/upload \
  -H "Content-Type: application/json" \
  -H "x-api-key: <api-key>" \
  -d '{"entries":[{"question":"What is Convixx?","answer":"Convixx is an AI voice platform."}]}'
```

### Step 6: Ask Question

```bash
curl -X POST http://localhost:8080/ask \
  -H "Content-Type: application/json" \
  -H "x-api-key: <api-key>" \
  -d '{"question":"What is Convixx?"}'
```

Response will include the answer, which source was used (self-hosted or openai),
and the OpenAI cost if the fallback was triggered.
