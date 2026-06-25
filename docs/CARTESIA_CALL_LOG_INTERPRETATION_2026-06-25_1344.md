# Cartesia Voicebot Call — Log Interpretation (Post–Humanizer Merge)

**Date of call:** 2026-06-25  
**Time window:** 13:44:25 → 13:44:52 (~27 seconds)  
**Customer ID:** `ead34d8f-de23-452c-9091-85b2af98ac82`  
**Stream SID:** `43f1db9062fa2e0c867f75cb8dd21a6p`  
**Call SID:** `44db6fb0e11776e1c6558c6ffda11a6p`  
**Exotel call session:** `fcfd0463-dfbd-4f01-8447-6fd9969e663e`  
**Chat session:** `686eda60-2b94-409c-aca7-803169464f7f`  
**Caller:** `08898442005` → `02048555864`  
**Media:** 8 kHz PCM (`pcm_s16le`)  
**TTS:** Cartesia `sonic-3.5`, voice `5c32dce6-936a-4892-b131-bafe474afe5f`  
**STT:** ElevenLabs batch  
**LLM:** `gpt-4o-mini` (streaming RAG + streaming TTS)  

---

## Executive summary (what the caller experienced)

| Symptom you reported | What the log shows | Root cause |
|----------------------|-------------------|------------|
| Greeting felt slow | Server sent greeting audio in **&lt;1 s**; caller heard ~**2 s** of audio; bot ready to listen at **+2 s** | Normal playback length for 32-char greeting — not humanizer delay (humanizer **not** called) |
| Answers felt slow | Turn 1 TTFA **3478 ms**; Turn 2 TTFA **1937 ms** | VAD wait + STT (~1.3 s) + embedding (~1 s) + LLM-to-first-chunk + **multiple Cartesia round-trips per reply** |
| Bot “stopped after some words” | Reply was **split into 3–4 separate TTS jobs**; Exotel **mark acks** blocked listening until `mark_5` at +14 s | Comma-based streaming cuts + overlapping playback marks |
| Emotions “completely off” | LLM output had **no `[emotion]` tags**; every chunk used `emotion: calm` | `cartesia_emotion_mode = static` in DB + model ignored tag instructions |
| Wrong / odd replies | User said Hindi **“हां, हेलो?”**; bot replied **“Please continue in English, Marathi, or Hindi.”** | Language policy classified turn as `en-IN` while user spoke Hindi; strict language rules conflict |

**Good news:** There are **no separate humanizer OpenAI calls** in this log. Humanizer style is merged into the single RAG `openai_chat_stream_request` (see `--- CARTESIA VOICE OUTPUT ---` block in system prompt).

---

## High-level call flow

```
13:44:25  Connect → greeting TTS (Cartesia) → audio sent
13:44:27  Greeting playback done (mark_1) — bot listens
13:44:31  User speaks ~1.8 s → VAD fires
13:44:32  STT: "हां, हेलो?" (Hindi)
13:44:33  RAG: embed + KB + ONE OpenAI stream
13:44:34  Bot starts speaking (TTFA 3478 ms) — 4 TTS chunks for one sentence
13:44:35  LLM done: "Hello! Please continue in English, Marathi, or Hindi."
13:44:39  mark_5 ack (fallback had fired) — bot can listen again
13:44:42  User: "Okay"
13:44:44  Bot reply (TTFA 1937 ms ✓) — 3 TTS chunks
13:44:48  Playback done (mark_8)
13:44:52  Call ended (Exotel stop)
```

---

## Phase 1 — Connect & greeting (13:44:25)

| Time | Log event | Meaning |
|------|-----------|---------|
| `13:44:25` | `exotel.in` → `connected`, `start` | WebSocket up; 8 kHz stream negotiated |
| `13:44:25` | `call.session_ready` | DB sessions created |
| `13:44:25` | `greeting.sending` | Fixed agent greeting — **no LLM, no humanizer** |
| `13:44:25` | `tts.start` — `text_chars: 32`, `cartesiaSpeakRaw` path | Verbatim greeting text to Cartesia |
| `13:44:25` | `pipeline.tts.first_chunk` — 2274 bytes | Cartesia returned audio **same second** (WS already warm or fast connect) |
| `13:44:25` | `tts.sent_to_exotel` — 33,280 PCM bytes | ~**2.08 s** of audio @ 8 kHz mono 16-bit |
| `13:44:25` | `greeting.sent` | Greeting pipeline complete on server |
| `13:44:26` | `Cartesia greeting PCM cached` | Next call with same greeting can skip TTS |
| `13:44:27` | Exotel `mark_1` → playback complete | Caller finished hearing greeting; inbound buffer cleared |

