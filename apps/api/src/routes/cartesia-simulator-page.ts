/** Cartesia Sonic TTS simulator — GET /voice/cartesia/simulator?customer_id=... */

import { buildSimulatorSaveUi } from "./simulator-save-ui";

const CARTESIA_SAVE_UI = buildSimulatorSaveUi(
  "cartesia_tts",
  "/voice/cartesia/simulator/save-character"
);

export const CARTESIA_SIMULATOR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cartesia Sonic TTS simulator</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #141b26;
      --border: #263246;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #8b5cf6;
      --accent2: #a78bfa;
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
      max-width: 76rem;
      margin: 0 auto;
      align-items: start;
    }
    @media (min-width: 1024px) {
      .shell { grid-template-columns: 1fr 20rem; }
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
    input[type="text"], input[type="password"], input[type="url"], input[type="number"], select, textarea {
      width: 100%;
      padding: 0.45rem 0.55rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.88rem;
      margin-bottom: 0.55rem;
    }
    textarea { resize: vertical; font-family: inherit; min-height: 6rem; }
    .grid-2 { display: grid; gap: 0.55rem; }
    @media (min-width: 640px) { .grid-2 { grid-template-columns: 1fr 1fr; } }
    .grid-3 { display: grid; gap: 0.55rem; }
    @media (min-width: 900px) { .grid-3 { grid-template-columns: 1fr 1fr 1fr; } }
    .slider-row { margin-bottom: 0.65rem; }
    .slider-head {
      display: flex;
      justify-content: space-between;
      font-size: 0.78rem;
      color: var(--muted);
      margin-bottom: 0.15rem;
    }
    .slider-head strong { color: var(--text); }
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
      background: #2d1f4a;
      color: #c4b5fd;
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
      max-height: 10rem;
      overflow: auto;
      margin: 0.35rem 0 0;
    }
    .usage-box {
      font-size: 0.78rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 0.65rem;
    }
    .usage-row {
      display: flex;
      justify-content: space-between;
      gap: 0.5rem;
      padding: 0.25rem 0;
      border-bottom: 1px solid var(--border);
    }
    .usage-row:last-child { border-bottom: none; }
    .usage-total { color: var(--accent2); font-weight: 600; margin-top: 0.5rem; }
    .err { color: var(--err); font-size: 0.85rem; margin-top: 0.5rem; }
    .hint { font-size: 0.75rem; color: var(--muted); margin-top: 0.35rem; }
    .warn { color: var(--warn); font-size: 0.8rem; }
    audio { width: 100%; margin-top: 0.5rem; }
    .aside { position: sticky; top: 1rem; }
    details { margin-bottom: 0.5rem; }
    details summary { cursor: pointer; color: var(--accent2); font-size: 0.85rem; margin-bottom: 0.5rem; }
    a { color: var(--accent2); }
  </style>
