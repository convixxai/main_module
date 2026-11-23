# Voicebot response time: findings and plan (23 Nov 2026)

Status: **findings recorded, work not started.** Nothing below is switched on except what "Already done" lists.

Response time here means: the caller stops talking, then hears the bot's first word.

## 1. Measured today (UCB, Vodafone)

Source: production engine log, 849 bot replies on 285 UCB calls, 6–8 Nov 2026. The opening greeting is not counted.

### Bot-side (end of silence wait → first reply audio sent)

| | Average | Lowest | Median | 90% within | Highest |
|---|---|---|---|---|---|
| Bot response | **2,007 ms** | 887 ms | 1,890 ms | 2,930 ms | 4,501 ms |

By campaign:
- "Main campaign diwali": 113 replies, average 1,982 ms.
- Filed as "New Test" (`b5e386f6`): 708 replies, average 2,001 ms. These are mostly UCB-link calls carrying the fixed `campaign_id`.

### What the caller hears

**About 2.8 s on average** (about 1.7 to 5.3 s). That is the bot-side time plus the 800 ms silence wait, plus Vodafone's network.

### Where the time goes, per reply

| Step | Time | Notes |
|---|---|---|
| Silence wait (VAD) | 800 ms | Waits for 800 ms of silence before treating the caller as finished (`DEFAULT_VAD_SILENCE_MS`) |
| Speech-to-text (batch) | ~230 ms (96 – 1,963) | Starts only after the silence wait ends |
| `parallel_init_ms` | ~550 ms (median 602) | Almost all of it is the **Sarvam translate-to-English call for the KB search** (560–870 ms measured). The embedding itself takes ~25–30 ms |
| Vector search + history | ~3 ms | |
| AI model, first token | ~1,100 ms | Measured in the pipeline |
| TTS first audio | ~110 ms | |

Pipeline branch: `rag_openai` for 100% of replies, with streaming on. Settings: `reasoning_effort: minimal`, `verbosity: low`, `service_tier: priority`.

### OpenAI latency measured from the production server (India, Azure)

| Prompt | gpt-5-mini median | gpt-4.1-mini median |
|---|---|---|
| Tiny | 875 ms | 739 ms |
| ~13k chars (UCB size) | 683 ms | 714 ms |

From my local machine, gpt-4.1-mini was ~170 ms faster. From the server there is no clear difference.

- **Conclusion:** the model choice is not the bottleneck.
- A plain model request takes ~700 ms. In our pipeline the same step takes ~1,100 ms. The extra **~400 ms is our request content**: CRM tool definitions, rules, history, KB text and turn notes.
- The network to OpenAI is not a significant factor.

### KB search accuracy test (25 UCB questions, reworded the way callers speak)

| | Current: translate, then search the English KB (top 3 / top 5) | Native: no translation, KB also has native copies (top 3 / top 5) | Prep time |
|---|---|---|---|
| Marathi | 56% / 56% | 44% / 52% | 685 ms → 29 ms |
| Hindi | 44% / 44% | 48% / 52% | 667 ms → 29 ms |

- The current embedding model (nomic-embed-text, used through Sarvam translation) is weak in Indian languages: every score is low.
- With only 25 questions, expect about ±10% noise.

## 2. Already done (deployed 23 Nov 2026)

- **`customer_settings.kb_native_languages`** (migration 025) and **`GET`/`PUT /settings/kb-search`**:
  - Who can call it: `x-api-key`, or `x-admin-token` with `x-customer-id`.
  - A question in a listed language skips the translation (−0.65 s).
  - Guard: it only applies when the KB really holds entries in that language.
  - Default `[]`: no change.
  - UCB: not set. Its KB has 63 English entries and no Marathi or Hindi.
  - Recommendation: Hindi looks safe; test Marathi on real calls first.
- **`rag_top_k`** (KB entries per search) can be set through the same API (1–10). UCB is still 3; 5 was suggested.
- **UCB `llm_model_override = gpt-4.1-mini`**. gpt-4.1 now also uses the priority tier.
  - Given the server measurement above, expect little gain.
  - Check real UCB calls. Revert with `PATCH /admin/customers/{id}/settings {"llm_model_override": null}`: no deploy needed.

## 3. Plan (biggest saving first)