### Greeting timing

| Milestone | Timestamp | Delta from connect |
|-----------|-----------|-------------------|
| Connect | 13:44:25 | 0 ms |
| First audio chunk to Exotel | 13:44:25 | **~0 ms** (server) |
| Caller finished hearing greeting | 13:44:27 | **~2 s** (playback) |
| Bot ready for user speech | 13:44:27 | **~2 s** |

**Interpretation:** Greeting is **not** slow on the server anymore (no 3 s humanizer, no 4 s cold Cartesia in this log). Perceived delay is mostly **how long the greeting audio plays** (~2 s) plus the caller waiting to speak.

---

## Phase 2 — Utterance 1: “हां, हेलो?” (13:44:31–13:44:35)

### 2.1 Capture & STT

| Time | Event | Duration |
|------|-------|----------|
| `13:44:31` | `vad.timeout_triggered` — 28,480 bytes (~1.78 s audio) | **~4 s** after bot became ready (user pause + speech) |
| `13:44:31` | `pipeline.stt.request` — ElevenLabs batch | — |
| `13:44:32` | `stt.done` — transcript `"हां, हेलो?"`, tagged `en-IN` | **~1.0 s** STT |

**Note:** ElevenLabs detected language `eng` but text is **Hindi Devanagari**. Tenant policy still routed the turn as `en-IN`.

### 2.2 RAG — single OpenAI call (humanizer merged)

| Time | Event | Duration |
|------|-------|----------|
| `13:44:32` | `pipeline.rag.start` | — |
| `13:44:32–33` | Embedding (`nomic-embed-text`) | **~1 s** |
| `13:44:33` | `pipeline.rag.kb_hit` — top distance **0.688** (weak; not a factual question) | — |
| `13:44:33` | `pipeline.rag.llm_stream` — **one** `openai_chat_stream_request` | — |
| `13:44:35` | `rag.llm.done` — `"Hello! Please continue in English, Marathi, or Hindi."` | **~2 s** stream |

**System prompt includes (one call):** agent prompt, RAG rules, language policy, **`--- CARTESIA VOICE OUTPUT ---`** (humanizer + Cartesia rules), industry context, KB (3 travel FAQ rows — poor match for “hello”).

**No** `humanizeTextForOpenAiTts` / second OpenAI request appears anywhere in this log.

### 2.3 Streaming TTS — why it sounded broken

The LLM answer is one short sentence, but the log shows **four** `tts.start` events:

| Time | `text_chars` | Likely spoken fragment | Issue |
|------|--------------|------------------------|-------|
| `13:44:34` | 6 | `Hello!` | OK — first sentence cut |
| `13:44:35` | 27 | `Please continue in English` | Cut on **comma** |
| `13:44:35` | 8 | `, Marathi` | Comma fragment |
| `13:44:35` | 9 | ` or Hindi.` | Tail fragment |

**Root cause:** `findNextSpeakCut()` treats **commas** as speak boundaries (`, ` in the cut set). For Cartesia, each fragment = **separate WebSocket synthesis** → sequential audio, unnatural pauses, and the feeling that the bot “stops mid-sentence.”

ElevenLabs path uses `findNextSpeakCutElevenLabs` (sentence endings only). **Cartesia still uses the comma-aggressive cutter.**

### 2.4 TTFA (turn 1)

| Metric | Value | Target |
|--------|-------|--------|
| `pipeline.ttfa` / `ttfa.first_audio` | **3478 ms** | 2000 ms |
| `met_target` | **false** | — |
| `timing_stt_ms` | 1260 | — |
| `timing_ask_pipeline_ms` | 2890 | — |
| `total_ms` | 4150 | — |

**TTFA breakdown (approximate):**

