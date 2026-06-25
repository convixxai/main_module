# Cartesia TTS — Post-Implementation Checklist

**Status:** Code implemented (Phase 1). Run database SQL before testing.

---

## 1. SQL to run (in order)

| Step | File / query |
|------|----------------|
| 1 | Run full migration: `infra/postgres/migrations/008_cartesia_avatars.sql` |
| 2 | Configure tenant + sample avatars: `docs/sql/cartesia_voicebot_setup.sql` (replace `YOUR_CUSTOMER_UUID`, etc.) |

---

## 2. Environment variables

| Variable | Required |
|----------|----------|
| `CARTESIA_API_KEY` | **Yes** for Cartesia TTS |
| `OPENAI_API_KEY` | Only if `tts_humanizer_enabled = true` |
| `CARTESIA_USD_PER_MILLION_CREDITS` | Optional (cost estimates in simulator) |

Restart API after setting env vars.

---

## 3. Tenant configuration (minimum)

1. `customer_settings.tts_provider = 'cartesia'`
2. `tts_default_speaker` = Cartesia voice UUID (or use `cartesia_avatars`)
3. `tts_model = 'sonic-3.5'`
4. `tts_streaming_enabled = true` (recommended)
5. `rag_streaming_enabled = true` (optional, lower latency)
6. `cartesia_max_buffer_delay_ms = 0`
7. `cartesia_emotion_mode = 'llm_per_turn'` (or `static`)
8. Agent `cartesia_avatar_id` → avatar row

---

## 4. API endpoints added

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/cartesia-avatars` | List personas |
| POST | `/cartesia-avatars` | Create persona |
| GET | `/cartesia-avatars/:id` | Get persona |
| PUT | `/cartesia-avatars/:id` | Update persona |
| DELETE | `/cartesia-avatars/:id` | Delete persona |
| POST | `/cartesia-avatars/:id/set-default` | Set default |
| GET | `/cartesia-avatars/emotions` | Allowed emotion list |

All require `x-api-key` (tenant scope).

---

## 5. What to verify on a live call

- [ ] Migration `008` applied without errors
- [ ] `GET /settings` shows new Cartesia fields
- [ ] Exotel call connects; greeting plays via Cartesia
- [ ] Logs show `tts_provider: cartesia`, `output_format` PCM @ negotiated rate (8k/16k/24k)
- [ ] No `pipeline.tts.resample` logs for Cartesia path
- [ ] LLM replies include `EMOTION: <word>` line when `llm_per_turn` (check chat transcript / logs)
- [ ] Invalid emotion falls back to avatar `generation_config.emotion`
- [ ] `EMOTION:` line is **not** spoken (skipped in TTS)
- [ ] Cartesia simulator still works (`/voice/cartesia/simulator`)

---

## 6. Known Phase 1 limitations

| Topic | Behavior |
|-------|----------|
| RAG **streaming** + LLM emotion | Sentences spoken during stream use **avatar base emotion**; `EMOTION:` parsed after stream ends (too late for first chunks). Use non-streaming RAG or `static` emotion for consistent per-turn tone. |
| `llm_per_sentence` | DB value accepted; per-sentence WS emotion changes are **Phase 2**. |
| Humanizer | Optional; adds ~300–800 ms per utterance. |

---

## 7. Files changed (implementation)

| Area | Files |
|------|-------|
| Migration | `infra/postgres/migrations/008_cartesia_avatars.sql` |
| SQL samples | `docs/sql/cartesia_voicebot_setup.sql` |
| Cartesia WS client | `apps/api/src/services/cartesia-tts-ws.ts` |
| Cartesia helpers | `apps/api/src/services/cartesia.ts` |
| Avatars DAO | `apps/api/src/services/cartesia-avatars.ts` |
| Avatars API | `apps/api/src/routes/cartesia-api.ts` |
| Voicebot | `apps/api/src/routes/exotel-voicebot.ts` |
| Persona | `apps/api/src/services/voice-persona.ts` |
| Session | `apps/api/src/services/voicebot-session.ts` |
| Settings | `apps/api/src/services/customer-settings.ts`, `routes/settings.ts` |
| Agents | `routes/agents.ts` |
| App | `apps/api/src/app.ts` |
