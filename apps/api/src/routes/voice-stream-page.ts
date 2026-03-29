/** Temporary real-time voice → /ask/voice demo — GET /voice/stream */

export const VOICE_STREAM_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice stream — Ask</title>
  <style>
    :root {
      --bg: #0c1016;
      --panel: #151c28;
      --border: #2a3548;
      --text: #e8edf4;
      --muted: #8b9ab0;
      --accent: #5b8def;
      --warn: #d4a534;
      --danger: #e85d5d;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 1.25rem;
      max-width: 40rem;
      margin-left: auto;
      margin-right: auto;
      line-height: 1.5;
    }
    h1 { font-size: 1.2rem; margin: 0 0 0.35rem; }
    .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem;
      margin-bottom: 1rem;
    }
    label { display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.2rem; }
    input, select {
      width: 100%;
      padding: 0.45rem 0.55rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      margin-bottom: 0.5rem;
      font-size: 0.9rem;
    }
    .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    button {
      cursor: pointer;
      border: none;
      border-radius: 8px;
      padding: 0.65rem 1rem;
      font-size: 0.95rem;
      font-weight: 600;
    }
    #btnStart {
      width: 100%;
      background: var(--accent);
      color: #fff;
    }
    #btnStart:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    #btnCancel {
      background: #333a47;
      color: var(--text);
      margin-top: 0.5rem;
      width: 100%;
    }
    .status-pill {
      display: inline-block;
      padding: 0.25rem 0.6rem;
      border-radius: 999px;
      font-size: 0.8rem;
      margin-bottom: 0.75rem;
    }
    .st-ready { background: #1e3a2f; color: #7dffb3; }
    .st-listen { background: #3a2e1e; color: #ffd27d; }
    .st-work { background: #2e2538; color: #c4b5fd; }
    #responseMs { font-variant-numeric: tabular-nums; font-weight: 700; color: #7dffb3; }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.78rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.6rem;
      max-height: 10rem;
      overflow: auto;
    }
    #timingLogs {
      max-height: 16rem;
      font-size: 0.75rem;
      line-height: 1.45;
    }
    .log-line { display: block; }
    .log-hot { color: #ffb86c; font-weight: 600; }
    .log-label { color: var(--muted); }
    audio { width: 100%; margin-top: 0.5rem; }
    .hint { font-size: 0.78rem; color: var(--muted); margin-top: 0.5rem; }
  </style>
</head>
<body>
  <h1>Voice stream → /ask/voice</h1>
  <p class="sub">Speak; after ~1.2s silence your clip is sent. Same <strong>session</strong> keeps chat history for follow-ups. Mic stays off until the answer returns.</p>

  <section>
    <label>API base</label>
    <input type="url" id="base" placeholder="http://localhost:8080" />
    <label>x-api-key</label>
    <input type="password" id="key" autocomplete="off" />
    <div class="row2">
      <div>
        <label>Chat session (from last reply)</label>
        <input type="text" id="sessionId" readonly placeholder="First reply creates a session" style="font-size:0.8rem" />
      </div>
      <div>
        <label>&nbsp;</label>
        <button type="button" id="btnNewChat" style="width:100%;background:#333a47;color:var(--text);padding:0.45rem">New conversation</button>
      </div>
    </div>
    <div class="row2">
      <div>
        <label>target_language_code (TTS)</label>
        <select id="ttsLang"></select>
      </div>
      <div>
        <label>speaker</label>
        <input type="text" id="speaker" value="ritu" />
      </div>
    </div>
    <label style="margin-top:0.5rem">Latency helpers</label>
    <div class="row2">
      <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.85rem;cursor:pointer">
        <input type="checkbox" id="chkFastLlm" checked /> Faster LLM: self-hosted first, OpenAI only if needed (sends <code>voice_fast_llm</code>)
      </label>
    </div>
    <div class="row2">
      <div>
        <label>Max TTS chars (optional, shorter = faster TTS)</label>
        <input type="number" id="ttsMax" min="200" max="2500" placeholder="e.g. 900 — empty = full answer" />
      </div>
      <div>
        <label style="display:flex;align-items:center;gap:0.35rem;font-size:0.85rem;cursor:pointer;margin-top:1.35rem">
          <input type="checkbox" id="chkMp3" /> MP3 output (often smaller / slightly faster encode)
        </label>
      </div>
    </div>
  </section>

  <section>
    <span id="pill" class="status-pill st-ready">Ready</span>
    <div id="statusLine">Click the button below, then speak. Pause ~1.2s to send.</div>
    <button type="button" id="btnStart">Start speaking</button>
    <button type="button" id="btnCancel" style="display:none">Cancel</button>
    <p class="hint">Browser round-trip: <span id="responseMs">—</span> (includes upload + download)</p>
  </section>

  <section>
    <strong>Server timing (live breakdown)</strong>
    <p class="hint" style="margin-top:0">Where the server spent time for this request. Largest row ≈ bottleneck.</p>
    <pre id="timingLogs">—</pre>
  </section>

  <section>
    <strong>Transcript</strong>
    <pre id="outTranscript">—</pre>
    <strong>Answer</strong>
    <pre id="outAnswer">—</pre>
    <audio id="player" controls></audio>
    <pre id="outErr" style="color:var(--danger); display:none"></pre>
  </section>

  <script>
(function () {
  var LANGS = ["hi-IN","en-IN","bn-IN","gu-IN","kn-IN","ml-IN","mr-IN","od-IN","pa-IN","ta-IN","te-IN"];
  var sel = document.getElementById("ttsLang");
  LANGS.forEach(function (c) {
    var o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    if (c === "hi-IN") o.selected = true;
    sel.appendChild(o);
  });

  var base = document.getElementById("base");
  var key = document.getElementById("key");
  var sessionIdInput = document.getElementById("sessionId");
  var btnNewChat = document.getElementById("btnNewChat");
  try {
    base.value = localStorage.getItem("voiceStreamBase") || window.location.origin || "";
    key.value = localStorage.getItem("voiceStreamKey") || "";
    var sid = localStorage.getItem("voiceStreamSessionId");
    if (sid) sessionIdInput.value = sid;
  } catch (e) {}

  var SILENCE_MS = 1200;
  var RMS_THRESH = 0.018;
  var MIN_SPEECH_SEC = 0.35;
  var pill = document.getElementById("pill");
  var statusLine = document.getElementById("statusLine");
  var btnStart = document.getElementById("btnStart");
  var btnCancel = document.getElementById("btnCancel");
  var responseMs = document.getElementById("responseMs");
  var outTranscript = document.getElementById("outTranscript");
  var outAnswer = document.getElementById("outAnswer");
  var outErr = document.getElementById("outErr");
  var player = document.getElementById("player");
  var timingLogs = document.getElementById("timingLogs");

  function formatVoiceTimings(v) {
    if (!v || typeof v !== "object") return "No voice_timings in response.";
    var rows = [];
    function pushRow(label, ms, key) {
      var n = typeof ms === "number" && !isNaN(ms) ? ms : null;
      rows.push({ label: label, ms: n, key: key || label });
    }
    pushRow("Multipart upload (server read)", v.multipart_ms, "multipart");
    pushRow("Sarvam STT", v.stt_ms, "stt");
    var pb = v.pipeline_breakdown;
    if (pb && typeof pb === "object") {
      pushRow("  • session + embed + sessionAgent (parallel)", pb.parallel_init_ms, "p1");
      pushRow("  • resolve agent", pb.resolve_agent_ms, "p2");
      pushRow("  • vector search + chat history (parallel)", pb.vector_history_ms, "p3");
      pushRow("  • RAG: LLM wall time (parallel or sequential)", pb.rag_llm_parallel_ms, "p4");
    } else if (typeof v.ask_pipeline_ms === "number") {
      pushRow("Ask pipeline (total)", v.ask_pipeline_ms, "ask");
    }
    pushRow("Sarvam TTS", v.tts_ms, "tts");
    pushRow("Server total (handler)", v.server_total_ms, "total");

    var maxMs = 0;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].ms != null && rows[i].ms > maxMs) maxMs = rows[i].ms;
    }

    var lines = [];
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var hot = r.ms != null && maxMs > 0 && r.ms === maxMs && r.key !== "total";
      var pad = r.ms != null ? ("     " + r.ms + " ms").slice(-10) : "";
      var line = (hot ? "● " : "  ") + r.label;
      if (r.ms != null) line += " " + pad;
      lines.push(hot ? '<span class="log-hot">' + line + "</span>" : line);
    }
    if (pb && pb.branch) {
      lines.push('  <span class="log-label">branch:</span> ' + pb.branch);
    }
    return lines.join(String.fromCharCode(10));
  }

  var stream = null;
  var audioCtx = null;
  var proc = null;
  var sourceNode = null;
  var mute = null;
  var buffers = [];
  var accumulating = false;
  var silenceMs = 0;
  var sampleRate = 48000;

  function root() {
    var u = (base.value || "").trim();
    while (u.length > 0 && u.charAt(u.length - 1) === "/") {
      u = u.slice(0, -1);
    }
    return u || window.location.origin;
  }

  function setPill(text, cls) {
    pill.textContent = text;
    pill.className = "status-pill " + cls;
  }

  function concatFloat32(arrs) {
    var n = 0;
    for (var i = 0; i < arrs.length; i++) n += arrs[i].length;
    var out = new Float32Array(n);
    var o = 0;
    for (var j = 0; j < arrs.length; j++) {
      out.set(arrs[j], o);
      o += arrs[j].length;
    }
    return out;
  }

  function encodeWav(samples, rate) {
    var len = samples.length;
    var buf = new ArrayBuffer(44 + len * 2);
    var view = new DataView(buf);
    function wStr(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    }
    function f32To16(off, input) {
      for (var i = 0; i < input.length; i++, off += 2) {
        var s = Math.max(-1, Math.min(1, input[i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      }
    }
    wStr(0, "RIFF");
    view.setUint32(4, 36 + len * 2, true);
    wStr(8, "WAVE");
    wStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, rate, true);
    view.setUint32(28, rate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wStr(36, "data");
    view.setUint32(40, len * 2, true);
    f32To16(44, samples);
    return new Blob([buf], { type: "audio/wav" });
  }

  function rms(chunk) {
    var s = 0;
    for (var i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
    return Math.sqrt(s / chunk.length);
  }

  function stopCapture() {
    if (proc) {
      try { proc.disconnect(); } catch (e) {}
      proc.onaudioprocess = null;
    }
    if (mute) {
      try { mute.disconnect(); } catch (e) {}
    }
    if (sourceNode) {
      try { sourceNode.disconnect(); } catch (e) {}
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch (e) {}
    }
    if (stream) {
      stream.getTracks().forEach(function (t) { t.stop(); });
    }
    proc = null;
    mute = null;
    sourceNode = null;
    audioCtx = null;
    stream = null;
    buffers = [];
    accumulating = false;
    silenceMs = 0;
  }

  function finalizeAndSend() {
    if (buffers.length === 0) return;
    var merged = concatFloat32(buffers);
    buffers = [];
    accumulating = false;
    silenceMs = 0;
    var dur = merged.length / sampleRate;
    if (dur < MIN_SPEECH_SEC) {
      statusLine.textContent = "Too short — speak a bit longer.";
      setPill("Ready", "st-ready");
      btnStart.disabled = false;
      btnCancel.style.display = "none";
      stopCapture();
      return;
    }
    var blob = encodeWav(merged, sampleRate);
    stopCapture();
    sendAskVoice(blob);
  }

  function sendAskVoice(wavBlob) {
    setPill("Working…", "st-work");
    statusLine.textContent = "Calling /ask/voice — mic disabled.";
    btnStart.disabled = true;
    btnCancel.style.display = "none";
    outErr.style.display = "none";
    responseMs.textContent = "…";
    timingLogs.textContent = "Waiting for server…";

    var k = (key.value || "").trim();
    if (!k) {
      outErr.textContent = "Set x-api-key.";
      outErr.style.display = "block";
      timingLogs.textContent = "—";
      setPill("Ready", "st-ready");
      btnStart.disabled = false;
      statusLine.textContent = "Add API key.";
      return;
    }

    var fd = new FormData();
    fd.append("file", wavBlob, "speech.wav");
    fd.append("target_language_code", document.getElementById("ttsLang").value);
    var sp = document.getElementById("speaker").value.trim();
    if (sp) fd.append("speaker", sp);
    var sidSend = (sessionIdInput.value || "").trim();
    if (sidSend) fd.append("session_id", sidSend);
    if (document.getElementById("chkFastLlm").checked) fd.append("voice_fast_llm", "1");
    var ttsMaxVal = document.getElementById("ttsMax").value.trim();
    if (ttsMaxVal) fd.append("voice_tts_max_chars", ttsMaxVal);
    if (document.getElementById("chkMp3").checked) fd.append("output_audio_codec", "mp3");

    var url = root() + "/ask/voice";
    var t0 = performance.now();
    fetch(url, { method: "POST", headers: { "x-api-key": k }, body: fd })
      .then(function (res) {
        return res.json().then(function (j) {
          return { ok: res.ok, status: res.status, body: j };
        });
      })
      .then(function (x) {
        var ms = Math.round(performance.now() - t0);
        responseMs.textContent = ms + " ms";
        var vt = x.body && x.body.voice_timings;
        if (vt) {
          timingLogs.innerHTML = formatVoiceTimings(vt);
        } else {
          timingLogs.textContent = "No voice_timings in response.";
        }
        if (!x.ok) {
          outErr.textContent = JSON.stringify(x.body, null, 2);
          outErr.style.display = "block";
          outTranscript.textContent = "—";
          outAnswer.textContent = "—";
        } else {
          outTranscript.textContent = x.body.transcript != null ? x.body.transcript : "—";
          outAnswer.textContent = x.body.answer != null ? x.body.answer : "—";
          if (x.body.session_id) {
            sessionIdInput.value = x.body.session_id;
            try { localStorage.setItem("voiceStreamSessionId", x.body.session_id); } catch (e2) {}
          }
          if (x.body.audio && x.body.audio.base64) {
            var mime = x.body.audio.content_type || "audio/wav";
            var bin = atob(x.body.audio.base64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var ablob = new Blob([bytes], { type: mime });
            if (player.src) URL.revokeObjectURL(player.src);
            player.src = URL.createObjectURL(ablob);
            player.play().catch(function () {});
          } else {
            if (player.src) URL.revokeObjectURL(player.src);
            player.removeAttribute("src");
            if (x.body.audio_error) {
              outErr.textContent = "TTS: " + JSON.stringify(x.body.audio_error);
              outErr.style.display = "block";
            }
          }
        }
      })
      .catch(function (e) {
        responseMs.textContent = "—";
        timingLogs.textContent = "Request failed before JSON: " + String(e);
        outErr.textContent = String(e);
        outErr.style.display = "block";
      })
      .finally(function () {
        setPill("Ready", "st-ready");
        statusLine.textContent = "Click Start to speak again.";
        btnStart.disabled = false;
      });
  }

  btnStart.onclick = function () {
    if (btnStart.disabled) return;
    outErr.style.display = "none";
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      stream = s;
      var AC = window.AudioContext || window.webkitAudioContext;
      audioCtx = new AC();
      sampleRate = audioCtx.sampleRate;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      proc = audioCtx.createScriptProcessor(4096, 1, 1);
      mute = audioCtx.createGain();
      mute.gain.value = 0;
      sourceNode.connect(proc);
      proc.connect(mute);
      mute.connect(audioCtx.destination);

      buffers = [];
      accumulating = false;
      silenceMs = 0;

      proc.onaudioprocess = function (ev) {
        var input = ev.inputBuffer.getChannelData(0);
        var copy = new Float32Array(input.length);
        copy.set(input);
        var durMs = (input.length / sampleRate) * 1000;
        var loud = rms(input) > RMS_THRESH;

        if (loud) {
          accumulating = true;
          silenceMs = 0;
          buffers.push(copy);
        } else {
          if (accumulating) {
            buffers.push(copy);
            silenceMs += durMs;
            if (silenceMs >= SILENCE_MS) {
              proc.onaudioprocess = null;
              finalizeAndSend();
            }
          }
        }
      };

      setPill("Listening", "st-listen");
      statusLine.textContent = "Speak now — pause ~1.2s when done.";
      btnStart.disabled = true;
      btnCancel.style.display = "block";
    }).catch(function (e) {
      outErr.textContent = "Mic: " + String(e);
      outErr.style.display = "block";
    });
  };

  btnCancel.onclick = function () {
    stopCapture();
    setPill("Ready", "st-ready");
    statusLine.textContent = "Cancelled.";
    btnStart.disabled = false;
    btnCancel.style.display = "none";
  };

  base.addEventListener("change", function () {
    try { localStorage.setItem("voiceStreamBase", base.value); } catch (e) {}
  });
  key.addEventListener("change", function () {
    try { localStorage.setItem("voiceStreamKey", key.value); } catch (e) {}
  });

  btnNewChat.onclick = function () {
    sessionIdInput.value = "";
    try { localStorage.removeItem("voiceStreamSessionId"); } catch (e) {}
  };
})();
  </script>
</body>
</html>`;
