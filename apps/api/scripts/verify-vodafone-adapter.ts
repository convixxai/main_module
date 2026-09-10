// ============================================================
// Standalone verification for VodafoneAdapter — same pattern as
// verify-exotel-adapter.ts. Exercises the adapter against fixed sample
// payloads shaped like VI's real wire messages (from the vendor doc), plus
// a generic (non-DB) round-trip of the encryption primitive that will back
// a future company_telephony_settings row for provider_id='vodafone' once
// a real Vodafone customer exists (none does today).
//
// Deliberately does NOT attempt to exercise triggerOutboundCall or
// parseStatusCallback as if they worked — both are documented as not
// implemented (missing vendor spec details), so this script asserts they
// throw the expected explanatory errors instead.
//
// Usage (from apps/api): npx ts-node scripts/verify-vodafone-adapter.ts
// ============================================================

import {
  VodafoneAdapter,
  buildVodafonePatchResponse,
  isVodafonePatchWebhookRequest,
} from "../src/services/vodafone-adapter";
import { encrypt, decrypt } from "../src/services/crypto";
import {
  VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES,
  VODAFONE_MEDIA_CHUNK_MIN_BYTES,
  VODAFONE_MEDIA_CHUNK_MAX_BYTES,
} from "../src/types/vodafone-ws";

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
  const adapter = new VodafoneAdapter();

  // ---------- parseInboundMessage ----------
  section("parseInboundMessage");

  const connected = adapter.parseInboundMessage(JSON.stringify({ event: "connected" }));
  check("connected -> CallConnectedEvent", connected?.type === "connected", connected);

  const startRaw = JSON.stringify({
    event: "start",
    sequence_number: 1,
    room_id: "room-abc",
    start: {
      room_id: "room-abc",
      call_id: "call-xyz",
      cli: "+911234567890",
      dni: "+919876543210",
      custom_parameters: { queuename: "premium", product: "radio" },
      media_format: { encoding: "raw", sample_rate: "8000", bit_rate: "128000" },
    },
  });
  const start = adapter.parseInboundMessage(startRaw);
  check(
    "start -> CallStartEvent maps room_id/call_id/cli/dni/media_format (string->number)",
    start?.type === "start" &&
      start.streamId === "room-abc" &&
      start.callId === "call-xyz" &&
      start.fromNumber === "+911234567890" &&
      start.toNumber === "+919876543210" &&
      start.customParameters.queuename === "premium" &&
      start.mediaFormat.sampleRateHz === 8000 &&
      start.mediaFormat.bitRate === 128000,
    start
  );

  const pcmSample = Buffer.from([9, 8, 7, 6]);
  const mediaRaw = JSON.stringify({
    event: "media",
    sequence_number: 3,
    room_id: "room-abc",
    media: { chunk: 2, timestamp: "20", payload: pcmSample.toString("base64") },
  });
  const media = adapter.parseInboundMessage(mediaRaw);
  check(
    "media -> CallMediaEvent decodes base64 payload",
    media?.type === "media" &&
      media.streamId === "room-abc" &&
      media.chunkIndex === 2 &&
      media.timestampMs === 20 &&
      media.pcm16.equals(pcmSample),
    media
  );

  const dtmfRaw = JSON.stringify({
    event: "dtmf",
    sequence_number: 1,
    room_id: "room-abc",
    dtmf: { duration: "150", digit: "7" },
  });
  const dtmf = adapter.parseInboundMessage(dtmfRaw);
  check(
    "dtmf -> CallDtmfEvent (string duration -> number)",
    dtmf?.type === "dtmf" && dtmf.digit === "7" && dtmf.durationMs === 150,
    dtmf
  );

  const stopRaw = JSON.stringify({
    event: "stop",
    sequence_number: 10,
    room_id: "room-abc",
    stop: { call_id: "call-xyz", reason: "stopped or call ended" },
  });
  const stop = adapter.parseInboundMessage(stopRaw);
  check(
    "stop -> CallStopEvent",
    stop?.type === "stop" && stop.callId === "call-xyz" && stop.reason === "stopped or call ended",
    stop
  );

  const markRaw = JSON.stringify({
    event: "mark",
    sequence_number: 15,
    room_id: "room-abc",
    mark: { name: "mark_1" },
  });
  const mark = adapter.parseInboundMessage(markRaw);
  check("mark -> CallMarkAckEvent", mark?.type === "markAck" && mark.name === "mark_1", mark);

  check("garbage input -> null", adapter.parseInboundMessage("not json") === null);
  check("unknown event -> null", adapter.parseInboundMessage(JSON.stringify({ event: "banana" })) === null);

  // ---------- buildAudioFrame / buildMarkFrame / buildClearFrame / buildExitFrame ----------
  section("buildAudioFrame / buildMarkFrame / buildClearFrame / buildExitFrame");

  const streamId = "room-verify-1";
  const smallPush = Buffer.alloc(200, 3); // under the 1.6KB min chunk — should emit nothing yet
  const framesFromSmallPush = adapter.buildAudioFrame(streamId, smallPush);
  check("push below min chunk size emits 0 frames (buffered internally)", framesFromSmallPush.length === 0, framesFromSmallPush.length);

  const bigPush = Buffer.alloc(VODAFONE_MEDIA_CHUNK_MIN_BYTES * 3, 5);
  const framesFromBigPush = adapter.buildAudioFrame(streamId, bigPush);
  check("push above min chunk size emits >=1 frame", framesFromBigPush.length >= 1, framesFromBigPush.length);

  let prevChunkIndex = -1;
  for (const f of framesFromBigPush) {
    const parsed = JSON.parse(f.raw);
    check(
      `emitted frame is VI media shape (room_id=${streamId})`,
      parsed.event === "media" && parsed.room_id === streamId && typeof parsed.media?.payload === "string",
      parsed
    );
    const decoded = Buffer.from(parsed.media.payload, "base64");
    check(
      `emitted chunk length (${decoded.length}) is between ${VODAFONE_MEDIA_CHUNK_MIN_BYTES}-${VODAFONE_MEDIA_CHUNK_MAX_BYTES} bytes`,
      decoded.length >= VODAFONE_MEDIA_CHUNK_MIN_BYTES && decoded.length <= VODAFONE_MEDIA_CHUNK_MAX_BYTES,
      decoded.length
    );
    check(
      `emitted chunk length is a multiple of ${VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES} bytes`,
      decoded.length % VODAFONE_MEDIA_CHUNK_ALIGNMENT_BYTES === 0,
      decoded.length
    );
    check("media.chunk index is monotonically increasing across the stream", parsed.media.chunk > prevChunkIndex, {
      prevChunkIndex,
      chunk: parsed.media.chunk,
    });
    prevChunkIndex = parsed.media.chunk;
  }
  adapter.releaseStream(streamId);

  const markFrame = adapter.buildMarkFrame("room-abc", "mark_7");
  const parsedMark = JSON.parse(markFrame.raw);
  check(
    "buildMarkFrame produces VI mark shape",
    parsedMark.event === "mark" && parsedMark.room_id === "room-abc" && parsedMark.mark?.name === "mark_7",
    parsedMark
  );

  const clearFrame = adapter.buildClearFrame("room-abc");
  const parsedClear = JSON.parse(clearFrame.raw);
  check(
    "buildClearFrame produces VI clear shape",
    parsedClear.event === "clear" && parsedClear.room_id === "room-abc",
    parsedClear
  );

  const exitFrame = adapter.buildExitFrame("room-abc");
  const parsedExit = JSON.parse(exitFrame.raw);
  check(
    "buildExitFrame produces VI exit shape (Vodafone-only capability, no Exotel equivalent)",
    parsedExit.event === "exit" && parsedExit.room_id === "room-abc",
    parsedExit
  );

  // ---------- patch-to-agent webhook helpers ----------
  section("patch-to-agent webhook helpers");

  check(
    "isVodafonePatchWebhookRequest accepts a well-formed request",
    isVodafonePatchWebhookRequest({ Callid: "c1", dni: "d1", cli: "c2" })
  );
  check(
    "isVodafonePatchWebhookRequest rejects a malformed request",
    !isVodafonePatchWebhookRequest({ Callid: "c1" })
  );
  check(
    "buildVodafonePatchResponse(transfer) -> callstatus 1 + rm_number",
    JSON.stringify(buildVodafonePatchResponse({ transfer: true, agentNumber: "9998887770" })) ===
      JSON.stringify({ callstatus: "1", rm_number: "9998887770" })
  );
  check(
    "buildVodafonePatchResponse(hangup) -> callstatus 0, no rm_number",
    JSON.stringify(buildVodafonePatchResponse({ transfer: false })) === JSON.stringify({ callstatus: "0" })
  );

  // ---------- deliberately-not-implemented methods throw explanatory errors ----------
  section("deliberately-not-implemented methods (missing vendor spec details)");

  try {
    await adapter.triggerOutboundCall({ toNumber: "+919876543210" });
    check("triggerOutboundCall should throw (VI outbound REST API not documented)", false);
  } catch (err) {
    check(
      "triggerOutboundCall throws, naming the missing REST API contract",
      String(err).includes("REST API"),
      err
    );
  }

  try {
    adapter.parseStatusCallback({ some: "payload" });
    check("parseStatusCallback should throw (VI general status callback not documented)", false);
  } catch (err) {
    check(
      "parseStatusCallback throws, naming the missing status-callback shape",
      String(err).includes("status-callback"),
      err
    );
  }

  // ---------- credential encryption round-trip (generic — no live Vodafone row exists yet) ----------
  section("credentials_enc round-trip (generic AES-256-GCM, no live Vodafone row exists yet)");

  const sampleVodafoneCreds = { api_key: "sample-key-123", account_id: "acct-1" };
  const encrypted = encrypt(JSON.stringify(sampleVodafoneCreds));
  const decrypted = JSON.parse(decrypt(encrypted));
  check(
    "encrypt/decrypt round-trips a Vodafone-shaped credential object (same crypto.ts primitive ExotelAdapter uses)",
    decrypted.api_key === sampleVodafoneCreds.api_key && decrypted.account_id === sampleVodafoneCreds.account_id,
    decrypted
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("verify-vodafone-adapter crashed:", err);
  process.exit(1);
});
