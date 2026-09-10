# Voice AI Platform — Architecture Review, Latency/Quality Fix Plan & Feature Roadmap

**Date:** 2026-09-07
**Scope:** Full review of `apps/api` (Fastify + Postgres/pgvector, Exotel telephony, OpenAI brain, Cartesia/Sarvam/ElevenLabs TTS/STT) for a multi-tenant voice-AI product intended for external commercial deployment. This document is a plan only — no code was changed to produce it.

**How this document was built:** a full read of the call pipeline (`exotel-voicebot.ts`, `voicebot-session.ts`, all STT/TTS provider services), the multi-tenancy/data model (schema + all migrations + settings/agents/number routes), the RAG/KB pipeline (`ask.ts`, `kb.ts`, `rag-prompt-utils.ts`), and the tool-calling/CRM/secrets surface (`llm.ts`, `tenant-webhooks.ts`, `crypto.ts`), cross-referenced against ~35 existing internal docs in `/docs` that already capture a lot of prior incident analysis. Where this plan repeats something your team already wrote down, it's cited so you know it's confirmed, not guessed.

---

## 0. TL;DR — the six things that matter most

1. **Your three biggest latency levers already exist in your schema and default to OFF.** `stt_streaming_enabled`, `tts_streaming_enabled`, and `rag_streaming_enabled` all default to `FALSE` (`infra/postgres/migrations/005_customer_settings_and_avatars.sql:36,49,57`). Your own internal doc measured a **58% drop in time-to-first-audio (4850ms → 2050ms)** from turning these on together (`docs/VOICEBOT_LATENCY_SUB_2S_PLAN.md`, `VOICEBOT_UTTERANCE_TIMING_ESTIMATES.md`). If any tenant was onboarded without someone manually flipping these three flags, that tenant is running in the slowest possible mode. **This is almost certainly a major source of "sometimes it's fast, sometimes it's unbearable."** Fix this first, this week, before anything else in this document.
2. **A fragile self-hosted `phi3:mini` model sits in the critical path of every RAG turn**, doing embeddings, a first-pass answer attempt, and (for multi-agent tenants) a 3-second agent-router call — with no fallback and 8-10s timeouts (`apps/api/src/services/llm.ts:7-41`, `apps/api/src/routes/ask.ts:159-241`). This is a very plausible root cause of the "RAG sometimes fails / sometimes takes forever" complaint. It needs to either be removed from the hot path or given real resilience.
3. **RAG logic is implemented twice** — once in `ask.ts` (used by the `/ask` API and simulator) and once independently, by hand, inside `exotel-voicebot.ts` (used by live calls). They already drift (your own `docs/RELATED_QUESTIONS_FALLBACK_README.md` calls this out). Every future RAG fix has to be applied twice or it silently doesn't reach real calls. This should be consolidated into one shared module.
4. **There is no cross-call resilience anywhere** — no circuit breaker, no automatic provider failover, no retry-with-backoff pattern applied consistently. Your own incident doc (`docs/OUTBOUND_CALL_NO_AUDIO_FIX_2026-07-08.md`, still uncommitted in this repo) documents a real production outage where Cartesia silently returned 0 bytes and every call — inbound and outbound — went silent, because there was no fallback TTS provider. This is the single highest-severity reliability gap for a product you're about to sell to other companies who will not tolerate silent dead air.
5. **All five requested features are buildable on the existing schema with moderate, well-contained changes** — none require a rewrite. Section 8 gives you the concrete schema and routing design for each. The good news specific to "one company, many numbers": your Exotel webhook URLs are already keyed by `customerId`, not by phone number (`apps/api/src/services/exotel-voice-urls.ts:15-16`), so multi-number support is a **server-side-only** change — no Exotel-side reconfiguration scheme change needed.
6. **Onboarding Vodafone as a second carrier requires an architectural change first, not just a second copy of the Exotel code.** The entire STT→RAG→LLM→TTS pipeline is currently embedded inside one 5,601-line file (`exotel-voicebot.ts`) that also parses Exotel's specific WebSocket wire protocol. There is zero Vodafone-related code anywhere in this repo today. Section 8.5 gives you a Telephony Provider Adapter design so a second carrier is a thin translation layer, not a second 5,600-line file.

Read section 3 for *why* your bot feels robotic and inconsistent, section 4 for what to fix this week, and section 8 for the five new features.

---

## 1. Current State Assessment

### 1.1 Voice pipeline (STT → LLM → TTS)

**What's genuinely good and worth keeping:**
- TTS is the most mature layer: all three providers (Cartesia, ElevenLabs, Sarvam) have real incremental-streaming code paths with cross-fade stitching between utterances (`speakToExotel`, `exotel-voicebot.ts:1611`; `elevenLabsTextToSpeechStreamIncremental`; persistent Cartesia WS sessions with `first`/`middle`/`last` continuation contexts).
- LLM-token → TTS streaming pipeline exists end-to-end (`createStreamingVoiceTts`, `streamChatOpenAI`) — it's just gated behind flags that default off (see §0.1).
- Greeting pre-warming/caching is a nice touch (`preWarmGreetingCache`) — cuts first-turn latency for repeat greetings.
- Filler acknowledgements ("umm, let me check that") are a real implemented feature, not a stub (`services/voice-filler-acks.ts`) — though English-only today.
- Embedding/history/agent-row loads are already parallelized with `Promise.all` in the RAG hot path (`exotel-voicebot.ts:4130-4221`) — good instinct, just not extended everywhere it could be.
- The dual-leg (outbound campaign) echo/feedback-loop problem has been fought hard and is *functionally* solved today via three layered defenses (script-playback DB lock, cross-leg text-similarity echo detection, Single Active Leg responder check) — see your own commits `dc47fed`, `ce71898`, `6e5c3cd`, `10cb131`.

**What's structurally holding latency and consistency back:**
- **STT is turn-based, not truly streaming, for every provider** — confirmed explicitly in your own doc (`VOICEBOT_LATENCY_SUB_2S_PLAN.md:41`: *"True streaming STT is not implemented yet"*). Audio is buffered until a **fixed 1500ms silence timer** fires (hand-rolled RMS energy VAD, `VAD_ENERGY_THRESHOLD=200`, `exotel-voicebot.ts:319-334`), then the *entire* utterance is sent for one-shot transcription. There is no partial-transcript hypothesis, no ASR-confidence-driven endpointing, and no speculative LLM warm-start on partial text.
- **The dual-leg "single active leg" check is a synchronous Postgres round-trip on every single turn** of every outbound-campaign call (`isActiveResponder`, `exotel-voicebot.ts:2770`) — latency tax paid every turn for a coordination problem that could be resolved with in-memory/Redis pub-sub state instead of a DB query per turn.
- **Two sequential OpenAI calls can happen per turn**: one for language detection (`detectVoiceUtteranceLanguageOpenAI`), one for the actual answer — serial, not combined, not parallelized.
- **The system prompt is rebuilt with dynamic KB content spliced before the end of the same message every turn** (`exotel-voicebot.ts:4489-4498`), which defeats OpenAI's automatic prefix-based prompt caching — you're not benefiting from a mechanism that's free money on every repeat call.
- **Session state, embedding cache, and greeting cache are all process-local, in-memory** (`voicebot-session.ts`, `services/cache.ts`). Fine for one instance; means zero cache sharing and unrecoverable in-flight calls the moment you need more than one Node process — which you will, the day you have enough customers to need horizontal scale.
- **No circuit breaker / provider failover anywhere.** OpenAI chat calls: 8s timeout, no retry, no fallback (`llm.ts:13-16`). Self-hosted embeddings: 10s timeout, no fallback (`llm.ts:7-11`). If Cartesia TTS starts returning empty audio (as it did in production per `docs/OUTBOUND_CALL_NO_AUDIO_FIX_2026-07-08.md`), every call — inbound and outbound — goes silent until a human intervenes.
- **Documented production numbers confirm the above is not theoretical:** a real call logged in `docs/VOICEBOT_UTTERANCE_TIMING_ESTIMATES.md` shows one utterance taking **8648ms total**, driven by a **7229ms LLM call**, with the doc's own conclusion calling this *"catastrophic LLM latency... the primary optimization target."*

### 1.2 RAG / knowledge base

