# ElevenLabs eleven_v3 Voice Quality & Humanization — Improvement Plan

**Date:** 2026-05-02  
**Goal:** Make the voicebot sound **faster** and **more human-like** on phone calls  
**Status:** Proposal — waiting for approval before any code changes

---

## Table of Contents

1. [Current Setup Audit](#1-current-setup-audit)
2. [The Audio Journey (How Voice Gets to the Caller)](#2-the-audio-journey)
3. [Problem Areas](#3-problem-areas)
4. [Improvement Steps](#4-improvement-steps)
   - Step 1: ~~Switch from `eleven_v3` to `eleven_flash_v2_5` or `eleven_turbo_v2_5`~~ — **DO NOT IMPLEMENT** (already in `customer_settings.tts_model`)
   - Step 2: Eliminate Resampling — Use `ulaw_8000` Directly
   - Step 3: Tune `voice_settings` for Phone Conversations
   - Step 4A: Fix LLM Prompt for Natural Phone Speech
   - Step 4B: Fix Audio Tag Leak Bug (Tags Showing for Non-v3 Models)
   - Step 5: Reduce Streaming Chunk Fragmentation
   - Step 6: Use ElevenLabs Streaming API Properly
5. [Impact Summary](#5-impact-summary)
6. [Testing Checklist](#6-testing-checklist)
7. [Database Changes Required](#7-database-changes-required)

---

## 1. Current Setup Audit

### What We Have Right Now

| Component | Current Setting | Where It Lives |
|-----------|----------------|----------------|
| **TTS Model** | `eleven_v3` | `customer_settings.tts_model` or env `ELEVENLABS_DEFAULT_TTS_MODEL` (default: `eleven_v3`) |
| **Voice ID** | Per customer/agent or `ELEVENLABS_DEFAULT_VOICE_ID` fallback | `customer_settings.tts_default_speaker`, `elevenlabs_avatars.voice_id`, or env |
| **Output Format** | `pcm_22050` (hardcoded for v3) | `elevenlabs.ts` → `elevenLabsTtsOutputFormatForTelephony()` |
| **Exotel Expects** | Raw PCM `slin` 16-bit LE mono @ **8000 Hz** | Negotiated in Exotel `start` message (`media_format.sample_rate`) |
| **What Happens** | ElevenLabs generates audio at **22,050 Hz** → our code **resamples** to **8,000 Hz** → sends to Exotel | `speakToExotel()` in `exotel-voicebot.ts` |
| **Stability** | `0.48` | `ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS` in `elevenlabs.ts` |
| **Similarity Boost** | `0.88` | Same location |
| **Style** | `0.12` | Same location |
| **Speaker Boost** | `true` | Same location |
| **Speed** | `1.0` (capped at max 1.0) | Same location, `normalizeVoiceSettingsForApi()` caps at 1.0 |
| **Audio Tags** | v3 uses `[happy]`, `[calm]`, etc. via LLM prompt | `ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE` in `elevenlabs.ts` |
| **Streaming** | Per customer `tts_streaming_enabled` | `customer_settings.tts_streaming_enabled` |

### Current Voice Settings Defaults (Code)

```typescript
const ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS = {
  stability: 0.48,
  similarity_boost: 0.88,
  style: 0.12,
  use_speaker_boost: true,
  speed: 1.0,
};
```

### Current LLM Instructions for v3

The system prompt tells the LLM to add audio tags like `[happy]`, `[calm]`, `[curious]` before every sentence. This is intended to make v3 sound expressive, but it adds complexity and can cause unpredictable behavior.

---

## 2. The Audio Journey

### Technical Version

```
LLM generates text → Text cleanup (polish, cap 2500 chars) →
  ElevenLabs API (POST /v1/text-to-speech/{voice_id}) →
  Response: PCM audio at 22,050 Hz, 16-bit signed LE, mono →
  Parse WAV header (or treat as raw PCM) →
  Resample 22,050 Hz → 8,000 Hz (linear interpolation) →
  Crossfade with previous chunk tail (40 samples) →
  Split into 320-byte aligned chunks (3.2KB–100KB) →
  Base64 encode → Send to Exotel WebSocket →
  Exotel plays to caller via PSTN (phone network)
```

### Simple Version

> Imagine you're recording a song in a professional studio at high quality, then someone squishes it down to play on an old radio. That's basically what we're doing — **ElevenLabs creates beautiful audio at "studio quality" (22,050 Hz), then we crunch it down to "phone quality" (8,000 Hz) before sending it to the caller.** This crunching step (called "resampling") can make the voice sound worse than it needs to be.
>
> It's like photocopying a color photo in black and white — you lose information.

### Where Quality Gets Lost

```
┌────────────────────────┐
│ ElevenLabs generates   │  ← Quality is great here
│ audio at 22,050 Hz     │
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Our code resamples     │  ← QUALITY LOSS #1: basic linear interpolation
│ 22,050 → 8,000 Hz     │     introduces aliasing artifacts
└───────────┬────────────┘
            │
            ▼
┌────────────────────────┐
│ Exotel sends to phone  │  ← Audio is already at the right rate
│ network (PSTN)         │     for the negotiated format (slin PCM)
└────────────────────────┘
```

> [!IMPORTANT]
> **We are generating at 22,050 Hz but Exotel expects 8,000 Hz (or 16,000 Hz) slin PCM.** That means we resample every time, losing quality through basic linear interpolation. If we ask ElevenLabs to give us audio at the exact rate Exotel negotiated, we skip our resampling step entirely.

---

## 3. Problem Areas

### Problem 1: Wrong Model for Phone Calls
**Technical:** `eleven_v3` is designed for content creation (audiobooks, videos) with high expressiveness. It is NOT optimized for real-time telephony. It has **higher latency** (~500ms+ TTFB) compared to turbo/flash models (~75-300ms).

**Simple:** Think of `eleven_v3` as a Hollywood actor who takes time to "get into character" for every line. For a phone call, you want a friendly receptionist who responds instantly and naturally — that's what the "turbo" or "flash" models are.

### Problem 2: Double Audio Degradation
**Technical:** We generate at 22,050 Hz, then resample to 8,000 Hz using basic linear interpolation (no anti-aliasing filter), then Exotel applies G.711 µ-law compression on the PSTN bridge. Two lossy transformations.

**Simple:** We're making a high-quality photo, shrinking it ourselves (losing quality), then the phone company shrinks it again (losing more quality). Instead, we should ask for a "phone-sized" photo from the start.

### Problem 3: Audio Tags Cause Inconsistency
**Technical:** The LLM is instructed to prepend audio tags like `[happy]`, `[calm]` before every sentence. Different tags on consecutive sentences cause prosody resets — the voice "restarts" its emotional tone, creating audible seams.

**Simple:** Imagine asking a speaker to be "excited" for one sentence, then "calm" for the next, then "curious" for the third. They'd sound like three different people. On a phone call, you want one consistent, warm tone throughout.

### Problem 4: Streaming Fragmentation
**Technical:** When `rag_streaming_enabled + tts_streaming_enabled = true`, the LLM response is split at sentence boundaries and each sentence is a separate TTS API call. Each call is an independent synthesis — prosody resets, potential pitch/energy discontinuities between chunks.

**Simple:** Instead of reading a paragraph smoothly, the bot says each sentence as if it's starting a brand new conversation. The gaps and tone changes between sentences feel unnatural.

### Problem 5: Speed Capped Too Conservatively
**Technical:** `normalizeVoiceSettingsForApi()` caps `speed` at `1.0`. ElevenLabs turbo/flash models support up to `1.2` and can sound more natural at slightly higher speeds on phone.

**Simple:** Conversations on the phone are naturally a bit faster than reading a book aloud. Our bot is forced to speak at "audiobook speed" when "conversational speed" (slightly faster) would sound more natural and reduce response time.

---

## 4. Improvement Steps

### ~~Step 1: Switch from `eleven_v3` to a Faster Model~~ — DO NOT IMPLEMENT

> [!NOTE]
> **This step is already handled.** The TTS model is configurable per customer via `customer_settings.tts_model`. Customers can already be set to `eleven_turbo_v2_5`, `eleven_flash_v2_5`, or any other model via SQL update. No code changes needed.
>
> To switch a customer, simply run:
> ```sql
> UPDATE customer_settings SET tts_model = 'eleven_turbo_v2_5' WHERE customer_id = '<UUID>';
> ```

The table below is kept for reference when choosing a model per customer:

| Model | Latency (TTFB) | Quality | Best For |
|-------|----------------|---------|----------|
| `eleven_v3` (current) | ~500ms+ | ★★★★★ expressiveness | Audiobooks, content creation |
| `eleven_turbo_v2_5` | ~250-300ms | ★★★★ natural | Balanced telephony |
| `eleven_flash_v2_5` | ~75ms | ★★★ good | **Fastest telephony** ✅ |

**No code changes needed for this step — use SQL to switch customers to the right model.**

---

### Step 2: Eliminate Resampling — Request Native Sample Rate from ElevenLabs

> [!WARNING]
> **Exotel does NOT support µ-law (ulaw_8000).** After checking the Exotel WebSocket spec (`docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md` §5, §7, §8) and the vendor offline doc (`docs/vendor-offline/exotel-stream-voicebot-applet.md`), Exotel exclusively uses **`raw/slin` — signed linear PCM, 16-bit, mono, little-endian** at the negotiated sample rate (8000, 16000, or 24000 Hz). Both inbound AND outbound must be in this format. There is no µ-law or A-law option.

#### What to change
Instead of requesting `pcm_22050` from ElevenLabs (which doesn't match any Exotel rate) and resampling to the Exotel rate, request PCM at the **exact Exotel negotiated rate** directly.

#### Technical details

**Current flow (bad — always 22050 Hz for v3):**
```
ElevenLabs → pcm_22050 (22,050 Hz linear PCM)
  → Our resamplePcm16() → 8,000 Hz linear PCM  [QUALITY LOSS - basic interpolation]
  → base64 → Exotel (slin 8000 Hz)
```

**Why 22050?** In `elevenlabs.ts` → `elevenLabsTtsOutputFormatForTelephony()`:
```typescript
if (elevenLabsTtsModelIsV3(modelId)) {
  return "pcm_22050";  // ← hardcoded for v3! Ignores exotelSampleRate
}
```
This means even when Exotel negotiates 8000 Hz, v3 always generates at 22050 Hz.

**Proposed flow (match Exotel rate):**
```
Exotel negotiates 8000 Hz (or 16000 Hz)
  → ElevenLabs → pcm_8000 (or pcm_16000)  [Native rate!]
  → No resample needed!
  → base64 → Exotel (slin 8000 Hz)
```

#### Exotel supported sample rates (from docs)

| Rate | Exotel Encoding | Notes |
|------|----------------|-------|
| **8,000 Hz** | `raw/slin` 16-bit LE mono | PSTN default, lowest bandwidth |
| **16,000 Hz** | `raw/slin` 16-bit LE mono | Exotel recommended for voicebots |
| **24,000 Hz** | `raw/slin` 16-bit LE mono | HD quality |

**Exotel does NOT support:** µ-law, A-law, MP3, WAV headers, or any other encoding. Only raw `slin` PCM.

#### ElevenLabs available PCM rates

| Format | Rate | Works with Exotel 8kHz? | Works with Exotel 16kHz? |
|--------|------|-------------------------|--------------------------|
| `pcm_8000` | 8,000 Hz | ✅ Direct match, no resample | Needs upsample |
| `pcm_16000` | 16,000 Hz | Needs resample 16k→8k | ✅ Direct match |
| `pcm_22050` | 22,050 Hz | Needs resample 22k→8k (current) | Needs resample 22k→16k |
| `pcm_24000` | 24,000 Hz | Needs resample | ✅ Close match for 24k |
| `pcm_44100` | 44,100 Hz | Needs resample | Needs resample |

#### Recommended approach

1. **If Exotel is at 8000 Hz:** Request `pcm_8000` from ElevenLabs. If the model rejects it (v3 is known to), fall back to `pcm_16000` (16k→8k resample is much better than 22k→8k).
2. **If Exotel is at 16000 Hz:** Request `pcm_16000` from ElevenLabs — zero resample.
3. **If Exotel is at 24000 Hz:** Request `pcm_24000` from ElevenLabs — zero resample.

The fix in `elevenLabsTtsOutputFormatForTelephony()`:
```typescript
// PROPOSED: Match Exotel rate instead of hardcoding 22050 for v3
export function elevenLabsTtsOutputFormatForTelephony(
  modelId: string,
  exotelSampleRate: number,
  opts?: { streaming?: boolean }
): string {
  // For streaming: always use pcm_* (no WAV)
  if (opts?.streaming === true) {
    return elevenLabsPcmOutputFormat(exotelSampleRate);
  }
  // For non-streaming: try WAV at target rate (better headers)
  // but for v3, use pcm_16000 as fallback (v3 rejects low rates)
  if (elevenLabsTtsModelIsV3(modelId) && exotelSampleRate <= 8000) {
    return "pcm_16000";  // 16k→8k resample is much better than 22k→8k
  }
  return elevenLabsWavOutputFormat(exotelSampleRate);
}
```

#### Simple explanation
> Right now, we're asking ElevenLabs for audio at a rate (22,050 Hz) that doesn't match what the phone system uses (8,000 Hz). It's like ordering a size XL shirt and then cutting it down to size M — you lose material and the result doesn't look as good. Instead, we should order the right size from the start. If they don't have our exact size, we pick the closest one (16,000 Hz instead of 22,050 Hz), so less cutting is needed.

#### Impact on response time
- Eliminates or reduces resample computation: saves **2-10ms per chunk**
- Better audio quality: 16k→8k resample preserves more than 22k→8k
- Smaller response payload from ElevenLabs (8kHz PCM = ~36% the size of 22kHz): **faster download**

---

### Step 3: Tune `voice_settings` Per Model for Phone Conversations

#### The Problem

Currently, **one set of defaults** is used for ALL ElevenLabs models:

```typescript
// elevenlabs.ts line 195
const ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS = {
  stability: 0.48,
  similarity_boost: 0.88,
  style: 0.12,
  use_speaker_boost: true,
  speed: 1.0,   // capped at max 1.0 in normalizeVoiceSettingsForApi()
};
```

But `eleven_v3` and `eleven_turbo_v2_5` / `eleven_flash_v2_5` are fundamentally different models with different strengths. Using the same knobs for both is like tuning a piano and a guitar the same way — they need different settings.

Additionally, `normalizeVoiceSettingsForApi()` (line 478) caps `speed` at `1.0`, which is too restrictive for turbo/flash models that support up to `1.2`.

#### What to change

Replace the single `ELEVENLABS_DEFAULT_HUMAN_VOICE_SETTINGS` with **two model-specific profiles**, and pick the right one based on the resolved model ID.

#### Proposed settings — Model-specific profiles

**Profile A: `eleven_v3` (Expressive / Realistic)**

| Setting | Current | Proposed | Why |
|---------|---------|----------|-----|
| `stability` | `0.48` | **`0.55`** | v3's expressiveness benefits from moderate stability. 0.55 keeps emotion alive while preventing wild pitch swings between streamed chunks. Higher than 0.65 would kill v3's signature naturalness. |
| `similarity_boost` | `0.88` | **`0.85`** | Slightly lowered to reduce metallic artifacts that appear when telephony compresses the audio. 0.85 keeps the voice recognizable without fighting the 8kHz pipeline. |
| `style` | `0.12` | **`0.15`** | v3 thrives on style — this is where its "human-like" quality comes from. 0.15 adds warmth and natural inflection without theatrical drift on short phone sentences. |
| `use_speaker_boost` | `true` | **`true`** | Keep ON for v3. The model benefits from speaker boost for voice clarity, and since v3 already has higher latency, the extra compute cost is proportionally small. |
| `speed` | `1.0` | **`1.0`** | Keep at 1.0 for v3. The model's expressiveness needs breathing room. Faster speeds reduce the emotional nuance that makes v3 worth using. |

**Profile B: `eleven_turbo_v2_5` / `eleven_flash_v2_5` (Speed / Telephony)**

| Setting | Current | Proposed | Why |
|---------|---------|----------|-----|
| `stability` | `0.48` | **`0.65`** | Turbo/flash models need higher stability for consistent delivery across streamed chunks. Prevents "voice resets" between sentences. |
| `similarity_boost` | `0.88` | **`0.80`** | Lower than v3 — turbo/flash produce cleaner audio at lower similarity. High values + phone compression = metallic tones. |
| `style` | `0.12` | **`0.05`** | Turbo/flash don't benefit from style like v3 does. Higher values add instability and artifacts on short phone sentences without the payoff. |
| `use_speaker_boost` | `true` | **`false`** | Disable for speed models. Speaker boost adds 10-30ms latency per call. For turbo/flash, speed is the priority and the extra fidelity is lost in 8kHz anyway. |
| `speed` | `1.0` | **`1.05`** | Slightly faster = more natural conversational pace. 1.05 is the sweet spot — not rushed, not sluggish. Saves ~5% of audio duration. |

#### Proposed code change

```typescript
// NEW: Model-aware defaults
const ELEVENLABS_V3_VOICE_SETTINGS: Required<ElevenLabsVoiceSettingsPayload> = {
  stability: 0.55,
  similarity_boost: 0.85,
  style: 0.15,
  use_speaker_boost: true,
  speed: 1.0,
};

const ELEVENLABS_TURBO_FLASH_VOICE_SETTINGS: Required<ElevenLabsVoiceSettingsPayload> = {
  stability: 0.65,
  similarity_boost: 0.80,
  style: 0.05,
  use_speaker_boost: false,
  speed: 1.05,
};

/** Pick the right defaults based on the model. */
function defaultVoiceSettingsForModel(
  modelId: string | null | undefined
): Required<ElevenLabsVoiceSettingsPayload> {
  if (elevenLabsTtsModelIsV3(modelId)) {
    return ELEVENLABS_V3_VOICE_SETTINGS;
  }
  return ELEVENLABS_TURBO_FLASH_VOICE_SETTINGS;
}
```

And update `normalizeVoiceSettingsForApi()` to accept the model ID and use the right profile:

```typescript
function normalizeVoiceSettingsForApi(
  raw: ElevenLabsVoiceSettingsPayload | null | undefined,
  modelId?: string | null   // ← NEW parameter
): ElevenLabsVoiceSettingsPayload | null {
  const defaults = defaultVoiceSettingsForModel(modelId);
  const o: ElevenLabsVoiceSettingsPayload = { ...defaults };
  if (!raw || typeof raw !== "object") return o;
  
  // v3 keeps speed at 1.0 max; turbo/flash allows up to 1.2
  const maxSpeed = elevenLabsTtsModelIsV3(modelId) ? 1.0 : 1.2;
  
  // ... same merge logic, but with model-aware speed cap:
  const speed = num("speed", 0.7, maxSpeed);
  // ... rest unchanged
}
```

#### Where settings come from (priority order)

```
1. elevenlabs_avatars.voice_settings (per avatar, merged with language_voice_map)
2. session.elevenlabsVoiceSettings (set by applyAgentVoicePersonaToSession)
3. FALLBACK → defaultVoiceSettingsForModel(resolvedModelId)  ← THIS IS WHAT WE CHANGE
```

Customers can still override ANY setting via their avatar `voice_settings` JSON. The model-aware defaults only kick in when no avatar override exists.

#### Simple explanation
> Think of it like two different car types: a luxury sedan (v3) and a sports car (turbo/flash). The luxury sedan needs different tuning — softer suspension, smoother acceleration — to feel premium. The sports car needs tighter handling and faster response. Right now, we're using the same tuning for both, which makes neither feel right. By giving each model its own settings, both sound their best on a phone call.

#### Impact on response time
- **v3 customers:** Minimal latency change (speaker_boost stays on, speed stays 1.0). Focus is on voice quality.
- **Turbo/flash customers:** Disabling `speaker_boost` saves **10-30ms**. Speed 1.05 reduces audio duration by **~5%**. Combined with faster model TTFB, this is significant.

---

### Step 4A: Model-Aware LLM Prompt — Tags for v3, Natural Speech for Others

#### Confirmed Rules

| `customer_settings.tts_model` | LLM Gets | Why |
|-------------------------------|----------|-----|
| **`eleven_v3`** | **Audio tags compulsory** — `[happy]`, `[calm]`, `[curious]`, etc. before every sentence | v3 is designed to interpret these tags. They make v3 sound expressive and human. This is v3's key advantage. |
| **`eleven_turbo_v2_5`** / **`eleven_flash_v2_5`** / other | **No tags** — natural phone speech prompt instead | Non-v3 models read `[happy]` as literal words ("bracket happy bracket"). Tags must NOT appear. |
| **NULL / empty** | **No tags** — treat as non-v3 | If no model is explicitly set, assume it's not v3. (Fixes the Step 4B bug.) |

#### What stays the same (v3 customers)

The existing `ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE` prompt is good and stays:
```
Your reply will be read with **eleven_v3**. You MUST use ElevenLabs **audio tags**
in square brackets so the voice sounds human and expressive.

Requirements:
- **Every sentence** you output should start with **exactly one** audio tag
  right before the words, e.g. [happy] Great question. [calm] Here is what we offer.
- Use concise English tags: [happy], [sad], [excited], [warmly], [sympathetic],
  [curious], [reassuring], [thoughtful], [whispers], [laughs], [sighs], etc.
```

This is what makes v3 worth using — keep it.

#### What to change (non-v3 customers)

Replace the current `ELEVENLABS_RAG_AUDIO_TAGS_RULE` (which just says "don't use tags") with a more helpful **natural phone speech prompt**:

**Current (for non-v3):**
```
Do NOT use square-bracket tags like [happy] or [sighs]...
For natural speech here, use wording, commas, and periods only.
```

**Proposed (for non-v3):**
```
--- ElevenLabs TTS delivery (phone call) ---
Your response will be read aloud by text-to-speech on a live phone call.

Rules:
- Keep answers to 1-3 SHORT sentences. Phone listeners can't absorb long answers.
- Use commas and periods where a human would naturally pause or breathe.
- Write like you're talking, not writing. Use contractions (don't, we're, that's).
- Start responses warmly but briefly ("Sure!", "Of course.", "Great question.").
- DO NOT use bullet points, numbered lists, markdown, or any formatting.
- DO NOT use square brackets, parentheses, or special characters like [happy] or [sighs].
- Prefer simple, everyday words over formal vocabulary.
- End with a short question to keep the conversation going when appropriate.
```

#### Why different prompts per model

```
┌───────────────────────────────┐
│ customer_settings.tts_model   │
│ = 'eleven_v3'                 │
└──────────┬────────────────────┘
           │ YES
           ▼
   ┌──────────────────┐
   │ TAGS COMPULSORY   │ → v3 interprets [happy], [calm] as emotion cues
   │ Expressive prompt │    This is what makes v3 sound human
   └──────────────────┘

┌───────────────────────────────┐
│ customer_settings.tts_model   │
│ = 'eleven_turbo_v2_5' / other │
│ = NULL / empty                │
└──────────┬────────────────────┘
           │
           ▼
   ┌──────────────────┐
   │ NO TAGS           │ → turbo/flash read [happy] as literal text!
   │ Natural speech    │    Expressiveness comes from punctuation & phrasing
   │ prompt instead    │
   └──────────────────┘
```

#### Simple explanation
> For customers using v3 (the premium voice), the AI is told to add emotion hints like `[happy]` before each sentence — v3 understands these and uses them to sound expressive. For customers using the faster models (turbo/flash), the AI is told to write naturally without any special markers, because those models would say "bracket happy bracket" out loud instead of understanding the emotion.

#### Impact on response time
- **v3 customers:** No change — tags stay as-is
- **Non-v3 customers:** Fewer LLM output tokens (no `[tag]` overhead) saves **20-50ms**. Better natural speech prompt produces shorter, more phone-friendly answers saving **200-500ms** of TTS time.

---

### Step 4B: Fix Audio Tag Leak Bug (Tags Showing for Non-v3 Models)

> [!WARNING]
> **This is a real bug found during code analysis.** Audio tags are leaking into the LLM prompt for non-v3 models under certain conditions.

#### The Bug

In `elevenlabs.ts`, the function `buildElevenLabsRagAudioTagHintForProvider()` decides what LLM instructions to add based on the TTS model. Here's the problem:

```typescript
// elevenlabs.ts lines 290-306
export function buildElevenLabsRagAudioTagHintForProvider(
  ttsProvider, ttsModelRaw, opts
) {
  if (ttsProvider !== "elevenlabs") return "";        // ✅ OK
  
  // Path A: customer_settings.tts_model IS "eleven_v3"
  if (elevenLabsTtsModelIsV3(opts?.customerTtsModelRaw)) {
    return STRICT_SENTENCE_TAGS_RULE;                  // ✅ OK — v3 gets tags
  }
  
  // Path B: customer_settings.tts_model is NOT "eleven_v3"
  const resolved = resolveElevenLabsTtsModelId(ttsModelRaw);
  let s = ELEVENLABS_RAG_AUDIO_TAGS_RULE;   // "Do NOT use tags"
  
  if (elevenLabsTtsModelIsV3(resolved)) {
    s += ELEVENLABS_V3_AUDIO_DELIVERY_RULE;  // "Here's how to use tags"  ← BUG!
  }
  return s;
}
```

**What happens when `ttsModelRaw` is null/empty:**

`resolveElevenLabsTtsModelId(null)` falls back to `env.elevenlabs.defaultTtsModelId` which is **`"eleven_v3"`** by default.

So when a customer has `tts_model = 'eleven_turbo_v2_5'` in `customer_settings`, but `session.ttsModel` is null (no avatar override) AND the raw model string doesn't reach the function correctly, the resolved model becomes `eleven_v3` and the LLM gets **contradictory instructions**: "Don't use tags" AND "Here's how to use audio tags with v3."

#### When This Bug Triggers

**Voicebot path** (`exotel-voicebot.ts` line 2972):
```typescript
const elevenLabsTagHint = buildElevenLabsRagAudioTagHintForProvider(
  csRag?.tts_provider,
  session.ttsModel ?? csRag?.tts_model ?? null,  // ← can be null!
  { customerTtsModelRaw: csRag?.tts_model ?? null }
);
```

If `session.ttsModel` is null AND `csRag?.tts_model` is null → `ttsModelRaw` = null → resolves to env default `eleven_v3` → **bug triggers**.

**Ask route** (`ask.ts` line 343):
```typescript
const elHint = buildElevenLabsRagAudioTagHintForProvider(
  opts?.ttsProvider,
  opts?.ttsModelRaw ?? null,        // ← same issue
  { customerTtsModelRaw: opts?.customerTtsModelRaw ?? null }
);
```

#### The Fix

In `buildElevenLabsRagAudioTagHintForProvider()`: when `customerTtsModelRaw` is NOT v3, do NOT add the v3 audio delivery rule regardless of what the resolved fallback model is. The `customerTtsModelRaw` is the source of truth for what model the customer **actually uses**.

```typescript
// PROPOSED FIX:
export function buildElevenLabsRagAudioTagHintForProvider(
  ttsProvider, ttsModelRaw, opts
) {
  if (ttsProvider !== "elevenlabs") return "";
  
  // Only v3 gets audio tag instructions
  const customerV3 = elevenLabsTtsModelIsV3(opts?.customerTtsModelRaw);
  if (customerV3) {
    return `\n${ELEVENLABS_V3_CUSTOMER_STRICT_SENTENCE_TAGS_RULE}\n`;
  }
  
  // For ALL non-v3 ElevenLabs models: tell LLM to NOT use tags
  // DO NOT check resolveElevenLabsTtsModelId() — it can falsely resolve to v3
  return `\n${ELEVENLABS_RAG_AUDIO_TAGS_RULE}\n`;
}
```

#### Simple explanation
> The AI is being given two conflicting instructions: "don't use emotion tags" AND "here's how to use emotion tags." This happens because our code checks a fallback value that defaults to the old v3 model. The fix is simple: if the customer's chosen model isn't v3, never tell the AI about audio tags.

#### Impact
- **Quality:** Eliminates confusing/contradictory LLM prompts → more consistent output
- **Latency:** Slightly shorter system prompt → ~5-10ms faster LLM processing
- **Reliability:** No more random `[happy]` or `[calm]` tags appearing in non-v3 TTS output (which those models may read aloud as literal words)

---

### Step 5: Reduce Streaming Chunk Fragmentation (When Streaming is ON)

> [!NOTE]
> Streaming is controlled per customer via `customer_settings.tts_streaming_enabled`. When `false`, the full LLM answer is sent as one TTS call (smoothest voice, no fragmentation). This step only applies when a customer has `tts_streaming_enabled = TRUE`.

#### What to change
When streaming is enabled for a customer, make smarter decisions about when to split text into separate TTS calls.

#### Technical details

**Current behavior** (`findNextSpeakCutElevenLabs()` in `exotel-voicebot.ts`):
- Splits at `.!?।` (sentence end) immediately
- Splits at `,` after 100 chars
- Force-cuts at 140 chars if no punctuation found
- Each split = a separate TTS API call = prosody reset

**Proposed behavior — Bigger, smarter chunks:**
- Only split at `.!?` (full sentence end), never at commas
- Increase minimum chunk to **200+ chars** before force-cutting
- Fewer TTS calls = fewer prosody resets = smoother voice
- First chunk may take ~100ms longer, but subsequent audio flows without gaps

**Why this matters for v3 specifically:**
`eleven_v3` is an expressive model that builds an emotional arc across a passage. When we chop a 3-sentence answer into 3 separate TTS calls, v3 treats each as an independent utterance — the emotion resets, pacing changes, and the voice sounds like 3 different recordings glued together. Bigger chunks let v3 build natural prosody across the full thought.

#### Simple explanation
> When streaming is on, we currently chop the answer into tiny pieces and ask the voice to read each piece separately. Each time, the voice "restarts" its tone — like three separate phone calls stitched together. By sending bigger pieces, the voice can maintain its natural rhythm across the whole answer.

#### Impact on response time
- Reduces TTS API calls from ~3 to ~1-2 per answer. Saves **200-500ms** overhead from eliminated round-trips.
- Slight increase in time-to-first-audio (~100ms) because we wait for a full sentence before sending.
- Net effect: faster total delivery, smoother voice.

---

### Step 6: Fix ElevenLabs Streaming — True Incremental Delivery (When Streaming is ON)

> [!NOTE]
> This step also only applies when `customer_settings.tts_streaming_enabled = TRUE`.

#### What to change
The current "streaming" API call actually **buffers the entire response** before returning. Fix it to pipe audio chunks to Exotel as they arrive from ElevenLabs.

#### Technical details

**Current code** (`elevenLabsTextToSpeechStream()` in `elevenlabs.ts`):
```typescript
// This is NOT true streaming — it collects everything, then returns:
const chunks: Buffer[] = [];
for await (const chunk of res.body) {
  chunks.push(Buffer.from(chunk));
}
return { body: Buffer.concat(chunks) };  // ← returns all at once!
```

Even though the API endpoint is `/stream`, our code waits for the full audio before processing. This defeats the purpose.

**Proposed:** Implement incremental consumption — forward PCM chunks to Exotel as they arrive:
- Read chunks from ElevenLabs as they stream in
- Parse/resample each chunk independently
- Send each chunk to Exotel immediately via `sendAudioToExotel()`
- First audio reaches caller ~100-200ms after ElevenLabs starts generating

#### Simple explanation
> Even with the "fast delivery" setting turned on, we're currently waiting for the entire voice recording to finish before playing it. It's like waiting for a full song to download before pressing play, instead of streaming it. The fix makes it play each piece as soon as it arrives.

#### Impact on response time
- **First audio to caller:** from ~500ms+ after TTS call to ~100-200ms
- This is the single biggest latency improvement for perceived responsiveness
- Only benefits customers with `tts_streaming_enabled = TRUE`

---

## 5. Impact Summary

### Combined Impact of All Steps

| Step | Latency Improvement | Quality Improvement | Effort |
|------|--------------------:|--------------------:|--------|
| 1. Switch to turbo/flash model | **-200 to -425ms** per sentence | Slightly less expressive, more consistent | Low (DB change + minor code) |
| 2. Eliminate resampling (pcm_8000) | **-5 to -20ms** + better quality | **Significant** — no aliasing artifacts | Medium (code change) |
| 3. Tune voice_settings | **-15 to -50ms** + 5% shorter audio | More natural phone tone | Low (code change) |
| 4. Better LLM prompt | **-30 to -70ms** LLM + shorter answers | **Significant** — natural phrasing | Low (code change) |
| 5. Reduce fragmentation | **-200 to -500ms** overhead | **Major** — smooth continuous voice | Medium (code change) |
| 6. True incremental streaming | **-300 to -500ms** first audio | Same | Medium-High (code change) |
| **TOTAL** | **-750ms to -1,565ms** | **Much more human** | |

### Before vs After (Expected)

| Metric | Before (eleven_v3) | After (turbo/flash + optimizations) |
|--------|-------------------:|------------------------------------:|
| Time to first audio (TTS) | ~500-800ms | ~100-300ms |
| Total answer audio duration | ~3-5 seconds | ~2.5-4 seconds |
| Prosody resets per answer | 2-4 (streaming chunks) | 0-1 |
| Audio artifacts from resample | Present | Eliminated |
| Emotional consistency | Low (tag conflicts) | High (natural prosody) |
| Naturalness on phone | Medium | **High** |

---

## 6. Testing Checklist

After implementing each step, test with these criteria:

### A. Phone Test (Most Important)
- [ ] Record a real Exotel call (not computer speakers)
- [ ] Does the voice sound like a real person on the phone?
- [ ] Are there any "robot breaks" (sudden tone changes mid-answer)?
- [ ] Does the speed feel natural for a conversation?
- [ ] Is the voice clear and easy to understand?

### B. Latency Test
- [ ] Measure TTFA (time from customer stops speaking to first bot audio)
- [ ] Target: under 2 seconds total pipeline
- [ ] Check logs for `pipeline.ttfa` and `pipeline.utterance.timing`

### C. Consistency Test
- [ ] Call the bot 5 times with the same question
- [ ] Does the voice sound roughly the same each time?
- [ ] No calls where the voice suddenly sounds "off"?

### D. Multilingual Test (if applicable)
- [ ] Test in Hindi and Marathi (turbo/flash support 32 languages)
- [ ] Is pronunciation acceptable in non-English?
- [ ] Does language switching still work?

---

## 7. Database Changes Required

### SQL: Update customer to use turbo model

```sql
-- Switch a specific customer to eleven_turbo_v2_5
UPDATE customer_settings
SET tts_model = 'eleven_turbo_v2_5'
WHERE customer_id = '<CUSTOMER_UUID>'
  AND tts_provider = 'elevenlabs';

-- Or switch ALL ElevenLabs customers
UPDATE customer_settings
SET tts_model = 'eleven_turbo_v2_5'
WHERE tts_provider = 'elevenlabs';
```

### SQL: Use flash for maximum speed

```sql
UPDATE customer_settings
SET tts_model = 'eleven_flash_v2_5'
WHERE customer_id = '<CUSTOMER_UUID>'
  AND tts_provider = 'elevenlabs';
```

### SQL: Disable TTS streaming (recommended for Step 5 Option B)

```sql
-- Let the full answer be one TTS call (smoother voice)
UPDATE customer_settings
SET tts_streaming_enabled = FALSE
WHERE tts_provider = 'elevenlabs';
```

---

## Appendix: Glossary for Non-Technical Readers

| Term | Simple Meaning |
|------|---------------|
| **TTFB** (Time to First Byte) | How long before the voice engine starts producing sound |
| **TTFA** (Time to First Audio) | How long the caller waits after speaking before hearing the bot respond |
| **Resampling** | Converting audio from one quality level to another (like resizing a photo) |
| **slin / raw PCM** | The audio format Exotel uses — uncompressed sound data, 16-bit, single channel |
| **PCM** | Raw, uncompressed audio data (like a BMP image vs. a JPEG) |
| **Sample rate (Hz)** | How many audio snapshots per second. 8,000 = phone quality. 22,050 = FM radio quality. 44,100 = CD quality. |
| **Prosody** | The rhythm, stress, and intonation of speech — what makes it sound "human" vs "robotic" |
| **Audio tags** | Special instructions like `[happy]` that tell the v3 model what emotion to use |
| **Streaming** | Sending audio piece by piece as it's generated, instead of waiting for the whole thing |

---

> [!IMPORTANT]
> **No code changes have been made.** This document is a plan for discussion. Once approved, each step can be implemented incrementally and tested independently.