All items go behind per-customer switches, default off, and get simulation tests before going live.

### Step 0: per-reply timing log (do first)

- One log line per reply with: silence wait, STT, translate, embed, search, model first token, prompt tokens and **cached tokens**, TTS first audio, and the total.
- This measures every step below on real calls.

### Option 3: leaner AI request (saves ~0.1–0.3 s, low risk)

- Read `usage.prompt_tokens_details.cached_tokens` to see how much of each request OpenAI serves from cache.
- Order the request as fixed first (agent prompt, rules, tool definitions), then changing parts last (KB text, history, turn notes).
- Send `prompt_cache_key` per company and agent.
- Send only the CRM tools the customer actually has, and keep history to what is needed.
- The model sees the same content, so answers stay the same.

### Option 1: speculative start (saves ~0.4–0.5 s, same answers)

- Start STT and the answer pipeline after 300–400 ms of silence, but play nothing until the full silence wait has passed.
- If the caller speaks again, discard that attempt and carry on as today.

**Must be held until the turn is confirmed** (every feature checked):
- CRM SAVE tools (fire-and-forget) and ACTION tools, including the one-time confirmation rule and duplicate-action drop.
- `saveMessage` of the user turn: transcript and `chat_messages`, and therefore the reports and `/vodafone/reports/numbers`.
- Call-log language (`noteVodafoneCallLanguage`) and `customerQueryCount`.
- Language-switch flow (`handleLanguageSwitchFlow`, pending-switch state) and the passive language-mismatch detection.
- The "please hold" line for read tools (it must not be spoken for a discarded attempt).
- The ignore-speech-before-the-script-ends rule (`isSpeaking` guard) and the neutral-word language guard.
- Multi-agent routing (`resolveAgent`) and the session's `agent_id`.
- Exotel needs the same changes (`exotel-voicebot.ts`), as does the batch (non-streaming) path.

**Cost:** extra STT and AI calls when callers pause mid-sentence. Measure how often.

### Option 2: multilingual embedding model (saves ~0.5 s, likely better accuracy)

- Replace nomic-embed-text plus translation with a multilingual model on our own server (e.g. multilingual-e5-small, 384 dimensions, like today). Marathi and Hindi are then searched directly in ~30 ms.
- Safe rollout:
  - a new embedding column next to the old one;
  - a background job re-embeds every KB entry;
  - every KB write path (KB admin, uploads, bulk upload, Ganeshotsav admin, `kb_entry_translations`, suggested-KB) writes both vectors;
  - switch it on per customer only after the accuracy test above shows it is at least as good.
- Covers every language with no Marathi or Hindi KB copies needed. The `kb_native_languages` flag becomes optional.

### Option 4: streaming STT (saves up to ~0.2 s, lower priority)

- Send audio to STT while the caller talks, so the text is ready when they stop.
- Option 1 already hides most of this gain.
- Marathi accuracy in streaming mode needs its own test.

### Not recommended

- **Moving to an OpenAI region in India:** the network is not the bottleneck.
- **A shorter silence wait (800 → 600 ms):** it risks cutting callers off, and Option 1 gives the same gain safely.
- **Smaller or older models:** a quality risk for little gain (gpt-4.1-nano is deprecated).

## 4. Expected result

| | Today | After Options 3 + 1 + 2 |
|---|---|---|
| What the caller hears (average) | ~2.8 s | ~1.6–1.8 s |

## 5. Code pointers

| Area | Location |
|---|---|
| Vodafone turn loop | `apps/api/src/routes/vodafone-voicebot.ts` (silence timer and `processUtterance`, streaming turn, `turn complete (streaming)` log) |
| Answer pipeline | `apps/api/src/routes/ask.ts` (`runAskPipeline`, `parallel_init_ms`, `rag_llm_parallel_ms`) |
| Translate for search | `apps/api/src/services/llm.ts` (`prepareQuestionForKbEmbedding`) |
| Model parameters | `apps/api/src/services/llm.ts` (`openAiGenerationParams`, `streamChatOpenAIWithTools`) |
| Native-language KB flag | `apps/api/src/services/kb-native-languages.ts`; `/settings/kb-search` in `apps/api/src/routes/settings.ts` |
| Exotel equivalent | `apps/api/src/routes/exotel-voicebot.ts` |