- Retrieval is Postgres + `pgvector`, one row per Q&A pair (`kb_entries`, `init.sql:52-59`) — no chunking pipeline, no document ingestion, no reranking. This is fine for a curated-FAQ product but **there is no ANN index on the embedding column** (`ivfflat`/`hnsw` absent from every migration) — every retrieval is a brute-force scan, which degrades linearly as any tenant's KB grows and there's no per-tenant row cap.
- **Embeddings come from a self-hosted `nomic-embed-text` model** (not OpenAI), with no timeout-safe fallback (`generateEmbedding`, `llm.ts:230-268`). Only the *question* text is embedded, not the answer — retrieval quality depends on the caller's phrasing matching how the KB question was written.
- **"Is this in scope" detection uses a hardcoded distance cutoff (`topDistance > 0.8`)** applied to a self-hosted embedding model's cosine/L2 distance — not learned, not tenant-tunable in a data-driven way, and a legitimate question with unlucky post-STT phrasing can score just past this and get wrongly refused as out-of-scope.
- **A "not found" detector uses substring string-matching** (`isNotFound()`, `ask.ts:422-440`) against phrases like *"i don't have enough information"* — fragile against small local-model phrasing drift, a very plausible cause of intermittent "wrong" RAG behavior.
- **The live voice call does not call the same RAG pipeline as `/ask`** — `exotel-voicebot.ts` reimplements embedding, vector search, and prompt assembly independently (confirmed: no reference to `ask.ts`'s exports in the voicebot file). This means every RAG bugfix and tuning change must be applied twice, and your own `RELATED_QUESTIONS_FALLBACK_README.md` already names this as a known risk.
- Caching is a single in-memory LRU keyed on exact normalized question text (`services/cache.ts`) — real callers rarely repeat a question verbatim, so this rarely helps in practice, and it's process-local (same horizontal-scaling problem as above).
- KB is scoped only to `customer_id`, not `agent_id` — all agents in a company currently share one knowledge base. Relevant directly to feature #2 (multi-agent).

### 1.3 Multi-tenancy & data model

- `agents` table has existed since `init.sql` with its own `system_prompt`, but the runtime **never actually chooses between multiple agents** — `bootstrapVoicebotChatSession()` always picks `SELECT ... WHERE customer_id=$1 AND is_active=TRUE ORDER BY created_at ASC LIMIT 1` (`exotel-voicebot.ts:1256-1263`). This is documented as the known v1 shortcut in `docs/PLATFORM_EXTENSIONS_DESIGN_2026-04-23.md:51-53`, not a bug you're misreading.
- **TTS provider is resolved at the company level before the agent is even consulted** (`voice-persona.ts:73`, reading `customer_settings.tts_provider`). An agent's `cartesia_avatar_id` is silently ignored if the company's provider is `elevenlabs`. Only the *voice within* the company's chosen provider is agent-scoped today, not the provider itself.
- **The resolved voice persona is written onto the session object once and reused for the whole call** — meaning the "one voice for the whole call" behavior feature #1 wants is already the natural behavior of this code; it just needs to become provider-aware and be explicitly pinned so a mid-call agent switch (feature #2) can't silently change it.
- **Phone number ⇄ company is a hard 1:1** at the schema level: `customer_exotel_settings.customer_id UUID UNIQUE` with a single scalar `inbound_phone_number` column — there is no phone-number table at all today.
- **Good news for feature #3:** the WS/webhook URL scheme is already keyed by `customerId`, not by number (`exotel-voice-urls.ts:15-16`), and the dialed number (`to_number`) is already captured per call in `exotel_call_sessions` (migration 002/003/006). Multi-number support is realistically a server-side data-model + routing change, not an Exotel-integration rework.
- Auth is a single flat tier: `x-api-key` → `customer_id`, full read/write over everything that customer owns (`middleware/auth.ts:12-46`). No agent-scoped or number-scoped keys exist yet — relevant if you want a customer's own CRM integration credentials to only touch one agent/number.

### 1.4 Tool-calling / CRM integration readiness

- **OpenAI's tool/function-calling API is not used anywhere in this codebase today** — every LLM call shape in `llm.ts` is free-text in, free-text out. Language detection is done via a `[LANG:xx-XX]` text-prefix convention parsed with regex, not structured output. This means feature #4 (tool calling) is greenfield — there's no existing round-trip pattern to fight against, but also nothing to reuse for the execution loop itself.
- **The only existing "bot action" beyond speaking is a keyword-triggered human handoff** (`exotel-voicebot.ts:2970-2981`) — regex-matched, not LLM-decided.
- **`tenant-webhooks.ts` is a different concern than in-call tool use**: it's outbound, fire-and-forget, platform→tenant notification (call-lifecycle events), HMAC-signed, with no timeout on its `fetch()` call. Structurally reusable (signing/retry skeleton) but wrong shape for a synchronous, latency-bounded, response-matters CRM tool call mid-conversation.
- **Secret storage is inconsistent today**: a clean AES-256-GCM `encrypt`/`decrypt` utility exists (`services/crypto.ts`) but is only used for chat-message content at rest — Exotel API keys/tokens are stored as **plaintext columns** in `customer_exotel_settings`. This needs to become a deliberate, consistent convention before you add OAuth access/refresh tokens for Zoho/Salesforce, not an extension of "however Exotel does it today" (that's a pre-existing gap worth fixing regardless of the new feature).
- **No job queue / async worker system exists at all** — no BullMQ, no Redis, no cron. OAuth token refresh and async CRM writes are genuinely new infrastructure.
- HTTP timeout discipline is inconsistent across providers (ElevenLabs consistently uses `AbortSignal.timeout(60_000)`; `tenant-webhooks.ts` has none at all) — the pattern to standardize on for a customer-CRM cURL tool call is a **short, hard timeout (2-3s) with a spoken fallback**, since this runs inside a live call.

### 1.5 Telephony transport coupling (Exotel-specific today)

- `apps/api/src/routes/exotel-voicebot.ts` is **5,601 lines** and mixes three concerns that should be separate: (a) raw Exotel WebSocket wire-protocol parsing, (b) Exotel-shaped outbound message construction, and (c) the entire STT→RAG→LLM→TTS turn-processing pipeline, session bootstrapping, dual-leg coordination, echo detection, and filler-ack logic. There is no boundary between "how Exotel talks to us" and "how the voice AI actually works."
- The inbound/outbound message types (`apps/api/src/types/exotel-ws.ts`) are modeled 1:1 against Exotel's documented protocol: `connected` / `start` / `media` (base64 `slin` PCM) / `dtmf` / `stop` / `mark` events in, `media` / `mark` / `clear` out. This happens to be structurally similar to the "Twilio Media Streams"-style protocol several CPaaS/telecom vendors converge on — which is good news for building a second adapter, but today nothing distinguishes "the normalized internal event model" from "literally Exotel's JSON shape," because there is no normalized model — the pipeline code reads Exotel's field names directly.
- Settings/credentials are modeled as `customer_exotel_settings` (table name and columns — `exotel_account_sid`, `exotel_app_id`, `exotel_subdomain`, `exotel_api_key`, `exotel_api_token` — all Exotel-named), and the WS route is registered at a fixed, provider-named path (`/exotel/voicebot/:customerId`). Outbound call triggering (`exotel-outbound-call.ts`, `exotel-outbound-flow.ts`, `exotel-connect-call.ts`) all call Exotel's REST endpoints directly and build Exotel-shaped request bodies inline.
- **There is no Vodafone-related code anywhere in this repository today** (confirmed by a full repo grep) — onboarding Vodafone is genuinely new integration work, not "flip a config flag." See §8.5 for the design.

---

## 2. Why the bot feels slow and "not conversational" — synthesis

Putting the four investigations together, the human experience of "sometimes it fails, sometimes it's slow, and it doesn't feel like a conversation" has four independent causes stacking on top of each other, and you're likely experiencing whichever combination hits on a given call:

1. **Non-streaming mode is probably the default for a lot of tenants** (§0.1) — this alone is the difference between a ~2.0s and a ~4.9s reply, and if it's inconsistent per-tenant, that alone explains "sometimes fast, sometimes slow."
2. **A silence-timer-based turn boundary (1500ms fixed) instead of true streaming ASR with semantic endpointing** means the bot always waits at least 1.5s of dead air after you stop talking before it even starts thinking — this is the single biggest "does not feel conversational" contributor, independent of everything downstream. Real conversational turn-taking (interrupting, finishing a thought early) is impossible with a fixed silence timer.
3. **Two independent unreliable single points of failure sit in the hot path**: a self-hosted small LLM (embeddings + RAG pre-check + agent routing) with no fallback, and a single TTS provider per call with no failover. Either one being slow or down produces exactly "sometimes it fails / takes forever."
4. **No structured tool-calling and duplicated RAG logic** mean answers are less accurate and consistent than they could be, and any fix has to be applied in two places to actually reach live callers.

None of this requires switching away from OpenAI, Cartesia, or Sarvam. It requires: turning on what you already built, adding resilience where there is none, replacing fixed-timer endpointing with real streaming ASR + a proper VAD, and consolidating the two RAG implementations into one.

---

## 3. Priority 0 — do this week (config/flag changes, near-zero engineering risk)

These use code that already exists and is already tested in your own docs' benchmarks.

| # | Action | Why | Reference |
|---|---|---|---|
| P0-1 | Flip `stt_streaming_enabled`, `tts_streaming_enabled`, `rag_streaming_enabled` to `TRUE` as the default for all new tenants, and audit/backfill existing tenants | Documented 58% TTFA reduction, zero new code | `migrations/005:36,49,57`, `VOICEBOT_LATENCY_SUB_2S_PLAN.md` |
| P0-2 | Add a **TTS provider failover**: if primary provider returns 0 bytes / errors / times out, immediately retry once against a per-agent-configured backup provider before falling back to the generic error message | Prevents a repeat of the July 2026 "silent dead air on every call" incident | `docs/OUTBOUND_CALL_NO_AUDIO_FIX_2026-07-08.md` |
| P0-3 | Shrink the OpenAI chat-completion client timeout from 8s to ~3.5-4s **for the voice path specifically**, and speak a filler ack ("let me check that...") if no first token arrives within ~1200ms | 7+ second waits with dead silence are worse than a short filler + a slightly later real answer | `llm.ts:13-16`, `services/voice-filler-acks.ts` |
| P0-4 | Fix `tenant-webhooks.ts`'s missing `fetch` timeout | An unresponsive tenant endpoint can hold a webhook call open indefinitely today | `tenant-webhooks.ts:31,55` |
| P0-5 | Fix `voiceTtsCanRun()` to check `CARTESIA_API_KEY` presence, not just `SARVAM_API_KEY`, when provider is Cartesia | Directly caused the July incident's silent-greeting failure mode | `OUTBOUND_CALL_NO_AUDIO_FIX_2026-07-08.md:50` |
| P0-6 | Replace the `isNotFound()` substring-matching heuristic with a structured JSON response from the self-hosted/OpenAI RAG check (`{"found": bool, "answer": "..."}`) instead of parsing prose for phrases like "i don't have enough information" | Removes a fragile string-match that silently misclassifies real answers as failures whenever a model phrases "I don't know" slightly differently | `ask.ts:422-440` |
| P0-7 | Add an `ivfflat` or `hnsw` index on `kb_entries.embedding` (partitioned/filtered by `customer_id` if needed) | Cheap now, prevents retrieval degrading as tenants' KBs grow; zero downside | `init.sql:52-59` |

### 3.1 Implementation progress (2026-09-09)

**Done, applied to the live dev DB via `infra/postgres/migrations/011_roadmap_p0_and_schema.sql`:**
- **P0-7**: `hnsw (embedding vector_cosine_ops)` index added on `kb_entries.embedding` — matches the actual `<=>` cosine operator used by both `ask.ts:270-273` and `exotel-voicebot.ts`'s hand-rolled search (confirmed pgvector 0.8.2, 384-dim embeddings). At today's 92 rows the planner correctly still picks a seq scan (verified via `EXPLAIN`) — expected and fine; the index is there for when KB size grows, with zero cost today.
- **P0-4**: `tenant-webhooks.ts`'s two unguarded `fetch()` calls (`postTenantWebhook`, `postSlackIncomingWebhook`) now carry `AbortSignal.timeout(8000)`.
- **P0-5**: `voiceTtsCanRun()`/`voiceTtsBlockingReason()` (`exotel-voicebot.ts:368-408`) now have an explicit `tts_provider==='cartesia'` branch checking `CARTESIA_API_KEY`, instead of silently falling through to the `SARVAM_API_KEY` check — the exact bug that caused the July 2026 incident. **This was the one deliberate touch to `exotel-voicebot.ts` in this pass** — confirmed via `git diff` to be exactly these two branches, nothing else in the file changed. Confirmed dead-code-safe today: both live customers use `tts_provider='sarvam'`.
- **§5.5**: `customer_settings.out_of_scope_distance_threshold` (nullable) added; `ask.ts`'s hardcoded `topDistance > 0.8` gate (line ~693) now reads `outOfScopeDistanceThresholdAsk(cs)`, falling back to `0.8` when unset — verified against 8 edge cases (null/undefined/valid/out-of-range/NaN) matching the exact validation pattern already used by the sibling `ragDirectThresholdAsk`/`relatedScopeDistanceThresholdAsk` helpers. Zero behavior change until a tenant sets a custom value. Also added to `routes/settings.ts`'s Zod schema and `services/customer-settings.ts`'s `CustomerSettings` type/`ALL_SETTINGS_FIELDS`/numeric-coercion list, matching every place its siblings are wired.
- **P0-1 (partial, by design)**: `stt_streaming_enabled`/`tts_streaming_enabled`/`rag_streaming_enabled` `DEFAULT` flipped to `TRUE` for all **future** `customer_settings` rows. For the 2 *existing* customers: both already had `tts_streaming_enabled`/`rag_streaming_enabled=TRUE`; the one remaining `FALSE` (`stt_streaming_enabled` on the ElevenLabs-STT customer) was backfilled to `TRUE` after confirming it's a no-op today (that flag is only ever consumed when `stt_provider==='cartesia'`, `exotel-voicebot.ts:455,570`). Both live customers now read `{true,true,true}`.
- **Additive schema only, not wired into any live route** (same safe pattern as `company_telephony_settings` from the prior session — confirmed via `git diff` that no existing route/service file references these): `agents.tts_provider` (Feature 1, §8.1), `kb_entries.agent_id` (§5.6), `company_phone_numbers` (Feature 3, §8.3), `agent_tools`/`crm_oauth_connections`/`customer_crm_tools` (Feature 4, §8.4).

**Data-quality issue surfaced by the `company_phone_numbers` backfill, needs a human decision:** the migration found that **both existing customers share the identical `inbound_phone_number` value** (`+9102048555864`) in `customer_exotel_settings`. Since `company_phone_numbers.phone_number` is `UNIQUE` (as specified in §8.3), the backfill inserted only one row (`ON CONFLICT DO NOTHING` — safe, nothing broke) and left the second customer with no `company_phone_numbers` row at all. This wasn't something this session introduced; it's pre-existing data. Before Feature 3 (multi-number) is ever built out, someone needs to determine: is this a real duplicate DID misconfiguration, or dummy/test data for one of the two customers? Whichever customer's number is wrong needs correcting in `customer_exotel_settings` before `company_phone_numbers` can be trusted as a source of truth.

**Deliberately NOT done this pass, with reasons** (see the full triage in this session's plan): P0-2 (TTS failover), P0-3 (voice-path timeout + filler-ack trigger), P0-6 (structured JSON not-found response) — each is a real behavior change to the live call pipeline or the LLM prompt contract, needing staged rollout/real-call testing this session can't do. All of §4 (streaming ASR/VAD replacement, Redis, circuit breakers, the 3 specific Sarvam/ElevenLabs/Cartesia streaming bugs), §5.1 (RAG pipeline consolidation), §5.2/5.3/5.7, all of §6, and the **runtime behavior** for Features 1-4 (only schemas landed) remain open — each requires either new infrastructure not in this stack, or a substantial, carefully-tested change to `exotel-voicebot.ts`'s live call-handling code.

---

## 4. Latency architecture — the structural fix (P1)

Once P0 is live, the next tier of work replaces the fixed-timer, turn-based model with something closer to how modern voice-AI frameworks actually get sub-second, natural-feeling turns.

### 4.1 Replace fixed-silence-timer endpointing with real streaming ASR + proper VAD

- Swap the hand-rolled RMS-energy VAD (`VAD_ENERGY_THRESHOLD=200`) for a real voice-activity model. **Silero VAD** (MIT-licensed, ONNX, runs in a few ms per frame, used by LiveKit Agents and Pipecat) is the standard open-source choice here and is a drop-in replacement for "is this audio speech" without needing a full ASR round-trip.
- For ASR, prefer genuinely streaming providers that emit **interim hypotheses**, not just a streamed-audio-in/single-final-transcript-out socket. Cartesia's own STT and Sarvam's STT both support this mode if driven correctly — the finding was that your integration currently only finalizes once at end-of-utterance (`cartesiaSttFinalizeStreamingSession`), not that the providers themselves can't do it. If Indic-language accuracy on Cartesia continues to be a problem (see `CARTESIA_STT_CALL_LOG_INTERPRETATION_2026-06-27_1002.md` — garbled Hindi/Marathi transcription), evaluate **Deepgram Nova-3** or **AssemblyAI Universal-Streaming** as a secondary/fallback STT specifically for those languages — both have mature true-streaming multilingual support and sub-300ms partial-result latency.
- Use interim transcripts to drive **semantic endpointing**: don't cut off on silence alone — use a lightweight heuristic or a small turn-detection model (LiveKit's open-sourced `turn-detector` model is a good reference architecture: a tiny classifier that looks at the last partial transcript and decides "sentence complete" vs "still speaking") so a caller who pauses mid-sentence isn't cut off, and a caller who trails off with a complete thought isn't kept waiting the full 1500ms.
- This is the single change most responsible for making the bot *feel* conversational rather than like a walkie-talkie.

### 4.2 Collapse serial round-trips into one

- Merge language detection into the main answer call via structured output (ask the model to emit `{"lang": "hi-IN", "reply": "..."}` in one call) instead of a separate `detectVoiceUtteranceLanguageOpenAI` call before the main one.
- Replace the per-turn Postgres round-trip for dual-leg "single active leg" coordination with an in-memory/Redis-backed flag (pub/sub or a shared TTL key) — same correctness, no DB latency tax on every turn.
- Move the agent-router LLM call (currently a separate `chatSelfHosted` call with a 3s timeout, `ask.ts:180-230`) to the embedding-similarity approach described in §9.2 below — this removes an entire LLM round trip from every multi-agent tenant's first turn.

### 4.3 Fix prompt structure for caching

- Restructure the system message so the **static instruction/persona text comes first and stays byte-identical across turns**, and the **dynamic KB context is isolated as its own trailing message** (or clearly delimited block) rather than spliced mid-message. This lets OpenAI's automatic prefix caching actually hit, which is free latency and cost reduction on every call after the first.

### 4.4 Move to shared, not process-local, state

- Introduce **Redis** for: the embedding cache, the greeting-audio cache, and customer-settings cache (all currently in-memory `Map`/LRU structures scoped to one Node process). This is required the moment you run more than one API instance, which a multi-tenant SaaS product will need for both scale and availability.
- Add basic **circuit breaker** behavior (a library like `cockatiel` or `opossum`) around every external call in the hot path — OpenAI, embeddings, each TTS provider, each STT provider — so a provider having a bad minute fails fast (with the P0-2 failover or a graceful degraded response) instead of every call paying the full timeout.

### 4.5 Diagnosed: why "streaming enabled" still silently falls back to non-streaming

This was reported directly (streaming flags flipped on, but calls still behave like the buffered path) and traced to **three separate, provider-specific bugs**, not one shared cause. Turning on `tts_streaming_enabled`/`rag_streaming_enabled` (§0.1) is necessary but not sufficient until these are fixed — a tenant can have both flags on and still get non-streaming behavior depending on which TTS provider/model they're on and whether a transient error occurs.

**Sarvam — a bare `try/catch` silently and permanently downgrades the whole utterance on any transient error.** The true incremental-streaming path (`exotel-voicebot.ts:2225-2274`) wraps the `for await` loop over `sarvamTtsStreamIncremental(...)` in a `try/catch` that, on *any* error, logs a low-severity trace event (`pipeline.tts.incremental_fallback`) and falls through to the buffered path — for that entire utterance, not just the failed chunk. Compounding this: `sarvamTtsStreamIncremental` itself (`services/sarvam.ts:181-267`) makes its `fetch()` call with **no timeout and no retry**, unlike every other Sarvam call in the same file (which consistently use `AbortSignal.timeout(...)`). Any transient network blip trips this. Nothing above `voiceTrace` severity surfaces it, so there's currently no way to see how often this fires without manually grepping traces.

**ElevenLabs — incremental streaming is structurally disabled by design for the standard 8kHz Exotel trunk when using the v3 model.** `elevenLabsTtsOutputFormatForTelephony()` (`services/elevenlabs.ts:714-729`) requests `pcm_16000` from ElevenLabs when the model is `eleven_v3` and the trunk is ≤8kHz, because v3 cannot emit native 8kHz PCM — this then requires a 16kHz→8kHz resample before the audio can reach Exotel. `useElIncrementalPipe` (`exotel-voicebot.ts:1741-1742`) requires the TTS output rate to *exactly equal* Exotel's rate, so `16000 === 8000` is false and the buffered path is always taken. This is a known, deliberate limitation, not an accident — your own `docs/ELEVENLABS_V3_IMPLEMENTATION_REPORT.md:34` states: *"Buffered path unchanged when resampling is still required."* Net effect: any tenant on ElevenLabs v3 with a normal phone-call trunk rate never gets incremental delivery, regardless of the `tts_streaming_enabled` flag.

**Cartesia — the opposite problem: no fallback at all, so a stream error kills the whole answer instead of just the speed.** `beginReplyStream()` (`services/cartesia-tts-ws.ts:248-256`) calls `await this.connect()` completely unguarded, and its caller, `ensureCartesiaReply()` (`exotel-voicebot.ts:2540-2548`), awaits it with no try/catch either. A connect/stream failure (bad key, brief TLS/network hiccup, a Cartesia-side blip) throws all the way up through `pushDelta` to `runVoicebotAskPipeline`'s single outer catch (`exotel-voicebot.ts:4660`), which discards the already-generated LLM answer entirely and speaks the generic `"Sorry, I was unable to process that"` fallback. This is a worse failure mode than Sarvam's: the caller doesn't get a slower correct answer, they get no answer.

**Fix directions (design-level, not implemented here):**
1. Add `AbortSignal.timeout(~6-8s)` and one bounded retry to `sarvamTtsStreamIncremental`'s fetch call; promote the incremental-fallback trace to a `warn` plus a per-tenant/per-provider counter (feeds the observability dashboard in §6.4) so this is visible and alertable, not silent.
2. For ElevenLabs v3 at ≤8kHz: implement streaming-aware resampling — resample small rolling windows of audio as they arrive rather than requiring the entire buffered response before resampling. The full-buffer requirement, not the rate mismatch itself, is what actually needs fixing.
3. Wrap Cartesia's `beginReplyStream`/`connect()` call in a try/catch that falls back to the buffered `speakToExotel()` call — the same graceful-degrade pattern Sarvam already has (even with its own bugs) — so a Cartesia hiccup costs latency, not the entire answer.
4. Once fixed, this becomes an ideal first target for the circuit-breaker/provider-failover work in §4.4/§6.2 — these are exactly the kind of per-call transient failures that pattern is meant to catch uniformly instead of via three different bespoke (and inconsistent) fallback behaviors per provider.

### 4.6 Target metrics

| Metric | Current (documented) | Target |
|---|---|---|
| Time-to-first-audio, p50 | ~2050ms (streaming on) / ~4850ms (streaming off) | < 1200ms |
| Time-to-first-audio, p95 | 7000-8600ms (observed) | < 2500ms |
| Silence after caller stops speaking before bot starts responding | 1500ms fixed | 300-700ms (semantic endpointing) |
| Provider failure → dead air | Yes (observed incident) | Never — always failover or a spoken apology within 1s |

---

## 5. RAG accuracy & reliability fix plan (P1)

1. **Consolidate the two RAG implementations.** Extract `ask.ts`'s pipeline (embedding → vector search → context build → LLM → fallback tiers) into a shared `services/rag-pipeline.ts` module, and have `exotel-voicebot.ts` call the same module instead of its own hand-rolled copy. This is the single highest-leverage reliability fix in this section — every other RAG improvement you make will otherwise need to be done twice, forever.
2. **Add a resilient fallback for the self-hosted embedding/answer model.** If `generateEmbedding()` or the self-hosted RAG pre-check times out or errors, fall back to Postgres full-text search (`tsvector`/`ts_rank`) on `kb_entries` rather than failing the turn outright. This gives you a degraded-but-functional answer instead of "Unable to generate an answer at this time" when the self-hosted box has a bad moment.
3. **Seriously consider removing the self-hosted model from the critical path entirely.** It currently does three jobs (embeddings, RAG pre-check, agent routing) with no fallback and 8-10s timeouts, and is the most likely single explanation for intermittent RAG failures. Options, cheapest first:
   - Keep self-hosted embeddings but add the fallback in (2), and stop using it for the RAG pre-check answer (go straight to the parallel self-hosted+OpenAI race you already have as an option, or straight to OpenAI, for the actual answer).
   - Move to OpenAI's `text-embedding-3-small` for embeddings (fast, cheap, no separate infra dependency, no timeout-prone self-hosted box to babysit) — this trades a small ongoing per-call cost for removing an entire class of failure.
4. **Embed a synthesized `question + key terms from answer` string, not just the question**, to improve recall when a caller phrases things differently than the stored FAQ question.
5. **Make the out-of-scope distance cutoff tenant-tunable and monitored**, not a single hardcoded `0.8` — log the distance score on every "refused as out of scope" event so you can see per-tenant false-refusal rates and adjust, rather than guessing.
6. **Add per-agent KB scoping** — `kb_entries.agent_id` (nullable = shared/company-wide). Required for feature #2 to make sense (a "billing" agent and a "sales" agent should generally see different knowledge, with a shared fallback tier).
7. **Replace the exact-string embedding cache with a genuinely useful cache**: either a semantic cache (round embeddings into buckets, or cache at "which KB entry ID was the top match" granularity per tenant with a short TTL) since real callers rarely phrase things identically but frequently ask the same handful of underlying questions.

---

## 6. Reliability, resilience & multi-tenant scale-out (P1/P2)

This is the section most directly about "I'm going to sell this to other companies" — a single-tenant hobby project and a commercial multi-tenant platform have different bars for "acceptable failure."

1. **Consistent secret handling.** You already have a solid AES-256-GCM primitive (`crypto.ts`) — apply it consistently to *every* credential column (Exotel API key/token today are plaintext; this needs fixing before OAuth tokens for Zoho/Salesforce are added on top of an inconsistent pattern).
2. **Circuit breakers + provider failover as a standard pattern**, not a one-off fix for TTS (§4.4) — apply the same shape to STT and to the LLM brain itself (e.g., if OpenAI has a regional incident, having a documented "degrade to X" path, even if X is just "apologize and offer a callback," beats an unhandled hang).
3. **Move all session/cache state that needs to survive a process restart or be shared across instances into Redis/Postgres**, keeping only truly per-connection state (the live WebSocket object itself) in process memory.
4. **Observability**: you already have `voicebot-trace.ts`/`rag-trace.ts` — extend this into real per-call structured tracing (OpenTelemetry spans per pipeline stage: STT, RAG, LLM, TTS) with a dashboard on p50/p95 TTFA, error rate, and provider latency **per tenant**, plus alerting when a tenant's error rate or latency spikes. When you're selling this externally, you need to know a customer's calls are degrading before they email you about it.
5. **Per-tenant isolation and quotas.** As a multi-tenant platform, make sure one tenant's KB size, call volume, or a buggy webhook can't degrade another tenant's latency (e.g., cap `rag_top_k`, cap KB row count with a clear upgrade path, rate-limit outbound webhook/tool-call fan-out per tenant).
6. **Synthetic/canary test calls.** A scheduled job that places a real test call through each critical path (each TTS provider, each STT provider, at least one call per active tenant per day) and alerts on failure would have caught the July 2026 Cartesia-0-bytes incident automatically instead of via a customer complaint.

---

## 7. Should you keep using OpenAI as the "brain"? Model/provider guidance

**Yes — OpenAI is a fine choice and is what most commercial voice-AI platforms in this space (Vapi, Bland, Retell) also default to or support.** The problem your investigation surfaced isn't "wrong provider," it's "not used in the way that makes a voice product feel fast":

- **Use streaming everywhere** (§0.1) — this is worth more than any model swap.
- **Use a smaller/faster OpenAI model for the lightweight decisions** (agent routing structured-output, language tagging) — `gpt-4o-mini` or `gpt-4.1-mini`/`gpt-4.1-nano` — and reserve a stronger model only for turns that actually need deep reasoning. Right now a full model is used uniformly and a *separate* fragile self-hosted model does the "fast/cheap" jobs — flip that: let OpenAI's small fast models do the cheap jobs reliably, and stop depending on the self-hosted box for latency-critical work.
- **Use OpenAI's native tool/function-calling for the CRM feature (§9.4)** rather than inventing a text-convention protocol — it's mature, well-documented, supports streaming + tool calls together, and this codebase currently uses zero of it, so there's no legacy pattern to migrate away from.
- **If you want to push latency below what GPT-4o-mini/4.1-mini can hit (sub-300ms LLM time-to-first-token) for simple FAQ-style turns specifically**, evaluate **Groq** (LPU-hosted open models, extremely fast inference) as an *optional* fast-lane brain for simple, low-stakes turns, with OpenAI remaining the default/fallback for anything requiring tool calls or careful instruction-following. This is optional — don't add it until the streaming + resilience work above is done and you've measured where you actually still are latency-bound.
- **Stop using the self-hosted `phi3:mini` for anything on the critical call path** unless you specifically invest in making that infrastructure as reliable as OpenAI's (dedicated hardware, health checks, autoscaling, its own circuit breaker) — right now it's the least reliable link carrying some of the most latency-sensitive jobs.

**On architecture patterns worth borrowing from open-source voice-AI frameworks** (you don't need to adopt any of these wholesale, but they're the right reference points for the redesign in §4 and §9.2):
- **Pipecat** (Daily.co, open source) — frame-based real-time pipeline architecture with proper interruption/barge-in handling; good reference for how to structure a truly streaming STT→LLM→TTS pipeline instead of a turn-based one.
- **LiveKit Agents** (open source) — has an open-sourced turn-detection model and a plugin architecture cleanly separating STT/LLM/TTS/VAD providers; good reference for the semantic-endpointing work in §4.1.
- **Vocode** (open source) — another reference implementation of a streaming voice-agent pipeline with provider abstraction, useful for provider-failover pattern ideas.
- **Silero VAD** — the standard lightweight open-source VAD model, referenced in §4.1.

---

### 7.1 OpenAI SDK / Agents SDK for orchestration, vs. the current custom flow

**Recommendation: keep the current custom flow for the telephony/audio plumbing — do not replace it — but adopt OpenAI's native tool-calling loop for the new tool-calling feature, and treat the fuller Agents SDK as worth a bounded evaluation for the tool/orchestration layer specifically, not the voice pipeline itself.**

- **The value of the current flow is entirely in telephony-specific work no generic SDK provides**: Exotel's 320-byte chunk alignment, per-provider sample-rate handling, the dual-leg SAL/echo-suppression pattern, filler acks, provider-specific sentence-boundary cutting. Replacing the core pipeline with a generic orchestration framework means rebuilding all of this from scratch on someone else's abstraction, for no latency benefit — don't do this.
- **OpenAI's Realtime API** (speech-to-speech, built-in server VAD, native low-latency streaming) is the one genuinely relevant alternative to the current architecture, and it would directly target the "not conversational" complaint. But it uses OpenAI's own STT and voices — adopting it wholesale would mean giving up the Cartesia/Sarvam voice and Indic-language differentiation this whole roadmap (and feature #1 specifically) is built around, since your own docs already show Cartesia's STT struggling on some Hindi/Marathi audio in ways OpenAI's Whisper-based STT is not guaranteed to fix. Treat this as a bounded side experiment (does it measurably beat the current pipeline's latency for English-heavy tenants) rather than a direction to commit to now.
- **OpenAI's Agents SDK** (handoffs, tool definitions, guardrails, built-in tracing) is a much better fit for **Feature 4 (tool calling, §8.4)**, which is genuinely greenfield today — there's no existing round-trip loop to migrate away from. Using it (or its patterns) saves you hand-rolling the tool-execution loop and gives you tracing largely for free, which also partially covers the observability gap in §6.4.
- It is a weaker fit for **Feature 2's mid-call agent auto-switch (§8.2)** specifically: the SDK's "handoff" mechanism is still an LLM deciding to call a `transfer_to_X` tool — the same latency cost as the existing slow router already flagged in §5.3/§8.2, not the near-zero-cost embedding-similarity approach recommended there. Use it for tool execution; don't expect it to solve agent-switching latency.

---

## 8. Feature Roadmap

Each feature below states: what exists today (from the investigation), the schema/design change, and how it interacts with the latency work above so you don't build something that reintroduces the same bottlenecks.

### 8.1 Feature 1 — Agent-level TTS provider (voice pinned for the whole call)

**Today:** provider is chosen at company level (`customer_settings.tts_provider`) before the agent is even consulted; only the *voice within* that provider is agent-scoped, via `agents.avatar_id`/`elevenlabs_avatar_id`/`cartesia_avatar_id`. Once resolved, the voice is already pinned onto the session for the call's duration — that part is already correct.

**Change required:**
- Add `agents.tts_provider` (nullable, same `CHECK` domain as `customer_settings.tts_provider`: `sarvam|elevenlabs|cartesia`). `NULL` = inherit company default — this exact nullable-inherits-company pattern was already recommended for other agent-level settings in your own `docs/PLATFORM_EXTENSIONS_DESIGN_2026-04-23.md:315`, just never applied to the provider field.
- Update `applyAgentVoicePersonaToSession()` (`voice-persona.ts`) to resolve `ttsProvider` from the agent row **first**, falling back to `customer_settings.tts_provider` only when the agent's is null, then pick the matching avatar table exactly as it does today.
- **Critical for correctness with feature #2 (multi-agent switching):** once resolved at call start, `session.ttsProvider`/`session.ttsSpeaker`/etc. must be treated as immutable for the rest of the call. When the multi-agent router switches active agent mid-call, it must re-resolve `system_prompt` and KB scope but **must not** re-run voice-persona resolution — otherwise a mid-call agent switch would change the caller's voice mid-sentence, which is explicitly the opposite of what you asked for.

### 8.2 Feature 2 — Multi-agent system with fast, automatic mid-call switching

**Today:** no dynamic agent selection exists at all — the oldest active agent is always used. A prototype "agent router" exists only in `ask.ts` (text-chat path) and costs a full extra LLM call (up to 3s timeout) per session.

**Design — two separate decisions, both cheap:**

*Initial agent selection (call start):* resolve in this priority order, each essentially free:
1. Explicit routing by dialed number (`company_phone_numbers.default_agent_id` — see feature #3).
2. IVR/DTMF selection if configured.
3. Fallback: company's designated default agent (replacing today's arbitrary "oldest `created_at`").

*Mid-call auto-switch (the actual "fast approach" ask):* the key insight from the investigation is that **you already compute an embedding of every caller utterance for KB retrieval** — reuse that same vector, at zero extra latency, for agent routing:
- Precompute (once, at agent-creation/update time, not per call) a small set of "topic/capability" embeddings per agent — e.g., embed the agent's own description/system-prompt summary, or a curated list of example intents per agent.
- On every turn, alongside the existing KB-entry similarity search, do a cheap in-process cosine-similarity comparison of the utterance embedding against each active agent's topic centroid(s).
- If a different agent's topic scores meaningfully higher than the currently active agent's (with a hysteresis/confidence margin so you don't flip-flop on ambiguous turns), switch: swap `system_prompt`, KB scope (see §5.6 above — `kb_entries.agent_id`), and `agent_id` on the session/`chat_sessions` row — **without** touching the pinned TTS voice (§8.1).
- This adds **no LLM round trip and no extra network call** — it's a handful of dot products against pre-computed vectors, which is why it's fast. This directly replaces and removes the existing 3-second LLM-based router in `ask.ts`, which should be deprecated once this ships.
- Keep shared conversation history across the switch (you already do this for dual-leg calls via `chat_sessions` reuse, commit `10cb131` — same pattern applies here) so the caller doesn't have to repeat themselves after a switch.
- Log every switch decision (from-agent, to-agent, confidence margin, transcript) for tuning — you'll want to adjust the confidence margin per tenant based on real call data.

### 8.3 Feature 3 — One company, many phone numbers

**Today:** hard 1:1 via `customer_exotel_settings.customer_id UNIQUE` + a single scalar `inbound_phone_number` column. Good news: the WS/webhook URL scheme is already per-`customerId`, not per-number, so Exotel-side app/flow configuration does not need to change.

**Schema change:**
```
company_phone_numbers
  id                UUID PK
  customer_id       UUID FK -> customers
  phone_number      TEXT UNIQUE
  label             TEXT               -- "Sales line", "Support line", etc.
  default_agent_id  UUID FK -> agents (nullable)
  is_primary        BOOLEAN DEFAULT FALSE   -- used for legacy single-number lookups & default outbound caller ID
  is_enabled        BOOLEAN DEFAULT TRUE
  created_at        TIMESTAMPTZ DEFAULT now()
```
- Shared Exotel account credentials (`exotel_account_sid`, API key/token, subdomain) **stay at the company level** on `customer_exotel_settings` — only the DID and its default agent move to the new per-number table.
- Update `getExotelSettingsByNumber()` to: look up the number in `company_phone_numbers`, resolve `customer_id`, then join back to the company's shared Exotel credentials — instead of today's "the tenant's one number" query.
- **Inbound routing:** at the `start` WS event (where `to_number` is already parsed and stored on `exotel_call_sessions`), look up `company_phone_numbers.default_agent_id` for that number and use it as the initial agent (feeds directly into §8.2's initial-selection priority order), falling back to the company default agent if the number has none configured.
- **Outbound routing:** `exotel-outbound-call.ts` and `outbound-campaigns.ts` currently resolve caller ID from a single scalar (`default_outbound_caller_id || inbound_phone_number`). Add an optional `phone_number_id` (or explicit number string) parameter to the campaign/call-trigger request, defaulting to the company's `is_primary` number when omitted, so a customer can run different campaigns from different numbers.
- Migration path for existing tenants: backfill one `company_phone_numbers` row per existing `customer_exotel_settings.inbound_phone_number`, marked `is_primary=TRUE`, so nothing breaks for current customers on day one.

### 8.4 Feature 4 — Tool calling via three CRM source types

**Today:** zero tool-calling infrastructure exists (§1.4) — this is genuinely new build, but on a codebase with no legacy pattern to fight.

**Foundation — adopt OpenAI's native tool-calling** (not a custom text convention). Define a small, versioned tool registry per agent, each entry tagged with its source type:

```
agent_tools
  id            UUID PK
  agent_id      UUID FK -> agents
  tool_name     TEXT           -- exposed to the LLM as the function name
  source_type   TEXT CHECK IN ('native_crm','oauth_crm','customer_curl')
  config        JSONB          -- shape depends on source_type, see below
  is_enabled    BOOLEAN DEFAULT TRUE
```

**Type 1 — Native Convixx CRM (own database):** implement as plain internal function handlers (e.g., `lookup_customer_by_phone`, `create_lead`, `update_deal_stage`) that query/write your own Postgres tables directly. This is the fastest and safest tier — sub-50ms, no network hop, no external auth — and should be the reference implementation the other two tiers are benchmarked against for added latency.

**Type 2 — Third-party CRM via OAuth (Zoho, Salesforce):**
```
crm_oauth_connections
  id                UUID PK
  customer_id       UUID FK
  agent_id          UUID FK (nullable — company-wide vs agent-scoped connection)
  provider          TEXT CHECK IN ('zoho','salesforce', ...)
  access_token_enc  TEXT   -- AES-256-GCM via the EXISTING crypto.ts helper
  refresh_token_enc TEXT   -- same
  expires_at        TIMESTAMPTZ
  scope             TEXT
  metadata          JSONB  -- provider-specific (Zoho org ID, Salesforce instance URL, etc.)
```
- Use the standard OAuth2 authorization-code flow for tenant onboarding (a one-time "Connect your Zoho/Salesforce" admin flow, not something that happens mid-call).
- **This is the first place in the codebase these tokens will be encrypted at rest correctly** — use the existing `crypto.ts` AES-GCM helper consistently (fixing the plaintext-Exotel-credential gap noted in §1.4/§6.1 while you're at it is strongly recommended, same helper, same migration effort).
- Token refresh needs a background job, not an inline mid-call check — this is where the "no queue system exists" gap (§1.4) becomes unavoidable: introduce a minimal job runner (BullMQ + Redis, which you'll also want for §4.4's shared cache) to refresh tokens ~5 minutes before expiry, so a live call never blocks on an OAuth refresh round-trip.
- Wrap every Zoho/Salesforce API call with the same short-timeout + circuit-breaker pattern as everything else in the hot path (2-3s hard timeout, since this executes inside a live call).

**Type 3 — Generic customer CRM via cURL/webhook:**
```
customer_crm_tools
  id              UUID PK
  agent_id        UUID FK
  tool_name       TEXT
  description     TEXT          -- fed to the LLM as the function description
  http_method     TEXT
  url_template    TEXT          -- with {param} placeholders
  headers_template JSONB        -- may include an encrypted API key via crypto.ts
  param_schema    JSONB         -- JSON Schema, becomes the OpenAI tool's `parameters`
  response_mapping JSONB        -- how to extract the fields the LLM should see from the response
  timeout_ms      INTEGER DEFAULT 2500
```
- This is effectively a small no-code "generic HTTP connector" (same shape as a Zapier/n8n custom webhook step) — the customer configures it once via a settings UI, and it becomes an OpenAI tool definition automatically from `param_schema`.
- **Security requirements, non-negotiable given this executes arbitrary customer-configured HTTP calls from your infrastructure:** enforce HTTPS only, block requests to private/internal IP ranges (SSRF protection), hard timeout (2-3s) with `AbortSignal.timeout`, response size cap, and never let a customer's tool config exceed a global concurrency/rate limit that could be used to hit your own infrastructure or a third party at volume.

**Execution loop pattern (applies to all three types), for latency:**
- On a tool call request from the model, immediately trigger a filler acknowledgement ("let me check that for you") — you already have this infrastructure (`voice-filler-acks.ts`) — while the tool executes, rather than sitting in silence.
- If the tool doesn't return within its timeout budget, tell the caller you'll follow up rather than hanging the call, and complete the write/lookup asynchronously via the same job-queue infrastructure, notifying via the existing `tenant-webhooks.ts` pattern (extended with a timeout fix, per P0-4) or SMS/email.
- Log every tool call (tool name, source type, latency, success/failure) per call for the same per-tenant observability dashboard recommended in §6.4 — tool-call latency will be a new, customer-controlled variable in your total turn latency, and you'll want visibility into which customers' CRMs are slow.

### 8.5 Feature 5 — Multiple telephony providers (Exotel + Vodafone), one provider per company, one WebSocket per call

**The requirement as stated:** onboard Vodafone alongside Exotel, and each customer connects through exactly one WebSocket to exactly one telecom provider — no mixing providers within a company, no ambiguity about which carrier a given live call belongs to.

**Today:** as detailed in §1.5, there is no provider abstraction at all — Exotel's wire protocol, REST APIs, and settings shape are hard-coded directly into the same file as the core voice-AI turn logic. Building Vodafone support by copy-pasting `exotel-voicebot.ts` into a `vodafone-voicebot.ts` would double every future pipeline fix (STT/RAG/TTS/latency work from §3-§6) across two files forever — the exact same maintenance trap already identified for the duplicated RAG logic in §5.1. This needs to be solved with a real abstraction, not a second copy.

**Design: Telephony Provider Adapter pattern**

Split the current monolith into two layers:

1. **Core voice-AI pipeline (provider-agnostic).** Turn orchestration (STT → RAG/LLM → TTS), session state, dual-leg coordination, echo detection, filler acks, persona/voice resolution, agent routing. This layer knows nothing about Exotel or Vodafone — it only speaks a normalized internal event model.
2. **Telephony Provider Adapter (one per carrier).** The only place that speaks a given carrier's wire protocol. Each adapter is responsible for:
   - WebSocket handshake/auth for that carrier.
   - Translating the carrier's inbound messages into a **normalized `CallEvent`**: `connected`, `start { fromNumber, toNumber, callId, streamId, mediaFormat }`, `mediaChunk { pcm16, sampleRateHz, timestampMs }`, `dtmf { digit }`, `stop { reason }`, `markAck { name }`.
   - Translating the core pipeline's outbound intents — `sendAudio(pcm)`, `sendMark(name)`, `clearQueuedAudio()` (barge-in), `hangup()`, `transferToNumber()` — into that carrier's outbound wire format.
   - Triggering outbound calls via that carrier's REST API, behind a common `triggerOutboundCall(params)` signature.
   - Normalizing status callbacks (answered / failed / completed / busy / no-answer) into one shared shape for the rest of the platform (billing, campaign tracking, webhooks) to consume identically regardless of carrier.

```
interface TelephonyProviderAdapter {
  parseInboundMessage(raw: string): CallEvent | null;
  buildAudioFrame(streamId: string, pcm: Buffer): OutboundFrame;
  buildMarkFrame(streamId: string, markName: string): OutboundFrame;
  buildClearFrame(streamId: string): OutboundFrame;      // barge-in support — confirm Vodafone can do this (see checklist)
  triggerOutboundCall(params: OutboundCallParams): Promise<{ callId: string }>;
  parseStatusCallback(payload: unknown): CallStatusEvent;
}
```

`ExotelAdapter` becomes the first (refactored, not rewritten) implementation of this interface — today's `types/exotel-ws.ts` shapes and Exotel-specific logic in `exotel-voicebot.ts` move into it largely as-is. `VodafoneAdapter` is added later as a second, independent implementation. The core pipeline function (`handleVoicebotTurn(session, event)` or equivalent) is written once and called by both adapters — this is what actually stops Vodafone support from costing a second multi-thousand-line file.

**Enforcing "one company → one provider, one WebSocket per call":**
- Model it explicitly at the data layer, not just as a convention: each company has exactly one active `company_telephony_settings` row (`customer_id UNIQUE`), so a company is structurally incapable of being configured for two providers at once.
- Each live call is exactly one WebSocket connection, owned by exactly one adapter instance — this falls out naturally once the adapter split exists, since a call's WS connects to a specific provider's route and there is no code path that lets a single call's audio be sourced from two different carriers.
- This does **not** conflict with §8.3's multi-number design — a company can still have many phone numbers, they just all resolve to that one company's one configured provider. If you ever need a *carrier migration* window (moving a customer from Exotel to Vodafone gradually, number by number), keep a nullable `provider_override_id` on `company_phone_numbers` for that transitional case only — but the default and the common case is exactly what you asked for: one provider per company.
- This also simplifies a subtlety in the existing dual-leg (Single Active Leg) design: today's cross-leg coordination logic implicitly assumes both legs of an outbound campaign call are Exotel WS connections. Once it's rewritten against the normalized session model (not raw Exotel fields), it keeps working unmodified for a Vodafone-only company too — and the one-provider-per-company rule means you'll never need to handle a call whose two legs are on *different* carriers, which would otherwise be a much harder coordination problem.

**Schema changes:**
```
telephony_providers                 -- static registry
  id            TEXT PK              -- 'exotel' | 'vodafone'
  display_name  TEXT
  is_active     BOOLEAN

company_telephony_settings          -- generalizes today's customer_exotel_settings
  id                    UUID PK
  customer_id           UUID FK UNIQUE     -- enforces one provider per company
  provider_id           TEXT FK -> telephony_providers
  credentials_enc       JSONB              -- provider-specific creds, AES-GCM via the EXISTING crypto.ts helper
                                            -- (also the moment to fix §1.4's plaintext-Exotel-credential gap)
  wss_base_url          TEXT
  bootstrap_https_url   TEXT
  is_enabled            BOOLEAN
  use_sandbox           BOOLEAN
  metadata              JSONB              -- provider-specific extras that don't need to be named columns
```
- **Migration path:** backfill one `company_telephony_settings` row per existing `customer_exotel_settings` row, `provider_id='exotel'`, moving `exotel_account_sid`/`exotel_api_key`/`exotel_api_token` into encrypted `credentials_enc`. Zero behavior change for current Exotel customers on day one.

**WS route generalization:**
- Replace the fixed `/exotel/voicebot/:customerId` path with a per-provider mount — e.g. `/telephony/exotel/voicebot/:customerId` and `/telephony/vodafone/voicebot/:customerId` — each a thin Fastify WS route whose only job is: instantiate the right adapter, hand normalized events into the shared core pipeline function, and hand the adapter's translated outbound frames back to the socket. Outbound call triggering becomes provider-dispatched the same way: look up `company_telephony_settings.provider_id` for the company, call that adapter's `triggerOutboundCall()`.

**What you need from Vodafone before an adapter can actually be built** (checklist to hand to whoever owns that relationship — none of this exists in the repo in Vodafone-specific form today). **Update 2026-09-08: items 1, 2, and 6 are now confirmed** — see the protocol summary immediately below; items 3, 4, 5, 7 are still open.
1. ~~Real-time media transport spec~~ — **confirmed**: WebSocket, JSON events, Media-Streams-style (mirrors Exotel/Twilio). See below.
2. ~~Audio format~~ — **confirmed**: raw 16-bit linear PCM, 8kHz, 128kbps, base64. See below.
3. Auth/handshake mechanism (API key header, signed URL, mTLS, IP allowlisting?) — **still open**, see below.
4. Outbound call origination REST API — the equivalent of today's `exotel-outbound-call.ts` trigger — **still open**, see below.
5. Status callback / webhook format for general call lifecycle events (answered, failed, completed, busy, no-answer) — needed to normalize into `CallStatusEvent` for billing/campaign tracking — **still open**, see below (a *different*, already-documented webhook exists for agent-patching specifically — see below).
6. ~~Barge-in / mid-stream "clear queued audio" support~~ — **confirmed supported**, with a documented caveat. See below.
7. Concurrency limits, per-account number provisioning model (does one Vodafone account support many DIDs the way Exotel's `account_sid`/subdomain does?), and sandbox/test-call availability for development — **still open**.

### 8.5.1 VI (Vodafone) Voice Streaming protocol — spec received 2026-09-08

The customer supplied Vodafone's own integration document, *"Voice Streaming – User Manual – Agent Calling"*. Vodafone's product is referred to as **"VI"** throughout that source document (Vodafone Idea's voice-streaming product — not a typo; "VI" and "Vodafone" mean the same provider below). This directly answers checklist items 1, 2, and 6 above and gives enough detail to firm up the `TelephonyProviderAdapter` design from a guess into a real implementation target.

**Transport — confirmed WebSocket, JSON events, `ws`/`wss`, Media-Streams-style (same family as Exotel/Twilio).** VI's flow builder exposes streaming as a **"Streaming Object"** with:
- `Streaming Type`: `Unidirectional` (VI → your endpoint only — caller audio out, nothing played back; for live STT/transcription/supervisor monitoring/coaching) or `Bidirectional` (VI ↔ your endpoint — for voice bots and conversational IVR, the type this platform needs).
- `Streaming Mode`: `Foreground` or `Background` — **but Bidirectional is always Foreground.** In Foreground, the call flow blocks on the stream and only advances when the call disconnects, the WebSocket closes, the client explicitly stops it, or `Total Stream Duration` elapses. Unidirectional can run `Background` (flow advances immediately, stream runs alongside). This is a real difference from whatever flow-blocking model Exotel uses and needs to be accounted for in how `VodafoneAdapter` integrates with outbound campaign flow — a Vodafone bidirectional voicebot leg is flow-blocking by construction; there's no "fire and forget" bidirectional mode to fall back on.
- Streaming can also be started directly via VI's REST API on incoming, outgoing, patching, and Click-to-Call calls (not just from the visual flow builder) — same shape as `triggerOutboundCall()`.
- The WebSocket URL can be **static or dynamic** (a variable resolved via an in-flow API call to your endpoint before VI connects) — this is VI's equivalent of Exotel's per-customer applet URL, and should map cleanly onto whatever the new `/telephony/vodafone/voicebot/:customerId` route scheme ends up needing.
- Up to **3 custom key-value parameters** can be attached to the Streaming Object config; VI passes them through verbatim in the `start` event's `custom_parameters`. This is VI's equivalent of Exotel's custom-parameter passthrough and is the natural place to carry routing hints (e.g. `agentId`, campaign id) if the URL path alone isn't enough.

**Event model.** VI → your endpoint: `connected`, `start` (sent once, immediately after `connected`), `media`, `dtmf` (bidirectional + Voice Bot flows only), `stop`, `mark` (bidirectional only). Your endpoint → VI (bidirectional only): `media`, `mark`, `clear`, `exit`. All messages are JSON, correlated by a `room_id` (VI's equivalent of Exotel's `streamSid`) plus a monotonic `sequence_number` — this maps directly onto the `CallEvent`/`OutboundFrame` design already specced above: `room_id` → `streamId`, `start.start.call_id` → `callId`, `start.start.cli`/`dni` → `fromNumber`/`toNumber`, `start.start.media_format` → `mediaFormat`. If the IVR server receives malformed data, an unsupported size, or an unsupported format from your endpoint, VI unilaterally sends `stop` with a reason and disconnects the call — the adapter's outbound framing needs to respect VI's chunk-size rules (below) exactly, not just "close enough."

Condensed payload shapes, from the vendor doc:
```jsonc
// VI -> you, once, immediately after "connected"
{
  "event": "start", "sequence_number": 1, "room_id": "<room id>",
  "start": {
    "room_id": "<room id>", "call_id": "<call id>",
    "cli": "<caller number>", "dni": "<recipient number>",
    "custom_parameters": { "queuename": "premium", "product": "radio" },
    "media_format": { "encoding": "raw", "sample_rate": "8000", "bit_rate": "128000" }
  }
}

// media, both directions (bidirectional)
{ "event": "media", "sequence_number": 3, "room_id": "<room id>",
  "media": { "chunk": 2, "timestamp": "10", "payload": "<base64-encoded PCM>" } }

// you -> VI: request graceful stream teardown (used to trigger agent patching, see below)
{ "event": "exit", "room_id": "<room id>" }

// you -> VI: cancel not-yet-played queued audio (barge-in)
{ "event": "clear", "room_id": "<room id>" }
```

**Audio format — confirmed: raw 16-bit linear PCM, 8kHz, 128kbps, base64-encoded, both directions.** Same encoding family Exotel uses at 8kHz — worth explicitly diffing against whatever sample rate `pcm-audio.ts` assumes for Exotel today, but on paper the core pipeline's existing 8kHz PCM handling needs **no new resampling path** for Vodafone specifically (unrelated to the ElevenLabs-v3-at-8kHz resampling problem in §4.5, which is a TTS-provider issue, not a carrier issue).

**New, Vodafone-specific constraint not present in the Exotel integration today — `media` chunk-size rules:**
- Minimum **1.6 KB** (~100ms of audio) — smaller risks jitter/broken audio from network instability.
- Maximum **50 KB** — larger risks timeouts/delayed playback.
- Must be a **multiple of 160 bytes** (VI's framing unit: 160 bytes = 10ms of 8kHz 16-bit PCM).

This needs its own chunking function inside `VodafoneAdapter.buildAudioFrame()` — do not reuse Exotel's chunking logic unmodified (§7.1 notes Exotel uses 320-byte-aligned chunks); the two carriers have different framing constraints, which is exactly the kind of detail the `TelephonyProviderAdapter` split exists to isolate per-carrier instead of leaking into the shared core pipeline.

**Barge-in / clear-queued-audio — confirmed supported, answering checklist item 6.** The `clear` event (client → VI) cancels not-yet-played queued audio; `VodafoneAdapter.buildClearFrame()` maps onto it directly. Documented caveat worth carrying into the interruption-handling work in §4.1: VI's own doc states `clear` only cancels **whole not-yet-started queued messages**, not the one currently playing — e.g. if two 5-second audio messages are queued and `clear` fires at second 3 into the first, only the second (not-yet-started) message is cleared; the one already playing finishes. **Practical implication: send audio in smaller chunks** (nearer the 1.6KB floor than the 50KB ceiling) specifically so barge-in feels responsive — this is a vendor-documented, direct tradeoff between chunk size and interruption latency that whoever tunes Vodafone chunking needs to know about explicitly.

**New capability not present in the Exotel integration today — "patch to a live agent" as a first-class VI flow, not something you'd have to build from scratch:**
- Your endpoint sends `{"event":"exit","room_id":...}` (or the stream disconnects any other way) → VI calls a **webhook you configure** with `{"Callid":..., "dni":..., "cli":...}` → your webhook responds `{"callstatus":"1"|"0","rm_number":"<10-digit agent number>"}` (`1` = transfer the call to that number, `0` = hang up). VI then produces **two separate call recordings** — one for the bot-streaming portion, one for the live-agent leg.
- This directly relates to the "keyword-triggered human handoff" noted in §1.4 (today regex-matched and implicitly Exotel-only). For Vodafone, the natural implementation is: on handoff trigger, send `exit`; have this ping-back webhook resolve the right live-agent number (from `company_phone_numbers`/an agent-routing table) and return it. Worth checking whether Exotel has an equivalent mechanism so handoff logic can live in the provider-agnostic core (§8.5's layer 1) rather than being reimplemented per adapter.

**Still open — not answered by this doc (checklist items 3, 4, 5, 7; get these before writing `VodafoneAdapter` code):**
- **3. Auth/handshake mechanism** — the Streaming Object config UI shows an `Authentication` checkbox next to the WebSocket URL field, but the doc doesn't say what it does (header token? signed URL? mTLS?) — ask VI directly.
- **4. Outbound call origination REST API contract** — the doc confirms streaming can be triggered via API "for all types of calls like incoming, outgoing, patching and Click-to-Calls" and references "our standard API(s)"/"API documentation" without including it — request the actual REST reference (the equivalent of what `exotel-outbound-call.ts` calls today).
- **5. General call-lifecycle status callbacks** (answered/failed/busy/no-answer, for billing/campaign tracking) — the doc only documents the agent-patching webhook above, not a general lifecycle callback; confirm whether a separate one exists.
- **7. Concurrency limits, DID provisioning model, sandbox availability** — not covered in this doc; still needs a direct answer from the Vodafone account contact.

### 8.5.2 Implementation progress (2026-09-08 → 2026-09-09)

Two sessions of work have landed against this section so far — recorded here so the next session picks up from the real state, not an assumed one:

**Done, applied to the live dev DB:**
- `infra/postgres/migrations/010_telephony_provider_adapter.sql` — `telephony_providers` (seeded `exotel`/`vodafone`) and `company_telephony_settings` (`customer_id UNIQUE` — enforces one provider per company at the schema level), backfilled 1:1 from `customer_exotel_settings` for both existing customers.
- `apps/api/scripts/backfill-telephony-credentials.ts` — ran for real; both customers' Exotel credentials are now also present as an AES-256-GCM-encrypted JSON blob in `company_telephony_settings.credentials_enc` (verified by decrypting and matching against the plaintext originals). `customer_exotel_settings` itself is untouched — the live route still reads from there.
- `apps/api/src/types/telephony-provider.ts` — the normalized `CallEvent`/`OutboundFrame`/`CallStatusEvent`/`TelephonyProviderAdapter` types. **Corrected during adapter-building**: `buildAudioFrame` now returns `OutboundFrame[]` (not a single frame) — Exotel's real chunking is stateful (a per-call `PcmChunkBuffer` accumulating partial pushes), so one PCM push can legitimately emit zero, one, or several wire frames.
- `apps/api/src/types/vodafone-ws.ts` — VI's raw wire types, `chunkVodafoneAudio()` implementing its 1.6KB-50KB/160-byte-alignment rule (§8.5.1), and (added when building the adapter) `VodafoneChunkBuffer`, a stateful counterpart mirroring `PcmChunkBuffer` for PCM arriving as a stream of pushes rather than one buffer.
- `apps/api/src/services/telephony-settings.ts` (new) — generic `company_telephony_settings` DAO (`getTelephonySettings`, `getDecryptedCredentials`), mirroring `exotel-settings.ts`'s shape/cache pattern but carrier-agnostic.
- `apps/api/src/services/exotel-adapter.ts` (new) — a **complete, verified `ExotelAdapter implements TelephonyProviderAdapter`**: `parseInboundMessage` (wraps the existing `parseExotelMessage`, maps to normalized `CallEvent`s), `buildAudioFrame`/`buildMarkFrame`/`buildClearFrame` (reuses the existing `PcmChunkBuffer` from `services/pcm-audio.ts` unchanged, so chunking is byte-for-byte the same rule the live route uses), `triggerOutboundCall` (wraps the existing, unmodified `exotelConnectCall()`), `parseStatusCallback` (wraps the existing `statusPayloadIndicatesCalleeLegAnswered()`). Verified against fixed sample payloads plus one read-only round-trip against a real `company_telephony_settings` row — see `apps/api/scripts/verify-exotel-adapter.ts` (`npx ts-node scripts/verify-exotel-adapter.ts` from `apps/api`; all 21 checks pass as of this writing).
- `apps/api/src/services/vodafone-adapter.ts` (new) — a **`VodafoneAdapter implements TelephonyProviderAdapter`**, same pattern: `parseInboundMessage`, `buildAudioFrame`/`buildMarkFrame`/`buildClearFrame`/`buildExitFrame` (VI's `exit` has no Exotel equivalent — a genuinely Vodafone-only capability the interface's optional method exists for) are fully implemented and verified against fixed VI-shaped sample payloads (`apps/api/scripts/verify-vodafone-adapter.ts`, all 30 checks pass). Also exports `isVodafonePatchWebhookRequest`/`buildVodafonePatchResponse` for the "patch to live agent" webhook flow (§8.5.1). **`triggerOutboundCall` and `parseStatusCallback` deliberately throw an explanatory "not implemented" error** rather than a real implementation — VI's outbound-call REST API contract and general call-status-callback shape are still open items (§8.5.1 items 4/5) with no vendor spec to build against; guessing a fictional contract for a real outbound-call trigger was judged worse than an honest stub. No real Vodafone customer/credentials exist yet, so the credential-encryption path was verified generically (encrypt/decrypt round-trip on a sample credential object, same `crypto.ts` primitive `ExotelAdapter` uses against real data) rather than against a live DB row.

**Discovered this session — a parallel Laravel-side telephony schema already exists on the same database, unrelated to this work:** the live DB (shared with a Laravel SaaS control-plane app, confirmed via its own `migrations` table) has `telephony_routes`/`telephony_settings`/`telephony_tests` tables (Laravel migration batch 6, `2026_08_04_100001_create_telephony_tables`, all currently empty) plus `companies.engine_customer_id`/`engine_api_key`/`engine_admin_token` (`2026_07_25_100001_add_engine_columns_to_companies`) — the latter strongly suggests `companies` (Laravel's bigint-keyed tenant table) links to this Node app's `customers` (UUID-keyed) via `engine_customer_id`, with Laravel likely acting as the admin/config UI that writes into `customer_exotel_settings` via the Node API rather than storing real secrets itself (`telephony_settings.has_api_key`/`has_api_token` are booleans, not values). **No naming/schema collision occurred** — `telephony_providers` (this session's/last session's table) has a `text` PK with no sequence, confirming Laravel didn't create it; Laravel's `telephony_settings`/`telephony_routes` are separate, differently-shaped tables I have not touched. But `telephony_settings` is currently Exotel-only (no `provider_id` column, no Vodafone awareness) and `telephony_routes` looks like Laravel's own take on per-company routing (no phone-number column, unlike the roadmap's §8.3 `company_phone_numbers` sketch). **Flagging for whoever owns the Laravel codebase**, not something to fix from here: if Vodafone needs to be selectable from Laravel's admin UI, `telephony_settings` will eventually need a `provider_id` column and Vodafone-shaped credential fields — that's a Laravel-repo migration, out of this session's reach (this repo has no visibility into Laravel's models/migrations, and altering a Laravel-owned table from here would create schema drift its own migration history doesn't know about). Also noted in passing: `customer_exotel_settings` has grown an `exotel_rest_cluster` column not referenced anywhere in this Node codebase or its migrations — likely added by the same external process; left untouched since its purpose isn't known here.

**Deliberately NOT done yet — `exotel-voicebot.ts` and `voicebot-session.ts` have zero changes:**
A closer read of `exotel-voicebot.ts` (5,601 lines, full read by an Explore pass) found the coupling is deeper than the original section 6/§8.5 framing assumed: raw wire-*parsing* is a small, bounded surface (~200-300 lines), but Exotel's *naming* is threaded through everything downstream of it — `VoicebotSession` (`voicebot-session.ts`) directly imports `ExotelMediaFormat` from `types/exotel-ws.ts` and is keyed by `streamSid`/`callSid`; the DB schema is `exotel_call_sessions`/`exotel_call_sid`; and STT/RAG/TTS/echo-detection/SAL tracing throughout `processUtterance`/`runVoicebotReplyPipelineAfterTranscriptReady`/`runVoicebotAskPipeline` tags every log line with `stream_sid`/`call_sid`. Renaming that and cutting the live `/exotel/voicebot/:customerId` route over to route through `ExotelAdapter` is a large, high-risk rewrite of a pipeline whose dual-leg SAL/echo-suppression logic took 4 recent commits to stabilize (`dc47fed`, `ce71898`, `6e5c3cd`, `10cb131`) — deliberately not attempted in the same pass as building the adapter. `ExotelAdapter`'s `triggerOutboundCall` is also a minimal implementation (doesn't yet replicate `exotel-outbound-call.ts`'s campaign `CustomField`/`streamUrl`/`statusCallback`/default-caller-ID wiring) — full parity is cutover-phase work, not adapter-building work.

**Next steps, in order:** (1) ~~build `VodafoneAdapter`~~ — **done, see above**; (2) get answers to §8.5.1's remaining open items (VI auth mechanism, outbound REST API contract, general status-callback shape) so `VodafoneAdapter.triggerOutboundCall`/`parseStatusCallback` can become real implementations instead of explanatory stubs; (3) plan the actual cutover: renaming `VoicebotSession`'s Exotel-named fields to carrier-agnostic ones and re-threading `CallEvent` through the core pipeline functions, ideally behind a feature flag so it can be validated against real Exotel traffic before Vodafone traffic ever touches it — this is the point at which a real Vodafone WS route (`/telephony/vodafone/voicebot/:customerId`) would also get built, since there's nowhere for `VodafoneAdapter` to be wired in before the core pipeline is carrier-agnostic.

**Sequencing:** do the Exotel-adapter extraction (splitting the core pipeline out of `exotel-voicebot.ts` into the provider-agnostic core + `ExotelAdapter`) as part of Phase 1 below, **before** building `VodafoneAdapter` or onboarding real Vodafone traffic — this refactor is a prerequisite, not an add-on, exactly like the RAG-pipeline consolidation in §5.1. Building Vodafone support directly against the current monolith would mean copy-pasting the entire pipeline a second time. (Per §8.5.2 above, the `ExotelAdapter` implementation itself is now done and verified in isolation — what remains of this prerequisite is the cutover: rewiring the live route and renaming `VoicebotSession`'s fields.)

---

## 9. Phased delivery plan

**Phase 0 (this week, config-only):** all of §3 (P0-1 through P0-7). No architecture changes, immediate latency and reliability improvement.

**Phase 1 (structural latency + reliability, foundational for everything else):**
- Consolidate RAG pipeline (§5.1) — do this before building per-agent KB scoping on top of two divergent implementations.
- Circuit breakers + provider failover pattern, applied uniformly (§4.4, §6.2).
- Introduce Redis (shared cache + will be needed for job queue in Phase 3 anyway).
- Real streaming ASR + VAD replacement (§4.1) — the highest-effort, highest-payoff item; budget the most time here.
- **Telephony Provider Adapter extraction (§8.5)** — split `exotel-voicebot.ts`'s core pipeline out from Exotel-specific wire-protocol handling, land `company_telephony_settings`/`telephony_providers`, and migrate existing customers onto the `ExotelAdapter` with zero behavior change. Do this in the same phase as the RAG consolidation — it's the same category of fix (remove a duplication trap before it's paid for twice) and it's a hard prerequisite for onboarding Vodafone.

**Phase 2 (features that build on Phase 1's schema/session model):**
- Feature 1 (agent-level TTS provider) — small, do first, validates the "pinned session persona" pattern.
- Feature 3 (multi-number) — moderate, mostly additive schema + routing.
- Feature 2 (multi-agent auto-switch) — depends on per-agent KB scoping (§5.6) and the pinned-voice invariant from Feature 1.
- **Feature 5, part 1 (§8.5)** — once the adapter split from Phase 1 has landed and proven itself on real Exotel traffic, send Vodafone the integration checklist from §8.5 and begin `VodafoneAdapter` development in parallel with the other Phase 2 features — it has no dependency on Features 1-3.

**Phase 3 (new infrastructure, largest scope):**
- Feature 4 (tool calling, all three source types) — depends on Redis/job-queue (introduced in Phase 1) for OAuth refresh and async fallback, and on the consistent secret-encryption convention (§6.1).
- **Feature 5, part 2** — cut real Vodafone traffic over once `VodafoneAdapter` has been validated against Vodafone's sandbox (if available) and a small pilot set of numbers/customers.

**Ongoing, in parallel throughout:** observability/tracing (§6.4) and canary test calls (§6.6) — build these alongside Phase 1 so you can actually measure whether each change helped, per tenant, rather than guessing from anecdotal call reports. Once Vodafone is live, extend canary calls to run against both providers so a carrier-specific regression is caught the same way a code regression would be.

---

## 10. Open decisions for you to make

### 10.1 Self-hosted embedding model → OpenAI: decided, with numbers

**Decision inputs you asked for — time impact and cost impact of switching `generateEmbedding()` (`llm.ts:230-268`) from the self-hosted `nomic-embed-text` model to OpenAI's `text-embedding-3-small`:**

**Time:** your own call logs (`docs/Streaming call.json`, `docs/CARTESIA_CALL_LOG_INTERPRETATION_2026-06-25_1344.md:95`, `docs/VOICEBOT_UTTERANCE_TIMING_ESTIMATES.md:57`) show the self-hosted model's *real measured* latency ranges from **~30-150ms on a good turn up to ~1000ms+ on a bad one**, with an unbounded worst case up to the 10s client timeout (`llm.ts:7-11`) on failure — no SLA, no fallback. OpenAI's embeddings endpoint is a mature, high-availability production API; for a short (~10-30 token) query like a transcribed voice utterance, typical round-trip latency is commonly in the **150-400ms range** from a well-connected server, with a much tighter P95/P99 than a self-hosted box with no redundancy. **Be precise about what actually improves: this is not guaranteed to beat the self-hosted model's best case** (30-150ms is genuinely fast when the local box is healthy) — the real win is **eliminating the long tail and the failure mode**: no more 1s+ spikes, no more 10s timeouts, no more turns that fail outright because the self-hosted box had a bad moment. If your median-case self-hosted latency is closer to the 1s figure logged in your own traces than the 30-150ms best case, you'd likely see a **net median improvement too**. Recommend measuring both side by side for ~50-100 real logged questions (you already have real question text captured in your traces) before fully committing, using the exact wording in §5.3.

**Cost:** `text-embedding-3-small` is **$0.02 per 1 million input tokens** (verified current pricing, Sept 2026). A typical transcribed voice question runs roughly 10-20 tokens. At that size:

| Turns/month (≈ embedding calls) | Extra monthly cost |
|---|---|
| 10,000 | ~$0.003 (under a cent) |
| 100,000 | ~$0.03 |
| 1,000,000 | ~$0.30 |
| 10,000,000 | ~$3.00 |

**This cost is negligible at any realistic scale** — it will not show up as a line item next to your OpenAI chat-completion or TTS/STT provider costs, which are orders of magnitude larger per call. It's also worth noting the self-hosted model isn't actually "free" today — it's a fixed infrastructure cost (a GPU/CPU box you're running and babysitting regardless of call volume) plus the engineering time spent on the reliability issues this document already documents, versus OpenAI's pure pay-per-use cost that's this cheap. **Recommendation: switch.** The cost is immaterial and the reliability/tail-latency case is strong; keep the self-hosted box only if there's a data-residency requirement (e.g., a customer contractually requiring transcripts never leave your infrastructure) that OpenAI can't satisfy.

### 10.2 STT provider comparison for Indic languages: standalone test tool built

Both Deepgram and AssemblyAI currently offer no-credit-card trial credit (Deepgram: $200; AssemblyAI: $50 — confirmed Sept 2026), so a real side-by-side accuracy test is doable today at zero cost. A standalone comparison page has been added at **`tools/stt-comparison/index.html`** — open it directly in a browser (no build step, no server, doesn't touch the Convixx app at all). Paste in trial API keys from each provider (stored only in your browser's `localStorage`), upload a real recorded call snippet (or record fresh audio via mic) in English/Hindi/Marathi, and it runs both providers in parallel and shows transcript, confidence, and latency side by side. Two things it does **not** replace: (1) it uses each provider's *file-based* API, so AssemblyAI's timing includes upload+queue overhead and isn't a fair proxy for their real-time streaming latency — treat this tool as an **accuracy** test, and benchmark real-time streaming separately once you've picked a provider worth pursuing further; (2) if Marathi isn't supported by a given provider/model, the tool will simply surface the API's error — that's itself the answer to whether it's viable today.

### 10.3 Mid-call agent auto-switch criteria: decided

Refining §8.2's design per your direction: switch agents mid-call only when **both** conditions hold, not on a generic similarity-margin heuristic:
1. **The currently active agent looks low-confidence/out-of-scope for the caller's question** — reuse the exact out-of-scope distance signal already computed for RAG scoping (§5.5's tenant-tunable KB distance cutoff) against the *current* agent's KB/topic scope, rather than inventing a second confidence metric.
2. **A candidate agent's topic-similarity score for that same utterance is above its own confidence threshold** — using the pre-computed per-agent topic embeddings from §8.2.

Only switch when both are true: current agent scores as a poor match *and* a specific other agent scores as a good match for that exact query. This is a cleaner trigger than a bare similarity margin because it directly reuses signal you're already computing for RAG (no new metric to tune from scratch), and it avoids switching just because a candidate scores marginally higher on an ambiguous utterance that the current agent could still reasonably handle. Still tune the two thresholds (current-agent low-confidence cutoff, candidate-agent high-confidence cutoff) per tenant based on real call data, same as recommended for the RAG out-of-scope cutoff in §5.5.

### 10.4 CRM tool-call monitoring: resolved — built on the SaaS side

You'll build tool-call monitoring (per-tool latency, success/failure rate, per-customer health) into your own SaaS admin panel rather than needing external tooling — this matches the logging already recommended in §8.4's execution-loop pattern (tool name, source type, latency, success/failure per call) and the per-tenant observability dashboard in §6.4. No further design needed here beyond what's already specified in those sections; this note just closes the loop so it's not tracked as a gap.

### 10.5 Still open

- **Whether customer-CRM cURL tools (§8.4, Type 3) are self-serve from day one or require your team's review before going live** — given the SSRF/security surface, a lightweight manual review gate for the first several customer-configured tools (before fully self-serve) is a reasonable risk-reduction step for a young product.
- **Whether the `provider_override_id` transitional field (§8.5) is worth building now or deferred until you actually have a customer mid-migration between carriers** — it's cheap to add alongside the rest of the multi-number schema in §8.3, but there's no reason to build the migration *workflow* (UI, number-by-number cutover tooling) before you have a concrete customer who needs it.
- **Get Vodafone's protocol/API details (the §8.5 checklist) in hand before committing engineering time to `VodafoneAdapter`** — **partially resolved 2026-09-08**: the WebSocket media protocol, audio format, chunking rules, and barge-in behavior are now confirmed (§8.5.1) and are enough to design the adapter's message-translation layer concretely. Still missing before implementation can start: the auth/handshake mechanism, the outbound-call REST API contract, general call-status callbacks, and account-level concurrency/provisioning/sandbox details (§8.5.1's four remaining open items) — chase these with the Vodafone account contact next.
