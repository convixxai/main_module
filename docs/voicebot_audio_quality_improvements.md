# 🎙️ Convixx Voicebot — Audio Quality & Humanization Guide (Database-Driven)

This document analyzes why the Voicebot currently sounds "robotic," "metallic," and "too fast," and provides a step-by-step roadmap to fix these issues. 

**Per your request, we are moving away from global `.env` settings.** All voice quality controls (pace, speaker, model, sample rate) and the conversational system prompt will be managed **per agent/client directly in the database.**

No code has been modified directly yet. Below is the blueprint containing the SQL query and the required code adjustments.

---

## 🔍 Root Cause Analysis

We have analyzed the TTS (Text-to-Speech), Audio pipeline, and LLM code. There are **3 main reasons** for the poor audio quality:

### 1. Speed Validation (Why is it so fast?)
The Sarvam models speak quite fast by default. Currently, the system uses Sarvam's 1.0 (100%) default speed. 

### 2. Robotic/Metallic Sound (The Resampling Problem)
Exotel telephony requires audio at **8,000 Hz**. Sarvam generates audio at **22,050 Hz**. Our current code mathematically shrinks that audio (downsampling), introducing high-pitch "aliasing" noise that sounds extremely metallic. We need to tell Sarvam to generate 8,000 Hz natively.

### 3. LLM Tone (Why does it sound like a machine?)
LLMs naturally format text with perfect grammar. Reading dense paragraphs out loud through TTS sounds like a robot. We need to instruct the LLM's `system_prompt` to insert human filler words, short sentences, and commas (to force natural pauses).

---

## 💾 1. Database Schema Changes

To allow individual clients (agents) to have their own voice pace, specific speaker, and model, we must add new configuration columns to the existing `agents` table.

### Run this SQL Query in your Database (`convixx_kb`):

```sql
-- 1. Add new columns for per-agent Voicebot settings
ALTER TABLE agents
ADD COLUMN tts_pace NUMERIC(3,2) DEFAULT 0.85,
ADD COLUMN tts_model TEXT DEFAULT 'bulbul:v3',
ADD COLUMN tts_speaker TEXT DEFAULT NULL, -- NULL means Sarvam uses its default voice, or you can supply 'amartya'
ADD COLUMN tts_sample_rate INTEGER DEFAULT 8000;

-- 2. Update the existing system_prompt to make the LLM speak like a human.
-- (Note: 'system_prompt' already exists in the agents table, we just need to update it with humanization rules).
UPDATE agents
SET system_prompt = system_prompt || '
You are a warm, helpful human receptionist on a phone call.
Keep answers EXTREMELY short (1-2 sentences).
Speak naturally using conversational fillers occasionally (e.g., "Well,", "Sure!").
Use commas (,) and periods (.) frequently to force natural pauses in the speech.
Never read lists or complex formatting. Just talk to them in a natural way.'
WHERE is_active = true;
```

---

## 🛠️ 2. Planned Code Architecture Changes

Once the database supports these fields, we will modify the Voicebot pipeline (`exotel-voicebot.ts`) so it fetches these preferences dynamically per call session, overriding the global `.env`.

### Step 2.1: Load Agent Settings During the Call
When processing the utterance, the voicebot fetches the `system_prompt`. We will modify that query to also fetch our new TTS properties.

**File:** `apps/api/src/routes/exotel-voicebot.ts`
*(Inside `runVoicebotAskPipeline`)*

```typescript
// We will update the query to pull the TTS settings from the active agent
const agentResult = await pool.query(
  `SELECT system_prompt, tts_pace, tts_model, tts_speaker, tts_sample_rate 
   FROM agents WHERE id = $1`,
  [session.agentId]
);

if (agentResult.rows.length > 0) {
  const row = agentResult.rows[0];
  agentPrompt = row.system_prompt;
  
  // Store these in the session so the TTS function can use them later
  session.ttsPace = row.tts_pace;
  session.ttsModel = row.tts_model;
  session.ttsSpeaker = row.tts_speaker;
  session.ttsSampleRate = row.tts_sample_rate;
}
```

### Step 2.2: Apply Agent Settings to the Sarvam TTS Call
Right now, `speakToExotel` hardcodes the environment variables. We will modify it to use the `session` variables loaded from the database.

**File:** `apps/api/src/routes/exotel-voicebot.ts`
*(Inside `speakToExotel`)*

```typescript
const ttsPayload: SarvamTtsBody = {
  text: text.slice(0, 2500),
  target_language_code: languageCode,
  // DYNAMIC: Pull from agent database settings, fallback to env
  model: session.ttsModel || env.sarvam.ttsModel || "bulbul:v3",
  speech_sample_rate: (session.ttsSampleRate || env.sarvam.ttsSpeechSampleRate || "8000").toString(),
  output_audio_codec: "wav",
};

// Apply custom speaker if the agent has one assigned
if (session.ttsSpeaker) {
  ttsPayload.speaker = session.ttsSpeaker;
} else if (env.sarvam.ttsSpeaker) {
  ttsPayload.speaker = env.sarvam.ttsSpeaker;
}

// Apply slower reading pace
if (session.ttsPace != null) {
  ttsPayload.pace = session.ttsPace;
} else if (env.sarvam.ttsPace != null) {
  ttsPayload.pace = env.sarvam.ttsPace;
}
```

---

## 👩‍💻 3. Managing from the Frontend Dashboard

Because this is now database-driven, you will need to update your **Agent Creation / Editing API** and the **Frontend UI**.

1. **Add Form Fields (Frontend):**
   - **TTS Model:** Dropdown (`bulbul:v2`, `bulbul:v3`)
   - **TTS Speaker:** Dropdown (List of Sarvam speaker IDs)
   - **TTS Pace:** Slider (0.70 to 1.30)
   - **Speech Sample Rate:** Dropdown (`8000`, `16000`, `22050`)
2. **Update API (Backend):**
   - When a user updates an Agent, accept `tts_pace`, `tts_model`, `tts_speaker`, and `tts_sample_rate` in the JSON body and save them to the `agents` table.

---

## 🚀 Execution Plan

Since this requires Database changes, let me know when you are ready! I can:
1. Provide the exact code to apply **Step 2.1** and **Step 2.2** into `apps/api/src/routes/exotel-voicebot.ts`.
2. Add the dynamic variables to the `VoicebotSession` type.
3. Help you modify your Agent API endpoints so the dashboard can save these settings.
