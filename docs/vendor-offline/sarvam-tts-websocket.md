# Sarvam — WebSocket streaming Text-to-Speech (offline snapshot)

**Source:** [Streaming Text-to-Speech API (WebSocket)](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket)  
**Official machine-readable:** [llms-full.txt](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket/llms-full.txt)

> Real-time TTS: connect once, send **config**, then **text** messages; receive **audio** messages as **base64** chunks. Suited to **low time-to-first-byte** when the first synthesized chunk is enough to start playback.

---

## When to prefer WebSocket TTS (vendor)

- Conversational agents — text arrives over time  
- Low-latency IVR / kiosks / narration  
- **Multiple** phrases on **one** connection without paying full HTTP handshake each time  

See also: [HTTP stream vs WebSocket](./sarvam-tts-http-stream.md#http-stream-vs-websocket-vendor-comparison).

---

## Best practices (vendor)

1. Send **config** first after connect.  
2. Use **flush** to force processing when needed.  
3. Send **ping** on long-lived connections; inactivity may close (~**1 minute** without activity per typical patterns — confirm on live doc).  
4. Optional: `send_completion_event=True` to get a completion/final event for clean shutdown.

---

## Message types (inbound to server)

### `config` (first message)

Sets language, speaker, codec, pacing, buffer behaviour.

Example:

```json
{
  "type": "config",
  "data": {
    "speaker": "shubh",
    "target_language_code": "en-IN",
    "pace": 1.2,
    "min_buffer_size": 50,
    "max_chunk_length": 200,
    "output_audio_codec": "mp3",
    "output_audio_bitrate": "128k"
  }
}
```

**`output_audio_codec`** (vendor): `mp3`, `wav`, `aac`, `opus`, `flac`, `pcm` (LINEAR16), `mulaw`, `alaw`.

- **`min_buffer_size`:** minimum characters before the model flushes internally.  
- **`max_chunk_length`:** sentence-splitting upper bound.

### `text`

```json
{
  "type": "text",
  "data": {
    "text": "This is an example sentence that will be converted to speech."
  }
}
```

- **0–2500** characters per message (per vendor doc).  
- **&lt; ~500** characters recommended for “optimal streaming performance” for some workloads; longer text also works.

### `flush`

Forces buffer to process immediately (ignores `min_buffer_size`).

```json
{ "type": "flush" }
```

### `ping`

Keepalive.

```json
{ "type": "ping" }
```

---

## Outbound messages (client handling)

Typical pattern: messages with `type === "audio"`; **audio** payload is **base64** — decode to bytes and append to file or play buffer.

With **`send_completion_event`**, you may also receive an **event** (e.g. `final`) to stop reading.

---

## SDKs

- Python: `AsyncSarvamAI` — `text_to_speech_streaming.connect`  
- JavaScript: `SarvamAIClient` — `textToSpeechStreaming.connect`  

Full async examples (config → `convert` / text → `flush` → read chunks) are on the [live page](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket).

---

## Telephony (Exotel) integration angle

- Exotel wants **8 kHz** s16le **PCM** in many Voicebot flows — map Sarvam output (`wav` / `pcm` / resample) to that format and chunk per Exotel min/max/320-byte rules (see `exotel-stream-voicebot-applet.md` and `../EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`).  
- A **reused** WebSocket with incremental **text** from a streaming LLM + incremental **audio** out is a strong match for sub–2 s **time to first heard** *if* the app pipes chunks to Exotel without waiting for the full MP3/WAV.

---

*This snapshot is abbreviated; see llms-full.txt or the live page for full code blocks and edge cases.*