</head>
<body>
  <button type="button" id="btnSaveCharacter" class="sim-save-float sim-save-pending" title="Save all settings + last output audio by email">Save character profile</button>
  <div class="shell">
    <div class="main">
      <h1>Cartesia Sonic TTS</h1>
      <p class="sub">Sonic 3.5 — 42 languages, native emotion/speed/volume, sub-90ms latency. <a href="https://docs.cartesia.ai/build-with-cartesia/tts-models/latest" target="_blank" rel="noopener">Docs</a></p>
      <p id="cartesiaWarn" class="warn" style="display:none">CARTESIA_API_KEY is not set on the server — synthesis will fail until configured.</p>

      <section>
        <h2>Connection</h2>
        <label>Customer ID (from URL ?customer_id=)</label>
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
        <p class="hint">Cartesia API key is server-side (CARTESIA_API_KEY). x-api-key is your tenant key for STT/save.</p>
      </section>

      <section>
        <h2>Model &amp; voice</h2>
        <div class="grid-2">
          <div>
            <label>Model</label>
            <select id="modelId"></select>
          </div>
          <div>
            <label>Language (ISO code)</label>
            <select id="language"></select>
          </div>
        </div>
        <label>Voice ID</label>
        <input type="text" id="voiceId" placeholder="Paste Cartesia voice UUID" />
        <p class="hint">Find voices in the <a id="voiceBrowserLink" href="/voice/cartesia/browser" target="_blank" rel="noopener">Cartesia Voice Browser</a>, then copy the voice_id here.</p>
        <label class="chk"><input type="checkbox" id="isPvcVoice" /> Pro voice clone (PVC) — ~1.5 credits/char</label>
      </section>

      <section>
        <h2>Generation config (Sonic 3.5)</h2>
        <div class="grid-3">
          <div class="slider-row">
            <div class="slider-head"><span>Speed</span><strong id="valSpeed">1.00</strong></div>
            <input type="range" id="genSpeed" />
            <p class="hint">0.6 slow → 1.5 fast</p>
          </div>
          <div class="slider-row">
            <div class="slider-head"><span>Volume</span><strong id="valVolume">1.00</strong></div>
            <input type="range" id="genVolume" />
            <p class="hint">0.5 – 2.0</p>
          </div>
          <div>
            <label>Emotion</label>
            <select id="genEmotion"></select>
          </div>
        </div>
      </section>

      <section>
        <h2>Output format</h2>
        <div class="grid-2">
          <div>
            <label>Preset</label>
            <select id="outputPreset"></select>
          </div>
          <div>
            <label>Legacy speed (deprecated)</label>
            <select id="legacySpeed">
              <option value="">— none —</option>
            </select>
          </div>
        </div>
        <label>Pronunciation dictionary ID (optional)</label>
        <input type="text" id="pronunciationDictId" placeholder="dict UUID" />
        <p class="hint">SSML in transcript: &lt;speed ratio="1.2"/&gt;, &lt;volume ratio="0.8"/&gt;, &lt;emotion value="excited"/&gt;, [laughter]</p>
      </section>

      <details>
        <summary>Optional OpenAI humanizer (off by default — Cartesia handles emotion natively)</summary>
        <section style="margin-top:0.5rem;border-style:dashed">
          <label class="chk"><input type="checkbox" id="skipHumanizer" checked /> Skip humanizer (send text directly to Cartesia)</label>
          <label>Humanizer system prompt</label>
          <textarea id="humanizerPrompt" style="min-height:8rem;font-size:0.8rem"></textarea>
          <div class="grid-3">
            <div>
              <label>Emotion intensity</label>
              <select id="emotionIntensity">
                <option value="subtle">subtle</option>
                <option value="moderate">moderate</option>
                <option value="high">high</option>
                <option value="theatrical">theatrical</option>
              </select>
            </div>
            <div>
              <label>Speaking pace</label>
              <select id="speakingPace">
                <option value="slow_thoughtful">slow_thoughtful</option>
                <option value="natural_conversational">natural_conversational</option>
                <option value="energetic">energetic</option>
              </select>
            </div>
            <div>
              <label>LLM temperature</label>
              <input type="number" id="llmTemperature" min="0" max="1.5" step="0.05" />
            </div>
          </div>
        </section>
      </details>

      <section>
        <h2>Input</h2>
        <label>Transcript</label>
        <textarea id="sourceText" placeholder="Hello! Your order number is ORD-48291."></textarea>
        <button type="button" id="btnSendText">Synthesize text</button>
        <hr style="border:none;border-top:1px solid var(--border);margin:1rem 0" />
        <span class="pill" id="speechPill">Ready</span>
        <p class="hint" id="speechStatus">Speech → STT → (optional humanizer) → Cartesia TTS</p>
        <button type="button" id="btnStartSpeech">Record speech</button>
        <button type="button" class="secondary" id="btnCancelSpeech" style="display:none">Stop &amp; send</button>
        <label>STT language hint (BCP-47)</label>
        <input type="text" id="targetLang" placeholder="en-IN" />
      </section>

      <section>
        <h2>Output</h2>
        <p class="err" id="outErr" style="display:none"></p>
        <label>Source text</label>
        <pre id="outSource">—</pre>
        <label>Transcript sent to Cartesia</label>
        <pre id="outTranscript">—</pre>
        <label>API usage (this call)</label>
        <pre id="outUsage">—</pre>
        <label>Speed / latency</label>
        <pre id="outTimings">—</pre>
        <audio id="player" controls></audio>
      </section>
    </div>

    <aside class="aside">
      <section>
        <h2>Session totals</h2>
        <div class="usage-box">
          <div class="usage-row"><span>Turns</span><span id="suTurns">0</span></div>
          <div class="usage-row"><span>TTS characters</span><span id="suChars">0</span></div>
          <div class="usage-row"><span>TTS credits</span><span id="suCredits">0</span></div>
          <div class="usage-row"><span>Humanizer $</span><span id="suHumCost">$0</span></div>
          <div class="usage-row"><span>TTS $ (est.)</span><span id="suTtsCost">$0</span></div>
          <div class="usage-total" id="suTotal">Total: $0</div>
        </div>
        <button type="button" class="secondary" id="btnResetUsage">Reset session</button>
      </section>
      <section>
        <h2>Pricing reference</h2>
        <div class="usage-box" id="pricingBox"></div>
        <p class="hint"><a id="pricingLink" href="#" target="_blank" rel="noopener">Cartesia pricing docs</a></p>
      </section>
    </aside>
  </div>
  <script>
