# Offline vendor documentation (snapshots)

This folder holds **mirrors of public documentation** for use when you are offline or when vendor pages move. **Always treat the live site as authoritative** and refresh these files when behaviour or APIs change.

| File | Source (canonical URL) | Notes |
|------|------------------------|--------|
| [sarvam-stt-streaming.md](./sarvam-stt-streaming.md) | [Sarvam — Streaming Speech-to-Text API](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/speech-to-text/streaming-api) | Snapshot from `…/streaming-api/llms-full.txt` + guide content. |
| [sarvam-tts-http-stream.md](./sarvam-tts-http-stream.md) | [Sarvam — HTTP Streaming TTS](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/http-stream) | Request/response, parameters, piping. |
| [sarvam-tts-websocket.md](./sarvam-tts-websocket.md) | [Sarvam — TTS WebSocket streaming](https://docs.sarvam.ai/api-reference-docs/api-guides-tutorials/text-to-speech/streaming-api/web-socket) | Config / text / flush / ping messages, low-latency use. |
| [exotel-stream-voicebot-applet.md](./exotel-stream-voicebot-applet.md) | [Exotel — Stream and Voicebot applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet) | Bidirectional Voicebot, chunk rules, JSON events. |
| [LATENCY_STREAMING_PLAYBOOK.md](./LATENCY_STREAMING_PLAYBOOK.md) | *Convixx internal* | Maps vendor capabilities → **&lt;2 s** goals and our `apps/api` voicebot path. |
| [../VOICEBOT_SUB_2S_IMPLEMENTATION_READINESS.md](../VOICEBOT_SUB_2S_IMPLEMENTATION_READINESS.md) | *Convixx internal* | **Gap analysis & checklist** (no code): feasibility, layer-by-layer changes, P0–P3. |

**Sarvam tip:** Many docs pages offer **`.md`** or **`llms-full.txt`** variants (see each file’s header) for machine-readable copies.

**Related internal docs**

- [`../VOICEBOT_STREAMING_LOG_ANALYSIS.md`](../VOICEBOT_STREAMING_LOG_ANALYSIS.md)
- [`../VOICEBOT_SUB_2S_IMPLEMENTATION_READINESS.md`](../VOICEBOT_SUB_2S_IMPLEMENTATION_READINESS.md)
- [`../VOICEBOT_LATENCY_SUB_2S_PLAN.md`](../VOICEBOT_LATENCY_SUB_2S_PLAN.md)
- [`../EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`](../EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md)

**Last bulk refresh:** 2026-04-27 (this README and playbook; individual mirror files may cite their own snapshot date in the first section).
