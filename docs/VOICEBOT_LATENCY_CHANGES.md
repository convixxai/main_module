# Voicebot latency improvements (implementation notes)

## What changed (code)

| Area | Change |
|------|--------|
| **STT WebSocket idle** | After the last transcript message, wait **`SARVAM_STT_WS_IDLE_MS`** (default **450**) instead of **2000** ms before settling (`apps/api/src/services/sarvam.ts`, `env.sarvam.sttWsIdleAfterTranscriptMs`). |
| **TTS HTTP stream** | When `tts_streaming_enabled` and **`SARVAM_TTS_STREAM_LINEAR16`** is not `false`, Sarvam `/text-to-speech/stream` uses **`linear16`** at the **Exotel** sample rate (e.g. 8000 Hz) so the body is raw **s16le** PCM and decodes in one pass—reduces **`stream_body_not_decodable` → REST** double round-trips (`exotel-voicebot.ts` `speakToExotel`). |
| **RAG history (voice)** | Default cap when `rag_history_max_turns` is null: **3** Q/A pairs (**6** messages) instead of **50** pairs—smaller prompts, faster LLM (`trimRagHistory`). Tenants can still set `rag_history_max_turns` explicitly. |
| **Timing logs** | Each completed utterance logs **`pipeline.utterance.timing`** (`voiceTrace`) and **`utterance.completed`** includes `timing_stt_ms`, `timing_ask_pipeline_ms`, `timing_final_tts_ms` (incremental TTS is inside `ask_pipeline_ms` when streaming). |

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SARVAM_STT_WS_IDLE_MS` | `450` | Post-transcript settle time for Sarvam STT WS (50–5000). |
| `SARVAM_TTS_STREAM_LINEAR16` | `true` | Use `linear16` + Exotel rate for HTTP TTS stream; set `false` to use tenant WAV stream. |

## Simulation (local, no API keys)

```text
cd apps/api
node scripts/voicebot-latency-simulation.mjs
```

Edit **`BASE`** timings in that script to reflect your measured `pipeline.utterance.timing` / `utterance.completed` fields. Output is **illustrative** only.

## Measuring in production

1. Enable normal logging; search for `pipeline.utterance.timing` or `utterance.completed` with `timing_stt_ms`.  
2. Compare **before/after** deploy on similar calls.  
3. Target remains **TTFA** (first audio after VAD commit)—use logs to split **STT** vs **ask** (RAG + LLM + incremental TTS).

## Risks

- **STT idle too low:** may finalize before Sarvam sends a late update—raise `SARVAM_STT_WS_IDLE_MS` if transcripts truncate.  
- **linear16 @ 8 kHz:** if Sarvam rejects a parameter combo, the path falls back to REST JSON (single TTS). Monitor `pipeline.tts.stream_fallback_rest`.  
- **Shorter history:** may reduce context for long conversations—increase `rag_history_max_turns` per tenant if needed.
