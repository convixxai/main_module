# Voicebot STT quality: diagnosis and tuning (Sarvam & ElevenLabs)

This note explains why telephony STT degrades (wrong words **even when the “language” is correct**, wrong script, or wrong language altogether), how to separate **audio** from **API / policy** causes, and how to improve accuracy **without extra STT round-trips or intentional delay** in the live voice pipeline.

It aligns with the session language behaviour described in `docs/EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md` and the Exotel voicebot implementation (`apps/api/src/routes/exotel-voicebot.ts`). Operational checklists here are meant to stay in sync with **vendor documentation** (§9)—refresh links and offline mirrors when APIs change.

---

## 1. Symptoms → likely causes

| Symptom | Typical drivers (not mutually exclusive) |
|--------|------------------------------------------|
| **Wrong text in “any” language** (script looks right, language tag plausible, words still wrong) | **Acoustic confusions** on narrowband audio, **short utterances**, **noise**, **proper-noun vs high-frequency dictionary** (“Chhavani” → “Xiaomi”), **barge-in / tail clipping**. Not always a “wrong language” bug. |
| Proper noun → famous brand / generic word | **Lexical prior**: models favour frequent words; telephony limits consonant cues. |
| Same issue in **English-only** and **multilingual** | Points to **audio**, **VAD/buffer**, **hint vs reality**, or **model**—not only multilingual routing. |
| Multilingual: **meaning** of whole sentence changes | Often **wrong implicit language** for a span, **code-mix** crushed into one language, or **Latin vs Indic script** inconsistent with speech. |
| Regression vs older branch | **When `language_code` / `languageCode` is sent vs omitted**, **STT model id**, **WebSocket `unknown` vs hinted `language-code`**, **VAD thresholds**, **sample-rate labelling**—diff payloads, not only “model got worse.” |

Treat causes as **hypotheses** until you reproduce with frozen audio + frozen API bodies (§6).

---

## 2. “Wrong STT” even when language settings look correct

Language configuration can be **perfect** and you still get garbage text. Language-agnostic explanations:

1. **Same-language mishear** — Hindi transcribed as wrong Hindi, English as wrong English. Fix with **audio**, **utterance length**, **better_hints where the product allows**, not only allowlists.
2. **Hint says right language, model still guesses wrong words** — Normal on **8 kHz**; reduce noise, avoid **half-syllable** buffers, validate **WAV/sample_rate** match.
3. **Session “active language” vs STT request** — If policy sends **auto/omit** for detection, transcript quality can diverge from a branch that always **biased** with `language_code`. See §5 and `docs/EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md`.
4. **Code-switching** — User mixes languages in one breath; single `language_code` biases one layer; remainder is misrecognised **without** changing the “configured language.”

**Zero added latency (conceptually):** one STT call with the **best single hint** you are allowed to send for that turn, plus **customer_settings** tuning (VAD, min speech)—no second REST/WS transcript job.

---

## 3. Audio vs model: quick separation

| Clue | Lean toward |
|------|-------------|
| Worse on poor mobile / outdoor | **Audio / network** |
| Worse only live, fine on recorded WAV replayed through same API | **Buffering, VAD, chunking**, or **live path bugs** |
| Changes sharply when you toggle **only** `language_code` / Scribe `language_code` | **Hint / detection** |
| Short utterances much worse | **Length / vad_min_speech_ms** 

**Offline comparisons (no production delay):** capture **raw PCM/WAV** at Exotel rate; replay identical bytes to Sarvam and ElevenLabs in a script.

---

## 4. Sarvam STT — accuracy without added latency

**Single-request levers:**

| Lever | Note |
|-------|------|
| **Model** (e.g. `saaras:v3`) | Validate on **your** 8 kHz samples. |
| **`language_code` on the wire** | Omit/`unknown` → `language_probability` (policy-friendly). Explicit hint → often **stabler text** for fixed language; see product trade-off in §5. |
| **Mode** (`transcribe`, etc.) | Match Saaras v3 docs; wrong mode can skew output. |
| **WAV honesty** | Sample rate in WAV + query params must match payload. |
| **VAD / min utterance** (`customer_settings`) | Fewer nonsense partials—not an extra API call; may add **slight** user wait before STT starts. |

**Avoid for “no delay”:** second full-file STT, “rehint” except where the product already does it as a deliberate quality pass (that path is **not** zero-cost).

**Canonical docs (verify periodically):**

