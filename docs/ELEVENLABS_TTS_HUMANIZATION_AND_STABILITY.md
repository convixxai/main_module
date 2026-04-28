# ElevenLabs TTS: more human, stable audio (no “robot breaks”)

This document lists **ordered steps** to improve **naturalness** and **continuity** of bot speech when using ElevenLabs on the voicebot path. It is written to complement `docs/ELEVENLABS_VOICEBOT_README.md` and the current pipeline behaviour (telephony sample rate, optional streaming TTS, WAV/PCM handling, optional resample before Exotel).

**Reference sample:** `c:\Users\dhira\Downloads\testing.mp3` — use it as a **baseline recording** while you work through the checklist. This repo does not analyze that file automatically; treat it as your A/B reference (before/after).

---

## 1. Clarify what you are measuring

| Question | Why it matters |
|----------|----------------|
| Is `testing.mp3` a **recording from the PSTN / Exotel** playout, or a **direct export** from ElevenLabs (browser/app)? | PSTN adds band-limiting, jitter, and possible transcoding; fixes differ. |
| Is the problem **within one TTS generation** or **between sentences / chunks**? | Single-call issues → model, text, voice settings. **Between chunks** → streaming RAG, multiple `speak` passes, framing. |
| Does it match **non-streaming** (`tts_streaming_enabled = false`) or **streaming** (`true`)? | Streaming paths buffer and concatenate audio; seams can sound like “breaks”. |

Write down 1–2 sentences for each before changing knobs.

---

## 2. Voice and model (biggest “human” lever)

1. **Pick a voice intended for conversation**, not narration-only. In the ElevenLabs UI, preview the same text at **8 kHz telephony** (or the closest export) if available; studio previews lie about phone reality.
2. **Model choice**
   - **`eleven_v3`**: more expressive; works best when **audio tags** are used consistently (see §4). Can sound unstable if tags conflict or are stripped.
   - **Other models** (e.g. `eleven_turbo_v2_5` class): often **flatter** but **more consistent** prosody for factual reads—sometimes better if “breaks” are emotional glitches from v3.
3. **Avoid Voice Library voices on restricted plans** if they fall back to a different premade voice mid-flight (quality and timbre shifts feel like “breaks”). Prefer a stable **`voice_id`** you control.

---

## 3. `voice_settings`: stability vs expressiveness (API)

The stack’s defaults (see `docs/ELEVENLABS_VOICEBOT_README.md`) bias **human phone** delivery: moderate stability, high similarity, moderate style, speaker boost on, speed capped at 1.0.

**If audio sounds choppy, wobbly, or “restarts” mid-phrase:**

- **Raise `stability` slightly** (e.g. toward **0.45–0.55**) to reduce runaway expressiveness and odd phrase-boundary resets.
- **Lower `style` slightly** if delivery feels theatrical or inconsistent on short sentences.
- **Keep `similarity_boost` sensible** (very high + unstable model can add artifacts on some voices).

**If audio sounds flat or robotic:**

- **Lower `stability` slightly** within a safe band, or move to **v3 + disciplined tags** (§4) rather than maxing `style`.

Tune in **small steps**; telephony masks detail—validate on a **phone recording**, not only desktop speakers.

---

## 4. Text and LLM output (continuity and “human” phrasing)

Breaks and weird cadence often come from **input text**, not the codec.

1. **Punctuation**  
   Use commas and periods where a human would breathe. Avoid huge single-line paragraphs; prefer **short clauses** for phone listening.
2. **Lists and bullets**  
   Spelled-out lists (“First … Second …”) usually sound smoother than dense punctuation clusters.
3. **`eleven_v3` and audio tags**  
   - RAG prompts can require **tags per sentence** for v3.  
   - In application, tags are **kept for v3** unless `ELEVENLABS_V3_STRIP_AUDIO_TAGS` (or equivalent env) strips them—**misalignment** between “LLM always tags” and “runtime strips” makes results feel random. Confirm env + tenant `tts_model` **match** your intent.  
   - **Too many tags** or conflicting tags (e.g. `[whispers]` then clipped sentence) can sound like cuts or unnatural resets.
