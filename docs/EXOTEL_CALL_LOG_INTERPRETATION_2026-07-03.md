# Exotel Voicebot Call Log Interpretation — 2026-07-03 13:05

## Summary

**Issue:** Incoming call to voicebot resulted in complete silence — no greeting was played to the caller. The call was idle for ~10 seconds before the caller hung up.

**Root Cause:** The Exotel WebSocket connection was established, but **no `start` event was ever received from Exotel**. Without the `start` event, the voicebot session is never initialized, and no greeting audio can be sent.

---

## Log Timeline Analysis

| Time | Event | Log Message | Analysis |
|------|-------|-------------|----------|
| 13:05:00 | HTTP Request | `GET /exotel/voicebot/ead34d8f-...` | WebSocket upgrade request from Exotel |
| 13:05:00 | WS Upgrade | Headers show `upgrade: websocket` | Valid WebSocket handshake headers present |
| 13:05:00 | Connection Accepted | `exotel voicebot connection accepted` | Server-side socket opened successfully |
| 13:05:00 → 13:05:10 | **NO EVENTS** | — | **10 seconds of silence — no `connected`, no `start`, no `media`** |
| 13:05:10 | Stop Event | `event: "stop"`, `reason: "canceled or call ended"` | Call terminated by Exotel |
| 13:05:10 | WS Close | `code: 1006`, `reason: ""` | Abnormal WebSocket closure |

---

## What SHOULD Have Happened

According to the Exotel Voicebot WebSocket spec (`docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md`), the expected message sequence is:

```
1. [Client connects to WSS URL]
2. Exotel sends: { "event": "connected", "protocol": "...", "version": "..." }
3. Exotel sends: { "event": "start", "start": { stream_sid, call_sid, from, to, media_format, ... } }
4. Convixx: Creates session, sends greeting audio
5. Exotel sends: { "event": "media", ... } (caller's audio chunks, every ~20ms)
6. [Conversation loop: STT → LLM → TTS → audio playback]
7. Exotel sends: { "event": "stop", ... } when call ends
```

**In this call:** Steps 2 and 3 never occurred. The connection was established but Exotel never sent the `connected` or `start` events.

---

## Missing Log Entries

The following logs are **missing** but should have appeared if the flow worked correctly:

1. **`voicebot: Exotel connected`** — Logged when `event: "connected"` is received
2. **`voicebot:exotel.in` with `event: "start"`** — Would contain stream_sid, call_sid, media_format
3. **`voicebot stage: greeting.sending`** — Logged when greeting TTS begins
4. **`voicebot stage: greeting.sent`** — Logged after greeting audio is sent

---

## Root Cause Analysis

### Primary Causes (Most Likely)

| # | Cause | Evidence | Likelihood |
|---|-------|----------|------------|
| 1 | **Exotel platform issue** — stream not sending `start` event | No `connected` or `start` logged despite valid WS connection | **High** |
| 2 | **Exotel flow misconfiguration** — Voicebot applet not properly configured | WebSocket connects but never activates | **High** |
| 3 | **Network/proxy issue** — Exotel messages dropped between their edge and your server | Connection works but messages don't arrive | **Medium** |
| 4 | **TLS handshake timing** — Exotel sent messages before TLS was fully negotiated | Messages lost in transit | **Low** |

### Secondary Causes (Less Likely)

| # | Cause | Evidence | Likelihood |
|---|-------|----------|------------|
| 5 | **Message parsing failure** — `parseExotelMessage()` returning null | Would show `unparseable message` warning | **Very Low** |
| 6 | **Rate limiting** — Exotel hitting rate limits on your endpoint | No 429 errors logged | **Very Low** |

---

## Code Path Analysis

The relevant code in `apps/api/src/routes/exotel-voicebot.ts`:

### 1. Connection Acceptance (Line ~4400)
```typescript
log.info({ customerId }, "exotel voicebot connection accepted");
// ✅ This DID log — connection was established
```

### 2. Message Handler (Line ~4411)
```typescript
socket.on("message", async (rawData: Buffer | string) => {
  const raw = typeof rawData === "string" ? rawData : rawData.toString("utf-8");
  const msg = parseExotelMessage(raw);
  
  if (!msg) {
    log.warn({ raw: raw.slice(0, 200) }, "voicebot: unparseable message");
    // ❌ This did NOT log — no malformed messages received
    return;
  }
  
  // Events other than "media" are logged
  if (msg.event !== "media") {
    voiceTrace(log, "exotel.in", { ... });
    // ❌ No "connected" or "start" logged — they were never received
  }
  // ...
});
```

### 3. Start Event Handler (Line ~4442)
```typescript
case "start": {
  const startMsg = msg as ExotelStartMessage;
  // Creates session, loads customer_settings, sends greeting
  // ❌ Never reached — "start" event never arrived
}
```

### 4. Greeting Logic (Line ~4698)
```typescript
if (voiceTtsCanRun(session)) {
  logVoiceStage(log, "greeting.sending", { ... });
  // ❌ Never reached — session was never created
  await speakToExotel(socket, session, greetingText, greetingLang, log);
}
```

---

## Fixes and Action Items

### Immediate Investigation