- [Speech-to-text (REST)](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/rest-api)  
- [Streaming STT](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api)  
- [WebSocket transcribe](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws)  
- Models / `language_probability`: [Saaras & related model pages](https://docs.sarvam.ai/api-reference-docs/getting-started/models/saaras)

**In-repo offline mirrors (may lag upstream—diff when upgrading integration):**

- `docs/vendor-offline/sarvam-stt-streaming.md`  
- Related: `docs/vendor-offline/sarvam-tts-*.md` (TTS only; same vendor folder)

---

## 5. ElevenLabs STT (Scribe) — accuracy without added latency

**Single-request levers:**

| Lever | Note |
|-------|------|
| **`language_code` (ISO-style)** | Omit → **auto** (risky on messy 8 kHz). **Send hint** when session language is known → often fewer “wrong language” transcripts **without** a second request. |
| **`model_id`** | Use the **Scribe** variant you validated for telephony. |
| **English-only product** | Prefer **forced English** mapping from your BCP-47 defaults—not full auto—unless you must detect. |

BCP-47 ↔ ElevenLabs mapping and call sites live in `apps/api/src/services/elevenlabs.ts` and `exotel-voicebot.ts`.

**Canonical docs (verify periodically):**

- [Speech-to-text overview](https://elevenlabs.io/docs/capabilities/speech-to-text)  
- [Create transcript / API](https://elevenlabs.io/docs/api-reference/speech-to-text) (exact URL may move—use site search if 404)

**In-repo offline mirrors:**

- `docs/vendor-offline/ELEVENLABS_TTS_QUICKSTART_AND_STREAMING.md` (TTS focus; still point engineers at ElevenLabs **STT** URLs above for Scribe).  
- `docs/ELEVENLABS_VOICEBOT_README.md` — env + DB flags for ElevenLabs on the voicebot.

---

## 6. Session language policy vs transcript quality

Implemented behaviour (see `docs/EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md`):

- **Early window (queries 1–2):** Sarvam STT omits `language_code` (WebSocket `unknown`) and ElevenLabs omits `language_code` when multilingual and not in full-auto — **open** detection for language policy and `language_probability` on Sarvam.
- **Query 3 onward:** Both providers send a **single** biased request (`language_code` = session active language / BCP→EL map) for **narrowband accuracy** — no extra STT round-trip.

Reconcile any regression by comparing traces: `pipeline.stt.sarvam_language_hint` / `pipeline.stt.elevenlabs_language_hint` include `prior_user_query_count` and open-detect flags.

---

## 7. Diagnostic playbook

1. **Golden set:** 10–20 clips at production rate (names, code-mix, noisy + clean).  
2. **Matrix:** hint on/off, forced English vs auto, model A/B, Sarvam vs ElevenLabs—same bytes, same duration.  
3. **Diff** full HTTP/WS payloads (including `language_code`, `model`, `sample_rate`, file vs stream).  
4. **Correlate** with link quality if metadata exists.

---

## 8. Proper nouns & domain confusions

Models optimise for common n-grams. **Low-latency** mitigations:

- Curated **post-STT** normalisation for **known** entities (RAG/KB)—no second STT.  
- **Stable language + script** so lexicon matches user intent.

---

## 9. Keeping vendor & internal documentation “alive”

| Action | Owner / cadence |
|--------|------------------|
| Open **canonical** Sarvam & ElevenLabs links above before each integration change | Engineer doing STT work |
| Update **`docs/vendor-offline/*`** when you copy new vendor pages | Same PR as behaviour change, or quarterly audit |
| If a link 404s, replace from vendor **site search** and fix this file in the same PR | |
| Cross-check **`exotel-voicebot` STT branch** (Sarvam REST/WS, ElevenLabs multipart) against current OpenAPI / examples | Release QA |

---

## 10. Summary (priority order)

1. **Prove audio + encoding** (rate, WAV, VAD, buffer).  
2. **One STT call** with the **strongest permissible hint** for the session state (no second job for “no delay”).  
3. **Validate models** on **8 kHz** captures.  
4. **Align** language-switch policy with hinting (`EXOTEL_VOICEBOT_LANGUAGE_SWITCHING_SPEC.md`).  
5. **Domain** normalisation for measured systematic errors.

---

*Last expanded: 2026-04-28. Purpose: operational tuning and regression analysis for Exotel voicebot STT; keep §9 links and offline mirrors current.*
