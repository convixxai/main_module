/** ElevenLabs voice simulator — GET /voice/simulator?customer_id=... */

import { buildSimulatorSaveUi } from "./simulator-save-ui";

const ELEVENLABS_SAVE_UI = buildSimulatorSaveUi(
  "elevenlabs",
  "/voice/simulator/save-character"
);

export const VOICE_SIMULATOR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice simulator (ElevenLabs)</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #141b26;
      --border: #263246;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #4d8dff;
      --accent2: #3fb950;
      --warn: #d4a534;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 1rem;
      line-height: 1.45;
    }
    h1 { font-size: 1.25rem; margin: 0 0 0.25rem; }
    .sub { color: var(--muted); font-size: 0.85rem; margin-bottom: 1rem; }
    .shell {
      display: grid;
      gap: 1rem;
      max-width: 72rem;
      margin: 0 auto;
      align-items: start;
    }
    @media (min-width: 1024px) {
      .shell { grid-template-columns: 1fr 19rem; }
    }
    .compat {
      position: sticky;
      top: 1rem;
    }
    .compat-box {
      font-size: 0.76rem;
      line-height: 1.4;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.65rem;
      max-height: calc(100vh - 2rem);
      overflow: auto;
    }
    .compat-ok { color: var(--accent2); }
    .compat-no { color: var(--warn); }
    .compat-row {
      display: flex;
      justify-content: space-between;
      gap: 0.35rem;
      padding: 0.2rem 0;
      border-bottom: 1px solid var(--border);
    }
    .compat-row:last-child { border-bottom: none; }
    .compat-verdict {
      margin: 0.5rem 0;
      padding: 0.45rem 0.5rem;
      border-radius: 6px;
      background: #1a2332;
      border: 1px solid var(--border);
    }
    .grid-2 {
      display: grid;
      gap: 0.55rem;
    }
    @media (min-width: 640px) {
      .grid-2 { grid-template-columns: 1fr 1fr; }
    }
    .grid-sliders {
      display: grid;
      gap: 0.65rem;
    }
    @media (min-width: 640px) {
      .grid-sliders { grid-template-columns: 1fr 1fr; }
    }
    .divider {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1rem 0;
    }
    .mode-label {
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--accent2);
      margin: 0 0 0.5rem;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.9rem 1rem;
      margin-bottom: 1rem;
    }
    section h2 {
      font-size: 0.85rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--muted);
      margin: 0 0 0.75rem;
      font-weight: 600;
    }
    label { display: block; font-size: 0.75rem; color: var(--muted); margin-bottom: 0.15rem; }
    input[type="text"], input[type="password"], input[type="url"], select, textarea {
      width: 100%;
      padding: 0.45rem 0.55rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.88rem;
      margin-bottom: 0.55rem;
    }
    textarea { min-height: 4.5rem; resize: vertical; font-family: inherit; }
    .slider-row { margin-bottom: 0.65rem; }
    .slider-head {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 0.78rem;
      color: var(--muted);
      margin-bottom: 0.15rem;
    }
    .slider-head strong { color: var(--text); font-weight: 600; }
    input[type="range"] { width: 100%; accent-color: var(--accent); }
    .chk { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.55rem; font-size: 0.85rem; }
    .chk input { width: auto; margin: 0; }
    button {
      cursor: pointer;
      border: none;
      border-radius: 8px;
      padding: 0.6rem 1rem;
      font-size: 0.9rem;
      font-weight: 600;
      background: var(--accent);
      color: #fff;
      width: 100%;
    }
    button.secondary { background: #2a3344; color: var(--text); margin-top: 0.4rem; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .pill {
      display: inline-block;
      padding: 0.2rem 0.55rem;
      border-radius: 999px;
      font-size: 0.75rem;
      background: #1e3a2f;
      color: #7dffb3;
      margin-bottom: 0.5rem;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      font-size: 0.78rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.6rem;
      max-height: 8rem;
      overflow: auto;
      margin: 0.35rem 0 0;
    }
    .err { color: var(--err); font-size: 0.85rem; margin-top: 0.5rem; }
    .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.35rem; }
    .badge { font-size: 0.72rem; color: var(--warn); }
    audio { width: 100%; margin-top: 0.5rem; }
  </style>
