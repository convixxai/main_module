# Cartesia STT Call Log Interpretation — 2026-06-27 10:02 IST

**Call:** `stream_sid=d0e928e8c56035dee8055969a37d1a6r`  
**Customer:** `ead34d8f-de23-452c-9091-85b2af98ac82` (Chhavani Resort)  
**Caller:** `08898442005` → Exotel `02048555864`  
**Reported issue:** User spoke **Hindi/Marathi** but system treated everything as **English** — wrong STT text and wrong language for RAG/TTS.

---

## Straight answer: should you use Cartesia STT for multilingual?

**No — not for production Hindi / Marathi / English on Exotel 8 kHz phone calls.**

| Use case | Recommendation |
|----------|----------------|
| Multilingual voicebot (en + hi + mr) on Exotel | **Use Sarvam STT** |
| English-only voicebot | Cartesia STT is fine |
| Keep Cartesia TTS | **Yes** — STT and TTS are independent; use Sarvam STT + Cartesia TTS |

**Why:** This call shows Cartesia ink-whisper with `language=en` turns Hindi/Marathi speech into **broken Latin English**. Language detection (script rules or OpenAI JSON) cannot recover the **meaning** if the transcript itself is wrong. OpenAI language classify only helps pick `hi-IN` vs `mr-IN` — it does **not** fix `"MUGE A PINIME VATKAR TO"`.

---

## Timeline

| Time | Turn | Audio | Cartesia STT | Language detected | Bot behavior |
|------|------|-------|--------------|-------------------|--------------|
| 10:02:41 | Greeting done | — | — | `en-IN` | "Hello! How can I help you today?" |
| 10:02:46 | **Turn 1** | ~3.84 s (61440 B) | `"I want to about"` | `en-IN` (script) | Generic English clarifying question |
| 10:02:55 | **Turn 2** | ~2.48 s (39680 B) | `"MUGE A PINIME VATKAR TO"` | `en-IN` (script) | LLM replies **in Marathi** asking user to use allowed languages |
| 10:03:03 | Turn 3 | ~1.52 s (24320 B) | `"Thank you."` | `en-IN` | Normal English thank-you reply |
| 10:03:09 | Call end | — | — | — | — |

---

## What the caller likely said (Turn 2)

STT output:

```
MUGE A PINIME VATKAR TO
```

This is **not meaningful English**. Pattern matches **Romanized Marathi/Hindi** misheard by an English-biased model:

| STT fragment | Likely intent |
|--------------|---------------|
| `MUGE` / `MUG` | **मला** (mala — "to me") or **मujhe** |
| `PINIME` | **pricing** (English loanword common in Indian speech) |
| `VATKAR TO` | Garbled Marathi/Hindi verb phrase (e.g. pricing-related question) |

**User was probably asking about pricing in Marathi or Hindi**, not speaking English. Cartesia with `language=en` forced an English phonetic guess.

---

## Root causes (ordered by impact)

### 1. Cartesia STT transcribed Indic speech as broken English (primary)

Log on every turn:

```json
"stt_provider": "cartesia",
"cartesia_stt_full_auto": false,
"language_code_sent": "en",
"stt_implementation": "batch"
```

With `full_auto=false`, ink-whisper receives **`language=en`**. On **8 kHz telephony**, Hindi/Marathi audio is transcribed as **Latin garbage**, not Devanagari.

**Evidence:** Turn 2 has clear Indic speech patterns in Roman letters; no Devanagari in output.

---

### 2. Script language rule locked everything to `en-IN`

Every turn logs:

```
pipeline.stt.script_language_override
  script_inferred: en-IN
```

`inferLanguageFromTranscript()` sees **≥60% Latin letters** → assumes **English**. That is correct for real English, but **wrong for Romanized/garbled Indic STT output**.

Result: `session.currentLanguageCode` stays **`en-IN`** for the whole call even when user spoke Marathi/Hindi.

---

### 3. OpenAI language detect did NOT run (critical gap)

**Expected log (if working):**

```
pipeline.stt.openai_language_detect
```

**Absent on all 3 turns.**

Reason in current design: OpenAI JSON language classify runs only when `!scriptLang`. Because script inference already returned `en-IN` for Latin text, **OpenAI detect was skipped every time**.

So the hybrid approach (Cartesia STT + OpenAI language JSON) **did not activate** on this call.

---

### 4. Indic STT retry did not run (Turn 2)

Indic retry (`hi` → `mr`) only runs when the **first** Cartesia result is **empty/noise**. Turn 2 returned non-empty garbage → **no retry**, no `cartesia_indic_language_retry` log.

---

### 5. RAG/LLM ran on garbage text (downstream symptom)

Turn 2 pipeline:

```
question_preview: "MUGE A PINIME VATKAR TO"
stt_language: en-IN
```

RAG embedded the garbage string → irrelevant KB hits (Pune/Mumbai distance). LLM then guessed the user was using a disallowed language and replied:

> कृपया इंग्रजी, हिंदी, किंवा मराठीत बोलू शकता का?

