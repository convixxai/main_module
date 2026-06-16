/** Google Cloud TTS simulator — GET /voice/google-tts/simulator?customer_id=... */

import { buildSimulatorSaveUi } from "./simulator-save-ui";

const GOOGLE_TTS_SAVE_UI = buildSimulatorSaveUi(
  "google_tts",
  "/voice/google-tts/simulator/save-character"
);

export const GOOGLE_TTS_SIMULATOR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Google Cloud TTS simulator</title>
  <style>
    :root {
      --bg: #0b0f14;
      --panel: #141b26;
      --border: #263246;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #4285f4;
      --accent2: #34a853;
      --warn: #fbbc05;
      --err: #ea4335;
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
      background: #1e293b;
      color: #94a3b8;
      margin-bottom: 0.5rem;
    }
    .pill.active {
      background: #1d3557;
      color: #a8dadc;
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
    details { margin-bottom: 0.5rem; }
    details summary { cursor: pointer; color: var(--accent); font-size: 0.85rem; margin-bottom: 0.5rem; }
    a { color: var(--accent); }
    .auth-badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
      margin-top: 0.25rem;
    }
    .auth-badge.unauth { background: #3b1d1d; color: #ff8a8a; }
    .auth-badge.auth { background: #1b3b22; color: #8aff8a; }
  </style>
</head>
<body>
  <button type="button" id="btnSaveCharacter" class="sim-save-float sim-save-pending" title="Save all settings + last output audio by email">Save character profile</button>
  <div class="shell">
    <div class="main">
      <h1>Google Cloud Text-to-Speech Simulator</h1>
      <p class="sub">Dynamic voices (Studio, Journey, Neural2, WaveNet, Standard) with advanced pitch, speed, and audio device effects profiling.</p>

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
            <label>x-api-key (API Key authentication to server)</label>
            <input type="password" id="apiKey" autocomplete="off" />
          </div>
        </div>

        <div style="border-top: 1px solid var(--border); margin: 0.75rem 0; padding-top: 0.75rem;">
          <h3 style="font-size: 0.8rem; margin: 0 0 0.5rem; color: var(--muted)">Google Cloud Project credentials (stored in your browser)</h3>
          <div class="grid-2">
            <div>
              <label>Google OAuth Client ID</label>
              <input type="text" id="gClientId" placeholder="Paste your Google OAuth Client ID" />
            </div>
            <div>
              <label>Google OAuth Client Secret</label>
              <input type="password" id="gClientSecret" placeholder="Paste your Google OAuth Client Secret" autocomplete="off" />
            </div>
          </div>
          <div style="display: flex; gap: 0.55rem; align-items: center; margin-top: 0.25rem;">
            <button type="button" id="btnAuthGoogle" style="width: auto;">Authorize with Google</button>
            <span id="authStatusBadge" class="auth-badge unauth">Not Authorized</span>
          </div>
          <p class="hint">Make sure you have added <strong><span id="redirectUriHint">.../voice/google-tts/oauth/callback</span></strong> as an Authorized Redirect URI in your Google Cloud Console.</p>
        </div>
      </section>

      <section>
        <h2>Model &amp; Voice</h2>
        <div class="grid-3">
          <div>
            <label>Language code</label>
            <select id="langFilter">
              <option value="en-US">English (US)</option>
              <option value="en-IN">English (India)</option>
              <option value="hi-IN">Hindi (India)</option>
              <option value="mr-IN">Marathi (India)</option>
              <option value="ta-IN">Tamil (India)</option>
              <option value="te-IN">Telugu (India)</option>
              <option value="all">— Show all languages —</option>
            </select>
          </div>
          <div>
            <label>Voice model name</label>
            <select id="voiceName"></select>
          </div>
          <div>
            <label>&nbsp;</label>
            <button type="button" class="secondary" id="btnReloadVoices" style="margin-top: 0">Sync voices from project</button>
          </div>
        </div>
        <div id="voiceTypeDisplay" class="pill">Voice tier: Standard / WaveNet ($4.00 / 1M chars)</div>
      </section>

      <section>
        <h2>Audio Configuration (Google Cloud TTS)</h2>
        <div class="chk">
          <label><input type="checkbox" id="ssmlMode" /> Enable SSML (Speech Synthesis Markup Language) Mode</label>
        </div>
        
        <div class="grid-3">
          <div class="slider-row">
            <div class="slider-head"><span>Speaking rate (speed)</span><strong id="valRate">1.00</strong></div>
            <input type="range" id="speakingRate" />
            <p class="hint">0.25 slow → 4.0 fast</p>
          </div>
          <div class="slider-row">
            <div class="slider-head"><span>Pitch shift</span><strong id="valPitch">0.0</strong></div>
            <input type="range" id="pitch" />
            <p class="hint">-20.0 semitones → +20.0</p>
          </div>
          <div class="slider-row">
            <div class="slider-head"><span>Volume gain (dB)</span><strong id="valVolume">0.0</strong></div>
            <input type="range" id="volumeGain" />
            <p class="hint">-10.0 dB → +10.0 dB</p>
          </div>
        </div>

        <div class="grid-3">
          <div>
            <label>Audio encoding</label>
            <select id="audioEncoding">
              <option value="MP3">MP3 (.mp3)</option>
              <option value="LINEAR16">WAV / LINEAR16 (.wav)</option>
              <option value="OGG_OPUS">Ogg Opus (.ogg)</option>
              <option value="MULAW">Mu-law (.mulaw)</option>
              <option value="ALAW">A-law (.alaw)</option>
            </select>
          </div>
          <div>
            <label>Sample rate (Hz - optional)</label>
            <select id="sampleRateHertz">
              <option value="">Auto (recommended)</option>
              <option value="8000">8,000 Hz</option>
              <option value="16000">16,000 Hz</option>
              <option value="22050">22,050 Hz</option>
              <option value="24000">24,000 Hz</option>
              <option value="44100">44,100 Hz</option>
              <option value="48000">48,000 Hz</option>
            </select>
          </div>
          <div>
            <label>Device effects profile (optional)</label>
            <select id="effectsProfileId">
              <option value="">— none —</option>
              <option value="telephony-class-device">Telephony line (optimized for phone calls)</option>
              <option value="headphone-class-device">Headphones (expressive studio sound)</option>
              <option value="wearable-class-device">Wearables (smart watches)</option>
              <option value="handset-class-device">Handsets (smartphone speakers)</option>
              <option value="large-home-entertainment-class-device">Home speakers / TV</option>
            </select>
          </div>
        </div>
      </section>

      <details>
        <summary>Optional OpenAI script humanizer (highly recommended for real-life human voices)</summary>
        <section style="margin-top:0.5rem;border-style:dashed">
          <label class="chk"><input type="checkbox" id="skipHumanizer" checked /> Skip humanizer (send text directly to Google TTS)</label>
          <label>Humanizer system prompt</label>
          <textarea id="humanizerPrompt" class="xtall"></textarea>
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
          <div class="grid-2" style="margin-top:0.5rem">
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
              </select>
            </div>
          </div>
        </section>
      </details>

      <section>
        <h2>Input</h2>
        <p class="mode-label">Mode 1: Text synthesis</p>
        <label>Input text / SSML (SSML requires matching tags e.g. &lt;speak&gt;...&lt;/speak&gt;)</label>
        <textarea id="sourceText" style="min-height: 6rem;" placeholder="Hello! I am a real-life human voice simulation from Google Cloud."></textarea>
        <button type="button" id="btnSendText">Synthesize text</button>

        <hr class="divider" />
        
        <p class="mode-label">Mode 2: Speech to Text (Record audio, then synthesize)</p>
        <span class="pill" id="speechPill">Mic status: Ready</span>
        <button type="button" id="btnStartSpeech">Record microphone speech</button>
        <button type="button" class="secondary" id="btnCancelSpeech" style="display:none">Stop &amp; send</button>
        <label style="margin-top:0.5rem">STT language hint (BCP-47)</label>
        <input type="text" id="targetLang" placeholder="en-US" value="en-US" />
      </section>

      <section>
        <h2>Output</h2>
        <div class="err" id="outErr" style="display:none"></div>
        <label>Source text</label>
        <pre id="outSource">—</pre>
        <label>Script sent to Google TTS</label>
        <pre id="outTranscript">—</pre>
        <label>API usage / payload metrics</label>
        <pre id="outUsage">—</pre>
        <label>Latency / timings</label>
        <pre id="outTimings">—</pre>
        <audio id="player" controls></audio>
      </section>
    </div>

    <aside class="aside">
      <section>
        <h2>Session Totals</h2>
        <div class="usage-box">
          <div class="usage-row"><span>Turns</span><span id="suTurns">0</span></div>
          <div class="usage-row"><span>Google Characters</span><span id="suChars">0</span></div>
          <div class="usage-row"><span>Humanizer $</span><span id="suHumCost">$0.00</span></div>
          <div class="usage-row"><span>Google $ (est.)</span><span id="suTtsCost">$0.00</span></div>
          <div class="usage-total" id="suTotal">Total: $0.00</div>
        </div>
        <button type="button" class="secondary" id="btnResetUsage">Reset session</button>
      </section>

      <section>
        <h2>Pricing references</h2>
        <div class="usage-box">
          <div class="usage-row"><span>Standard / WaveNet</span><span>$4.00 / 1M chars</span></div>
          <div class="usage-row"><span>Neural2</span><span>$16.00 / 1M chars</span></div>
          <div class="usage-row"><span>Chirp / Journey HD</span><span>$30.00 / 1M chars</span></div>
          <div class="usage-row"><span>Studio (Longform)</span><span>$160.00 / 1M chars</span></div>
        </div>
        <p class="hint">Google provides a free tier every month (4M standard/WaveNet chars, 1M neural2/journey chars). <a href="https://cloud.google.com/text-to-speech/pricing" target="_blank" rel="noopener">Official Pricing</a></p>
      </section>
    </aside>
  </div>

  <script>
  (function () {
    var CONFIG = __SIMULATOR_CONFIG__;
    var CUSTOMER_ID = "__CUSTOMER_ID__";
    var session = { turns: 0, chars: 0, humCost: 0, ttsCost: 0 };
    var lastTurn = null;
    var lastAudioB64 = null;
    var lastAudioMime = "audio/mpeg";
    var lastAudioFilename = "google_tts_output.mp3";
    var voicesList = CONFIG.popular_voices || [];

    var $ = function (id) { return document.getElementById(id); };

    function fmtUsd(n) {
      return "$" + (Number(n) || 0).toFixed(6);
    }

    function updateSessionUsage() {
      $("suTurns").textContent = String(session.turns);
      $("suChars").textContent = String(session.chars);
      $("suHumCost").textContent = fmtUsd(session.humCost);
      $("suTtsCost").textContent = fmtUsd(session.ttsCost);
      $("suTotal").textContent = "Total: " + fmtUsd(session.humCost + session.ttsCost);
    }

    // Initialize values from storage
    $("customerId").value = CUSTOMER_ID;
    $("base").value = localStorage.getItem("gTtsBase") || window.location.origin || "";
    $("apiKey").value = localStorage.getItem("gTtsApiKey") || "";
    $("gClientId").value = localStorage.getItem("gTtsClientId") || "";
    $("gClientSecret").value = localStorage.getItem("gTtsClientSecret") || "";

    var redirectUri = window.location.origin + "/voice/google-tts/oauth/callback";
    $("redirectUriHint").textContent = redirectUri;

    function root() {
      return ($("base").value || "").trim().replace(/\\/+$/, "") || window.location.origin;
    }

    function getVoiceTierPriceLabel(name) {
      var lower = name.toLowerCase();
      if (lower.includes("-studio-")) return "Studio ($160.00 / 1M chars)";
      if (lower.includes("-journey-") || lower.includes("-chirp-")) return "Journey / Chirp HD ($30.00 / 1M chars)";
      if (lower.includes("-neural2-") || lower.includes("-polyglot-")) return "Neural2 ($16.00 / 1M chars)";
      if (lower.includes("-wavenet-")) return "WaveNet ($4.00 / 1M chars)";
      return "Standard ($4.00 / 1M chars)";
    }

    function updateVoiceTypeLabel() {
      var name = $("voiceName").value;
      if (name) {
        $("voiceTypeDisplay").textContent = "Voice tier: " + getVoiceTierPriceLabel(name);
      }
    }

    function populateVoices() {
      var filter = $("langFilter").value;
      var sel = $("voiceName");
      var currentVal = sel.value || CONFIG.voice_name || "en-US-Journey-F";
      sel.innerHTML = "";

      var filtered = voicesList.filter(function (v) {
        if (filter === "all") return true;
        return v.languageCodes.some(function (c) {
          return c.toLowerCase().startsWith(filter.toLowerCase());
        });
      });

      // If nothing matches language filter, show all
      if (filtered.length === 0) {
        filtered = voicesList;
      }

      filtered.forEach(function (v) {
        var o = document.createElement("option");
        o.value = v.name;
        o.textContent = v.name + " (" + v.ssmlGender + ")";
        sel.appendChild(o);
      });

      // Try setting back current value
      if (filtered.some(function (v) { return v.name === currentVal; })) {
        sel.value = currentVal;
      } else if (filtered.length > 0) {
        sel.value = filtered[0].name;
      }
      updateVoiceTypeLabel();
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

    function checkAuthStatus() {
      var hasAccess = !!localStorage.getItem("gTtsAccessToken");
      var hasRefresh = !!localStorage.getItem("gTtsRefreshToken");
      
      var badge = $("authStatusBadge");
      if (hasAccess && hasRefresh) {
        badge.textContent = "Authorized (Permanent)";
        badge.className = "auth-badge auth";
      } else if (hasAccess) {
        badge.textContent = "Authorized (Temporary)";
        badge.className = "auth-badge auth";
      } else {
        badge.textContent = "Not Authorized";
        badge.className = "auth-badge unauth";
      }
    }

    function applyDefaults() {
      $("humanizerPrompt").value = CONFIG.default_humanizer_system_prompt || "";
      var st = CONFIG.default_humanizer_style || {};
      $("emotionIntensity").value = st.emotion_intensity || "high";
      $("speakingPace").value = st.speaking_pace || "natural_conversational";
      $("warmth").value = st.warmth || "warm_friendly";
      $("formality").value = st.formality || "casual_professional";
      $("skipHumanizer").checked = CONFIG.skip_humanizer !== false;
      $("ssmlMode").checked = !!CONFIG.ssml_mode;
      $("llmTemperature").value = CONFIG.llm_temperature || 0.85;

      initSlider("speakingRate", "speaking_rate", CONFIG.speaking_rate, "valRate", 2);
      initSlider("pitch", "pitch", CONFIG.pitch, "valPitch", 1);
      initSlider("volumeGain", "volume_gain_db", CONFIG.volume_gain_db, "valVolume", 1);

      populateVoices();
      checkAuthStatus();
    }

    $("speakingRate").oninput = function () { $("valRate").textContent = Number($("speakingRate").value).toFixed(2); };
    $("pitch").oninput = function () { $("valPitch").textContent = Number($("pitch").value).toFixed(1); };
    $("volumeGain").oninput = function () { $("valVolume").textContent = Number($("volumeGain").value).toFixed(1); };
    $("langFilter").onchange = populateVoices;
    $("voiceName").onchange = updateVoiceTypeLabel;

    applyDefaults();

    // Setup postMessage listener for popup window callback
    window.addEventListener("message", function (event) {
      if (event.origin !== window.location.origin) return;
      if (event.data && event.data.type === "google-oauth-code") {
        exchangeCodeForTokens(event.data.code);
      }
    });

    $("btnAuthGoogle").onclick = function () {
      clearErr();
      var cid = $("gClientId").value.trim();
      var secret = $("gClientSecret").value.trim();
      if (!cid || !secret) {
        showErr("Please input both Google Client ID and Google Client Secret before authorizing.");
        return;
      }
      persistCredentials();

      var scope = encodeURIComponent("https://www.googleapis.com/auth/cloud-platform");
      var state = encodeURIComponent(CUSTOMER_ID || "convixx");
      var url = "https://accounts.google.com/o/oauth2/v2/auth" +
                "?client_id=" + encodeURIComponent(cid) +
                "&redirect_uri=" + encodeURIComponent(redirectUri) +
                "&response_type=code" +
                "&scope=" + scope +
                "&access_type=offline" +
                "&prompt=consent" +
                "&state=" + state;

      window.open(url, "google-oauth-popup", "width=600,height=700,status=no,resizable=yes");
    };

    function persistCredentials() {
      localStorage.setItem("gTtsBase", root());
      localStorage.setItem("gTtsApiKey", ($("apiKey").value || "").trim());
      localStorage.setItem("gTtsClientId", $("gClientId").value.trim());
      localStorage.setItem("gTtsClientSecret", $("gClientSecret").value.trim());
    }

    async function exchangeCodeForTokens(code) {
      persistCredentials();
      try {
        var res = await fetch(root() + "/voice/google-tts/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ($("apiKey").value || "").trim()
          },
          body: JSON.stringify({
            code: code,
            client_id: $("gClientId").value.trim(),
            client_secret: $("gClientSecret").value.trim(),
            redirect_uri: redirectUri
          })
        });

        var data = await res.json();
        if (!res.ok) throw new Error(data.error || "Token exchange failed");

        localStorage.setItem("gTtsAccessToken", data.access_token);
        if (data.refresh_token) {
          localStorage.setItem("gTtsRefreshToken", data.refresh_token);
        }
        checkAuthStatus();
        showErr("Successfully authorized with Google! Loading voices...");
        await reloadVoicesList();
      } catch (e) {
        showErr("Authorization failed: " + e.message);
      }
    }

    async function reloadVoicesList() {
      var token = localStorage.getItem("gTtsAccessToken");
      if (!token) {
        showErr("Cannot sync voices: You are not authorized. Please click 'Authorize with Google' first.");
        return;
      }
      $("btnReloadVoices").disabled = true;
      try {
        var res = await fetch(root() + "/voice/google-tts/voices", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": ($("apiKey").value || "").trim()
          },
          body: JSON.stringify({
            access_token: token,
            refresh_token: localStorage.getItem("gTtsRefreshToken") || "",
            client_id: $("gClientId").value.trim(),
            client_secret: $("gClientSecret").value.trim()
          })
        });

        var data = await res.json();
        if (!res.ok) throw new Error(data.error || "Failed loading voices");

        if (data.access_token) {
          localStorage.setItem("gTtsAccessToken", data.access_token);
        }

        if (Array.isArray(data.voices) && data.voices.length > 0) {
          voicesList = data.voices;
          populateVoices();
          showErr("Sync complete. " + voicesList.length + " voices loaded from Google.");
        }
      } catch (e) {
        showErr("Voice sync error: " + e.message);
      } finally {
        $("btnReloadVoices").disabled = false;
        checkAuthStatus();
      }
    }

    $("btnReloadVoices").onclick = reloadVoicesList;

    function formFields() {
      return {
        customer_id: CUSTOMER_ID,
        voice_name: $("voiceName").value,
        language_code: $("voiceName").value ? $("voiceName").value.slice(0, 5) : "en-US",
        speaking_rate: $("speakingRate").value,
        pitch: $("pitch").value,
        volume_gain_db: $("volumeGain").value,
        audio_encoding: $("audioEncoding").value,
        sample_rate_hertz: $("sampleRateHertz").value,
        effects_profile_id: $("effectsProfileId").value ? [ $("effectsProfileId").value ] : [],
        ssml_mode: $("ssmlMode").checked ? "true" : "false",
        skip_humanizer: $("skipHumanizer").checked ? "true" : "false",
        humanizer_system_prompt: $("humanizerPrompt").value.trim(),
        emotion_intensity: $("emotionIntensity").value,
        speaking_pace: $("speakingPace").value,
        warmth: $("warmth").value,
        formality: $("formality").value,
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

    function getAudioMimeType(enc) {
      switch (enc) {
        case "LINEAR16": return "audio/wav";
        case "OGG_OPUS": return "audio/ogg";
        case "MULAW": return "audio/basic";
        case "ALAW": return "audio/basic";
        default: return "audio/mpeg";
      }
    }

    function playResponse(data) {
      lastTurn = data;
      $("outSource").textContent = data.source_text || "—";
      $("outTranscript").textContent = data.transcript_sent || "—";
      
      var u = data.api_usage || {};
      var h = data.humanizer;
      var g = data.google || {};
      
      var lines = [];
      if (h) {
        lines.push("Humanizer LLM: " + (h.model || "—"));
        lines.push("  tokens: " + (h.total_tokens ?? 0) + "  cost: " + fmtUsd(h.cost_usd));
      } else if (data.skip_humanizer) {
        lines.push("Humanizer: skipped");
      }
      lines.push("Google TTS: " + (g.voice_name || "—") + " (" + getVoiceTierPriceLabel(g.voice_name || "") + ")");
      lines.push("  characters: " + (u.tts_characters ?? 0));
      lines.push("  cost (est.): " + fmtUsd(u.tts_cost_usd_estimated));
      lines.push("TOTAL (est.): " + fmtUsd(u.total_cost_usd_estimated));
      $("outUsage").textContent = lines.join("\\n");

      var tm = data.timings || {};
      $("outTimings").textContent =
        "STT: " + (tm.stt_ms ?? "—") + " ms\\n" +
        "Humanizer: " + (tm.humanizer_ms ?? "—") + " ms\\n" +
        "Google Synthesis: " + (tm.tts_ms ?? "—") + " ms\\n" +
        "Total Turn time: " + (tm.total_ms ?? "—") + " ms";

      if (data.audio && data.audio.base64) {
        var mime = data.audio.content_type || "audio/mpeg";
        var blob = b64ToBlob(data.audio.base64, mime);
        $("player").src = URL.createObjectURL(blob);
        $("player").play().catch(function () {});
        lastAudioMime = mime;
        var ext = mime.indexOf("wav") >= 0 ? "wav" : "mp3";
        lastAudioFilename = "google_tts_output." + ext;
        blobToBase64(blob).then(function (b64) {
          lastAudioB64 = b64;
          setSaveReady(!!b64);
        }).catch(function () { setSaveReady(false); });
      }

      session.turns += 1;
      session.chars += u.tts_characters || 0;
      session.humCost += u.humanizer_cost_usd || 0;
      session.ttsCost += u.tts_cost_usd_estimated || 0;
      updateSessionUsage();

      if (data.new_access_token) {
        localStorage.setItem("gTtsAccessToken", data.new_access_token);
        checkAuthStatus();
      }
    }

    async function apiTurn(body, isMultipart) {
      var key = ($("apiKey").value || "").trim();
      var clientId = $("gClientId").value.trim();
      var clientSecret = $("gClientSecret").value.trim();
      var accessToken = localStorage.getItem("gTtsAccessToken") || "";
      var refreshToken = localStorage.getItem("gTtsRefreshToken") || "";

      if (!key) throw new Error("Set x-api-key");
      if (!accessToken) throw new Error("Please Authorize with Google first to set up access token.");
      if (!CUSTOMER_ID) throw new Error("Add ?customer_id=UUID to the page URL");
      
      persistCredentials();
      
      var headers = { "x-api-key": key };
      var init = { method: "POST", headers: headers, body: body };
      
      if (!isMultipart) {
        headers["Content-Type"] = "application/json";
        // Merge tokens & credentials in JSON
        var payload = Object.assign({}, body, {
          access_token: accessToken,
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret
        });
        init.body = JSON.stringify(payload);
      } else {
        // Multipart, append fields to FormData
        body.append("access_token", accessToken);
        body.append("refresh_token", refreshToken);
        body.append("client_id", clientId);
        body.append("client_secret", clientSecret);
      }

      var res = await fetch(root() + "/voice/google-tts/simulator/turn", init);
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
      return json;
    }

    $("btnSendText").onclick = async function () {
      clearErr();
      var text = $("sourceText").value.trim();
      if (!text) { showErr("Enter source text to speak."); return; }
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
      session = { turns: 0, chars: 0, humCost: 0, ttsCost: 0 };
      updateSessionUsage();
    };

    updateSessionUsage();

    // Mic recording
    var mediaRec = null;
    var chunks = [];
    function setSpeechUi(active, status) {
      $("btnStartSpeech").style.display = active ? "none" : "block";
      $("btnCancelSpeech").style.display = active ? "block" : "none";
      $("speechPill").textContent = active ? "Mic status: Recording..." : "Mic status: Ready";
      $("speechPill").className = active ? "pill active" : "pill";
      if (status) $("speechPill").textContent = "Mic status: " + status;
    }

    $("btnCancelSpeech").onclick = function () {
      if (mediaRec && mediaRec.state !== "inactive") mediaRec.stop();
      setSpeechUi(false, "Cancelled.");
    };

    $("btnStartSpeech").onclick = async function () {
      clearErr();
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        showErr("Microphone not supported by browser.");
        return;
      }
      try {
        var stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        chunks = [];
        mediaRec = new MediaRecorder(stream);
        mediaRec.ondataavailable = function (e) { if (e.data.size) chunks.push(e.data); };
        mediaRec.onstop = async function () {
          stream.getTracks().forEach(function (t) { t.stop(); });
          setSpeechUi(false, "Transcribing...");
          var blob = new Blob(chunks, { type: mediaRec.mimeType || "audio/webm" });
          var fd = new FormData();
          try {
            var fields = formFields();
            fields.mode = "speech";
            Object.keys(fields).forEach(function (k) { fd.append(k, fields[k]); });
            fd.append("file", blob, "speech.webm");
            var data = await apiTurn(fd, true);
            playResponse(data);
            setSpeechUi(false, "Ready");
          } catch (e) {
            showErr(e.message || String(e));
            setSpeechUi(false, "Error");
          }
        };
        mediaRec.start();
        setSpeechUi(true, "Recording... Click Stop when finished.");
      } catch (e) {
        showErr(e.message || "Microphone access denied.");
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
          google: formFields(),
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
  ${GOOGLE_TTS_SAVE_UI}
</body>
</html>`;
