/** OpenAI TTS humanizer simulator — GET /voice/openai-tts/simulator?customer_id=... */

export const OPENAI_TTS_SIMULATOR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenAI TTS humanizer simulator</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #141b26;
      --border: #263246;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #10a37f;
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
    textarea { resize: vertical; font-family: inherit; }
    textarea.tall { min-height: 9rem; }
    textarea.xtall { min-height: 14rem; font-size: 0.8rem; }
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
    .divider { border: none; border-top: 1px solid var(--border); margin: 1rem 0; }
    .mode-label { font-size: 0.8rem; font-weight: 600; color: var(--accent2); margin: 0 0 0.5rem; }
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
    audio { width: 100%; margin-top: 0.5rem; }
    .aside { position: sticky; top: 1rem; }
  </style>
</head>
<body>
  <div class="shell">
    <div class="main">
      <h1>OpenAI TTS humanizer</h1>
      <p class="sub">Plain text → emotional human script (LLM) → OpenAI speech. Tune every prompt and setting on this page.</p>

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
        <p class="hint">API key must match the customer tenant. Used for STT in speech mode only.</p>
      </section>

      <section>
        <h2>Humanizer system prompt</h2>
        <label>Core instructions (editable — injected with style settings below)</label>
        <textarea id="humanizerPrompt" class="xtall"></textarea>
        <button type="button" class="secondary" id="btnResetPrompt">Reset to default prompt (v3)</button>
        <p class="hint" id="promptVersionHint"></p>
      </section>

      <section>
        <h2>Style settings (merged into LLM prompt)</h2>
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
              <option value="rushed_urgent">rushed_urgent</option>
            </select>
          </div>
          <div>
            <label>Warmth</label>
            <select id="warmth">
              <option value="neutral">neutral</option>
              <option value="warm_friendly">warm_friendly</option>
              <option value="very_warm_empathetic">very_warm_empathetic</option>
              <option value="cool_professional">cool_professional</option>
            </select>
          </div>
          <div>
            <label>Formality</label>
            <select id="formality">
              <option value="casual">casual</option>
              <option value="casual_professional">casual_professional</option>
              <option value="formal">formal</option>
              <option value="friendly_expert">friendly_expert</option>
            </select>
          </div>
          <div>
            <label>Fillers / disfluency</label>
            <select id="useFillers">
              <option value="none">none</option>
              <option value="light_natural">light_natural</option>
              <option value="natural_phone">natural_phone</option>
              <option value="heavy_colloquial">heavy_colloquial</option>
            </select>
          </div>
          <div>
            <label>Emphasis style</label>
            <select id="emphasisStyle">
              <option value="understated">understated</option>
              <option value="expressive_balanced">expressive_balanced</option>
              <option value="highly_expressive">highly_expressive</option>
            </select>
          </div>
          <div>
            <label>Scenario</label>
            <select id="scenario">
              <option value="live_phone_call">live_phone_call</option>
              <option value="customer_support">customer_support</option>
              <option value="sales_outreach">sales_outreach</option>
              <option value="friend_catching_up">friend_catching_up</option>
              <option value="calm_reassurance">calm_reassurance</option>
            </select>
          </div>
          <div>
            <label>Reaction level</label>
            <select id="reactionLevel">
              <option value="minimal">minimal</option>
              <option value="believable_not_dramatic">believable_not_dramatic</option>
              <option value="animated">animated</option>
            </select>
          </div>
          <div>
            <label>Pause style</label>
            <select id="pauseStyle">
              <option value="minimal">minimal</option>
              <option value="natural_micro_pauses">natural_micro_pauses</option>
              <option value="dramatic_pauses">dramatic_pauses</option>
            </select>
          </div>
        </div>
        <label>Speaker persona (free text)</label>
        <input type="text" id="speakerPersona" />
        <label>Target language</label>
        <select id="targetLanguage">
          <option value="preserve_input_language">preserve_input_language</option>
          <option value="force_english">force_english</option>
          <option value="force_hindi">force_hindi</option>
          <option value="force_marathi">force_marathi</option>
        </select>
      </section>

      <section>
        <h2>LLM humanizer</h2>
        <div class="grid-2">
          <div>
            <label>Model (blank = tenant default — gpt-4o-mini is fastest)</label>
            <input type="text" id="llmModel" placeholder="gpt-4o-mini" />
          </div>
          <div>
            <label class="chk" style="margin-top:1.4rem">
              <input type="checkbox" id="skipHumanizer" /> Skip humanizer — TTS source text as-is
            </label>
          </div>
        </div>
        <div class="grid-2">
          <div class="slider-row">
            <div class="slider-head"><span>temperature</span><strong id="valTemp">0.85</strong></div>
            <input type="range" id="llmTemperature" />
          </div>
          <div class="slider-row">
            <div class="slider-head"><span>max_tokens</span><strong id="valMaxTok">600</strong></div>
            <input type="range" id="llmMaxTokens" />
          </div>
        </div>
      </section>

      <section>
        <h2>OpenAI TTS settings</h2>
        <div class="grid-2">
          <div>
            <label>TTS model</label>
            <select id="ttsModel">
              <option value="gpt-4o-mini-tts">gpt-4o-mini-tts</option>
              <option value="tts-1-hd">tts-1-hd</option>
              <option value="tts-1">tts-1</option>
            </select>
          </div>
          <div>
            <label>Voice</label>
            <select id="voice"></select>
          </div>
        </div>
        <div class="grid-2">
          <div>
            <label>Response format</label>
            <select id="responseFormat">
              <option value="mp3">mp3</option>
              <option value="wav">wav</option>
              <option value="opus">opus</option>
              <option value="aac">aac</option>
              <option value="flac">flac</option>
              <option value="pcm">pcm</option>
            </select>
          </div>
          <div>
            <label>target_language_code (STT hint, BCP-47)</label>
            <select id="targetLang">
              <option value="en-IN">en-IN</option>
              <option value="hi-IN">hi-IN</option>
              <option value="mr-IN">mr-IN</option>
              <option value="bn-IN">bn-IN</option>
              <option value="ta-IN">ta-IN</option>
              <option value="te-IN">te-IN</option>
            </select>
          </div>
        </div>
        <div class="slider-row">
          <div class="slider-head"><span>speed (tts-1 / tts-1-hd)</span><strong id="valSpeed">1.00</strong></div>
          <input type="range" id="speed" />
        </div>
        <label class="chk">
          <input type="checkbox" id="ttsInstructionsAuto" checked /> Auto-build TTS instructions from style settings (recommended)
        </label>
        <label>Extra TTS instructions (optional — appended when auto-build is on)</label>
        <textarea id="ttsInstructions" class="tall" placeholder="Leave empty to use auto-built delivery instructions from your style settings above."></textarea>
        <p class="hint">gpt-4o-mini-tts follows these instructions closely — style sliders now drive the audio model, not just the LLM.</p>
      </section>

      <section>
        <h2>Input</h2>
        <p class="mode-label">1. Speech → humanize → TTS</p>
        <span class="pill" id="speechPill">Ready</span>
        <p class="hint" id="speechStatus">Record WAV via mic; uses tenant STT provider.</p>
        <button type="button" id="btnStartSpeech">Start speaking</button>
        <button type="button" class="secondary" id="btnCancelSpeech" style="display:none">Cancel</button>
        <hr class="divider" />
        <p class="mode-label">2. Text → humanize → TTS</p>
        <label>Source text</label>
        <textarea id="sourceText" placeholder="Type a normal sentence to emotionalize…"></textarea>
        <button type="button" id="btnSendText">Convert &amp; speak</button>
      </section>

      <section>
        <h2>Output</h2>
        <div><strong>Source</strong><pre id="outSource">—</pre></div>
        <div><strong>Humanized script</strong><pre id="outHumanized">—</pre></div>
        <div><strong>TTS instructions sent</strong><pre id="outTtsInstr">—</pre></div>
        <div><strong>Last API usage</strong><pre id="outUsage">—</pre></div>
        <div><strong>Timings</strong><pre id="outTimings">—</pre></div>
        <audio id="player" controls></audio>
        <div class="err" id="outErr" style="display:none"></div>
      </section>
    </div>

    <aside class="aside">
      <section>
        <h2>Session usage</h2>
        <div class="usage-box" id="sessionUsage">
          <div class="usage-row"><span>Turns</span><span id="suTurns">0</span></div>
          <div class="usage-row"><span>LLM tokens</span><span id="suTokens">0</span></div>
          <div class="usage-row"><span>TTS characters</span><span id="suChars">0</span></div>
          <div class="usage-row"><span>Humanizer $</span><span id="suHumCost">$0.000000</span></div>
          <div class="usage-row"><span>TTS $</span><span id="suTtsCost">$0.000000</span></div>
          <div class="usage-total">Total: <span id="suTotal">$0.000000</span></div>
        </div>
        <button type="button" class="secondary" id="btnResetUsage">Reset session totals</button>
      </section>
    </aside>
  </div>

  <script>