</head>
<body>
  <button type="button" id="btnSaveCharacter" class="sim-save-float sim-save-pending" title="Save all settings + last output audio by email">Save character profile</button>
  <div class="shell">
    <div class="main">
    <h1>Voice simulator</h1>
    <p class="sub">Connection, ElevenLabs TTS tuning, speech or text input, and 8 kHz playback. Pipeline: STT → RAG → TTS.</p>

    <section>
      <h2>Connection</h2>
      <label>Customer ID (from URL <code>?customer_id=</code>)</label>
      <input type="text" id="customerId" readonly />
      <div class="grid-2">
        <div>
          <label>API base</label>
          <input type="url" id="base" />
        </div>
        <div>
          <label>x-api-key</label>
          <input type="password" id="apiKey" autocomplete="off" />
        </div>
      </div>
      <div class="grid-2">
        <div>
          <label>Agent ID (optional)</label>
          <input type="text" id="agentId" placeholder="uuid" />
        </div>
        <div>
          <label>Session ID (optional, from last reply)</label>
          <input type="text" id="sessionId" placeholder="uuid" />
        </div>
      </div>
      <button type="button" class="secondary" id="btnLoadTenant">Load tenant TTS defaults</button>
      <p class="hint">API key is stored in localStorage only. Customer ID must match the API key tenant.</p>
    </section>

    <section>
      <h2>Additional system prompt</h2>
      <label for="additionalSystemPrompt">Override (highest priority — leave blank to use agent/customer prompt only)</label>
      <textarea id="additionalSystemPrompt" rows="4" placeholder="Optional. When filled, this overrides conflicting agent, customer, and RAG instructions."></textarea>
      <p class="hint">Applied only for this simulator session turn. Empty = no override.</p>
    </section>

    <section>
      <h2>ElevenLabs TTS settings</h2>
      <label>Voice ID</label>
      <input type="text" id="voiceId" />
      <div class="grid-2">
        <div>
          <label>Model ID</label>
          <select id="modelId">
            <option value="eleven_turbo_v2_5">eleven_turbo_v2_5</option>
            <option value="eleven_flash_v2_5">eleven_flash_v2_5</option>
            <option value="eleven_multilingual_v2">eleven_multilingual_v2</option>
            <option value="eleven_v3">eleven_v3</option>
          </select>
        </div>
        <div>
          <label>language_code (TTS API — see panel →)</label>
          <select id="languageCode"></select>
          <p class="hint" id="langCodeHint"></p>
        </div>
      </div>
      <label>target_language_code (RAG / STT hint, BCP-47)</label>
      <select id="targetLang">
        <option value="mr-IN">mr-IN</option>
        <option value="hi-IN">hi-IN</option>
        <option value="en-IN">en-IN</option>
        <option value="bn-IN">bn-IN</option>
        <option value="ta-IN">ta-IN</option>
        <option value="te-IN">te-IN</option>
        <option value="kn-IN">kn-IN</option>
        <option value="gu-IN">gu-IN</option>
        <option value="pa-IN">pa-IN</option>
      </select>

      <div class="grid-sliders">
        <div class="slider-row">
          <div class="slider-head"><span>stability</span><strong id="valStability">0.45</strong></div>
          <input type="range" id="stability" />
        </div>
        <div class="slider-row">
          <div class="slider-head"><span>similarity_boost</span><strong id="valSimilarity">0.85</strong></div>
          <input type="range" id="similarityBoost" />
        </div>
        <div class="slider-row">
          <div class="slider-head"><span>style</span><strong id="valStyle">0.30</strong></div>
          <input type="range" id="style" />
        </div>
        <div class="slider-row">
          <div class="slider-head"><span>speed</span><strong id="valSpeed">0.95</strong> <span class="badge" id="speedCapHint"></span></div>
          <input type="range" id="speed" />
        </div>
      </div>
      <div class="grid-2">
        <label class="chk"><input type="checkbox" id="speakerBoost" checked /> use_speaker_boost</label>
      </div>
    </section>

    <section>
      <h2>Input — choose one</h2>

      <p class="mode-label">1. Speech → speech</p>
      <span class="pill" id="speechPill">Ready</span>
      <p class="hint" id="speechStatus">Click Start, speak, pause ~1.2s (same silence detect as /voice/stream).</p>
      <button type="button" id="btnStartSpeech">Start speaking</button>
      <button type="button" class="secondary" id="btnCancelSpeech" style="display:none">Cancel</button>

      <hr class="divider" />

      <p class="mode-label">2. Text → speech</p>
      <label>Your question</label>
      <textarea id="questionText" placeholder="Type your question…"></textarea>
      <button type="button" id="btnSendText">Send text → RAG → TTS</button>
    </section>

    <section>
      <h2>Output</h2>
      <div><strong>Transcript</strong><pre id="outTranscript">—</pre></div>
      <div><strong>Answer</strong><pre id="outAnswer">—</pre></div>
      <div><strong>Timings</strong><pre id="outTimings">—</pre></div>
      <audio id="player" controls></audio>
      <p class="hint">Playback: mono PCM s16le @ 8 kHz (telephony preview).</p>
      <div class="err" id="outErr" style="display:none"></div>
    </section>
    </div>

    <aside class="compat">
      <section>
        <h2>Model &amp; language</h2>
        <div class="compat-box" id="compatPanel">Loading…</div>
      </section>
    </aside>
  </div>

  <script>
