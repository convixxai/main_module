# ElevenLabs TTS Quickstart And Streaming Notes

Offline project notes based on ElevenLabs quickstart and streaming text-to-speech documentation shared on 2026-04-27.

## Quickstart

- Create an ElevenLabs API key in the dashboard.
- Store it as `ELEVENLABS_API_KEY`.
- Text-to-speech requests require:
  - `voice_id`
  - `model_id` such as `eleven_v3`
  - `text`
  - `output_format`, for example `mp3_44100_128`

Example request shape:

```ts
const audio = await elevenlabs.textToSpeech.convert("JBFqnCBsd6RMkjVDRZzb", {
  text: "The first move is what sets everything in motion.",
  modelId: "eleven_v3",
  outputFormat: "mp3_44100_128",
});
```

## Voice Settings

ElevenLabs supports optional voice settings:

```ts
voiceSettings: {
  stability: 0,
  similarityBoost: 1.0,
  useSpeakerBoost: true,
  speed: 1.0,
}
```

In this project, the API layer uses snake_case for the REST API payload:

```json
{
  "stability": 0.35,
  "similarity_boost": 0.9,
  "style": 0.2,
  "use_speaker_boost": true,
  "speed": 1.0
}
```

## Normal TTS

For non-streaming calls, use the normal text-to-speech endpoint:

```text
POST /v1/text-to-speech/{voice_id}?output_format=...
```

## Streaming TTS

For streaming calls, use the streaming text-to-speech endpoint:

```text
POST /v1/text-to-speech/{voice_id}/stream?output_format=...
```

The response body is an audio stream. The project buffers the stream into a `Buffer` for existing telephony processing, while still using the ElevenLabs streaming endpoint when `customer_settings.tts_streaming_enabled = true`.

## Important Project Note

Although ElevenLabs v3 can support expressive delivery, bracketed tags like `[happy]`, `[warmly]`, or `[sighs]` were heard as spoken text in the current voicebot path. The project therefore strips bracket tags before TTS and prompts the LLM to use natural punctuation instead.

