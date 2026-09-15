# Plan: "Typing" / thinking sound + office background ambience for the Vodafone voicebot

**Status:** Planning only — nothing implemented yet, per explicit request.
**Scope:** `apps/api/src/routes/vodafone-voicebot.ts` (Vodafone/VI route only; Exotel not touched).

---

## 1. What's being requested (and one ambiguity to resolve first)

Two distinct audio features were asked about together:

1. **"Typing effect" / thinking sound** — a short audio cue that starts playing the
   instant the caller stops talking, and stops once the bot's real answer starts
   speaking. Fills the silent STT→LLM→TTS gap so the call doesn't feel dead.
2. **"Office background sound effects"** — ambient office/call-center noise.

For (2), the request doesn't say whether the ambience should play **only during
the same thinking gap** (in which case it's really the same feature as #1 with a
different audio clip), or **continuously through the whole call**, mixed under
the greeting and every spoken answer too. These are very different amounts of
work (see §4). **This needs to be confirmed before implementation starts** —
the estimates below cover both interpretations separately.

---

## 2. What VI's (Vodafone's) protocol actually allows

Checked against `docs/VOICE_PLATFORM_ARCHITECTURE_REVIEW_AND_ROADMAP_2026-09-07.md`
§8.5.1 (the vendor's own *"Voice Streaming – User Manual – Agent Calling"* spec,
already on file from the original Vodafone integration work) and the current
`types/vodafone-ws.ts` implementation.

**Relevant facts:**

- Bidirectional streams (which this voicebot uses) let us send `media` events
  to VI **at any time**, containing arbitrary raw 16-bit PCM, 8kHz, base64-encoded
  — exactly the same wire format already used for greetings/TTS answers today.
  There's nothing VI-side that distinguishes "real speech" from "sound effect" —
  it's just PCM bytes. **Technically nothing new is needed from VI's side; this
  is just sending a different, pre-rendered audio clip instead of TTS output.**
- Chunking rule (already implemented in `chunkVodafoneAudio()`): each `media`
  frame must be **1.6KB–50KB, and a multiple of 160 bytes**. Same constraint
  applies to a sound-effect clip as to speech.
- `clear` (client → VI) cancels **queued-but-not-yet-started** audio only — the
  vendor doc is explicit that whatever chunk is *currently playing* finishes
  regardless. This is the key constraint for a clean handoff from "typing sound"
  to "real answer": if the typing sound is sent in one big chunk, `clear` can't
  cut it off mid-chunk, so the answer would either overlap or wait. **Mitigation:
  send the typing/ambience clip in small chunks (near the 1.6KB floor, ~100ms
  each)** so a `clear` sent as soon as the real answer's first audio is ready
  caps the worst-case overrun at about one chunk's duration (~100–200ms).
- `mark` (already wired up in the current codebase, commit `1f534b3`) tells us
  when previously-sent audio has actually finished playing on the call — this
  is what the existing no-barge-in gating (`isSpeaking`/`pendingMarks`) is built
  on, and the same mechanism would sequence "typing sound" → "clear" → "real
  answer" → "mark".
- **VI has no built-in hold-music / comfort-noise / typing-indicator feature.**
  There's nothing to configure on VI's side — any such sound is entirely our
  own audio asset, entirely our own code, sent as ordinary outbound `media`.
- No VI-side requirement to keep the outbound stream constantly full — the
  current implementation already goes silent for the full STT+LLM+TTS gap
  today with no protocol complaints, so there's no compliance reason to add
  filler audio, only a UX one.

**Conclusion: protocol-wise, this is fully feasible and low-risk.** The
complexity is entirely on our side (sourcing/preparing the audio, sequencing
it against the real answer, and — for continuous ambience — mixing).

---

## 3. Where this hooks into the current pipeline

Today's turn flow (`processUtterance` → `answerUtteranceStreaming` /
`answerUtteranceBatch`, both in `vodafone-voicebot.ts`):

```
silence timer fires
  → STT (runSimulatorStt)                         ← dead air today
  → runAskPipeline (LLM, streamed or batch)        ← dead air today
  → first TTS audio chunk ready → sendFrames(...)  ← caller first hears something here
```

The "typing sound" feature would add a step right after STT completes
(transcript is ready, `finalTranscript` resolved) and run **in parallel** with
the LLM/TTS call already in flight — it doesn't wait on anything, so it doesn't
add to the pipeline's actual critical path:

```
STT done → transcript ready
  ├─ start playing typing-sound clip (small looping chunks) ──┐
  └─ kick off runAskPipeline (unchanged, same as today)       │
                                                                 first real TTS
                                                        audio chunk ready
                                                                 │
                                              send `clear` (cancel queued
                                              typing-sound chunks) ──┘
                                              → send real answer audio
```

This interacts cleanly with the no-barge-in gating added in commit `1f534b3`:
the typing sound counts as the bot "speaking" (`isSpeaking = true`,
`pendingMarks` tracked) for exactly the same reason real TTS audio does — the
caller shouldn't be able to talk over it either, which matches "no barge-in by
design" already established for this project.

---

## 4. Two features, two different scopes

### 4a. Typing/thinking sound (gap-only, as literally requested)

- One short pre-rendered clip (e.g. soft keyboard-typing or a subtle "thinking"
  tone), looped in ~100–200ms chunks between STT completion and the first real
  answer chunk.
