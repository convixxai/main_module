export const QA_TEST_CONSOLE_PAGE_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>QA Test Console</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 920px; margin: 32px auto; padding: 0 16px; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .card { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 16px; margin-bottom: 16px; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  label { font-size: 12px; color: #444; display: block; margin-bottom: 3px; }
  input[type=text], input[type=password], select, textarea { border: 1px solid #d1d5db; border-radius: 6px; padding: 8px 10px; font-size: 13px; width: 100%; }
  textarea { resize: vertical; min-height: 60px; }
  .field { flex: 1; min-width: 180px; }
  button { font-size: 13px; padding: 9px 16px; border-radius: 6px; border: none; cursor: pointer; background: #2563eb; color: #fff; }
  button.secondary { background: #6b7280; }
  button.danger { background: #dc2626; }
  button:disabled { background: #9ca3af; cursor: not-allowed; }
  button.recording { background: #dc2626; }
  .status { font-size: 13px; color: #444; margin-top: 8px; min-height: 18px; }
  .error { color: #b91c1c; font-size: 13px; white-space: pre-wrap; margin-top: 6px; }
  .toggle { display: inline-flex; border: 1px solid #d1d5db; border-radius: 8px; overflow: hidden; }
  .toggle button { background: #fff; color: #333; border-radius: 0; padding: 8px 20px; }
  .toggle button.active { background: #2563eb; color: #fff; }
  .badge { display: inline-block; background: #eef2ff; color: #3730a3; border-radius: 4px; padding: 2px 8px; font-size: 11px; font-weight: 600; margin-left: 6px; }
  table { border-collapse: collapse; width: 100%; margin-top: 10px; font-size: 12px; }
  td, th { border: 1px solid #e5e7eb; padding: 6px 8px; text-align: left; }
  th { background: #f9fafb; }
  .qa { margin-top: 12px; padding: 12px; background: #f9fafb; border-radius: 6px; font-size: 14px; }
  .qa div { margin-bottom: 6px; }
  #answerLive .cursor { display: inline-block; width: 7px; height: 1em; background: #2563eb; vertical-align: middle; animation: blink 1s step-end infinite; }
  @keyframes blink { 50% { opacity: 0; } }
  .stageLog { font-size: 12px; color: #444; margin-top: 8px; max-height: 180px; overflow-y: auto; border: 1px solid #eee; border-radius: 6px; padding: 8px; background: #fcfcfc; }
  .stageLog div { padding: 2px 0; border-bottom: 1px dashed #eee; }
  .stageLog .t { color: #2563eb; font-weight: 600; margin-right: 6px; }
  .hidden { display: none !important; }
  .section-title { font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #333; }
  code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
</style>
</head>
<body>
  <h1>QA Test Console</h1>
  <div class="sub">Runs the same conversational pipeline used in production (runAskPipeline, shared with /ask and the voicebot), in chat or audio mode, with live per-stage timings for every turn.</div>

  <div class="card">
    <div class="section-title">Connection</div>
    <div class="row">
      <div class="field">
        <label>Customer ID</label>
        <input type="text" id="customerId" placeholder="00000000-0000-0000-0000-000000000000" />
      </div>
      <div class="field">
        <label>API Key</label>
        <input type="password" id="apiKey" placeholder="x-api-key" />
      </div>
      <div style="align-self:flex-end;">
        <button id="verifyBtn">Verify</button>
      </div>
    </div>
    <div class="status" id="connStatus">Not verified yet.</div>
    <div class="error" id="connError"></div>
  </div>

  <div class="card hidden" id="mainCard">
    <div class="row" style="justify-content: space-between;">
      <div class="toggle" id="modeToggle">
        <button id="chatModeBtn" class="active">Chat mode</button>
        <button id="audioModeBtn">Audio mode</button>
        <button id="chatVoiceModeBtn">Chat to voice</button>
      </div>
      <div class="row" style="gap:6px;">
        <span id="sessionBadge" class="badge">No session yet</span>
        <button class="secondary" id="newSessionBtn">New session</button>
      </div>
    </div>

    <div class="row" style="margin-top:12px;">
      <div class="field">
        <label>Agent (optional)</label>
        <select id="agentSelect"><option value="">Auto (default agent)</option></select>
      </div>
      <div class="field hidden" id="langField">
        <label>Cartesia language</label>
        <select id="langSelect">
          <option value="en">English</option>
          <option value="hi">Hindi</option>
          <option value="mr">Marathi</option>
          <option value="ta">Tamil</option>
          <option value="te">Telugu</option>
          <option value="bn">Bengali</option>
          <option value="gu">Gujarati</option>
          <option value="kn">Kannada</option>
        </select>
      </div>
      <div class="field hidden" id="voiceField">
        <label>Cartesia voice (filtered by language above)</label>
        <select id="voiceSelect"><option value="">Loading voices...</option></select>
      </div>
      <div class="field hidden" id="modelField">
        <label>Cartesia model</label>
        <select id="modelSelect"><option value="">Loading models...</option></select>
      </div>
      <div class="field hidden" id="normalizationField">
        <label>Normalization (optional)</label>
        <input type="text" id="normalizationInput" placeholder="e.g. en-IN, off" />
      </div>
    </div>
    <div class="hidden" id="normalizationHint" style="font-size:12px;color:#777;margin-top:-4px;margin-bottom:8px;">Overrides how numbers/dates are read, independent of the voice's own language - e.g. a Hindi voice reading digits the English way ("four eight two one" instead of a Hindi number word). Leave blank for Cartesia's own default. Requires the Sonic 3.6 model above.</div>

    <div id="chatPanel" style="margin-top:14px;">
      <label>Message</label>
      <textarea id="chatInput" placeholder="Type a question, like it would come from a real chat turn..."></textarea>
      <div class="row" style="margin-top:8px;">
        <button id="sendChatBtn">Send</button>
      </div>
      <div id="chatVoiceHint" class="hidden" style="font-size:12px;color:#777;margin-top:6px;">Sends your typed message straight through the pipeline (no speech-to-text step), then speaks the answer back using the Cartesia voice and model selected above.</div>
    </div>

    <div id="audioPanel" class="hidden" style="margin-top:14px;">
      <button id="recordBtn">Click to record</button>
      <div style="font-size:12px;color:#777;margin-top:6px;">Records from your microphone, sends it for speech to text, then speaks the answer back using the Cartesia voice and model selected above.</div>
    </div>

    <div class="status" id="turnStatus"></div>
    <div class="error" id="turnError"></div>

    <div id="qa" class="qa hidden">
      <div><b>Transcript / question:</b> <span id="transcriptEl"></span></div>
      <div><b>Answer:</b> <span id="answerLive"></span></div>
    </div>

    <div class="section-title" style="margin-top:14px;">Live pipeline trace (this turn)</div>
    <div class="stageLog" id="stageLog">No turn run yet.</div>

    <div class="section-title" style="margin-top:14px;">Per-iteration timings</div>
    <table id="timingsTable">
      <thead>
        <tr>
          <th>#</th>
          <th>Mode</th>
          <th>Branch / source</th>
          <th>Streaming</th>
          <th>STT ms</th>
          <th>Parallel init ms</th>
          <th>Resolve agent ms</th>
          <th>Vector + history ms</th>
          <th>RAG / LLM ms</th>
          <th>TTS ms</th>
          <th>Total ms</th>
        </tr>
      </thead>
      <tbody id="timingsBody"></tbody>
    </table>
  </div>

<script>
(function () {
  var customerIdEl = document.getElementById("customerId");
  var apiKeyEl = document.getElementById("apiKey");
  var verifyBtn = document.getElementById("verifyBtn");
  var connStatus = document.getElementById("connStatus");
  var connError = document.getElementById("connError");
  var mainCard = document.getElementById("mainCard");

  var chatModeBtn = document.getElementById("chatModeBtn");
  var audioModeBtn = document.getElementById("audioModeBtn");
  var chatVoiceModeBtn = document.getElementById("chatVoiceModeBtn");
  var chatPanel = document.getElementById("chatPanel");
  var audioPanel = document.getElementById("audioPanel");
  var chatVoiceHint = document.getElementById("chatVoiceHint");
  var voiceField = document.getElementById("voiceField");
  var langField = document.getElementById("langField");
  var modelField = document.getElementById("modelField");
  var normalizationField = document.getElementById("normalizationField");
  var normalizationHint = document.getElementById("normalizationHint");
  var voiceSelect = document.getElementById("voiceSelect");
  var agentSelect = document.getElementById("agentSelect");
  var langSelect = document.getElementById("langSelect");
  var modelSelect = document.getElementById("modelSelect");
  var normalizationInput = document.getElementById("normalizationInput");

  var chatInput = document.getElementById("chatInput");
  var sendChatBtn = document.getElementById("sendChatBtn");
  var recordBtn = document.getElementById("recordBtn");

  var sessionBadge = document.getElementById("sessionBadge");
  var newSessionBtn = document.getElementById("newSessionBtn");

  var turnStatus = document.getElementById("turnStatus");
  var turnError = document.getElementById("turnError");
  var qa = document.getElementById("qa");
  var transcriptEl = document.getElementById("transcriptEl");
  var answerLiveEl = document.getElementById("answerLive");
  var stageLog = document.getElementById("stageLog");
  var timingsBody = document.getElementById("timingsBody");

  var mode = "chat";
  var sessionId = null;
  var iterationCount = 0;
  var voicesLoadedForLanguage = null;
  var cartesiaModels = [];

  var isRecording = false;
  var stream, recCtx, sourceNode, proc, buffers = [], sampleRate = 44100;
  var playCtx = null;
  var nextPlayTime = 0;
  var audioChunkQueue = [];
  var audioChunkQueueRunning = false;

  function headers() {
    return { "x-api-key": apiKeyEl.value.trim() };
  }

  function setConnStatus(msg) { connStatus.textContent = msg; }
  function setConnError(msg) { connError.textContent = msg || ""; }
  function setTurnStatus(msg) { turnStatus.textContent = msg; }
  function setTurnError(msg) { turnError.textContent = msg || ""; }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  }

  function logStage(label, elapsedMs) {
    var div = document.createElement("div");
    div.innerHTML = '<span class="t">' + elapsedMs + "ms</span>" + escapeHtml(label);
    stageLog.appendChild(div);
    stageLog.scrollTop = stageLog.scrollHeight;
  }

  function resetStageLog() {
    stageLog.innerHTML = "";
  }

  function addTimingsRow(row) {
    iterationCount++;
    var tr = document.createElement("tr");
    var pt = row.pipeline_timings || {};
    tr.innerHTML =
      "<td>" + iterationCount + "</td>" +
      "<td>" + row.mode + "</td>" +
      "<td>" + (row.source || pt.branch || "-") + "</td>" +
      "<td>" + (row.streaming_used ? "yes" : "no") + "</td>" +
      "<td>" + (row.stt_ms != null ? row.stt_ms : "-") + "</td>" +
      "<td>" + (pt.parallel_init_ms != null ? pt.parallel_init_ms : "-") + "</td>" +
      "<td>" + (pt.resolve_agent_ms != null ? pt.resolve_agent_ms : "-") + "</td>" +
      "<td>" + (pt.vector_history_ms != null ? pt.vector_history_ms : "-") + "</td>" +
      "<td>" + row.ask_ms + "</td>" +
      "<td>" + (row.tts_ms != null && row.tts_ms > 0 ? row.tts_ms : "-") + "</td>" +
      "<td><b>" + row.total_ms + "</b></td>";
    timingsBody.appendChild(tr);
  }

  function setSession(id) {
    sessionId = id || null;
    sessionBadge.textContent = sessionId ? ("Session: " + sessionId.slice(0, 8) + "...") : "No session yet";
  }

  newSessionBtn.addEventListener("click", function () {
    setSession(null);
    setTurnStatus("Session cleared. Next turn starts a fresh session, just like a new caller.");
  });

  function setMode(next) {
    mode = next;
    chatModeBtn.classList.toggle("active", mode === "chat");
    audioModeBtn.classList.toggle("active", mode === "audio");
    chatVoiceModeBtn.classList.toggle("active", mode === "chat_voice");

    var needsAudioOut = mode === "audio" || mode === "chat_voice";
    chatPanel.classList.toggle("hidden", mode === "audio");
    audioPanel.classList.toggle("hidden", mode !== "audio");
    chatVoiceHint.classList.toggle("hidden", mode !== "chat_voice");
    voiceField.classList.toggle("hidden", !needsAudioOut);
    langField.classList.toggle("hidden", !needsAudioOut);
    modelField.classList.toggle("hidden", !needsAudioOut);
    normalizationField.classList.toggle("hidden", !needsAudioOut);
    normalizationHint.classList.toggle("hidden", !needsAudioOut);

    if (needsAudioOut && voicesLoadedForLanguage !== langSelect.value) {
      loadVoices();
    }
  }
  chatModeBtn.addEventListener("click", function () { setMode("chat"); });
  audioModeBtn.addEventListener("click", function () { setMode("audio"); });
  chatVoiceModeBtn.addEventListener("click", function () { setMode("chat_voice"); });
  langSelect.addEventListener("change", function () { loadVoices(); });

  async function loadAgents() {
    try {
      var res = await fetch("/agents", { headers: headers() });
      var data = await res.json();
      if (!res.ok) return;
      agentSelect.innerHTML = '<option value="">Auto (default agent)</option>';
      (data || []).forEach(function (a) {
        var opt = document.createElement("option");
        opt.value = a.id;
        opt.textContent = a.name + (a.is_active === false ? " (inactive)" : "");
        agentSelect.appendChild(opt);
      });
    } catch (e) {
      // agent list is a convenience only, ignore failures
    }
  }

  async function loadVoices() {
    var language = langSelect.value;
    voiceSelect.innerHTML = '<option value="">Loading voices...</option>';
    try {
      var res = await fetch(
        "/voice/cartesia/voices?limit=100&language=" + encodeURIComponent(language),
        { headers: headers() }
      );
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load voices");
      voicesLoadedForLanguage = language;
      var voices = data.voices || [];
      if (voices.length === 0) {
        voiceSelect.innerHTML = '<option value="">No voices found for this language</option>';
        return;
      }
      voiceSelect.innerHTML = "";
      voices.forEach(function (v) {
        var opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name + (v.language ? " (" + v.language + ")" : "");
        voiceSelect.appendChild(opt);
      });
    } catch (e) {
      voiceSelect.innerHTML = '<option value="">Failed to load voices</option>';
      setTurnError("Could not load Cartesia voices: " + (e.message || e));
    }
  }

  function loadModels() {
    modelSelect.innerHTML = "";
    if (cartesiaModels.length === 0) {
      modelSelect.innerHTML = '<option value="">No models available</option>';
      return;
    }
    cartesiaModels.forEach(function (m) {
      var opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.label || m.id;
      if (m.recommended) opt.selected = true;
      modelSelect.appendChild(opt);
    });
  }

  verifyBtn.addEventListener("click", async function () {
    setConnError("");
    var customerId = customerIdEl.value.trim();
    var apiKey = apiKeyEl.value.trim();
    if (!customerId || !apiKey) {
      setConnError("Enter both customer ID and API key.");
      return;
    }
    verifyBtn.disabled = true;
    setConnStatus("Verifying...");
    try {
      var res = await fetch("/qa/test-console/verify?customer_id=" + encodeURIComponent(customerId), {
        headers: headers(),
      });
      var data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setConnStatus(
        "Verified: " + data.customer_name + " (" + data.customer_id + "). Cartesia configured: " + (data.cartesia_configured ? "yes" : "no") + "."
      );
      mainCard.classList.remove("hidden");
      if (!data.cartesia_configured) {
        setTurnStatus("Note: Cartesia is not configured on this server, so audio and chat-to-voice mode's text to speech step will fail.");
      }
      cartesiaModels = data.cartesia_models || [];
      loadModels();
      loadAgents();
      setSession(null);
    } catch (e) {
      setConnStatus("Not verified.");
      setConnError(e.message || String(e));
      mainCard.classList.add("hidden");
    }
    verifyBtn.disabled = false;
  });

  function base64ToArrayBuffer(b64) {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // Chunks arrive over SSE and must be decoded+scheduled strictly in the order
  // the server emitted them. decodeAudioData's completion time depends on each
  // chunk's own size/complexity, not the order it started - firing chunks off
  // without awaiting one before starting the next let a later chunk's decode
  // finish first and read/write the shared nextPlayTime out of turn, so the
  // reply could play out of sequence or with chunks overlapping/cutting each
  // other off. Queuing and awaiting each chunk in turn removes that race.
  function scheduleAudioChunk(base64) {
    audioChunkQueue.push(base64);
    if (!audioChunkQueueRunning) runAudioChunkQueue();
  }

  async function runAudioChunkQueue() {
    audioChunkQueueRunning = true;
    while (audioChunkQueue.length > 0) {
      var base64 = audioChunkQueue.shift();
      try {
        await playOneAudioChunk(base64);
      } catch (e) {
        setTurnError("Playback error: " + (e.message || e));
      }
    }
    audioChunkQueueRunning = false;
  }

  async function playOneAudioChunk(base64) {
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

  async function sendTurn(fd) {
    resetStageLog();
    turnError.textContent = "";
    transcriptEl.textContent = "";
    answerLiveEl.innerHTML = '<span class="cursor"></span>';
    qa.classList.remove("hidden");
    nextPlayTime = 0;
    if (playCtx) { try { playCtx.close(); } catch (e) {} playCtx = null; }
    audioChunkQueue = [];
    audioChunkQueueRunning = false;

    fd.append("customer_id", customerIdEl.value.trim());
    fd.append("mode", mode);
    if (sessionId) fd.append("session_id", sessionId);
    if (agentSelect.value) fd.append("agent_id", agentSelect.value);
    if (mode === "audio" || mode === "chat_voice") {
      fd.append("cartesia_voice_id", voiceSelect.value);
      fd.append("cartesia_language", langSelect.value);
      fd.append("cartesia_model_id", modelSelect.value);
      if (normalizationInput.value.trim()) fd.append("cartesia_normalization", normalizationInput.value.trim());
    }

    setTurnStatus(mode === "audio" ? "Transcribing, then running pipeline..." : "Running pipeline...");

    var row = { mode: mode, stt_ms: null, ask_ms: 0, tts_ms: 0, total_ms: 0, source: null, pipeline_timings: null, streaming_used: false };

    try {
      var res = await fetch("/qa/test-console/turn", {
        method: "POST",
        headers: headers(),
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
        var chunkRead = await reader.read();
        if (chunkRead.done) break;
        buf += decoder.decode(chunkRead.value, { stream: true });
        var parts = buf.split("\\n\\n");
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var parsed = parseSseBlock(parts[i]);
          if (!parsed) continue;

          if (parsed.event === "stt_done") {
            row.stt_ms = parsed.data.stt_ms;
            transcriptEl.textContent = parsed.data.transcript;
            logStage("Speech to text done (" + parsed.data.stt_ms + "ms)", parsed.data.stt_ms);
          } else if (parsed.event === "question_received") {
            transcriptEl.textContent = parsed.data.question;
          } else if (parsed.event === "stage") {
            logStage(parsed.data.step, parsed.data.elapsed_ms);
          } else if (parsed.event === "answer_ready") {
            answerText = parsed.data.answer;
            answerLiveEl.textContent = answerText;
            row.ask_ms = parsed.data.ask_ms;
            row.source = parsed.data.source;
            row.pipeline_timings = parsed.data.pipeline_timings;
            row.streaming_used = !!parsed.data.streaming_used;
            setSession(parsed.data.session_id);
            logStage("Answer ready from RAG / LLM (" + parsed.data.ask_ms + "ms, source=" + parsed.data.source + ")", parsed.data.ask_ms);
          } else if (parsed.event === "first_audio") {
            logStage("First audio chunk ready to play", parsed.data.first_audio_ms);
          } else if (parsed.event === "audio_chunk") {
            scheduleAudioChunk(parsed.data.base64);
          } else if (parsed.event === "tts_error") {
            setTurnError("Text to speech error: " + parsed.data.error);
          } else if (parsed.event === "done") {
            row.total_ms = parsed.data.total_ms;
            row.tts_ms = parsed.data.tts_ms;
            row.pipeline_timings = parsed.data.pipeline_timings || row.pipeline_timings;
            addTimingsRow(row);
            setTurnStatus("Done. Total " + parsed.data.total_ms + "ms.");
          } else if (parsed.event === "error") {
            throw new Error(parsed.data.error || "Turn failed");
          }
        }
      }
    } catch (e) {
      setTurnError(e.message || String(e));
      setTurnStatus("Failed.");
    }
  }

  sendChatBtn.addEventListener("click", function () {
    var text = chatInput.value.trim();
    if (!text) return;
    var fd = new FormData();
    fd.append("question", text);
    chatInput.value = "";
    sendTurn(fd);
  });

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

  async function startRecording() {
    setTurnError("");
    if (!voiceSelect.value) {
      setTurnError("Pick a Cartesia voice first.");
      return;
    }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setTurnError("Microphone not supported in this browser.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      setTurnError("Microphone access denied: " + (e.message || e));
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
    setTurnStatus("Recording, speak now.");
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
    recordBtn.textContent = "Working...";

    var merged = concatFloat32(buffers);
    buffers = [];
    stopCaptureNodes();

    if (merged.length / sampleRate < 0.3) {
      setTurnStatus("Recording too short, try again and speak for at least half a second.");
      recordBtn.disabled = false;
      recordBtn.textContent = "Click to record";
      return;
    }

    var fd = new FormData();
    fd.append("file", encodeWav(merged, sampleRate), "speech.wav");
    await sendTurn(fd);
    recordBtn.disabled = false;
    recordBtn.textContent = "Click to record";
  }

  recordBtn.addEventListener("click", function () {
    if (!isRecording) startRecording();
    else stopRecordingAndSend();
  });

  setMode("chat");
})();
</script>
</body>
</html>
`;
