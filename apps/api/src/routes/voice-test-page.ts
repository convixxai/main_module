/** Temporary STT/TTS test UI — served at GET /voice/test-ui */

export const VOICE_TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Voice STT / TTS test</title>
  <style>
    :root {
      --bg: #0f1419;
      --panel: #1a2332;
      --border: #2d3a4d;
      --text: #e6edf3;
      --muted: #8b9cb3;
      --accent: #3d8bfd;
      --ok: #3fb950;
      --err: #f85149;
    }
    * { box-sizing: border-box; }
    body {
      font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      margin: 0;
      padding: 1.25rem;
      line-height: 1.5;
      max-width: 52rem;
      margin-left: auto;
      margin-right: auto;
    }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.5rem; }
    .sub { color: var(--muted); font-size: 0.875rem; margin-bottom: 1.5rem; }
    section {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 1rem 1.1rem;
      margin-bottom: 1rem;
    }
    h2 { font-size: 1rem; margin: 0 0 0.75rem; color: var(--muted); font-weight: 600; }
    label { display: block; font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem; }
    input[type="text"], input[type="password"], input[type="url"], select, textarea {
      width: 100%;
      padding: 0.5rem 0.6rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.9rem;
      margin-bottom: 0.65rem;
    }
    textarea { min-height: 5rem; resize: vertical; font-family: inherit; }
    .row { display: grid; gap: 0.65rem; }
    @media (min-width: 640px) {
      .row-2 { grid-template-columns: 1fr 1fr; }
    }
    button {
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      border: none;
      padding: 0.55rem 1rem;
      border-radius: 6px;
      font-size: 0.9rem;
      font-weight: 500;
    }
    button:hover { filter: brightness(1.08); }
    button.secondary { background: #30363d; color: var(--text); }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
    pre, .out {
      font-size: 0.78rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 0.65rem;
      overflow: auto;
      max-height: 14rem;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .out.ok { border-color: var(--ok); }
    .out.err { border-color: var(--err); color: #ffb4b0; }
    audio { width: 100%; margin-top: 0.5rem; }
    .hint { font-size: 0.8rem; color: var(--muted); margin-top: 0.35rem; }
  </style>
</head>
<body>
  <h1>Voice API test lab</h1>
  <p class="sub">Temporary page — STT (upload) and TTS (play Sarvam JSON <code>audios[0]</code> base64, or binary).</p>

  <section>
    <h2>Connection</h2>
    <div class="row row-2">
      <div>
        <label for="base">API base URL</label>
        <input type="url" id="base" placeholder="http://localhost:8080" />
      </div>
      <div>
        <label for="key">x-api-key</label>
        <input type="password" id="key" autocomplete="off" placeholder="Customer API key" />
      </div>
    </div>
    <p class="hint">Key is stored only in this browser (localStorage). Use the same origin as this page for simplest CORS (open this page via the API server URL below).</p>
  </section>

  <section>
    <h2>Speech → text (POST /voice/speech-to-text)</h2>
    <div class="row row-2">
      <div>
        <label for="sttFile">Audio file (WAV, MP3, …)</label>
        <input type="file" id="sttFile" accept="audio/*" />
      </div>
      <div>
        <label for="sttMode">mode</label>
        <select id="sttMode">
          <option value="transcribe">transcribe</option>
          <option value="translate">translate</option>
          <option value="verbatim">verbatim</option>
          <option value="translit">translit</option>
          <option value="codemix">codemix</option>
        </select>
      </div>
    </div>
    <label for="sttLang">language_code (optional)</label>
    <input type="text" id="sttLang" placeholder="e.g. hi-IN" />
    <div class="actions">
      <button type="button" id="btnStt">Transcribe</button>
    </div>
    <div id="sttOut" class="out" hidden></div>
  </section>

  <section>
    <h2>Text → speech (POST /voice/text-to-speech)</h2>
    <label for="ttsText">text</label>
    <textarea id="ttsText" placeholder="Type text to synthesize…"></textarea>
    <div class="row row-2">
      <div>
        <label for="ttsLang">target_language_code</label>
        <select id="ttsLang"></select>
      </div>
      <div>
        <label for="ttsSpeaker">speaker</label>
        <input type="text" id="ttsSpeaker" value="ritu" />
      </div>
    </div>
    <div class="row row-2">
      <div>
        <label for="ttsCodec">output_audio_codec</label>
        <select id="ttsCodec">
          <option value="wav">wav</option>
          <option value="mp3">mp3</option>
        </select>
      </div>
      <div>
        <label for="ttsRate">speech_sample_rate</label>
        <select id="ttsRate">
          <option value="24000" selected>24000</option>
          <option value="16000">16000</option>
          <option value="44100">44100</option>
        </select>
      </div>
    </div>
    <div class="actions">
      <button type="button" id="btnTtsJson">Synthesize &amp; play (JSON / base64)</button>
      <button type="button" class="secondary" id="btnTtsBin">Synthesize &amp; play (binary)</button>
    </div>
    <p class="hint">JSON path decodes <code>audios[0]</code> like a normal client. Binary uses <code>?response_format=binary</code>.</p>
    <audio id="player" controls></audio>
    <div id="ttsMeta" class="out" hidden></div>
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
  try {
    base.value = localStorage.getItem("voiceTestBase") || window.location.origin || "";
    key.value = localStorage.getItem("voiceTestKey") || "";
  } catch (e) {}

  function root() {
    var u = (base.value || "").trim().replace(/\\/$/, "");
    return u || window.location.origin;
  }

  function headers() {
    var k = (key.value || "").trim();
    if (!k) throw new Error("Set x-api-key");
    return { "x-api-key": k, "Content-Type": "application/json" };
  }

  function show(el, text, ok) {
    el.hidden = false;
    el.textContent = text;
    el.className = "out " + (ok === false ? "err" : ok === true ? "ok" : "");
  }

  document.getElementById("btnStt").onclick = function () {
    var f = document.getElementById("sttFile").files[0];
    var out = document.getElementById("sttOut");
    if (!f) {
      show(out, "Choose an audio file.", false);
      return;
    }
    var fd = new FormData();
    fd.append("file", f, f.name);
    fd.append("mode", document.getElementById("sttMode").value);
    var lg = document.getElementById("sttLang").value.trim();
    if (lg) fd.append("language_code", lg);

    var url = root() + "/voice/speech-to-text";
    var k = (key.value || "").trim();
    if (!k) {
      show(out, "Set x-api-key.", false);
      return;
    }
    fetch(url, { method: "POST", headers: { "x-api-key": k }, body: fd })
      .then(function (r) {
        return r.json().then(function (j) {
          return { status: r.status, body: j };
        });
      })
      .then(function (x) {
        show(out, JSON.stringify(x.body, null, 2), x.status >= 200 && x.status < 300);
      })
      .catch(function (e) {
        show(out, String(e), false);
      });
  };

  function mimeForCodec(codec) {
    return codec === "mp3" ? "audio/mpeg" : "audio/wav";
  }

  function playBlob(blob) {
    var a = document.getElementById("player");
    if (a.src) URL.revokeObjectURL(a.src);
    a.src = URL.createObjectURL(blob);
    a.play().catch(function () {});
  }

  document.getElementById("btnTtsJson").onclick = function () {
    var meta = document.getElementById("ttsMeta");
    var text = document.getElementById("ttsText").value.trim();
    if (!text) {
      show(meta, "Enter text.", false);
      return;
    }
    var codec = document.getElementById("ttsCodec").value;
    var body = {
      text: text,
      target_language_code: document.getElementById("ttsLang").value,
      speaker: document.getElementById("ttsSpeaker").value.trim() || undefined,
      model: "bulbul:v3",
      speech_sample_rate: document.getElementById("ttsRate").value,
      output_audio_codec: codec
    };
    var url = root() + "/voice/text-to-speech";
    fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) })
      .then(function (r) {
        return r.json().then(function (j) {
          return { status: r.status, body: j };
        });
      })
      .then(function (x) {
        if (x.status !== 200 || !x.body || !x.body.audios || !x.body.audios[0]) {
          show(meta, JSON.stringify(x.body, null, 2), false);
          return;
        }
        var b64 = x.body.audios[0];
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var blob = new Blob([bytes], { type: mimeForCodec(codec) });
        playBlob(blob);
        show(
          meta,
          "request_id: " +
            (x.body.request_id || "—") +
            String.fromCharCode(10) +
            "base64 length: " +
            b64.length +
            String.fromCharCode(10) +
            "Playing decoded bytes (same as Sarvam JSON response).",
          true
        );
      })
      .catch(function (e) {
        show(meta, String(e), false);
      });
  };

  document.getElementById("btnTtsBin").onclick = function () {
    var meta = document.getElementById("ttsMeta");
    var text = document.getElementById("ttsText").value.trim();
    if (!text) {
      show(meta, "Enter text.", false);
      return;
    }
    var codec = document.getElementById("ttsCodec").value;
    var body = {
      text: text,
      target_language_code: document.getElementById("ttsLang").value,
      speaker: document.getElementById("ttsSpeaker").value.trim() || undefined,
      model: "bulbul:v3",
      speech_sample_rate: document.getElementById("ttsRate").value,
      output_audio_codec: codec
    };
    var url = root() + "/voice/text-to-speech?response_format=binary";
    var k = (key.value || "").trim();
    if (!k) {
      show(meta, "Set x-api-key.", false);
      return;
    }
    fetch(url, {
      method: "POST",
      headers: { "x-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
      .then(function (r) {
        if (!r.ok) return r.text().then(function (t) { throw new Error(r.status + " " + t); });
        return r.blob();
      })
      .then(function (blob) {
        playBlob(blob);
        show(meta, "Playing binary response (?response_format=binary). size: " + blob.size + " bytes", true);
      })
      .catch(function (e) {
        show(meta, String(e), false);
      });
  };

  base.addEventListener("change", function () {
    try { localStorage.setItem("voiceTestBase", base.value); } catch (e) {}
  });
  key.addEventListener("change", function () {
    try { localStorage.setItem("voiceTestKey", key.value); } catch (e) {}
  });
})();
  </script>
</body>
</html>`;
