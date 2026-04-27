# Sarvam — HTTP Streaming Text-to-Speech (offline snapshot)

**Source:** [HTTP Streaming API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/http-stream)  
**Endpoint:** `POST https://api.sarvam.ai/text-to-speech/stream`

> Stream TTS audio over a **single HTTP POST**. No WebSocket setup — send JSON, receive a **binary** audio stream. Response can start as soon as the first chunk is ready (pipe or buffer client-side).

**Official machine-readable:** append `/llms-full.txt` to the doc URL path (see Sarvam header on live page).

---

## HTTP stream vs WebSocket (vendor comparison)

| | HTTP stream | WebSocket |
|---|-------------|-----------|
| Protocol | Single `POST` | Persistent connection |
| Setup | Normal HTTP | Handshake + config |
| Endpoint | `/text-to-speech/stream` | `/text-to-speech/ws` |
| Text per request | One payload (max **3500** chars) | Multiple messages (e.g. **2500** chars per message) |
| Audio output | **Binary** stream (`Content-Type` matches codec) | Base64 chunks in messages |
| Reuse | New connection per request | One connection, many conversions |
| Best for | One-shot server pipelines, simplicity | LLM-incremental text, multi-turn, warm connection / TTFB on follow-ups |

**Use HTTP stream when:** you have complete text and want the simplest integration (including `curl`).

**Use WebSocket when:** text arrives incrementally (e.g. from an LLM), you need **low time-to-first-byte** on successive utterances on a **warm** connection, or multiple texts without reconnecting.

---

## Request body (main parameters)

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `text` | string | Yes | — | Max **3500** characters; code-mix supported |
| `target_language_code` | string | No | `en-IN` | BCP-47, e.g. `hi-IN`, `en-IN` |
| `speaker` | string | No | `shubh` | See voice list in REST TTS doc |
| `model` | string | No | `bulbul:v2` | `bulbul:v3` recommended |
| `output_audio_codec` | string | No | `mp3` | `mp3`, `wav`, `aac`, `opus`, `flac`, `linear16`, `mulaw`, `alaw` |
| `output_audio_bitrate` | string | No | `128k` | `32k`, `64k`, `128k`, `192k`, `256k` |
| `pace` | number | No | `1.0` | v3: `0.5`–`2.0` |
| `speech_sample_rate` | number | No | `22050` | Output sample rate (Hz) |
| `temperature` | number | No | `0.6` | v3, expressiveness `0.01`–`1.0` |
| `dict_id` | string | No | — | Pronunciation dictionary (v3) |
| `enable_preprocessing` | boolean | No | `false` | Normalize English/numbers |
| `enable_cached_responses` | boolean | No | `false` | Caching (beta) |

---

## Response

- **Success:** **Raw binary** audio — not JSON, not base64.  
- `Content-Type` matches codec (e.g. `audio/mpeg` for MP3).

**Note:** The non-streaming REST endpoint `/text-to-speech` returns **JSON** with **base64** audio inside. The **stream** endpoint returns **raw** bytes — no JSON decoding of audio.

You may:

- Write to a file or buffer incrementally (chunked `ReadableStream` in modern runtimes)  
- Pipe to a player (e.g. `ffplay` in cURL examples on live doc)  
- Forward as a streaming HTTP response to a client  

---

## Piping the stream (vendor)

The response is a raw stream — you can process **chunks** without holding the full file in memory (see Python `convert_stream` iterator and similar patterns on the live page).

**cURL example (from Sarvam doc):**

```bash
curl -X POST https://api.sarvam.ai/text-to-speech/stream \
  -H "api-subscription-key: YOUR_SARVAM_API_KEY" \
  -H "Content-Type: application/json" \
  --output output.mp3 \
  -d '{
    "text": "Hello from Sarvam.",
    "target_language_code": "en-IN",
    "speaker": "shubh",
    "model": "bulbul:v3",
    "output_audio_codec": "mp3"
  }'
```

Header: `api-subscription-key: <key>` (same as other Sarvam APIs).

---

## Errors

Errors return **JSON** (not audio), e.g.:

```json
{
  "error": {
    "message": "Text exceeds maximum length of 3500 characters",
    "code": "unprocessable_entity_error"
  }
}
```

Typical status codes: `400` invalid request, `403` key, `422` unprocessable, `429` quota, `500` server (retry).

---

## Convixx implementation note

Our API uses `fetch` and currently may read the **entire** body with `arrayBuffer()` before decode — that **loses** early-chunk TTFB benefits of this endpoint. For telephony, we also need a decoder that matches the chosen **codec** (e.g. WAV/PCM for Exotel) and may fall back to REST JSON — see `LATENCY_STREAMING_PLAYBOOK.md` and `../VOICEBOT_STREAMING_LOG_ANALYSIS.md`.

---

*See also:* [sarvam-tts-websocket.md](./sarvam-tts-websocket.md), [README](./README.md).
