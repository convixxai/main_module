/** ElevenLabs voice browser — GET /voice/elevenlabs/browser */

export const ELEVENLABS_VOICE_BROWSER_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ElevenLabs Voice Browser</title>
  <style>
    :root {
      --bg: #0a0e14;
      --panel: #121a24;
      --card: #161f2c;
      --border: #2a3548;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #6c5ce7;
      --ok: #3fb950;
      --warn: #d4a534;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, Segoe UI, Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.4;
    }
    .top {
      padding: 1rem 1.25rem;
      border-bottom: 1px solid var(--border);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 1.2rem; }
    .sub { margin: 0.25rem 0 0; font-size: 0.85rem; color: var(--muted); }
    .shell {
      display: grid;
      gap: 0;
      min-height: calc(100vh - 4.5rem);
    }
    @media (min-width: 900px) {
      .shell { grid-template-columns: 17rem 1fr; }
    }
    .filters {
      padding: 1rem;
      border-right: 1px solid var(--border);
      background: var(--panel);
    }
    .filters label {
      display: block;
      font-size: 0.72rem;
      color: var(--muted);
      margin: 0.5rem 0 0.15rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .filters input, .filters select {
      width: 100%;
      padding: 0.4rem 0.5rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg);
      color: var(--text);
      font-size: 0.85rem;
    }
    .filters button {
      width: 100%;
      margin-top: 0.75rem;
      padding: 0.55rem;
      border: none;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      cursor: pointer;
    }
    .filters button.secondary {
      background: #2a3344;
      color: var(--text);
      margin-top: 0.4rem;
    }
    .chk { display: flex; align-items: center; gap: 0.35rem; font-size: 0.8rem; margin-top: 0.5rem; }
    .chk input { width: auto; }
    .main { padding: 1rem; overflow: auto; }
    .stats { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.75rem; }
    .grid {
      display: grid;
      gap: 0.75rem;
      grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
    }
    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 0.85rem;
      display: flex;
      flex-direction: column;
      gap: 0.45rem;
    }
    .card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
    .card h3 { margin: 0; font-size: 0.95rem; }
    .card .vid { font-size: 0.7rem; color: var(--muted); word-break: break-all; font-family: ui-monospace, monospace; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.25rem; }
    .chip {
      font-size: 0.68rem;
      padding: 0.12rem 0.4rem;
      border-radius: 999px;
      background: #1e2836;
      color: var(--muted);
      border: 1px solid var(--border);
    }
    .chip.lang { color: #9fd4ff; }
    .actions { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: auto; }
    .actions button {
      flex: 1;
      min-width: 4.5rem;
      padding: 0.35rem 0.5rem;
      font-size: 0.75rem;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: #222c3a;
      color: var(--text);
      cursor: pointer;
    }
    .actions button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
    .detail {
      margin-top: 1rem;
      padding: 1rem;
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
    }
    .detail h2 { margin: 0 0 0.5rem; font-size: 1rem; }
    .err { color: #f85149; font-size: 0.85rem; margin-top: 0.5rem; }
    audio { width: 100%; margin-top: 0.5rem; }
    .empty { color: var(--muted); padding: 2rem; text-align: center; }
  </style>
</head>
<body>
  <header class="top">
    <h1>ElevenLabs Voice Browser</h1>
    <p class="sub">Search voices by language, accent, and labels — play ElevenLabs samples or generate a custom preview. No customer account required.</p>
  </header>

  <div class="shell">
    <aside class="filters">
      <label for="base">API base</label>
      <input type="url" id="base" />

      <label for="apiKey">x-api-key</label>
      <input type="password" id="apiKey" autocomplete="off" />

      <label for="search">Search name / id</label>
      <input type="text" id="search" placeholder="Rachel, indian, …" />

      <label for="langFilter">Language (BCP-47)</label>
      <select id="langFilter">
        <option value="">All languages</option>
        <option value="en">en / en-US</option>
        <option value="hi-IN">hi-IN Hindi</option>
        <option value="mr-IN">mr-IN Marathi</option>
        <option value="ta-IN">ta-IN Tamil</option>
        <option value="te-IN">te-IN Telugu</option>
        <option value="bn-IN">bn-IN Bengali</option>
        <option value="gu-IN">gu-IN Gujarati</option>
        <option value="kn-IN">kn-IN Kannada</option>
        <option value="ml-IN">ml-IN Malayalam</option>
        <option value="pa-IN">pa-IN Punjabi</option>
        <option value="fr">fr French</option>
        <option value="de">de German</option>
        <option value="es">es Spanish</option>
        <option value="ja">ja Japanese</option>
      </select>

      <label for="accentFilter">Accent (label)</label>
      <select id="accentFilter">
        <option value="">Any accent</option>
      </select>

      <label for="genderFilter">Gender</label>
      <select id="genderFilter">
        <option value="">Any</option>
        <option value="female">female</option>
        <option value="male">male</option>
        <option value="neutral">neutral</option>
      </select>

      <label for="categoryFilter">Category</label>
      <select id="categoryFilter">
        <option value="">Any</option>
        <option value="premade">premade</option>
        <option value="cloned">cloned</option>
        <option value="professional">professional</option>
        <option value="generated">generated</option>
      </select>

      <label for="modelFilter">Supports model</label>
      <select id="modelFilter">
        <option value="">Any model</option>
        <option value="eleven_flash_v2_5">eleven_flash_v2_5</option>
        <option value="eleven_turbo_v2_5">eleven_turbo_v2_5</option>
        <option value="eleven_multilingual_v2">eleven_multilingual_v2</option>
        <option value="eleven_v3">eleven_v3</option>
      </select>

      <label class="chk"><input type="checkbox" id="showLegacy" /> Show legacy voices</label>

      <button type="button" id="btnLoad">Load / refresh voices</button>
      <button type="button" class="secondary" id="btnClear">Clear filters</button>
      <p class="err" id="filterErr" style="display:none"></p>
    </aside>

    <main class="main">
      <div class="stats" id="stats">Load voices to begin.</div>
      <div class="grid" id="voiceGrid"></div>
      <div class="detail" id="detailPanel" style="display:none">
        <h2 id="detailName">—</h2>
        <p class="vid" id="detailId">—</p>
        <div class="chips" id="detailChips"></div>
        <p id="detailDesc" style="font-size:0.85rem;color:var(--muted)"></p>
        <label>Preview model</label>
        <select id="previewModel">
          <option value="eleven_flash_v2_5">eleven_flash_v2_5</option>
          <option value="eleven_turbo_v2_5">eleven_turbo_v2_5</option>
          <option value="eleven_multilingual_v2">eleven_multilingual_v2</option>
          <option value="eleven_v3">eleven_v3</option>
        </select>
        <label>Custom preview text</label>
        <textarea id="previewText" rows="2" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:0.4rem;font-family:inherit"></textarea>
        <div class="actions" style="margin-top:0.5rem">
          <button type="button" class="primary" id="btnCustomPreview">Generate preview</button>
          <button type="button" id="btnCopyId">Copy voice_id</button>
        </div>
        <audio id="player" controls></audio>
      </div>
    </main>
  </div>

  <script>
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var allVoices = [];
  var selectedVoice = null;
  var sampleByLang = {
    en: "Hello! This is how I sound on a natural phone conversation.",
    hi: "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
    mr: "नमस्कार! आजचा दिवस कसा आहे?",
    ta: "வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?",
    te: "నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?",
    bn: "নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
  };

  $("base").value = localStorage.getItem("elVoiceBase") || window.location.origin || "";
  $("apiKey").value = localStorage.getItem("elVoiceKey") || "";

  function root() {
    var u = ($("base").value || "").trim().replace(/\\/+$/, "");
    return u || window.location.origin;
  }

  function apiKey() {
    return ($("apiKey").value || "").trim();
  }

  function showErr(msg) {
    var el = $("filterErr");
    el.textContent = msg;
    el.style.display = msg ? "block" : "none";
  }

  function labelOf(v, k) {
    var labels = v.labels || {};
    var x = labels[k];
    return typeof x === "string" ? x.trim() : "";
  }

  function verifiedLangs(v) {
    var out = [];
    var vl = v.verified_languages;
    if (!Array.isArray(vl)) return out;
    vl.forEach(function (e) {
      if (!e) return;
      var loc = e.locale || e.language || "";
      if (loc) out.push(String(loc));
    });
    return out;
  }

  function matchesSearch(v, q) {
    if (!q) return true;
    var s = q.toLowerCase();
    var name = (v.name || "").toLowerCase();
    var id = (v.voice_id || "").toLowerCase();
    var desc = (v.description || "").toLowerCase();
    return name.indexOf(s) >= 0 || id.indexOf(s) >= 0 || desc.indexOf(s) >= 0;
  }

  function matchesAccent(v, accent) {
    if (!accent) return true;
    return labelOf(v, "accent").toLowerCase() === accent.toLowerCase();
  }

  function matchesGender(v, g) {
    if (!g) return true;
    return labelOf(v, "gender").toLowerCase() === g.toLowerCase();
  }

  function matchesCategory(v, c) {
    if (!c) return true;
    return String(v.category || "").toLowerCase() === c.toLowerCase();
  }

  function clientFilter(list) {
    var q = $("search").value.trim();
    var accent = $("accentFilter").value;
    var gender = $("genderFilter").value;
    var cat = $("categoryFilter").value;
    return list.filter(function (v) {
      return matchesSearch(v, q) && matchesAccent(v, accent) &&
        matchesGender(v, gender) && matchesCategory(v, cat);
    });
  }

  function rebuildAccentOptions() {
    var sel = $("accentFilter");
    var cur = sel.value;
    var accents = {};
    allVoices.forEach(function (v) {
      var a = labelOf(v, "accent");
      if (a) accents[a.toLowerCase()] = a;
    });
    sel.innerHTML = '<option value="">Any accent</option>';
    Object.keys(accents).sort().forEach(function (k) {
      var o = document.createElement("option");
      o.value = accents[k];
      o.textContent = accents[k];
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  function renderGrid(list) {
    var grid = $("voiceGrid");
    grid.innerHTML = "";
    if (!list.length) {
      grid.innerHTML = '<div class="empty">No voices match filters.</div>';
      return;
    }
    list.forEach(function (v) {
      var card = document.createElement("div");
      card.className = "card" + (selectedVoice && selectedVoice.voice_id === v.voice_id ? " selected" : "");
      var langs = verifiedLangs(v).slice(0, 4);
      var chips = "";
      if (labelOf(v, "accent")) chips += '<span class="chip">' + labelOf(v, "accent") + '</span>';
      if (labelOf(v, "gender")) chips += '<span class="chip">' + labelOf(v, "gender") + '</span>';
      if (labelOf(v, "age")) chips += '<span class="chip">' + labelOf(v, "age") + '</span>';
      langs.forEach(function (l) { chips += '<span class="chip lang">' + l + '</span>'; });
      card.innerHTML =
        '<h3>' + (v.name || "Unnamed") + '</h3>' +
        '<div class="vid">' + (v.voice_id || "") + '</div>' +
        '<div class="chips">' + chips + '</div>' +
        '<div class="actions">' +
        '<button type="button" data-act="select">Select</button>' +
        (v.preview_url ? '<button type="button" data-act="el-sample">EL sample</button>' : '') +
        '<button type="button" data-act="custom" class="primary">Preview</button>' +
        '</div>';
      card.querySelector('[data-act="select"]').onclick = function () { selectVoice(v); };
      if (v.preview_url) {
        card.querySelector('[data-act="el-sample"]').onclick = function () {
          $("player").src = v.preview_url;
          $("player").play().catch(function () {});
        };
      }
      card.querySelector('[data-act="custom"]').onclick = function () {
        selectVoice(v);
        generateCustomPreview();
      };
      grid.appendChild(card);
    });
  }

  function selectVoice(v) {
    selectedVoice = v;
    $("detailPanel").style.display = "block";
    $("detailName").textContent = v.name || "Voice";
    $("detailId").textContent = v.voice_id || "";
    var chips = $("detailChips");
    chips.innerHTML = "";
    ["accent", "gender", "age", "language", "use_case", "descriptive"].forEach(function (k) {
      var val = labelOf(v, k);
      if (val) {
        var s = document.createElement("span");
        s.className = "chip";
        s.textContent = k + ": " + val;
        chips.appendChild(s);
      }
    });
    verifiedLangs(v).forEach(function (l) {
      var s = document.createElement("span");
      s.className = "chip lang";
      s.textContent = l;
      chips.appendChild(s);
    });
    $("detailDesc").textContent = v.description || "";
    var lang = $("langFilter").value || "en";
    var primary = lang.split("-")[0] || "en";
    $("previewText").value = sampleByLang[primary] || sampleByLang.en;
    renderGrid(clientFilter(allVoices));
  }

  async function fetchAllVoices() {
    var key = apiKey();
    if (!key) throw new Error("Enter x-api-key");
    localStorage.setItem("elVoiceBase", root());
    localStorage.setItem("elVoiceKey", key);
    var voices = [];
    var token = "";
    var lang = $("langFilter").value.trim();
    var model = $("modelFilter").value.trim();
    var legacy = $("showLegacy").checked;
    for (var page = 0; page < 20; page++) {
      var qs = new URLSearchParams();
      qs.set("page_size", "100");
      if (legacy) qs.set("show_legacy", "true");
      if (token) qs.set("next_page_token", token);
      if (lang) qs.set("language", lang);
      if (model) qs.set("supports_model", model);
      var res = await fetch(root() + "/voice/elevenlabs/voices?" + qs.toString(), {
        headers: { "x-api-key": key }
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
      if (Array.isArray(json.voices)) voices = voices.concat(json.voices);
      if (!json.has_more || !json.next_page_token) break;
      token = json.next_page_token;
    }
    return voices;
  }

  async function loadVoices() {
    showErr("");
    $("stats").textContent = "Loading…";
    try {
      allVoices = await fetchAllVoices();
      rebuildAccentOptions();
      var shown = clientFilter(allVoices);
      $("stats").textContent = shown.length + " shown · " + allVoices.length + " loaded";
      renderGrid(shown);
    } catch (e) {
      showErr(e.message || String(e));
      $("stats").textContent = "Load failed";
    }
  }

  async function generateCustomPreview() {
    if (!selectedVoice) return;
    var key = apiKey();
    if (!key) { showErr("Enter x-api-key"); return; }
    var lang = $("langFilter").value.trim();
    var primary = lang ? lang.split("-")[0] : "auto";
    var body = {
      voice_id: selectedVoice.voice_id,
      model_id: $("previewModel").value,
      text: $("previewText").value.trim() || undefined,
      language_code: primary === "auto" || !primary ? "auto" : primary
    };
    try {
      var res = await fetch(root() + "/voice/elevenlabs/preview", {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        throw new Error(err.error || ("HTTP " + res.status));
      }
      var blob = await res.blob();
      $("player").src = URL.createObjectURL(blob);
      $("player").play().catch(function () {});
    } catch (e) {
      showErr(e.message || String(e));
    }
  }

  $("btnLoad").onclick = loadVoices;
  $("btnClear").onclick = function () {
    $("search").value = "";
    $("accentFilter").value = "";
    $("genderFilter").value = "";
    $("categoryFilter").value = "";
    renderGrid(clientFilter(allVoices));
    $("stats").textContent = clientFilter(allVoices).length + " shown · " + allVoices.length + " loaded";
  };
  $("search").oninput = function () {
    var shown = clientFilter(allVoices);
    renderGrid(shown);
    $("stats").textContent = shown.length + " shown · " + allVoices.length + " loaded";
  };
  ["accentFilter", "genderFilter", "categoryFilter"].forEach(function (id) {
    $(id).onchange = $("search").oninput;
  });
  $("langFilter").onchange = function () {
    if (allVoices.length) loadVoices();
  };
  $("modelFilter").onchange = function () {
    if (allVoices.length) loadVoices();
  };
  $("btnCustomPreview").onclick = generateCustomPreview;
  $("btnCopyId").onclick = function () {
    if (!selectedVoice || !selectedVoice.voice_id) return;
    navigator.clipboard.writeText(selectedVoice.voice_id).catch(function () {});
  };
})();
  </script>
</body>
</html>`;
