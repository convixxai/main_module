# ElevenLabs Voicebot Setup

This project uses ElevenLabs only when `customer_settings.tts_provider = 'elevenlabs'`.

## Portal Checklist

1. Create or verify an API key in the ElevenLabs dashboard and set `ELEVENLABS_API_KEY`.
2. Use a voice that is available to your plan. Voice Library voices can fail on free plans; premade voices are safer.
3. For the default voice, set `ELEVENLABS_DEFAULT_VOICE_ID` if you want to override the built-in project default.
4. If using `eleven_v3`, test the selected voice in the ElevenLabs dashboard first. Do not rely on bracket tags like `[happy]`; in this voicebot path they are stripped because they were being spoken aloud.
5. Keep voice speed normal in the portal. The API layer also caps `voice_settings.speed` at `1.0`.

## Database Settings

- `customer_settings.tts_provider = 'elevenlabs'` enables ElevenLabs TTS.
- `customer_settings.tts_model = 'eleven_v3'` uses ElevenLabs v3.
- `customer_settings.tts_streaming_enabled = true` uses the ElevenLabs streaming TTS endpoint.
- `customer_settings.tts_streaming_enabled = false` uses the normal text-to-speech endpoint.
- `customer_settings.tts_default_speaker` should contain the ElevenLabs `voice_id` if the tenant needs a specific voice.

## Current Voice Behavior

- Bracketed tags like `[warmly]`, `[happy]`, `[sighs]` are removed before sending text to ElevenLabs.
- The LLM prompt now asks for natural punctuation and conversational phrasing instead of bracket tags.
- Default voice settings are tuned for a human phone voice:
  - `stability: 0.35`
  - `similarity_boost: 0.9`
  - `style: 0.2`
  - `use_speaker_boost: true`
  - `speed: 1.0`

