export const VOICE_CARTESIA_TEST_CONSOLE_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cartesia Voice Test Console (TEMP — Streaming)</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 760px; margin: 40px auto; padding: 0 16px; color: #1a1a1a; }
  h1 { font-size: 20px; }
  .badge { display: inline-block; background: #fef3c7; color: #92400e; border-radius: 4px; padding: 2px 8px; font-size: 12px; font-weight: 600; }
  .badge.stream { background: #dcfce7; color: #166534; }
  #recordBtn { font-size: 18px; padding: 16px 32px; border-radius: 8px; border: none; cursor: pointer; background: #2563eb; color: white; }
  #recordBtn.recording { background: #dc2626; }
  #recordBtn:disabled { background: #9ca3af; cursor: not-allowed; }
  #status { margin: 12px 0; font-size: 14px; color: #555; min-height: 20px; }
  #error { color: #b91c1c; font-size: 13px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 13px; }
  td, th { border: 1px solid #e5e7eb; padding: 6px 10px; text-align: left; }
  th { background: #f9fafb; }
  .qa { margin-top: 16px; padding: 12px; background: #f9fafb; border-radius: 6px; font-size: 14px; }
  .qa div { margin-bottom: 6px; }
  #answerLive { min-height: 1.4em; }
  #answerLive .cursor { display: inline-block; width: 7px; height: 1em; background: #2563eb; vertical-align: middle; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
  .log { font-size: 12px; color: #666; margin-top: 4px; }
</style>
</head>
<body>
  <h1>Cartesia Voice Test Console <span class="badge">TEMPORARY / TEST ONLY</span> <span class="badge stream">STREAMING</span></h1>
  <p>Speaks into your mic, streams the RAG/LLM answer token-by-token, and speaks each completed sentence via Cartesia TTS as soon as it's ready — audio for sentence 1 starts playing while later sentences are still being generated/synthesized. This page only ever uses the streaming endpoint (<code>/turn-stream</code>, Server-Sent Events); there is no batch fallback.</p>

  <button id="recordBtn">Click to record</button>
  <div id="status">Loading config…</div>
  <div id="error"></div>

  <div id="qa" class="qa" style="display:none">
    <div><b>Transcript:</b> <span id="transcript"></span></div>
    <div><b>Answer (live):</b> <span id="answerLive"></span></div>
  </div>

  <table id="timings" style="display:none">
    <thead><tr><th>Event</th><th>Time (ms, since request start)</th></tr></thead>
    <tbody id="timingsBody"></tbody>
  </table>
  <div id="chunkLog" class="log"></div>

<script>
(function () {
  var recordBtn = document.getElementById("recordBtn");
  var statusEl = document.getElementById("status");
  var errorEl = document.getElementById("error");
  var qa = document.getElementById("qa");
  var transcriptEl = document.getElementById("transcript");
  var answerLiveEl = document.getElementById("answerLive");
  var timingsTable = document.getElementById("timings");
  var timingsBody = document.getElementById("timingsBody");
  var chunkLog = document.getElementById("chunkLog");

  var config = null;
  var isRecording = false;
  var stream, recCtx, sourceNode, proc;
  var buffers = [];
  var sampleRate = 44100;

  // Playback audio context + gapless chunk scheduler (separate from the
  // recording AudioContext above).
  var playCtx = null;
  var nextPlayTime = 0;

  function setStatus(msg) { statusEl.textContent = msg; }
  function showError(msg) { errorEl.textContent = msg || ""; }
  function addTimingRow(label, ms) {
    var tr = document.createElement("tr");
    tr.innerHTML = "<td>" + label + "</td><td>" + ms + "</td>";
    timingsBody.appendChild(tr);
    timingsTable.style.display = "table";
  }
  function logLine(msg) {
    var div = document.createElement("div");
    div.textContent = msg;
    chunkLog.appendChild(div);
  }

  function concatFloat32(chunks) {
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Float32Array(total);
    var offset = 0;
    for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], offset); offset += chunks[j].length; }
    return out;
  }

  function encodeWav(samples, rate) {
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function writeStr(offset, str) { for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
    writeStr(0, "RIFF");
    view.setUint32(4, 36 + samples.length * 2, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data");
    view.setUint32(40, samples.length * 2, true);
    var offset = 44;
    for (var i = 0; i < samples.length; i++, offset += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }

  // ---------- Gapless incremental playback ----------
  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function scheduleAudioChunk(base64) {
    if (!playCtx) {
      playCtx = new (window.AudioContext || window.webkitAudioContext)();
      nextPlayTime = playCtx.currentTime;
    }
    var arrayBuf = base64ToArrayBuffer(base64);
    var audioBuf = await playCtx.decodeAudioData(arrayBuf);
    var src = playCtx.createBufferSource();
    src.buffer = audioBuf;
    src.connect(playCtx.destination);
    var startAt = Math.max(nextPlayTime, playCtx.currentTime);
    src.start(startAt);
    nextPlayTime = startAt + audioBuf.duration;
  }

  // ---------- SSE parsing over fetch's streamed response body ----------
  function parseSseBlock(block) {
    var eventType = "message";
    var dataLines = [];
    block.split("\\n").forEach(function (line) {
      if (line.indexOf("event: ") === 0) eventType = line.slice(7);
      else if (line.indexOf("data: ") === 0) dataLines.push(line.slice(6));
    });
    if (dataLines.length === 0) return null;
    try {
      return { event: eventType, data: JSON.parse(dataLines.join("\\n")) };
    } catch (e) {
      return null;
    }
  }

  async function loadConfig() {
    try {
      var res = await fetch("/voice/cartesia-test-console/config");
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load config");
      config = data;
      if (!data.cartesia_configured) {
        setStatus("CARTESIA_API_KEY is not configured on the server.");
        recordBtn.disabled = true;
        return;
      }
      if (!data.voice_id) {
        setStatus("Temp agent has no Cartesia voice configured.");
        recordBtn.disabled = true;
        return;
      }
      setStatus("Ready. customer_id=" + data.customer_id + " voice_id=" + data.voice_id);
    } catch (e) {
      setStatus("Config error — is the temp test customer seeded?");
      showError(e.message || String(e));
      recordBtn.disabled = true;
    }
  }

  async function startRecording() {
    showError("");
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError("Microphone not supported in this browser.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      showError("Microphone access denied: " + (e.message || e));
      return;
    }
    recCtx = new (window.AudioContext || window.webkitAudioContext)();
    sampleRate = recCtx.sampleRate;
    sourceNode = recCtx.createMediaStreamSource(stream);
    proc = recCtx.createScriptProcessor(4096, 1, 1);
    var mute = recCtx.createGain();
    mute.gain.value = 0;
    buffers = [];
    proc.onaudioprocess = function (ev) {
      buffers.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    sourceNode.connect(proc);
    proc.connect(mute);
    mute.connect(recCtx.destination);

    isRecording = true;
    recordBtn.textContent = "Click to stop and send";
    recordBtn.classList.add("recording");
    setStatus("Recording… speak now.");
  }

  function stopCaptureNodes() {
    if (proc) { proc.disconnect(); proc.onaudioprocess = null; proc = null; }
    if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
    if (recCtx) { recCtx.close(); recCtx = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  async function stopRecordingAndSend() {
    isRecording = false;
    recordBtn.classList.remove("recording");
    recordBtn.disabled = true;
    recordBtn.textContent = "Working…";

    var merged = concatFloat32(buffers);
    buffers = [];
    stopCaptureNodes();

    if (merged.length / sampleRate < 0.3) {
      setStatus("Recording too short — try again, speak for at least half a second.");
      recordBtn.disabled = false;
      recordBtn.textContent = "Click to record";
      return;
    }

    await sendForStreaming(encodeWav(merged, sampleRate));
  }

  // Exposed for automated testing of this temp page without a physical mic
  // (see apps/api/scripts — this function is the same one the real
  // recording flow calls).
  window.__sendForStreaming = sendForStreaming;

  async function sendForStreaming(wavBlob) {
    timingsBody.innerHTML = "";
    chunkLog.innerHTML = "";
    timingsTable.style.display = "none";
    transcriptEl.textContent = "";
    answerLiveEl.innerHTML = '<span class="cursor"></span>';
    qa.style.display = "block";
    nextPlayTime = 0;
    if (playCtx) { try { playCtx.close(); } catch (e) {} playCtx = null; }

    setStatus("Streaming (STT → token-streamed RAG → chunked Cartesia TTS)…");
    var fd = new FormData();
    fd.append("file", wavBlob, "speech.wav");

    var reqStart = performance.now();
    var summary = null;
    try {
      var res = await fetch("/voice/cartesia-test-console/turn-stream", {
        method: "POST",
        headers: { "x-api-key": config.api_key },
        body: fd,
      });
      if (!res.ok) {
        var errBody = await res.json().catch(function () { return {}; });
        throw new Error(errBody.error || ("HTTP " + res.status));
      }

      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      var answerText = "";

      while (true) {
        var _r = await reader.read();
        if (_r.done) break;
        buf += decoder.decode(_r.value, { stream: true });
        var parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var parsed = parseSseBlock(parts[i]);
          if (!parsed) continue;
          var elapsed = Math.round(performance.now() - reqStart);

          if (parsed.event === "transcript") {
            transcriptEl.textContent = parsed.data.transcript;
            addTimingRow("Transcript ready (STT, " + parsed.data.stt_ms + "ms)", elapsed);
          } else if (parsed.event === "retrieval_done") {
            addTimingRow("KB retrieval done (" + parsed.data.retrieve_ms + "ms, top_distance=" + parsed.data.top_distance + ")", elapsed);
          } else if (parsed.event === "first_token") {
            addTimingRow("<b>First LLM token</b>", elapsed);
          } else if (parsed.event === "text_delta") {
            answerText += parsed.data.delta;
            answerLiveEl.innerHTML = answerText.replace(/&/g, "&amp;").replace(/</g, "&lt;") + '<span class="cursor"></span>';
          } else if (parsed.event === "answer_complete") {
            answerLiveEl.textContent = parsed.data.answer;
            addTimingRow("Full answer text complete (" + parsed.data.chunk_count + " speech chunk(s))", elapsed);
          } else if (parsed.event === "first_audio") {
            addTimingRow("<b>First audio chunk ready to play</b>", elapsed);
          } else if (parsed.event === "audio_chunk") {
            logLine("Chunk " + parsed.data.index + " (\\"" + parsed.data.text + "\\") synthesized in " + parsed.data.synthMs + "ms, " + parsed.data.bytes + " bytes — scheduling playback");
            scheduleAudioChunk(parsed.data.base64).catch(function (e) { logLine("Playback error: " + e.message); });
          } else if (parsed.event === "done") {
            summary = parsed.data;
            addTimingRow("<b>done (total)</b>", elapsed);
          } else if (parsed.event === "error") {
            throw new Error(parsed.data.error || "Streaming error");
          }
        }
      }

      setStatus(
        summary
          ? "Done. total=" + summary.total_ms + "ms, first_token=" + summary.first_token_ms + "ms, first_audio=" + summary.first_audio_ms + "ms. Click to record again."
          : "Done. Click to record again."
      );
    } catch (e) {
      showError(e.message || String(e));
      setStatus("Failed.");
    }
    recordBtn.disabled = false;
    recordBtn.textContent = "Click to record";
  }

  recordBtn.addEventListener("click", function () {
    if (!isRecording) startRecording();
    else stopRecordingAndSend();
  });

  loadConfig();
})();
</script>
</body>
</html>
`;