**Irony:** User may already have been speaking Marathi; STT failed, language policy said English, LLM over-corrected into Marathi "please speak an allowed language."

---

## What improved vs 23:14 call

| Item | 23:14 call | 10:02 call |
|------|------------|------------|
| `cartesia_stt_full_auto` | `true` | **`false`** ✓ |
| STT path | streaming + fallback | **batch only** (multilingual) ✓ |
| Punctuation-only `"."` | triggered RAG | not seen this call |
| Hindi/Marathi quality | poor | **still poor** (different failure mode) |

Config fixes helped stability but **did not fix Indic transcription**.

---

## Configuration snapshot

| Setting | Value |
|---------|--------|
| `stt_provider` | cartesia |
| `tts_provider` | cartesia |
| `multilingual` | true |
| `allowed` | en-IN, hi-IN, mr-IN |
| `cartesia_stt_full_auto` | **false** |
| `language_code_sent` | **en** (all turns) |
| `current_language_code` | **en-IN** (entire call) |
| Exotel sample rate | 8000 Hz |
| OpenAI language detect | **not observed in logs** |

---

## Can Cartesia + OpenAI JSON language detect work?

**Partially — not as a full solution.**

| Layer | Can fix language tag? | Can fix transcript text? |
|-------|----------------------|---------------------------|
| OpenAI JSON classify | **Sometimes** (if it runs) | **No** |
| Script inference (Latin → en) | **No** for garbled Indic | **No** |
| Cartesia with `language=hi/mr` | N/A | **Better** but still weak at 8 kHz |
| Sarvam STT | **Yes** (`language_probability`) | **Yes** (telephony-tuned) |

OpenAI language JSON is useful **only after** you have a reasonable transcript (Devanagari or clear Roman Hindi/Marathi). It **cannot** turn `"MUGE A PINIME VATKAR TO"` into a correct question about pricing.

---

## Recommended architecture for your product

### Option A — Recommended (production)

```
Exotel 8 kHz → Sarvam STT (multilingual) → language policy → RAG/LLM → Cartesia TTS
```

- Best Hindi/Marathi/English on Indian phone audio
- Built-in `language_probability` for mid-call switching
- Keep Cartesia for voice quality on TTS

### Option B — English-only tenant

```
Exotel → Cartesia STT (language=en) → RAG → Cartesia TTS
```

- Simple, works with current logs for English

### Option C — Cartesia STT multilingual (not recommended)

Would require **all** of:

1. Sarvam-level STT accuracy at 8 kHz (Cartesia does not match today)
2. OpenAI language detect running **even when** script says `en-IN` for suspicious Latin garbage
3. Optional: OpenAI **audio** correction (not just JSON language) before RAG
4. Per-utterance STT retry with `hi`, `mr`, `en` and pick best transcript — **3× latency/cost**

Option C is fragile and expensive compared to Option A.

---

## Fixes needed IF you keep Cartesia STT (future work — not in this doc)

1. **Do not skip OpenAI language detect** when `script_inferred=en-IN` but transcript looks like garbled Roman Indic (e.g. contains `MUGE`, `MUJHE`, `MALA`, pricing words, no valid English grammar).
2. **Do not treat Latin-heavy garbage as English** in `inferLanguageFromTranscript` for Cartesia provider.
3. **Retry Cartesia STT with `language=hi` and `language=mr`** when English hint produces low-quality / ungrammatical Latin (not only when empty).
4. **Consider OpenAI audio correction** (`correctUtteranceWithOpenAI`) for Cartesia multilingual — uses WAV, not just text JSON.
5. **Split stack:** Sarvam STT + Cartesia TTS — smallest change with highest impact.

---

## Expected logs with Sarvam (contrast)

```
pipeline.stt.request          stt_provider: sarvam
pipeline.stt.sarvam_language_hint   language_code_sent: auto (turn 1-2)
pipeline.stt.response         transcript: <Devanagari or clean Roman Hindi>
                              language_probability: 0.92
                              language_code: hi-IN | mr-IN
pipeline.rag.start            question_preview: <actual question>
```

---

## Quick checklist after reading this call

- [ ] **Switch tenant `stt_provider` to `sarvam`** for multilingual Exotel calls
- [ ] Keep **`tts_provider: cartesia`** if voice quality is good
- [ ] Set **`VOICEBOT_CARTESIA_STT_FULL_AUTO=false`** (already done)
- [ ] Do **not** rely on OpenAI JSON language detect alone to fix Cartesia garbled text
- [ ] Retest same Hindi/Marathi phrases; expect Devanagari or accurate Roman transcript with Sarvam

---

## Related documents

- [2026-06-26 23:14 interpretation](./CARTESIA_STT_CALL_LOG_INTERPRETATION_2026-06-26_2314.md) — full-auto + streaming issues
- [2026-06-26 11:47 interpretation](./CARTESIA_STT_CALL_LOG_INTERPRETATION_2026-06-26_1147.md) — empty transcript bug
- [Language switching spec](./EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md)
- [STT quality tuning](./VOICEBOT_STT_QUALITY_AND_TUNING.md)