- Touches: `processUtterance`/`answerUtteranceStreaming`/`answerUtteranceBatch`
  (start the loop, send `clear` + stop the loop once real audio is ready), plus
  a small new helper to load/chunk the static clip once at startup (no TTS call
  needed — it's a fixed asset, not synthesized per turn).
- No mixing required — it's sequential (typing sound, *then* real answer), not
  simultaneous.

### 4b. Office ambience — Option 1: same gap only

Functionally identical to 4a, just a different (probably longer, seamlessly
loopable) audio asset. No extra engineering beyond 4a — could even be the same
code path with a per-customer choice of clip.

### 4b. Office ambience — Option 2: continuous under the whole call

If the intent is background office noise audible *underneath* the greeting and
every spoken answer (not just the silent gap), that's materially more work:

- Requires a **real-time PCM mixing** step (sample-by-sample addition of the
  looping ambience track under whatever's being spoken, with the ambience
  ducked to a lower volume than speech, and clipping-safe addition) — nothing
  like this exists in the codebase today (`pcm-audio.ts` has a crossfade
  helper for join points, not simultaneous mixing).
- Must be wired into **every** outbound audio path in the file: the greeting
  (`handleStart`), the batch answer, the streaming per-sentence path (both the
  Cartesia-streaming branch and the Sarvam-per-sentence branch), and the error
  fallback — five call sites instead of one.
- Needs tuning (ambience volume relative to speech, fade in/out at call
  start/end, making sure it doesn't make the bot's own voice harder to
  understand or trip up nothing on the inbound side — telephony audio is
  one-way per leg here, so it can't bleed into what VI sends back to us, but it
  can absolutely make the bot sound worse if not balanced carefully).
- Needs a genuinely seamless loop point in the source audio (an audible seam
  every N seconds would be worse than no ambience at all).

---

## 5. Latency impact

**Typing sound / gap-only ambience (4a / 4b-Option 1):**
Effectively **no added latency to the actual answer** — it runs in parallel
with STT/LLM/TTS, not in series, so wall-clock time-to-full-answer is
unchanged. If anything this is a *perceived*-latency improvement: the current
observed gap between "caller stops talking" and "bot starts speaking" is
roughly **1.5–3.5 seconds** in the last batch of real call logs (LLM
first-token time is the dominant cost, matches the latency numbers discussed
in this project already) — a typing sound fills exactly that window with
something audible instead of dead air.

Two small, bounded costs:
- The `clear` handoff can't interrupt a chunk already playing — capped at
  roughly one chunk's duration if the clip is sent in ~100–200ms pieces as
  recommended in §2. Worst case, the caller hears at most ~100–200ms of
  overlap/tail between the typing sound cutting off and the real answer
  starting — not a new pipeline delay, just a small, fixed sequencing slop.
- Loading the pre-rendered clip is one-time, in-memory (no network/TTS call
  per turn), so effectively 0ms of added per-turn cost.

**Continuous ambience mixing (4b-Option 2):**
Also no meaningful added *runtime* latency — mixing is simple sample addition,
sub-millisecond per audio chunk, nowhere near TTS/LLM cost. The cost here is
**engineering time and audio-quality risk**, not call latency.

---

## 6. Time estimates

These are engineering-time estimates only (not calendar time — depends on
review/deploy cadence), and assume a suitable royalty-free/licensed audio
clip is either already available or quick to source; sourcing/licensing audio
is explicitly called out as a separate dependency below.

| Feature | Estimate | Notes |
|---|---|---|
| **4a. Typing/thinking sound (gap-only)** | **~0.5–1 day** | New static-clip loader + chunker, hook into the 2 turn-loop functions, `clear`-based handoff, live-call tuning of clip length/volume. |
| **4b, Option 1. Office ambience (gap-only)** | **+~0.5 day** on top of 4a | Same plumbing as 4a; mainly sourcing/preparing a good loopable clip and (optionally) a per-customer choice of clip. |
| **4b, Option 2. Office ambience (continuous, mixed under speech)** | **~2–4 days** total | New PCM mixing utility, wiring into all 5 outbound audio call sites, volume/ducking tuning, multiple rounds of live-call listening to get it sounding natural rather than distracting. |

**Not included in the above, and worth flagging explicitly:**
- Sourcing or licensing the actual sound assets (typing sound, office ambience)
  is not an engineering task and isn't estimated here — needs a royalty-free
  source or a generated one. Converting whatever's sourced to raw 16-bit PCM
  8kHz mono is trivial (a one-line `ffmpeg` conversion) once the asset exists.
- Per-customer control: if this should be toggleable per tenant (recommended —
  mirrors the existing `filler_ack_enabled`-style pattern already used for the
  verbal filler-word feature in `docs/VOICEBOT_FILLER_ACK_LOGIC.md`), add a
  `customer_settings` column + migration — small, but not included above.

---

## 7. Open questions before implementation

1. **Ambience scope**: gap-only (4b-Option 1, cheap) or continuous under
   speech (4b-Option 2, real mixing engine)? This changes the estimate by
   several days.
2. Is this scoped to **this one Vodafone customer only**, or should it be a
   general capability (per-customer toggle) across all Vodafone/Exotel
   tenants? Affects whether it belongs behind a `customer_settings` flag.
3. Do we have an audio asset in mind already, or does one need to be
   sourced/generated? Any brand/style preference (subtle keyboard clicks vs. a
   soft tone vs. actual office chatter)?
4. Should the typing sound vary by language/customer, or is one universal clip
   fine?

No code has been written for this — this document is the plan only, per your
instruction.