4. **Hard truncations**  
   Very long replies are capped before TTS; cutting mid-sentence sounds like a **hard break**. Prefer shorter answers for voice, or intentional micro-summaries.

---

## 5. Streaming vs single-shot TTS (seams between chunks)

When **RAG + TTS streaming** are both enabled, the bot may synthesize **several fragments** in sequence. Each fragment is a **separate** TTS synthesis boundary:

- Prosody **resets** at each new chunk → listener may hear **micro-pauses** or **tone shifts**.
- **Mitigations (conceptual):** prefer **one TTS call per turn** when latency allows (disable TTS streaming for that tenant); or constrain the LLM to **fewer, longer speakable units** so streaming fires less often; or use a model/voice combo that **masks** boundaries better.

When **TTS streaming** is enabled at the API level (`/stream`), the client **concatenates** byte buffers. Concatenation is usually seamless **within one request**, but **multiple HTTP/stream requests** still mean multiple prosody starts.

---

## 6. Sample rate, WAV parsing, and resampling (hidden “quality” bugs)

Current voicebot behaviour (ElevenLabs path): response bytes → **parse as WAV PCM16 mono** when possible → otherwise treat as **raw s16le** derived from `output_format` → **resample** to Exotel’s stream rate if needed → send to Exotel.

**Audible issues to hunt:**

- **Wrong sample rate interpretation** (e.g. body is WAV but parser path differs): speed/pitch wrong, “crunchy” sound.
- **Resampling** from 16 kHz → 8 kHz: benign if done once with a good algorithm; **double resampling** or wrong source rate hurts clarity.
- **MP3** (`testing.mp3`) is **not** what Exotel sends raw; if you compare MP3 exports to live PCM, level-match and accept codec differences.

**Sanity check:** Log (or temporarily capture) **`output_format`**, **parsed vs raw path**, **srcRate**, **exotelRate** for the same utterance as in `testing.mp3`.

---

## 7. Exotel framing and playback (after TTS)

Outbound audio is split for Exotel’s **frame rules** (small aligned PCM chunks). If upstream audio has **DC offset**, **sharp digital silence gaps**, or **truncated last frame**, playback can click or “hiccup.”

Actions:

- Confirm **no zero-length** sends between logical phrases when the pipeline fires multiple times.
- Confirm **mark / playback** timing does not cut the tail of the last frame (sounds like an early clip).

---

## 8. Practical diagnostic order (use `testing.mp3` as “before”)

1. **Label the failure:** within-sentence vs between-sentence vs only on phone.  
2. **Fix text:** punctuation, length, tag policy aligned with v3 vs non-v3.  
3. **Fix voice/model:** conversational voice; try non-v3 if v3 is unstable for your content.  
4. **Tune `voice_settings`:** stability/style first.  
5. **Reduce TTS fragmentation:** fewer streaming chunks per answer if seams dominate.  
6. **Verify PCM path:** output format, WAV vs raw, single resample, Exotel rate.  
7. **Re-record** `testing.mp3` after each major change; keep a **table** (date / settings / subjective score).

---

## 9. What this document does *not* promise

- **Instant “broadcast” quality on 8 kHz** — physics and PSTN limit fidelity.  
- **Zero trade-offs** — more human delivery (v3, higher style) can **increase** variance; more stable delivery often means **less** dramatic expression.  
- **MP3-specific fixes** — your production chain is PCM-oriented; MP3 is mainly a **listening** artifact unless you transcode for distribution.

---

## 10. Related docs

- `docs/ELEVENLABS_VOICEBOT_README.md` — env, DB flags, default voice settings.  
- `docs/vendor-offline/ELEVENLABS_TTS_QUICKSTART_AND_STREAMING.md` — streaming API context (if you maintain offline vendor notes).

---

## 11. Implemented in this repo (voicebot)

Default API `voice_settings`, text polish before TTS, **longer ElevenLabs-only streaming cuts** (`findNextSpeakCutElevenLabs`), and a **short linear PCM crossfade** between consecutive ElevenLabs utterances after resampling to Exotel rate. Sarvam and non–ElevenLabs paths are unchanged.

---

*Sections 1–10 remain a general tuning guide; §11 reflects application code as of the ElevenLabs smoothness pass.*

