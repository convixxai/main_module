# Exotel — Stream & Voicebot applet (offline snapshot)

**Source:** [Working with the Stream and Voicebot applet](https://support.exotel.com/support/solutions/articles/3000108630-working-with-the-stream-and-voicebot-applet) (support article, print-friendly capture)

**Last captured:** 2026-04-27 (content reflects article state; Exotel may update without notice).

---

## Stream types

| Type | Direction | Use cases |
|------|-----------|-----------|
| **Unidirectional** | Exotel → your WebSocket only | Live transcription, monitoring, coaching |
| **Bidirectional (Voicebot)** | Caller audio **to** you; your audio **to** caller | Conversational bots, agent streams |

**Enabling:** Configure **Stream** (unidirectional) or **Voicebot** (bidirectional) applets in Custom Apps / App Bazaar. Not on all accounts by default — contact Exotel if missing.

---

## Bidirectional streaming — chunk size (Voicebot)

For bidirectional (Voicebot) use:

| Rule | Value |
|------|--------|
| **Minimum** chunk | **3.2 KB** (~100 ms of data) |
| **Maximum** chunk | **100 KB** |
| **Alignment** | Size must be a **multiple of 320 bytes** |

Implications (support article):

1. **Below minimum:** jitter can cause audio issues.  
2. **Above maximum:** may cause timeouts.  
3. **Not multiple of 320:** if a fragment is &lt; 320 B, the platform may wait **~20 ms** before the next chunk → possible **gaps** in audio.

**Best practice (support):** Send **smaller** `media` chunks if you use **`clear`**, so not-yet-played audio can be dropped predictably (large blocks reduce flexibility).

---

## URL configuration

- You may set **`wss://...`** directly, or an **`https://`** URL that returns JSON:  
  `{ "url": "wss://streamhandler.yourdomain.com" }`  
  so Exotel dials a **dynamic** `wss` (parameters, per-call routing).

**Sample rate (query on WSS):**

- `8 kHz` — PSTN default: `?sample-rate=8000`  
- `16 kHz` — often recommended for voicebots: `?sample-rate=16000`  
- `24 kHz` — HD: `?sample-rate=24000`  

**Default:** 8 kHz if unspecified. Exotel suggests **16 kHz** for many voicebot integrations; **8 kHz** for legacy PSTN interop.

**Custom query params:** up to **3** parameters; **total length of param string ≤ 256** characters (per article).

**Authentication (WSS):** IP whitelisting (contact `hello@exotel.com` for ranges); or **Basic** auth in the URL:  
`wss://<API_KEY>:<API_TOKEN>@stream...` with `Authorization: Basic` sent by Exotel.

---

## WebSocket — events **from** Exotel (inbound to your server)

JSON messages, types include (names as in article):

- `connected`  
- `start` — stream id, call id, `media_format` (encoding, sample rate, bit rate), `custom_parameters`  
- `media` — base64 **slin** PCM, 16-bit, mono, little-endian; **8 kHz** in typical PSTN  
- `dtmf` — bidirectional / Voicebot  
- `stop` — stream ended or call ended  
- `mark` — **bidirectional only** — playback position / completion tracking  

**Media payload (inbound):** `event: "media"`, `media.chunk`, `media.timestamp` (ms from stream start), `media.payload` = base64 audio.

---

## WebSocket — events **to** Exotel (outbound from your server)

**Bidirectional only:**

- **`media`:** same style — base64 slin PCM as Exotel expects for playback.  
- **`mark`:** after sending `media`, send `mark` with a **name**; Exotel echoes `mark` when that audio has been **processed/played** (for synchronization).  
- **`clear`:** clear buffered outbound audio not yet played (e.g. cancel speculative TTS). Works best when media was sent in **smaller** chunks.

---

## Protocol summary

- JSON string messages over WebSocket.  
- Inbound from caller: **raw/slin** PCM, base64, 16-bit, mono, LE — same expectation **to** the caller in Voicebot.  

**Related samples (Exotel GitHub, per article):**  
[exotel/Agent-Stream](https://github.com/exotel/Agent-Stream), [exotel/Agent-Stream-echobot](https://github.com/exotel/Agent-Stream-echobot)

---

## Limitations (article)

1. Unidirectional stream with **Connect** / multi-leg scenarios may fork audio; client may need filtering (future Exotel change planned).  
2. Max **3** custom parameters on START.  
3. Mono stream — diarization is client-side if needed.  

---

## Convixx alignment

Our implementation follows chunk sizing in `apps/api/src/services/pcm-audio.ts` and `exotel-voicebot.ts` (e.g. 320-byte multiples, min ~3.2 KB). Deeper spec: `../EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`.

---

*This is a support-article summary, not a legal or SLA document. For production SLAs, use Exotel contracts and current portal docs.*