(function () {
  var CONFIG = __SIMULATOR_CONFIG__;
  var CUSTOMER_ID = "__CUSTOMER_ID__";
  var session = { turns: 0, chars: 0, credits: 0, humCost: 0, ttsCost: 0 };
  var lastTurn = null;
  var lastAudioB64 = null;
  var lastAudioMime = "audio/mpeg";
  var lastAudioFilename = "cartesia_output.mp3";

  var $ = function (id) { return document.getElementById(id); };

  function fmtUsd(n) {
    return "$" + (Number(n) || 0).toFixed(6);
  }

  function updateSessionUsage() {
    $("suTurns").textContent = String(session.turns);
    $("suChars").textContent = String(session.chars);
    $("suCredits").textContent = String(Math.round(session.credits));
    $("suHumCost").textContent = fmtUsd(session.humCost);
    $("suTtsCost").textContent = fmtUsd(session.ttsCost);
    $("suTotal").textContent = "Total: " + fmtUsd(session.humCost + session.ttsCost);
  }

  $("customerId").value = CUSTOMER_ID;
  $("base").value = localStorage.getItem("cartesiaBase") || window.location.origin || "";
  $("apiKey").value = localStorage.getItem("cartesiaKey") || "";

  if (!CONFIG.cartesia_configured) {
    $("cartesiaWarn").style.display = "block";
  }

  function root() {
    var u = ($("base").value || "").trim().replace(/\\/+$/, "");
    return u || window.location.origin;
  }

  function fillSelect(id, items, valueKey, labelFn, selected) {
    var sel = $(id);
    sel.innerHTML = "";
    items.forEach(function (item) {
      var o = document.createElement("option");
      o.value = valueKey ? item[valueKey] : item;
      o.textContent = labelFn ? labelFn(item) : String(item);
      sel.appendChild(o);
    });
    if (selected) sel.value = selected;
  }

  function initSlider(id, boundKey, val, labelId) {
    var el = $(id);
    var b = (CONFIG.slider_bounds || {})[boundKey];
    if (!b) return;
    el.min = b.min;
    el.max = b.max;
    el.step = b.step;
    el.value = val;
    $(labelId).textContent = Number(val).toFixed(2);
  }

  function applyDefaults() {
    fillSelect("modelId", CONFIG.models || [], "id", function (m) { return m.label || m.id; }, CONFIG.model_id);
    fillSelect("language", CONFIG.languages || [], "code", function (l) { return l.label + " (" + l.code + ")"; }, CONFIG.language);
    fillSelect("genEmotion", CONFIG.emotions || [], null, null, CONFIG.generation_config.emotion);
    fillSelect("outputPreset", CONFIG.output_presets || [], "id", function (p) { return p.label; }, CONFIG.output_preset);
    fillSelect("legacySpeed", [{ id: "", label: "— none —" }].concat((CONFIG.legacy_speeds || []).map(function (s) { return { id: s, label: s }; })), "id", function (x) { return x.label; }, "");
    $("voiceId").value = CONFIG.voice_id || "";
    var browserPath = (CONFIG.docs || {}).voice_browser || "/voice/cartesia/browser";
    var browserUrl = root() + browserPath + (CUSTOMER_ID ? "?customer_id=" + encodeURIComponent(CUSTOMER_ID) : "");
    $("voiceBrowserLink").href = browserUrl;
    $("pronunciationDictId").value = CONFIG.pronunciation_dict_id || "";
    $("isPvcVoice").checked = !!CONFIG.is_pvc_voice;
    $("skipHumanizer").checked = CONFIG.skip_humanizer !== false;
    $("humanizerPrompt").value = CONFIG.default_humanizer_system_prompt || "";
    var st = CONFIG.default_humanizer_style || {};
    $("emotionIntensity").value = st.emotion_intensity || "high";
    $("speakingPace").value = st.speaking_pace || "natural_conversational";
    $("llmTemperature").value = CONFIG.llm_temperature || 0.85;
    initSlider("genSpeed", "speed", CONFIG.generation_config.speed, "valSpeed");
    initSlider("genVolume", "volume", CONFIG.generation_config.volume, "valVolume");

    var pr = CONFIG.pricing || {};
    $("pricingBox").innerHTML =
      "<div class='usage-row'><span>Standard TTS</span><span>~" + (pr.credits_per_character_standard || 1) + " credit/char</span></div>" +
      "<div class='usage-row'><span>PVC voice</span><span>~" + (pr.credits_per_character_pvc || 1.5) + " credit/char</span></div>" +
      "<div class='usage-row'><span>USD / 1M credits</span><span>" + fmtUsd(pr.usd_per_million_credits || 50) + "</span></div>";
    if (pr.docs_url) $("pricingLink").href = pr.docs_url;
  }

  $("genSpeed").addEventListener("input", function () {
    $("valSpeed").textContent = Number($("genSpeed").value).toFixed(2);
  });
  $("genVolume").addEventListener("input", function () {
    $("valVolume").textContent = Number($("genVolume").value).toFixed(2);
  });

  applyDefaults();

  var urlParams = new URLSearchParams(window.location.search);
  var preVoiceId = urlParams.get("voice_id");
  if (preVoiceId) $("voiceId").value = preVoiceId;

  function formFields() {
    var preset = (CONFIG.output_presets || []).find(function (p) { return p.id === $("outputPreset").value; }) || {};
    var voiceId = $("voiceId").value.trim();
    if (!voiceId) throw new Error("Enter a Cartesia voice_id (use Voice Browser to find one)");
    return {
      customer_id: CUSTOMER_ID,
      model_id: $("modelId").value,
      voice_id: voiceId,
      language: $("language").value,
      gen_speed: $("genSpeed").value,
      gen_volume: $("genVolume").value,
      gen_emotion: $("genEmotion").value,
      output_preset: $("outputPreset").value,
      output_container: preset.container || "",
      output_sample_rate: preset.sample_rate ? String(preset.sample_rate) : "",
      output_encoding: preset.encoding || "",
      output_bit_rate: preset.bit_rate ? String(preset.bit_rate) : "",
      pronunciation_dict_id: $("pronunciationDictId").value.trim(),
      legacy_speed: $("legacySpeed").value,
      is_pvc_voice: $("isPvcVoice").checked ? "true" : "false",
      skip_humanizer: $("skipHumanizer").checked ? "true" : "false",
      humanizer_system_prompt: $("humanizerPrompt").value.trim(),
      emotion_intensity: $("emotionIntensity").value,
      speaking_pace: $("speakingPace").value,
      llm_temperature: $("llmTemperature").value,
      target_language_code: $("targetLang").value.trim()
    };
  }

  function showErr(msg) {
    $("outErr").textContent = msg;
    $("outErr").style.display = "block";
  }
  function clearErr() { $("outErr").style.display = "none"; }

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
  }

  function b64ToBlob(b64, mime) {
    var raw = atob(b64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  function playResponse(data) {
    lastTurn = data;
    $("outSource").textContent = data.source_text || "—";
    $("outTranscript").textContent = data.transcript_sent || "—";
    var u = data.api_usage || {};
    var h = data.humanizer;
    var c = data.cartesia || {};
    var lines = [];
    if (h) {
      lines.push("Humanizer: " + (h.model || "—"));
      lines.push("  tokens: " + (h.total_tokens ?? 0) + "  cost: " + fmtUsd(h.cost_usd));
    } else if (data.skip_humanizer) {
      lines.push("Humanizer: skipped");
    }
    lines.push("Cartesia " + (c.model_id || "—") + " / voice " + (c.voice_id || "—"));
    lines.push("  characters: " + (u.tts_characters ?? 0));
    lines.push("  credits: " + (u.tts_credits ?? 0) + " (" + (u.tts_credits_per_character ?? 1) + "/char)");
    lines.push("  TTS cost (est.): " + fmtUsd(u.tts_cost_usd_estimated));
    lines.push("TOTAL (est.): " + fmtUsd(u.total_cost_usd_estimated));
    $("outUsage").textContent = lines.join("\\n");

    var tm = data.timings || {};
    $("outTimings").textContent =
      "STT: " + (tm.stt_ms ?? "—") + " ms\\n" +
      "Humanizer: " + (tm.humanizer_ms ?? "—") + " ms\\n" +
      "TTS (API): " + (tm.tts_ms ?? "—") + " ms\\n" +
      "TTFB: " + (tm.ttfb_ms ?? "—") + " ms\\n" +
      "Audio ~" + (tm.audio_duration_estimate_sec != null ? Number(tm.audio_duration_estimate_sec).toFixed(1) : "—") + " s\\n" +
      "Total: " + (tm.total_ms ?? "—") + " ms";

    if (data.audio && data.audio.base64) {
      var mime = data.audio.content_type || "audio/mpeg";
      var blob = b64ToBlob(data.audio.base64, mime);
      $("player").src = URL.createObjectURL(blob);
      $("player").play().catch(function () {});
      lastAudioMime = mime;
      var ext = mime.indexOf("wav") >= 0 ? "wav" : "mp3";
      lastAudioFilename = "cartesia_output." + ext;
      blobToBase64(blob).then(function (b64) {
        lastAudioB64 = b64;
        setSaveReady(!!b64);
      }).catch(function () { setSaveReady(false); });
    }

    session.turns += 1;
    session.chars += u.tts_characters || 0;
    session.credits += u.tts_credits || 0;
    session.humCost += u.humanizer_cost_usd || 0;
    session.ttsCost += u.tts_cost_usd_estimated || 0;
    updateSessionUsage();
  }

  function persistUi() {
    localStorage.setItem("cartesiaBase", root());
    localStorage.setItem("cartesiaKey", ($("apiKey").value || "").trim());
  }

  async function apiTurn(body, isMultipart) {
    var key = ($("apiKey").value || "").trim();
    if (!key) throw new Error("Set x-api-key");
    if (!CUSTOMER_ID) throw new Error("Add ?customer_id=UUID to the page URL");
    persistUi();
    var headers = { "x-api-key": key };
    var init = { method: "POST", headers: headers, body: body };
    if (!isMultipart) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    var res = await fetch(root() + "/voice/cartesia/simulator/turn", init);
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
    return json;
  }

  $("btnSendText").onclick = async function () {
    clearErr();
    var text = $("sourceText").value.trim();
    if (!text) { showErr("Enter transcript text"); return; }
    $("btnSendText").disabled = true;
    try {
      var fields = formFields();
      fields.mode = "text";
      fields.text = text;
      var data = await apiTurn(fields, false);
      playResponse(data);
    } catch (e) {
      showErr(e.message || String(e));
    } finally {
      $("btnSendText").disabled = false;
    }
  };

  $("btnResetUsage").onclick = function () {
    session = { turns: 0, chars: 0, credits: 0, humCost: 0, ttsCost: 0 };
    updateSessionUsage();
  };

  updateSessionUsage();

  var mediaRec = null;
  var chunks = [];
  function setSpeechUi(active, status) {
    $("btnStartSpeech").style.display = active ? "none" : "block";
    $("btnCancelSpeech").style.display = active ? "block" : "none";
    $("speechPill").textContent = active ? "Listening…" : "Ready";
    if (status) $("speechStatus").textContent = status;
  }

  $("btnCancelSpeech").onclick = function () {
    if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
    setSpeechUi(false, "Cancelled.");
  };

  $("btnStartSpeech").onclick = async function () {
    clearErr();
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showErr("Microphone not supported");
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunks = [];
      mediaRec = new MediaRecorder(stream);
      mediaRec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
      mediaRec.onstop = async function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        setSpeechUi(false, "Processing…");
        var blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
        var fd = new FormData();
        try {
          var fields = formFields();
          fields.mode = "speech";
          Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
          fd.append("file", blob, "speech.webm");
          var data = await apiTurn(fd, true);
          playResponse(data);
          setSpeechUi(false, "Done.");
        } catch (e) {
          showErr(e.message || String(e));
          setSpeechUi(false, "Error.");
        }
      };
      mediaRec.start();
      setSpeechUi(true, "Speak, then click Stop & send.");
    } catch (e) {
      showErr(e.message || "Mic permission denied");
    }
  };

  window.__simSaveApiBase = root;
  window.__simSaveHasAudio = function () { return !!lastAudioB64; };
  window.__simSaveCollectPayload = function (characterName, simType) {
    return {
      character_name: characterName,
      simulator_type: simType,
      customer_id: CUSTOMER_ID,
      settings: {
        connection: { api_base: root(), customer_id: CUSTOMER_ID },
        cartesia: formFields(),
        session_usage_totals: session,
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
${CARTESIA_SAVE_UI}
</body>
</html>`;