```
VAD end (user stopped speaking)     ~13:44:31
First audio to Exotel               13:44:34  (+3.5 s)
  ├─ STT                            ~1.0 s
  ├─ Embedding + KB                 ~1.0 s
  ├─ LLM until first speakable cut  ~1.0 s
  └─ Cartesia first chunk           ~0.5 s
```

---

## Phase 3 — Playback marks & “bot stopped listening” (13:44:35–13:44:39)

After utterance 1, Exotel sent mark acks `mark_2`, `mark_3`, `mark_4` but **`mark_5` was late**:

| Time | Event |
|------|-------|
| `13:44:36–38` | `mark_2`, `mark_3`, `mark_4` received |
| `13:44:39` | **WARN** `mark ack missing after playback window` — pending `mark_5`, fallback cleared marks |
| `13:44:39` | `mark_5` → playback complete, ready for caller |

**Interpretation:** Four TTS chunks ⇒ four playback marks (`mark_2`–`mark_5`). While marks are pending, the bot **buffers inbound audio** and may ignore the caller — feels like the bot “stopped” or didn’t hear you.

---

## Phase 4 — Utterance 2: “Okay” (13:44:42–13:44:44)

| Time | Event |
|------|-------|
| `13:44:42` | VAD — 1.14 s audio |
| `13:44:43` | STT — `"Okay"` (**701 ms**) |
| `13:44:43–44` | RAG stream — KB weak match (activities/pets/pricing) |
| `13:44:44` | **TTFA 1937 ms ✓** (under 2 s target) |
| `13:44:44` | Answer: `"Great! What would you like to know about Chhavani Resort?"` |

**Three** `tts.start` calls (`text_chars`: 6, 42, 7) — again comma/sentence splitting:

- `Great!` (6 chars)
- ` What would you like to know about Chhavani Resort?` (42 chars) — or split on internal punctuation

| Metric | Turn 1 | Turn 2 |
|--------|--------|--------|
| STT | 1260 ms | 701 ms |
| Ask pipeline | 2890 ms | 1816 ms |
| TTFA | 3478 ms ✗ | 1937 ms ✓ |
| TTS chunks | 4 | 3 |

Turn 2 is faster because Cartesia WS is warm and STT was shorter; still hurt by multi-chunk TTS.

---

## Phase 5 — Call end (13:44:52)

| Time | Event |
|------|-------|
| `13:44:48` | `mark_8` — last reply playback done |
| `13:44:52` | `exotel.in` → `stop` — `reason: canceled or call ended` |
| `13:44:52` | WebSocket close `1006` |

No TTS-after-stop race in this log (unlike the earlier 12:56 call).

---

## Emotion analysis

Every `tts.start` shows:

```json
"generation_config": { "speed": 1, "volume": 1, "emotion": "calm" }
```

The RAG system prompt in this call says:

```text
- Use emotion tag [neutral] on every sentence (fixed voice persona).
```

That indicates **`cartesia_emotion_mode = static`** in `customer_settings`.

The LLM’s actual replies had **no** `[neutral]` / `[sympathetic]` tags:

- `"Hello! Please continue in English, Marathi, or Hindi."`
- `"Great! What would you like to know about Chhavani Resort?"`

So:

1. Per-sentence emotion tags were **not produced** by the model.  
2. TTS always fell back to avatar default **`calm`**.  
3. Emotion cannot change per sentence until mode is `llm_per_sentence` **and** the model outputs tags **and** streaming does not strip them.

---

## Humanizer: confirmed merged (not separate)

| Check | This log |
|-------|----------|
| `humanizeTextForOpenAiTts` / humanizer LLM request | **Absent** |
| `openai_chat_stream_request` includes `CARTESIA VOICE OUTPUT` + `STYLE SETTINGS` | **Yes** |
| `tts_humanizer_enabled` separate path in `speakToExotel` | **Not used** |
| Greeting humanized | **No** — `text_chars: 32`, raw greeting |

**Pipeline:** STT → embed → KB → **one** OpenAI stream (agent + KB + Cartesia/humanizer rules + history) → stream tokens → Cartesia TTS per cut chunk.

---

## Issues ranked by impact

### P0 — Comma splitting creates multiple Cartesia calls per reply

