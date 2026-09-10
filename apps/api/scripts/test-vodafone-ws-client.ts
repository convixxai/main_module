// ============================================================
// Standalone WS test client simulating VI (Vodafone) connecting to our new
// /telephony/vodafone/voicebot/:customerId route — since I can't get a real
// Vodafone account, this drives the actual route with a real WebSocket
// connection and a real recorded question, exactly as VI's own protocol
// spec documents (connected -> start -> media... -> exit).
//
// Usage (from apps/api): npx ts-node scripts/test-vodafone-ws-client.ts <wavPath> <customerId>
// ============================================================

import fs from "fs";
import WebSocket from "ws";
import { parseWavToPcmS16leMono, resamplePcm16 } from "../src/services/pcm-audio";
import { chunkVodafoneAudio } from "../src/types/vodafone-ws";

async function main(): Promise<void> {
  const wavPath = process.argv[2];
  const customerId = process.argv[3];
  if (!wavPath || !customerId) {
    console.error("Usage: test-vodafone-ws-client.ts <wavPath> <customerId>");
    process.exit(1);
  }

  const wavBuf = fs.readFileSync(wavPath);
  const parsed = parseWavToPcmS16leMono(wavBuf);
  if (!parsed) throw new Error("could not parse input wav");
  const pcm8k = parsed.sampleRate === 8000 ? parsed.pcm : resamplePcm16(parsed.pcm, parsed.sampleRate, 8000);
  console.log(`Loaded ${wavPath}: ${parsed.sampleRate}Hz -> resampled to 8000Hz, ${pcm8k.length} bytes`);

  const roomId = "test-room-" + Date.now();
  const ws = new WebSocket(`ws://127.0.0.1:8080/telephony/vodafone/voicebot/${customerId}`);

  const receivedAudioChunks: Buffer[] = [];
  let seq = 1;
  let gotGreetingMark = false;
  let gotAnswerMark = false;

  ws.on("open", async () => {
    console.log("WS open — sending connected + start");
    ws.send(JSON.stringify({ event: "connected" }));
    ws.send(
      JSON.stringify({
        event: "start",
        sequence_number: seq++,
        room_id: roomId,
        start: {
          room_id: roomId,
          call_id: "test-call-1",
          cli: "+911234567890",
          dni: "+919876543210",
          custom_parameters: {},
          media_format: { encoding: "raw", sample_rate: "8000", bit_rate: "128000" },
        },
      })
    );

    // Wait for the greeting to arrive (first mark) before "speaking"
    await new Promise((resolve) => {
      const check = setInterval(() => {
        if (gotGreetingMark) {
          clearInterval(check);
          resolve(null);
        }
      }, 200);
      setTimeout(() => { clearInterval(check); resolve(null); }, 15000);
    });

    console.log(`Sending ${pcm8k.length} bytes of caller audio as media chunks...`);
    const chunks = chunkVodafoneAudio(pcm8k, 1600);
    for (let i = 0; i < chunks.length; i++) {
      ws.send(
        JSON.stringify({
          event: "media",
          sequence_number: seq++,
          room_id: roomId,
          media: { chunk: i, timestamp: String(i * 100), payload: chunks[i].toString("base64") },
        })
      );
      await new Promise((r) => setTimeout(r, 15));
    }
    console.log("Finished sending caller audio, waiting for silence timeout + reply...");
  });

  ws.on("message", (raw: Buffer) => {
    const msg = JSON.parse(raw.toString("utf8"));
    if (msg.event === "media") {
      receivedAudioChunks.push(Buffer.from(msg.media.payload, "base64"));
    } else if (msg.event === "mark") {
      console.log("Received mark:", msg.mark.name, `(audio chunks so far: ${receivedAudioChunks.length})`);
      if (!gotGreetingMark) {
        gotGreetingMark = true;
      } else {
        gotAnswerMark = true;
      }
    } else {
      console.log("Received event:", msg.event);
    }
  });

  ws.on("error", (err) => console.error("WS error:", err));

  await new Promise((resolve) => {
    const check = setInterval(() => {
      if (gotAnswerMark) {
        clearInterval(check);
        resolve(null);
      }
    }, 200);
    setTimeout(() => { clearInterval(check); resolve(null); }, 20000);
  });

  const totalAudioBytes = receivedAudioChunks.reduce((a, b) => a + b.length, 0);
  console.log(`\nTotal received audio: ${totalAudioBytes} bytes across ${receivedAudioChunks.length} chunks`);
  console.log(`Got greeting mark: ${gotGreetingMark}, got answer mark: ${gotAnswerMark}`);

  ws.send(JSON.stringify({ event: "exit", room_id: roomId }));
  await new Promise((r) => setTimeout(r, 500));
  ws.close();

  const success = gotGreetingMark && gotAnswerMark && totalAudioBytes > 0;
  console.log(success ? "\nEND-TO-END TEST PASSED" : "\nEND-TO-END TEST FAILED");
  process.exit(success ? 0 : 1);
}

main().catch((err) => {
  console.error("test-vodafone-ws-client crashed:", err);
  process.exit(1);
});