(function () {
  var CONFIG = __SIMULATOR_CONFIG__;
  var CUSTOMER_ID = "__CUSTOMER_ID__";
  var LANG_SUPPORT = CONFIG.language_support || {};
  var lastTurn = null;
  var lastAudioB64 = null;
  var lastAudioMime = "audio/wav";
  var lastAudioFilename = "elevenlabs_output.wav";

  var $ = function (id) { return document.getElementById(id); };

  function modelAcceptsLangParam(modelId) {
    return modelId === "eleven_turbo_v2_5" || modelId === "eleven_flash_v2_5";
  }

  function flashTurboSupportsCode(code) {
    var list = LANG_SUPPORT.flash_turbo_v25_language_codes || [];
    return list.indexOf(code) >= 0;
  }

  function willSendLanguageCode(modelId, code) {
    if (!code || code === "auto") return false;
    return modelAcceptsLangParam(modelId) && flashTurboSupportsCode(code);
  }

  function populateLanguageSelect() {
    var sel = $("languageCode");
    sel.innerHTML = "";
    var auto = document.createElement("option");
    auto.value = "auto";
    auto.textContent = "auto — omit (recommended for mr, bn, te, …)";
    sel.appendChild(auto);
    var indian = LANG_SUPPORT.indian_locales || [];
    indian.forEach(function (row) {
      var o = document.createElement("option");
      o.value = row.code;
      var tag = row.language_code_on_flash_turbo_v25 ? "flash/turbo ✓" : "text only";
      o.textContent = row.code + " — " + row.label + " (" + tag + ")";
      sel.appendChild(o);
    });
  }

  function renderCompatPanel() {
    var modelId = $("modelId").value;
    var code = $("languageCode").value;
    var panel = $("compatPanel");
    var lines = [];
    var modelRow = (LANG_SUPPORT.models || []).find(function (m) { return m.id === modelId; });
    lines.push("<strong>Model:</strong> " + modelId);
    if (modelRow) {
      lines.push(modelRow.accepts_language_code_param
        ? "<span class='compat-ok'>Accepts language_code param</span>"
        : "<span class='compat-no'>Does NOT accept language_code — inferred from text</span>");
      if (modelRow.note) lines.push("<span class='hint'>" + modelRow.note + "</span>");
    }
    lines.push("<hr class='divider' style='margin:0.5rem 0' />");
    lines.push("<strong>Your selection:</strong> " + (code === "auto" ? "auto (omit)" : code));
    var sent = willSendLanguageCode(modelId, code);
    var verdict = sent
      ? "<div class='compat-verdict compat-ok'>API will send language_code: <code>" + code + "</code></div>"
      : "<div class='compat-verdict compat-no'>API will <strong>omit</strong> language_code" +
        (code && code !== "auto" ? " — <code>" + code + "</code> not supported for this model" : "") +
        ". Use native script in text.</div>";
    lines.push(verdict);
    lines.push("<strong>Indian locales</strong>");
    (LANG_SUPPORT.indian_locales || []).forEach(function (row) {
      var onFlash = row.language_code_on_flash_turbo_v25;
      var cls = onFlash ? "compat-ok" : "compat-no";
      var note = onFlash ? "flash/turbo param" : "text only";
      lines.push("<div class='compat-row'><span>" + row.code + " " + row.label + "</span><span class='" + cls + "'>" + note + "</span></div>");
    });
    panel.innerHTML = lines.join("");
    $("langCodeHint").textContent = sent
      ? "Will send language_code to ElevenLabs."
      : (modelAcceptsLangParam(modelId) && code !== "auto"
        ? code + " is not in flash/turbo v2.5 list — using auto-detect from text."
        : "language_code omitted — model detects language from your text.");
  }

  $("customerId").value = CUSTOMER_ID;
  $("base").value = localStorage.getItem("simBase") || window.location.origin || "";
  $("apiKey").value = localStorage.getItem("simKey") || "";
  var sid = localStorage.getItem("simSessionId");
  if (sid) $("sessionId").value = sid;
  var savedOverride = localStorage.getItem("simAdditionalSystemPrompt");
  if (savedOverride) $("additionalSystemPrompt").value = savedOverride;

  function root() {
    var u = ($("base").value || "").trim().replace(/\\/+$/, "");
    return u || window.location.origin;
  }

  function initSlider(id, boundKey, val, labelId) {
    var el = $(id);
    var b = bounds()[boundKey];
    if (!b) return;
    el.min = b.min;
    el.max = boundKey === "speed" ? speedMax() : b.max;
    el.step = b.step;
    el.value = val;
    $(labelId).textContent = Number(val).toFixed(2);
  }

  function applyDefaults(d) {
    $("voiceId").value = d.voice_id || CONFIG.voice_id;
    $("modelId").value = d.model_id || CONFIG.model_id;
    if (d.language_code) $("languageCode").value = d.language_code;
    else $("languageCode").value = "auto";
    var vs = d.voice_settings || CONFIG.voice_settings;
    initSlider("stability", "stability", vs.stability, "valStability");
    initSlider("similarityBoost", "similarity_boost", vs.similarity_boost, "valSimilarity");
    initSlider("style", "style", vs.style, "valStyle");
    initSlider("speed", "speed", vs.speed, "valSpeed");
    $("speakerBoost").checked = vs.use_speaker_boost !== false;
    updateModelOptions();
  }

  function bounds() { return CONFIG.slider_bounds || {}; }

  function speedMax() {
    var m = $("modelId").value;
    return m === "eleven_v3" ? (bounds().speed.maxV3 || 1) : bounds().speed.max;
  }

  function updateModelOptions() {
    updateSpeedCap();
    renderCompatPanel();
  }

  function updateSpeedCap() {
    var cap = speedMax();
    $("speed").max = cap;
    if (Number($("speed").value) > cap) {
      $("speed").value = cap;
      $("valSpeed").textContent = cap.toFixed(2);
    }
    $("speedCapHint").textContent = $("modelId").value === "eleven_v3" ? "(max 1.0 for v3)" : "(max 1.2)";
  }

  ["stability", "similarityBoost", "style", "speed"].forEach(function (id) {
    var labelId = id === "similarityBoost" ? "valSimilarity" : "val" + id.charAt(0).toUpperCase() + id.slice(1);
    $(id).addEventListener("input", function () {
      $(labelId).textContent = Number($(id).value).toFixed(2);
    });
  });
  $("modelId").addEventListener("change", updateModelOptions);
  $("languageCode").addEventListener("change", renderCompatPanel);

  populateLanguageSelect();
  applyDefaults(CONFIG);
  updateModelOptions();

  function ttsFields() {
    return {
      customer_id: CUSTOMER_ID,
      voice_id: $("voiceId").value.trim(),
      model_id: $("modelId").value,
      language_code: $("languageCode").value,
      target_language_code: $("targetLang").value,
      stability: $("stability").value,
      similarity_boost: $("similarityBoost").value,
      style: $("style").value,
      speed: $("speed").value,
      use_speaker_boost: $("speakerBoost").checked ? "true" : "false",
      agent_id: $("agentId").value.trim(),
      session_id: $("sessionId").value.trim(),
      additional_system_prompt: $("additionalSystemPrompt").value.trim()
    };
  }

  function persistAdditionalPrompt() {
    var v = $("additionalSystemPrompt").value;
    if (v.trim()) localStorage.setItem("simAdditionalSystemPrompt", v);
    else localStorage.removeItem("simAdditionalSystemPrompt");
  }

  function pcmBase64ToWavBlob(b64, sampleRate) {
    var raw = atob(b64);
    var pcm = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) pcm[i] = raw.charCodeAt(i);
    var buf = new ArrayBuffer(44 + pcm.length);
    var view = new DataView(buf);
    function wStr(off, s) {
      for (var j = 0; j < s.length; j++) view.setUint8(off + j, s.charCodeAt(j));
    }
    wStr(0, "RIFF");
    view.setUint32(4, 36 + pcm.length, true);
    wStr(8, "WAVE");
    wStr(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    wStr(36, "data");
    view.setUint32(40, pcm.length, true);
    new Uint8Array(buf, 44).set(pcm);
    return new Blob([buf], { type: "audio/wav" });
  }

  function blobToBase64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || "");
        resolve(s.indexOf(",") >= 0 ? s.split(",")[1] : s);
      };
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  }

  function setSaveReady(ready) {
    var b = $("btnSaveCharacter");
    if (!b) return;
    b.classList.toggle("sim-save-ready", !!ready);
    b.classList.toggle("sim-save-pending", !ready);
    b.title = ready
      ? "Save all settings and last output audio by email"
      : "Run a simulation first — then save settings + audio by email";
  }

  function playResponse(data) {
    lastTurn = data;
    $("outTranscript").textContent = data.transcript || "—";
    $("outAnswer").textContent = data.answer || "—";
    var t = data.timings || {};
    $("outTimings").textContent =
      "STT: " + (t.stt_ms ?? "—") + " ms\\n" +
      "RAG: " + (t.ask_ms ?? "—") + " ms\\n" +
      "TTS: " + (t.tts_ms ?? "—") + " ms\\n" +
      "Total: " + (t.total_ms ?? "—") + " ms\\n" +
      "Audio: " + (data.audio && data.audio.duration_ms != null ? data.audio.duration_ms + " ms @ 8 kHz" : "—") +
      (data.tts_settings && data.tts_settings.language_code_sent != null
        ? "\\nlanguage_code sent: " + data.tts_settings.language_code_sent
        : (data.tts_settings ? "\\nlanguage_code sent: (omitted)" : ""));
    if (data.session_id) {
      $("sessionId").value = data.session_id;
      localStorage.setItem("simSessionId", data.session_id);
    }
    if (data.audio && data.audio.base64) {
      var blob = pcmBase64ToWavBlob(data.audio.base64, data.audio.sample_rate || 8000);
      $("player").src = URL.createObjectURL(blob);
      $("player").play().catch(function () {});
      lastAudioMime = "audio/wav";
      lastAudioFilename = "elevenlabs_output.wav";
      blobToBase64(blob).then(function (b64) {
        lastAudioB64 = b64;
        setSaveReady(!!b64);
      }).catch(function () { setSaveReady(false); });
    }
  }

  function showErr(msg) {
    $("outErr").textContent = msg;
    $("outErr").style.display = "block";
  }
  function clearErr() { $("outErr").style.display = "none"; }

  async function apiTurn(body, isMultipart) {
    var key = ($("apiKey").value || "").trim();
    if (!key) throw new Error("Set x-api-key");
    if (!CUSTOMER_ID) throw new Error("Add ?customer_id=UUID to the page URL");
    localStorage.setItem("simBase", root());
    localStorage.setItem("simKey", key);
    persistAdditionalPrompt();

    var headers = { "x-api-key": key };
    var init = { method: "POST", headers: headers, body: body };
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(root() + "/voice/simulator/turn", init);
    var json = await res.json().catch(function () { return { error: res.statusText }; });
    if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
    return json;
  }

  $("btnLoadTenant").addEventListener("click", async function () {
    clearErr();
    var key = ($("apiKey").value || "").trim();
    if (!key) { showErr("Set x-api-key first"); return; }
    try {
      var res = await fetch(root() + "/voice/simulator/tenant-defaults", {
        headers: { "x-api-key": key }
      });
      var json = await res.json();
      if (!res.ok) throw new Error(json.error || "Failed");
      applyDefaults(json);
      if (json.default_language_code) {
        $("targetLang").value = json.default_language_code;
      }
    } catch (e) {
      showErr(e.message || String(e));
    }
  });

  $("btnSendText").addEventListener("click", async function () {
    clearErr();
    $("btnSendText").disabled = true;
    try {
      var fields = ttsFields();
      fields.mode = "text";
      fields.question = $("questionText").value.trim();
      var data = await apiTurn(fields, false);
      playResponse(data);
    } catch (e) {
      showErr(e.message || String(e));
    } finally {
      $("btnSendText").disabled = false;
    }
  });

  // --- Mic capture (same pattern as /voice/stream) ---
  var SILENCE_MS = 1200;
  var RMS_THRESH = 0.018;
  var MIN_SPEECH_SEC = 0.35;
  var stream = null, audioCtx = null, proc = null, sourceNode = null, mute = null;
  var buffers = [], accumulating = false, silenceMs = 0, sampleRate = 48000;

  function setSpeechPill(text, ok) {
    $("speechPill").textContent = text;
    $("speechPill").style.background = ok ? "#1e3a2f" : "#3a2e1e";
    $("speechPill").style.color = ok ? "#7dffb3" : "#ffd27d";
  }

  function concatFloat32(arrs) {
    var n = 0;
    for (var i = 0; i < arrs.length; i++) n += arrs[i].length;
    var out = new Float32Array(n);
    var o = 0;
    for (var j = 0; j < arrs.length; j++) { out.set(arrs[j], o); o += arrs[j].length; }
    return out;
  }

  function encodeWav(samples, rate) {
    var len = samples.length;
    var buf = new ArrayBuffer(44 + len * 2);
    var view = new DataView(buf);
    function wStr(off, s) {
      for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
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
    for (var i = 0; i < len; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: "audio/wav" });
  }

  function rms(chunk) {
    var s = 0;
    for (var i = 0; i < chunk.length; i++) s += chunk[i] * chunk[i];
    return Math.sqrt(s / chunk.length);
  }

  function stopCapture() {
    if (proc) { try { proc.disconnect(); } catch (e) {} proc.onaudioprocess = null; }
    if (mute) { try { mute.disconnect(); } catch (e) {} }
    if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} }
    if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
    stream = null; audioCtx = null; proc = null; sourceNode = null; mute = null;
    buffers = []; accumulating = false; silenceMs = 0;
  }

  async function sendSpeech(wavBlob) {
    clearErr();
    setSpeechPill("Working…", false);
    $("speechStatus").textContent = "STT → RAG → TTS…";
    var fd = new FormData();
    fd.append("file", wavBlob, "speech.wav");
    fd.append("mode", "speech");
    var f = ttsFields();
    Object.keys(f).forEach(function (k) {
      if (f[k] !== undefined && f[k] !== null && String(f[k]).length > 0) {
        fd.append(k, f[k]);
      }
    });
    try {
      var data = await apiTurn(fd, true);
      playResponse(data);
      setSpeechPill("Ready", true);
      $("speechStatus").textContent = "Done. Click Start to speak again.";
    } catch (e) {
      showErr(e.message || String(e));
      setSpeechPill("Error", false);
      $("speechStatus").textContent = e.message || "Failed";
    }
    $("btnStartSpeech").disabled = false;
    $("btnCancelSpeech").style.display = "none";
  }

  function finalizeAndSend() {
    if (buffers.length === 0) return;
    var merged = concatFloat32(buffers);
    buffers = []; accumulating = false; silenceMs = 0;
    if (merged.length / sampleRate < MIN_SPEECH_SEC) {
      $("speechStatus").textContent = "Too short — speak longer.";
      setSpeechPill("Ready", true);
      $("btnStartSpeech").disabled = false;
      $("btnCancelSpeech").style.display = "none";
      stopCapture();
      return;
    }
    stopCapture();
    sendSpeech(encodeWav(merged, sampleRate));
  }

  $("btnStartSpeech").addEventListener("click", async function () {
    clearErr();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showErr("Microphone not supported in this browser");
      return;
    }
    $("btnStartSpeech").disabled = true;
    $("btnCancelSpeech").style.display = "block";
    setSpeechPill("Listening…", false);
    $("speechStatus").textContent = "Speak now…";
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      sampleRate = audioCtx.sampleRate;
      sourceNode = audioCtx.createMediaStreamSource(stream);
      proc = audioCtx.createScriptProcessor(4096, 1, 1);
      mute = audioCtx.createGain();
      mute.gain.value = 0;
      sourceNode.connect(proc);
      proc.connect(mute);
      mute.connect(audioCtx.destination);
      proc.onaudioprocess = function (ev) {
        var chunk = ev.inputBuffer.getChannelData(0);
        var level = rms(chunk);
        if (level >= RMS_THRESH) {
          accumulating = true;
          silenceMs = 0;
          buffers.push(new Float32Array(chunk));
        } else if (accumulating) {
          silenceMs += (chunk.length / sampleRate) * 1000;
          buffers.push(new Float32Array(chunk));
          if (silenceMs >= SILENCE_MS) finalizeAndSend();
        }
      };
    } catch (e) {
      showErr(e.message || "Mic access denied");
      stopCapture();
      $("btnStartSpeech").disabled = false;
      $("btnCancelSpeech").style.display = "none";
      setSpeechPill("Ready", true);
    }
  });

  $("btnCancelSpeech").addEventListener("click", function () {
    stopCapture();
    $("btnStartSpeech").disabled = false;
    $("btnCancelSpeech").style.display = "none";
    setSpeechPill("Ready", true);
    $("speechStatus").textContent = "Cancelled.";
  });

  if (!CUSTOMER_ID) {
    showErr("Missing ?customer_id= in URL. Example: /voice/simulator?customer_id=YOUR-UUID");
  }

  window.__simSaveApiBase = root;
  window.__simSaveHasAudio = function () { return !!lastAudioB64; };
  window.__simSaveCollectPayload = function (characterName, simType) {
    return {
      character_name: characterName,
      simulator_type: simType,
      customer_id: CUSTOMER_ID,
      settings: {
        connection: {
          api_base: root(),
          customer_id: CUSTOMER_ID,
          agent_id: $("agentId").value.trim(),
          session_id: $("sessionId").value.trim(),
          x_api_key: ($("apiKey").value || "").trim(),
        },
        elevenlabs_tts: ttsFields(),
        additional_system_prompt: $("additionalSystemPrompt").value,
        language_ui: {
          language_code: $("languageCode").value,
          target_language_code: $("targetLang").value,
        },
        server_config_snapshot: CONFIG,
      },
      last_output: lastTurn,
      audio_base64: lastAudioB64,
      audio_content_type: lastAudioMime,
      audio_filename: lastAudioFilename,
      _apiKey: ($("apiKey").value || "").trim(),
    };
  };
  setSaveReady(false);
})();
  </script>
${ELEVENLABS_SAVE_UI}
</body>
</html>`;