- **Symptom:** Choppy speech, long gaps, “stopped after some words,” extra marks blocking listen.  
- **Fix:** Use ElevenLabs-style cuts for Cartesia (`findNextSpeakCutElevenLabs`) or sentence-only cuts; never split on commas inside phrases like `English, Marathi, or Hindi`.

### P1 — `cartesia_emotion_mode = static`

- **Symptom:** Flat `calm` on every chunk; tags ignored.  
- **Fix:** Set `cartesia_emotion_mode = 'llm_per_sentence'` and verify LLM outputs `[emotion]` prefixes.

### P1 — Language policy vs Hindi greeting

- **Symptom:** User said Hindi hello; bot asked them to switch language.  
- **Fix:** Map Hindi STT (`hi-IN`) when Devanagari + Hindi words detected; allow Hindi replies per tenant policy (`en-IN`, `mr-IN`, `hi-IN`).

### P2 — Duplicate user message in LLM history

Log shows two identical user turns:

```json
{"role":"user","content":"हां, हेलो?"},
{"role":"user","content":"हां, हेलो?"}
```

May inflate tokens and confuse the model — worth tracing in chat append logic.

### P2 — Weak KB retrieval on conversational openers

“हां, हेलो?” retrieved Mumbai/Pune distance FAQs (distance ~0.69). Consider a **greeting / small-talk fast path** without full RAG.

### P3 — Mark ack fallback (13:44:39)

Harmless recovery but adds ~3 s where caller audio may be ignored. Fewer TTS chunks ⇒ fewer marks ⇒ less blocking.

---

## Latency scorecard

| Stage | Greeting | Turn 1 | Turn 2 |
|-------|----------|--------|--------|
| Server TTS start → first chunk | **&lt;1 s** | ~1 s after LLM stream starts | ~1 s |
| TTFA (pause → first heard) | N/A | **3478 ms** ✗ | **1937 ms** ✓ |
| OpenAI calls per turn | 0 | **1** (RAG stream) | **1** |
| Cartesia syntheses per reply | 1 | **4** | **3** |
| Humanizer OpenAI calls | 0 | **0** | **0** |

---

## Recommended configuration (SQL)

```sql
UPDATE customer_settings SET
  cartesia_emotion_mode = 'llm_per_sentence',
  tts_humanizer_enabled = FALSE   -- redundant for Cartesia; rules are in RAG prompt
WHERE customer_id = 'ead34d8f-de23-452c-9091-85b2af98ac82';
```

**Code follow-ups (not in this log, but required for your symptoms):**

1. Cartesia streaming: use sentence-only `findNextSpeakCutElevenLabs` (or equivalent).  
2. Optional: detect Hindi/Marathi from STT script and set `effectiveSttLanguageThisTurn` accordingly.  
3. Fix duplicate user line in RAG message assembly.  
4. Short greeting or cached PCM on connect for instant play on repeat calls.

---

## Log legend

| Field / prefix | Meaning |
|----------------|---------|
| `voicebotStage` | High-level lifecycle (`call.started`, `tts.start`, `utterance.completed`, …) |
| `voicebotTrace` | Detailed pipeline steps (`pipeline.rag.*`, `pipeline.tts.*`, `exotel.*`) |
| `rag_trace` | OpenAI / embedding internals |
| `pipeline.ttfa` | Time from utterance processing start to first PCM sent to Exotel |
| `exotel.out.media_batch` | PCM chunks batched to Exotel (`omit_mark: true` until final flush) |
| `mark` / `mark_*` | Exotel playback position ack — bot clears inbound buffer when mark received |

---

## Comparison to earlier call (12:56 same day)

| Item | 12:56 call (pre-fix) | 13:44 call (this log) |
|------|----------------------|------------------------|
| Greeting humanizer | ~3 s extra OpenAI call | **None** |
| Greeting Cartesia TTFB | ~4 s cold | **Same second** |
| Humanizer per TTS chunk | Yes (5 calls) | **None** |
| TTFA turn 1 | ~3497 ms | **3478 ms** (still high — STT+RAG+comma splits) |
| TTFA turn 2 | — | **1937 ms** ✓ |

Humanizer merge **worked**; remaining latency and choppy audio are dominated by **STT + embedding + comma-based TTS chunking + static emotion**, not duplicate OpenAI humanizer calls.
