# Sarvam — Streaming Speech-to-Text API (offline snapshot)

**Source:** [Streaming Speech-to-Text API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api)  
**Official machine-readable dump:** [llms-full.txt](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api/llms-full.txt)  
**Snapshot purpose:** Offline reference; refresh from Sarvam when debugging STT.

> Real-time audio transcription and translation with **WebSocket** connections. Low-latency streaming for live applications.

For the full REST/WebSocket endpoint spec, Sarvam also links to:
- [Speech-to-Text WebSocket (transcribe)](https://docs.sarvam.ai/api-reference-docs/speech-to-text/transcribe/ws)
- [Speech-to-Text Translate WebSocket](https://docs.sarvam.ai/api-reference-docs/speech-to-text-translate/ws)

---

## Model availability

- **Saaras v3** (recommended) — multiple `mode` values (see below).
- Legacy: **Saarika v2.5**, **Saaras v2.5** — migration to **Saaras v3** is recommended.

---

## Supported modes (Saaras v3)

| Mode | Description | Output |
|------|-------------|--------|
| `transcribe` | Standard transcription in the original language | Text in source language |
| `translate` | Transcribe and translate to English | English text |
| `verbatim` | Word-for-word including fillers and repetitions | Verbatim text in source language |
| `translit` | Transcribe and transliterate to Roman script | Romanized text |
| `codemix` | Code-mixed speech (e.g. Hindi–English) | Code-mixed text |

---

## Audio formats (streaming)

Streaming supports only:

- **WAV** (`wav`)
- **Raw PCM** (`pcm_s16le`, `pcm_l16`, `pcm_raw`)

MP3, AAC, OGG, etc. are **not** supported on the streaming WebSocket. Sample audio: [Sarvam cookbook sample_data/stt](https://github.com/sarvamai/sarvam-ai-cookbook/tree/main/sample_data/stt).

---

## Connection parameters (reference)

| Parameter | Type | Description | Example |
|-----------|------|-------------|---------|
| `language_code` | string | Language for STT | `en-IN`, `hi-IN` |
| `model` | string | Model | `saaras:v3` (recommended) |
| `mode` | string | Saaras v3: `transcribe`, `translate`, `verbatim`, `translit`, `codemix` | `transcribe` |
| `sample_rate` | integer | Hz | `8000`, `16000` |
| `input_audio_codec` | string | `wav` or raw PCM variants | `wav`, `pcm_s16le` |
| `high_vad_sensitivity` | boolean | Stronger VAD | `true` / `false` |
| `vad_signals` | boolean | Emit speech start/end | `true` / `false` |
| `flush_signal` | boolean | Manual buffer flush | `true` / `false` |

---

## Audio payload parameters (when sending data)

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `audio` | string (base64) | Yes | Encoded audio |
| `encoding` | string | Yes | e.g. `audio/wav` |
| `sample_rate` | integer | Yes | Must match connection `sample_rate` |

---

## Response message types (when `vad_signals=true`)

**STT**

- `speech_start` — voice activity detected  
- `speech_end` — voice activity ended  
- `transcript` — final transcription  

**Translate (STTT-style)**

- `speech_start`, `speech_end`  
- `translation` — final English translation  

---

## 8 kHz telephony (critical)

When using **8 kHz** audio, set `sample_rate` **in both places**:

1. WebSocket **connection** parameters  
2. Each **transcribe** (or equivalent) message  

Mismatch harms quality or causes errors.

```python
async with client.speech_to_text_streaming.connect(
    model="saaras:v3",
    mode="transcribe",
    language_code="en-IN",
    sample_rate=8000,
) as ws:
    await ws.transcribe(audio=audio_data, sample_rate=8000, encoding="audio/wav", ...)
```

---

## Flush signal

With `flush_signal=True`, you can call **`flush()`** after sending audio to force processing without waiting only for silence (useful with segmented or end-of-turn control).

---

## Silence handling (vendor guidance)

- About **1 s** silence when `high_vad_sensitivity=false`  
- About **0.5 s** silence when `high_vad_sensitivity=true`  

(Align with your **app-side** VAD / Exotel endpointing — see `LATENCY_STREAMING_PLAYBOOK.md`.)

---

## STT vs STTT (summary)

| Aspect | STT | STTT (translate path) |
|--------|-----|------------------------|
| Models | `saaras:v3`, `saarika:v2.5` (legacy) | `saaras:v3`, `saaras:v2.5` (legacy) |
| Method | `transcribe()` | `translate()` |
| Language | Required | Auto-detected |
| Output | Same language as input (per mode) | English |

---

## Best practices (vendor)

- Prefer **16 kHz** for quality; use **8 kHz** only when source is telephony — with **matching** `sample_rate` everywhere.  
- **Continuous streaming:** send audio continuously for lowest latency to partials/finals.  
- **Error handling:** handle WebSocket close and API errors.  
- Use **Saaras v3** + `mode` for flexible behaviour.

---

## SDK examples

Sarvam publishes **Python** (`AsyncSarvamAI`) and **JavaScript** (`SarvamAIClient`) examples on the live page (connect → transcribe/translate → handle messages). For verbatim code blocks, open the [canonical doc](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api) or the **llms-full.txt** link at the top.

---

*This snapshot may omit marketing UI blocks. Reconcile with live docs before production changes.*