(function () {
  var CONFIG = __SIMULATOR_CONFIG__;
  var CUSTOMER_ID = "__CUSTOMER_ID__";
  var session = { turns: 0, tokens: 0, chars: 0, humCost: 0, ttsCost: 0 };

  var $ = function (id) { return document.getElementById(id); };

  function fmtUsd(n) {
    return "$" + (Number(n) || 0).toFixed(6);
  }

  function updateSessionUsage() {
    $("suTurns").textContent = String(session.turns);
    $("suTokens").textContent = String(session.tokens);
    $("suChars").textContent = String(session.chars);
    $("suHumCost").textContent = fmtUsd(session.humCost);
    $("suTtsCost").textContent = fmtUsd(session.ttsCost);
    $("suTotal").textContent = fmtUsd(session.humCost + session.ttsCost);
  }

  $("customerId").value = CUSTOMER_ID;
  $("base").value = localStorage.getItem("oaiTtsBase") || window.location.origin || "";
  $("apiKey").value = localStorage.getItem("oaiTtsKey") || "";

  function root() {
    var u = ($("base").value || "").trim().replace(/\\/+$/, "");
    return u || window.location.origin;
  }

  function populateVoices() {
    var sel = $("voice");
    sel.innerHTML = "";
    (CONFIG.voices || []).forEach(function (v) {
      var o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      sel.appendChild(o);
    });
    sel.value = CONFIG.voice || "nova";
  }

  function initSlider(id, boundKey, val, labelId, decimals) {
    var el = $(id);
    var b = (CONFIG.slider_bounds || {})[boundKey];
    if (!b) return;
    el.min = b.min;
    el.max = b.max;
    el.step = b.step;
    el.value = val;
    $(labelId).textContent = Number(val).toFixed(decimals != null ? decimals : 2);
  }

  function applyDefaults() {
    $("humanizerPrompt").value = CONFIG.default_humanizer_system_prompt || "";
    var st = CONFIG.default_humanizer_style || {};
    $("emotionIntensity").value = st.emotion_intensity || "high";
    $("speakingPace").value = st.speaking_pace || "natural_conversational";
    $("warmth").value = st.warmth || "warm_friendly";
    $("formality").value = st.formality || "casual_professional";
    $("useFillers").value = st.use_fillers || "light_natural";
    $("emphasisStyle").value = st.emphasis_style || "expressive_balanced";
    $("scenario").value = st.scenario || "live_phone_call";
    $("reactionLevel").value = st.reaction_level || "believable_not_dramatic";
    $("pauseStyle").value = st.pause_style || "natural_micro_pauses";
    $("ttsInstructionsAuto").checked = CONFIG.tts_instructions_auto !== false;
    $("speakerPersona").value = st.speaker_persona || "";
    $("targetLanguage").value = st.target_language || "preserve_input_language";
    $("ttsModel").value = CONFIG.tts_model || "gpt-4o-mini-tts";
    $("responseFormat").value = CONFIG.response_format || "mp3";
    $("ttsInstructions").value = CONFIG.tts_instructions || "";
    initSlider("llmTemperature", "llm_temperature", CONFIG.llm_temperature, "valTemp", 2);
    initSlider("llmMaxTokens", "llm_max_tokens", CONFIG.llm_max_tokens, "valMaxTok", 0);
    initSlider("speed", "speed", CONFIG.speed, "valSpeed", 2);
    populateVoices();
  }

  $("llmTemperature").addEventListener("input", function () {
    $("valTemp").textContent = Number($("llmTemperature").value).toFixed(2);
  });
  $("llmMaxTokens").addEventListener("input", function () {
    $("valMaxTok").textContent = String(Math.round(Number($("llmMaxTokens").value)));
  });
  $("speed").addEventListener("input", function () {
    $("valSpeed").textContent = Number($("speed").value).toFixed(2);
  });

  $("btnResetPrompt").onclick = function () {
    $("humanizerPrompt").value = CONFIG.default_humanizer_system_prompt || "";
    localStorage.setItem("oaiTtsPromptVersion", String(CONFIG.prompt_version || 0));
    $("promptVersionHint").textContent = "Using latest default prompt.";
  };

  function persistUi() {
    localStorage.setItem("oaiTtsBase", root());
    localStorage.setItem("oaiTtsKey", ($("apiKey").value || "").trim());
    localStorage.setItem("oaiTtsHumanizerPrompt", $("humanizerPrompt").value);
    localStorage.setItem("oaiTtsPromptVersion", String(CONFIG.prompt_version || 0));
  }

  applyDefaults();
  var savedVer = localStorage.getItem("oaiTtsPromptVersion");
  var curVer = String(CONFIG.prompt_version || 0);
  if (savedVer === curVer) {
    var savedPrompt = localStorage.getItem("oaiTtsHumanizerPrompt");
    if (savedPrompt) $("humanizerPrompt").value = savedPrompt;
    $("promptVersionHint").textContent = "";
  } else {
    $("promptVersionHint").textContent = "Prompt upgraded to v" + curVer + " — click Reset if you still use an old saved prompt.";
  }

  function formFields() {
    return {
      customer_id: CUSTOMER_ID,
      humanizer_system_prompt: $("humanizerPrompt").value.trim(),
      emotion_intensity: $("emotionIntensity").value,
      speaking_pace: $("speakingPace").value,
      warmth: $("warmth").value,
      formality: $("formality").value,
      use_fillers: $("useFillers").value,
      emphasis_style: $("emphasisStyle").value,
      scenario: $("scenario").value,
      reaction_level: $("reactionLevel").value,
      pause_style: $("pauseStyle").value,
      speaker_persona: $("speakerPersona").value.trim(),
      target_language: $("targetLanguage").value,
      llm_model: $("llmModel").value.trim(),
      llm_temperature: $("llmTemperature").value,
      llm_max_tokens: $("llmMaxTokens").value,
      skip_humanizer: $("skipHumanizer").checked ? "true" : "false",
      tts_model: $("ttsModel").value,
      voice: $("voice").value,
      speed: $("speed").value,
      tts_instructions: $("ttsInstructions").value.trim(),
      tts_instructions_auto: $("ttsInstructionsAuto").checked ? "true" : "false",
      response_format: $("responseFormat").value,
      target_language_code: $("targetLang").value
    };
  }

  function showErr(msg) {
    $("outErr").textContent = msg;
    $("outErr").style.display = "block";
  }
  function clearErr() { $("outErr").style.display = "none"; }

  function playResponse(data) {
    $("outSource").textContent = data.source_text || "—";
    $("outHumanized").textContent = data.humanized_text || "—";
    $("outTtsInstr").textContent = data.tts_instructions_sent || "—";
    var u = data.api_usage || {};
    var h = data.humanizer;
    var t = data.tts || {};
    var lines = [];
    if (h) {
      lines.push("Humanizer LLM: " + (h.model || "—"));
      lines.push("  prompt_tokens: " + (h.prompt_tokens ?? 0));
      lines.push("  completion_tokens: " + (h.completion_tokens ?? 0));
      lines.push("  total_tokens: " + (h.total_tokens ?? 0));
      lines.push("  cost_usd: " + fmtUsd(h.cost_usd));
    } else if (data.skip_humanizer) {
      lines.push("Humanizer: skipped");
    }
    lines.push("TTS: " + (t.model || "—") + " / voice " + (t.voice || "—"));
    lines.push("  input_characters: " + (t.input_characters ?? 0));
    lines.push("  instructions_chars: " + (t.instructions_chars ?? 0));
    lines.push("  cost_usd: " + fmtUsd(t.cost_usd));
    lines.push("TOTAL cost_usd: " + fmtUsd(u.total_cost_usd));
    $("outUsage").textContent = lines.join("\\n");

    var tm = data.timings || {};
    $("outTimings").textContent =
      "STT: " + (tm.stt_ms ?? "—") + " ms\\n" +
      "Humanizer: " + (tm.humanizer_ms ?? "—") + " ms\\n" +
      "TTS: " + (tm.tts_ms ?? "—") + " ms\\n" +
      "Total: " + (tm.total_ms ?? "—") + " ms";

    if (data.audio && data.audio.base64) {
      var mime = data.audio.content_type || "audio/mpeg";
      var blob = b64ToBlob(data.audio.base64, mime);
      $("player").src = URL.createObjectURL(blob);
      $("player").play().catch(function () {});
    }

    session.turns += 1;
    session.tokens += u.humanizer_tokens || 0;
    session.chars += u.tts_characters || 0;
    session.humCost += u.humanizer_cost_usd || 0;
    session.ttsCost += u.tts_cost_usd || 0;
    updateSessionUsage();
  }

  function b64ToBlob(b64, mime) {
    var raw = atob(b64);
    var arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return new Blob([arr], { type: mime });
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
    var res = await fetch(root() + "/voice/openai-tts/simulator/turn", init);
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
    return json;
  }

  $("btnSendText").onclick = async function () {
    clearErr();
    var text = $("sourceText").value.trim();
    if (!text) { showErr("Enter source text"); return; }
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
    session = { turns: 0, tokens: 0, chars: 0, humCost: 0, ttsCost: 0 };
    updateSessionUsage();
  };

  updateSessionUsage();

  // Minimal mic recorder (WAV) — same pattern as voice simulator
  var mediaRec = null;
  var chunks = [];
  var speechActive = false;

  function setSpeechUi(active, status) {
    speechActive = active;
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
      showErr("Microphone not supported in this browser");
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
        var fields = formFields();
        fields.mode = "speech";
        Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
        fd.append("file", blob, "speech.webm");
        try {
          var data = await apiTurn(fd, true);
          playResponse(data);
          setSpeechUi(false, "Done.");
        } catch (e) {
          showErr(e.message || String(e));
          setSpeechUi(false, "Error.");
        }
      };
      mediaRec.start();
      setSpeechUi(true, "Speak now, then click Cancel to finish.");
    } catch (e) {
      showErr(e.message || "Mic permission denied");
    }
  };
})();
  </script>
</body>
</html>`;