1. **Check Exotel Dashboard**
   - Verify the Voicebot applet is properly configured for this flow
   - Check if the stream URL matches `wss://convixx.in/exotel/voicebot/<customer_id>`
   - Confirm the flow is routing calls through the Voicebot applet (not just Stream)

2. **Verify Exotel Account/Flow Settings**
   - Ensure the Voicebot feature is enabled in your Exotel account
   - Check if `StreamBegin` parameter is set correctly (should be `atConnect` or `atLeg2connect` for outbound)
   - Verify the Exotel sub-account and flow ID are correct

3. **Check Exotel Logs**
   - Log into Exotel dashboard → Call Logs
   - Find the call with `call_sid: dd0dbc98a0eb26a8876af5544c9a1a73`
   - Check if Exotel shows any errors on their side

### Code-Level Fixes (IMPLEMENTED)

The following fixes have been implemented in `apps/api/src/routes/exotel-voicebot.ts`:

#### Fix 1: Connection Timeout Warning ✅

A 5-second timeout now logs a CRITICAL error if `start` event isn't received:

```typescript
// After connection accepted, a 5s timeout starts
const startEventTimeout = setTimeout(() => {
  if (!receivedStartEvent) {
    log.error(
      { customerId, receivedConnectedEvent, totalMessagesReceived, ... },
      "voicebot: CRITICAL — no 'start' event received within 5s after connection..."
    );
  }
}, 5000);
```

#### Fix 2: Diagnostic Event Tracking ✅

New tracking variables help diagnose issues:

```typescript
let receivedConnectedEvent = false;
let receivedStartEvent = false;
let totalMessagesReceived = 0;
let totalMediaMessages = 0;
const connectionAcceptedAt = Date.now();
```

#### Fix 3: Enhanced Stop Event Logging ✅

When a call ends without `start` event, a detailed error is logged:

```typescript
if (!receivedStartEvent) {
  log.error({
    customerId, stream_sid, call_sid, reason,
    receivedConnectedEvent, totalMessagesReceived, totalMediaMessages,
    elapsedMs: Date.now() - connectionAcceptedAt,
  }, "voicebot: CALL FAILED — call ended before 'start' event was received...");
}
```

#### Fix 4: Enhanced Close Handler Logging ✅

WebSocket close now logs full diagnostic state:

```typescript
log.info({
  customerId, stream_sid, code, reason,
  sessionCreated: !!session,
  receivedConnectedEvent, receivedStartEvent,
  totalMessagesReceived, totalMediaMessages,
  connectionDurationMs,
}, "voicebot: WebSocket closed");
```

### Exotel Configuration Checklist

- [ ] Voicebot applet is added to the Exotel flow (not just Stream applet)
- [ ] WebSocket URL is exactly `wss://convixx.in/exotel/voicebot/{customer_id}`
- [ ] No HTTPS redirect issues (WSS should not 301/302)
- [ ] Exotel flow has proper `StreamBegin` timing configured
- [ ] Account has Voicebot feature enabled
- [ ] No IP whitelisting blocking Exotel's servers

### Network/Infrastructure Checks

- [ ] Nginx/reverse proxy allows WebSocket upgrade without buffering messages
- [ ] No firewall dropping initial WS frames after handshake
- [ ] SSL certificate is valid and trusted by Exotel
- [ ] WebSocket timeout settings in load balancer (should be >60s)

---

## Logging Enhancements (IMPLEMENTED)

The following diagnostic logging has been implemented:

1. **Message counting** — `totalMessagesReceived` and `totalMediaMessages` track all incoming messages
2. **Event tracking** — `receivedConnectedEvent` and `receivedStartEvent` flags track protocol events
3. **Timing** — `connectionAcceptedAt` timestamp enables duration calculations
4. **5-second timeout** — Proactive CRITICAL error if `start` event is missing
5. **Enhanced close logging** — Full diagnostic state logged on WebSocket close

**With these changes, the next time this issue occurs, you'll see clear error messages like:**

```
voicebot: CRITICAL — no 'start' event received within 5s after connection; caller will hear silence. Check Exotel flow configuration...
```

```
voicebot: CALL FAILED — call ended before 'start' event was received. Caller heard complete silence. Likely causes: (1) Exotel flow uses Stream applet instead of Voicebot applet, (2) WebSocket URL misconfigured in Exotel dashboard, (3) Exotel platform issue.
```

---

## Next Steps

1. **Contact Exotel Support** — Share the `call_sid` (`dd0dbc98a0eb26a8876af5544c9a1a73`) and ask them to check why the `start` event was not sent
2. **Test with Exotel Simulator** — Use Exotel's testing tools to verify your endpoint receives all expected events
3. **Deploy logging enhancements** — Add the timeout and logging fixes above to catch this issue faster in future
4. **Review recent changes** — Did anything change in the Exotel flow configuration recently?

---

## Related Documentation

- `docs/EXOTEL_VOICEBOT_WEBSOCKET_SPEC.md` — WebSocket protocol specification
- `docs/vendor-offline/exotel-stream-voicebot-applet.md` — Exotel's official documentation snapshot
- `apps/api/src/routes/exotel-voicebot.ts` — Main voicebot route handler
- `apps/api/src/types/exotel-ws.ts` — Exotel message type definitions
