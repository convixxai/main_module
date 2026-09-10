// ============================================================
// Standalone verification for ExotelAdapter (no test framework in this
// repo — see apps/api/scripts/backfill-telephony-credentials.ts for the
// same pattern). Exercises the adapter against fixed sample payloads
// shaped like Exotel's real wire messages, plus one read-only DB check
// against a real company_telephony_settings row.
//
// Does NOT call Exotel's real REST API — triggerOutboundCall param
// construction is checked structurally only, no network call is made.
//
// Usage (from apps/api): npx ts-node scripts/verify-exotel-adapter.ts
// ============================================================

import { ExotelAdapter } from "../src/services/exotel-adapter";
import { getDecryptedCredentials, getTelephonySettings, type ExotelCredentials } from "../src/services/telephony-settings";
import type { TelephonyProviderAdapter } from "../src/types/telephony-provider";
import { pool } from "../src/config/db";

let failures = 0;

function check(label: string, condition: boolean, detail?: unknown): void {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${label}`, detail ?? "");
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  const adapter = new ExotelAdapter();

  // ---------- parseInboundMessage ----------
  section("parseInboundMessage");

  const connected = adapter.parseInboundMessage(JSON.stringify({ event: "connected" }));
  check("connected -> CallConnectedEvent", connected?.type === "connected", connected);

  const startRaw = JSON.stringify({
    event: "start",
    sequence_number: "1",
    stream_sid: "stream-abc",
    start: {
      stream_sid: "stream-abc",
      call_sid: "call-xyz",
      account_sid: "acct-1",
      from: "+911234567890",
      to: "+919876543210",
      custom_parameters: { agentId: "agent-1" },
      media_format: { encoding: "raw", sample_rate: 8000, bit_rate: 128000 },
    },
  });
  const start = adapter.parseInboundMessage(startRaw);
  check(
    "start -> CallStartEvent maps stream_sid/call_sid/from/to/media_format",
    start?.type === "start" &&
      start.streamId === "stream-abc" &&
      start.callId === "call-xyz" &&
      start.fromNumber === "+911234567890" &&
      start.toNumber === "+919876543210" &&
      start.customParameters.agentId === "agent-1" &&
      start.mediaFormat.sampleRateHz === 8000 &&
      start.mediaFormat.bitRate === 128000,
    start
  );

  const pcmSample = Buffer.from([1, 2, 3, 4]);
  const mediaRaw = JSON.stringify({
    event: "media",
    stream_sid: "stream-abc",
    media: { chunk: "2", timestamp: "20", payload: pcmSample.toString("base64") },
  });
  const media = adapter.parseInboundMessage(mediaRaw);
  check(
    "media -> CallMediaEvent decodes base64 payload",
    media?.type === "media" &&
      media.streamId === "stream-abc" &&
      media.chunkIndex === 2 &&
      media.timestampMs === 20 &&
      media.pcm16.equals(pcmSample),
    media
  );

  const dtmfRaw = JSON.stringify({
    event: "dtmf",
    stream_sid: "stream-abc",
    dtmf: { digit: "5", duration: 120 },
  });
  const dtmf = adapter.parseInboundMessage(dtmfRaw);
  check(
    "dtmf -> CallDtmfEvent",
    dtmf?.type === "dtmf" && dtmf.digit === "5" && dtmf.durationMs === 120,
    dtmf
  );

  const stopRaw = JSON.stringify({
    event: "stop",
    stream_sid: "stream-abc",
    stop: { call_sid: "call-xyz", reason: "callerHangup" },
  });
  const stop = adapter.parseInboundMessage(stopRaw);
  check(
    "stop -> CallStopEvent",
    stop?.type === "stop" && stop.callId === "call-xyz" && stop.reason === "callerHangup",
    stop
  );

  const markRaw = JSON.stringify({
    event: "mark",
    stream_sid: "stream-abc",
    mark: { name: "mark_1" },
  });
  const mark = adapter.parseInboundMessage(markRaw);
  check("mark -> CallMarkAckEvent", mark?.type === "markAck" && mark.name === "mark_1", mark);

  check("garbage input -> null", adapter.parseInboundMessage("not json") === null);
  check("unknown event -> null", adapter.parseInboundMessage(JSON.stringify({ event: "banana" })) === null);

  // ---------- buildAudioFrame / buildMarkFrame / buildClearFrame ----------
  section("buildAudioFrame / buildMarkFrame / buildClearFrame");

  const streamId = "stream-verify-1";
  const smallPush = Buffer.alloc(100, 7); // well under the 3200B min chunk — should emit nothing yet
  const framesFromSmallPush = adapter.buildAudioFrame(streamId, smallPush);
  check("push below min chunk size emits 0 frames (buffered internally)", framesFromSmallPush.length === 0, framesFromSmallPush.length);

  const bigPush = Buffer.alloc(3200 * 3, 9); // 3 full 3200B chunks once combined with the buffered 100B... not aligned, just checking >=1 chunk emitted
  const framesFromBigPush = adapter.buildAudioFrame(streamId, bigPush);
  check("push above min chunk size emits >=1 frame", framesFromBigPush.length >= 1, framesFromBigPush.length);
  for (const f of framesFromBigPush) {
    const parsed = JSON.parse(f.raw);
    check(
      `emitted frame is Exotel media shape (stream_sid=${streamId})`,
      parsed.event === "media" && parsed.stream_sid === streamId && typeof parsed.media?.payload === "string",
      parsed
    );
    const decoded = Buffer.from(parsed.media.payload, "base64");
    check("emitted chunk length is a multiple of 320 bytes", decoded.length % 320 === 0, decoded.length);
  }
  adapter.releaseStream(streamId);

  const markFrame = adapter.buildMarkFrame("stream-abc", "mark_7");
  const parsedMark = JSON.parse(markFrame.raw);
  check(
    "buildMarkFrame produces Exotel mark shape",
    parsedMark.event === "mark" && parsedMark.stream_sid === "stream-abc" && parsedMark.mark?.name === "mark_7",
    parsedMark
  );

  const clearFrame = adapter.buildClearFrame("stream-abc");
  const parsedClear = JSON.parse(clearFrame.raw);
  check(
    "buildClearFrame produces Exotel clear shape",
    parsedClear.event === "clear" && parsedClear.stream_sid === "stream-abc",
    parsedClear
  );

  const adapterAsInterface: TelephonyProviderAdapter = adapter;
  check(
    "buildExitFrame is not implemented for Exotel (no VI-style exit)",
    adapterAsInterface.buildExitFrame === undefined
  );

  // ---------- parseStatusCallback ----------
  section("parseStatusCallback");

  const answeredPayload = {
    CallSid: "call-answered-1",
    EventType: "answered",
    From: "+911111111111",
    To: "+912222222222",
    Legs: [{ Status: "in-progress" }, { Status: "in-progress", OnCallDuration: 5 }],
  };
  const answeredEvent = adapter.parseStatusCallback(answeredPayload);
  check(
    "answered payload -> status=answered",
    answeredEvent.status === "answered" && answeredEvent.callId === "call-answered-1",
    answeredEvent
  );

  const busyPayload = {
    CallSid: "call-busy-1",
    EventType: "answered",
    Legs: [{ Status: "in-progress" }, { Status: "busy" }],
  };
  check("busy leg2 -> status=busy", adapter.parseStatusCallback(busyPayload).status === "busy");

  const noEventPayload = { CallSid: "call-x", EventType: "queued" };
  check(
    "non-answered EventType with no leg data -> status=failed (safe fallback)",
    adapter.parseStatusCallback(noEventPayload).status === "failed"
  );

  // ---------- triggerOutboundCall: structural checks only, no network call ----------
  section("triggerOutboundCall (structural only, no REST call made)");

  try {
    await adapter.triggerOutboundCall({ toNumber: "+919876543210" });
    check("missing fromNumber should throw", false);
  } catch (err) {
    check("missing fromNumber throws a clear error", String(err).includes("fromNumber"), err);
  }

  try {
    await adapter.triggerOutboundCall({ toNumber: "+919876543210", fromNumber: "+911234567890" });
    check("missing metadata.customerId should throw", false);
  } catch (err) {
    check("missing metadata.customerId throws a clear error", String(err).includes("customerId"), err);
  }

  // ---------- read-only DB check: real company_telephony_settings row round-trips ----------
  section("company_telephony_settings read-only round-trip (live DB)");

  try {
    const row = await pool.query(
      `SELECT customer_id FROM company_telephony_settings WHERE provider_id = 'exotel' AND credentials_enc IS NOT NULL LIMIT 1`
    );
    if (row.rows.length === 0) {
      console.log("  SKIP no company_telephony_settings row with credentials_enc found — nothing to verify");
    } else {
      const customerId = row.rows[0].customer_id as string;
      const settings = await getTelephonySettings(customerId);
      check("getTelephonySettings returns a row", settings !== null, customerId);
      if (settings) {
        const creds = getDecryptedCredentials<ExotelCredentials>(settings);
        check(
          "getDecryptedCredentials returns the expected Exotel credential shape",
          typeof creds.account_sid !== "undefined" && typeof creds.api_key !== "undefined",
          Object.keys(creds)
        );
      }
    }
  } catch (err) {
    failures += 1;
    console.error("  FAIL company_telephony_settings round-trip threw", err);
  }

  await pool.end();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-exotel-adapter crashed:", err);
  process.exit(1);
});
