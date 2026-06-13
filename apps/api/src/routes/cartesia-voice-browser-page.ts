/** Cartesia voice browser — GET /voice/cartesia/browser */

export const CARTESIA_VOICE_BROWSER_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cartesia Voice Browser</title>
  <style>
    :root {
      --bg: #0a0e14;
      --panel: #121a24;
      --card: #161f2c;
      --border: #2a3548;
      --text: #e8eef6;
      --muted: #8b9cb3;
      --accent: #8b5cf6;
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
      .shell { grid-template-columns: 18rem 1fr; }
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
    .chip.lang { color: #c4b5fd; }
    .chip.owner { color: #9fd4ff; }
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
    .warn { color: var(--warn); font-size: 0.8rem; margin-top: 0.35rem; }
    audio { width: 100%; margin-top: 0.5rem; }
    .empty { color: var(--muted); padding: 2rem; text-align: center; }
    a { color: #c4b5fd; }
  </style>
</head>
<body>
  <header class="top">
    <h1>Cartesia Voice Browser</h1>
    <p class="sub">Search Sonic voices by language, gender, ownership, and name — play free Cartesia previews or generate a custom sample. No customer account required.</p>
    <p id="cfgWarn" class="warn" style="display:none">CARTESIA_API_KEY is not set on the server.</p>
  </header>

  <div class="shell">
    <aside class="filters">
      <label for="base">API base</label>
      <input type="url" id="base" />

      <label for="apiKey">x-api-key</label>
      <input type="password" id="apiKey" autocomplete="off" />

      <label for="search">Search (name / description / ID)</label>
      <input type="text" id="search" placeholder="Katie, friendly, …" />

      <label for="langFilter">Language (API)</label>
      <select id="langFilter">
        <option value="">All languages</option>
      </select>

      <label for="genderFilter">Gender (API)</label>
      <select id="genderFilter">
        <option value="">Any</option>
      </select>

      <label for="ownerFilter">Ownership (API)</label>
      <select id="ownerFilter">
        <option value="">All voices</option>
        <option value="false">Public library only</option>
        <option value="true">My organization only</option>
      </select>

      <label for="countryFilter">Country (client filter)</label>
      <select id="countryFilter">
        <option value="">Any country</option>
      </select>

      <label for="visibilityFilter">Visibility (client)</label>
      <select id="visibilityFilter">
        <option value="">Any</option>
        <option value="public">Public only</option>
        <option value="private">Non-public only</option>
      </select>

      <label for="pageSize">Page size</label>
      <select id="pageSize">
        <option value="25">25</option>
        <option value="50" selected>50</option>
        <option value="100">100</option>
      </select>

      <button type="button" id="btnLoad">Search / refresh</button>
      <button type="button" class="secondary" id="btnLoadMore">Load more</button>
      <button type="button" class="secondary" id="btnClear">Clear filters</button>
      <p class="err" id="filterErr" style="display:none"></p>
    </aside>

    <main class="main">
      <div class="stats" id="stats">Set filters and click Search.</div>
      <div class="grid" id="voiceGrid"></div>
      <div class="detail" id="detailPanel" style="display:none">
        <h2 id="detailName">—</h2>
        <p class="vid" id="detailId">—</p>
        <div class="chips" id="detailChips"></div>
        <p id="detailDesc" style="font-size:0.85rem;color:var(--muted)"></p>
        <label>Preview model</label>
        <select id="previewModel">
          <option value="sonic-3.5">sonic-3.5</option>
          <option value="sonic-3.5-2026-05-04">sonic-3.5-2026-05-04</option>
          <option value="sonic-3">sonic-3</option>
        </select>
        <label>Preview language</label>
        <input type="text" id="previewLang" placeholder="en" />
        <label>Preview emotion</label>
        <select id="previewEmotion">
          <option value="neutral">neutral</option>
          <option value="content">content</option>
          <option value="calm">calm</option>
          <option value="sympathetic">sympathetic</option>
          <option value="excited">excited</option>
        </select>
        <label>Custom preview text</label>
        <textarea id="previewText" rows="2" style="width:100%;background:var(--bg);color:var(--text);border:1px solid var(--border);border-radius:6px;padding:0.4rem;font-family:inherit"></textarea>
        <div class="actions" style="margin-top:0.5rem">
          <button type="button" class="primary" id="btnCustomPreview">Generate preview (uses credits)</button>
          <button type="button" id="btnCopyId">Copy voice_id</button>
          <button type="button" id="btnOpenSimulator">Open in simulator</button>
        </div>
        <audio id="player" controls></audio>
      </div>
    </main>
  </div>

  <script>
(function () {
  var CONFIG = __BROWSER_CONFIG__;
  var $ = function (id) { return document.getElementById(id); };
  var allVoices = [];
  var selectedVoice = null;
  var nextPage = null;
  var hasMore = false;
  var sampleByLang = {
    en: "Hello! This is how I sound on a natural phone conversation.",
    hi: "नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?",
    mr: "नमस्कार! आजचा दिवस कसा आहे?",
    ta: "வணக்கம்! நான் உங்களுக்கு எப்படி உதவ முடியும்?",
    te: "నమస్కారం! నేను మీకు ఎలా సహాయం చేయగలను?",
    bn: "নমস্কার! আমি আপনাকে কীভাবে সাহায্য করতে পারি?"
  };

  if (!CONFIG.cartesia_configured) $("cfgWarn").style.display = "block";

  $("base").value = localStorage.getItem("cartVoiceBase") || window.location.origin || "";
  $("apiKey").value = localStorage.getItem("cartVoiceKey") || "";

  (CONFIG.languages || []).forEach(function (l) {
    var o = document.createElement("option");
    o.value = l.code;
    o.textContent = l.label + " (" + l.code + ")";
    $("langFilter").appendChild(o);
  });
  (CONFIG.genders || []).forEach(function (g) {
    var o = document.createElement("option");
    o.value = g;
    o.textContent = g.replace(/_/g, " ");
    $("genderFilter").appendChild(o);
  });

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

  function clientFilter(list) {
    var country = $("countryFilter").value;
    var vis = $("visibilityFilter").value;
    var q = $("search").value.trim().toLowerCase();
    return list.filter(function (v) {
      if (country && (v.country || "").toUpperCase() !== country.toUpperCase()) return false;
      if (vis === "public" && !v.is_public) return false;
      if (vis === "private" && v.is_public) return false;
      if (q) {
        var blob = ((v.name || "") + " " + (v.description || "") + " " + (v.id || "")).toLowerCase();
        if (blob.indexOf(q) < 0) return false;
      }
      return true;
    });
  }

  function rebuildCountryOptions() {
    var sel = $("countryFilter");
    var cur = sel.value;
    var countries = {};
    allVoices.forEach(function (v) {
      if (v.country) countries[v.country.toUpperCase()] = v.country.toUpperCase();
    });
    sel.innerHTML = '<option value="">Any country</option>';
    Object.keys(countries).sort().forEach(function (c) {
      var o = document.createElement("option");
      o.value = countries[c];
      o.textContent = countries[c];
      sel.appendChild(o);
    });
    sel.value = cur;
  }

  function genderLabel(g) {
    if (!g) return "";
    return g.replace(/_/g, " ");
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
      card.className = "card" + (selectedVoice && selectedVoice.id === v.id ? " selected" : "");
      var chips = "";
      if (v.language) chips += '<span class="chip lang">' + v.language + '</span>';
      if (v.country) chips += '<span class="chip">' + v.country + '</span>';
      if (v.gender) chips += '<span class="chip">' + genderLabel(v.gender) + '</span>';
      if (v.is_owner) chips += '<span class="chip owner">owned</span>';
      if (v.is_public) chips += '<span class="chip">public</span>';
      card.innerHTML =
        '<h3>' + (v.name || "Unnamed") + '</h3>' +
        '<div class="vid">' + (v.id || "") + '</div>' +
        '<div class="chips">' + chips + '</div>' +
        '<div class="actions">' +
        '<button type="button" data-act="select">Select</button>' +
        (v.preview_file_url ? '<button type="button" data-act="free-sample">Free sample</button>' : '') +
        '<button type="button" data-act="custom" class="primary">TTS preview</button>' +
        '</div>';
      card.querySelector('[data-act="select"]').onclick = function () { selectVoice(v); };
      if (v.preview_file_url) {
        card.querySelector('[data-act="free-sample"]').onclick = function () {
          playFreePreview(v);
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
    $("detailId").textContent = v.id || "";
    var chips = $("detailChips");
    chips.innerHTML = "";
    [
      ["language", v.language],
      ["country", v.country],
      ["gender", genderLabel(v.gender)],
      ["owner", v.is_owner ? "your org" : "library"],
      ["public", v.is_public ? "yes" : "no"],
    ].forEach(function (pair) {
      if (!pair[1]) return;
      var s = document.createElement("span");
      s.className = "chip" + (pair[0] === "language" ? " lang" : "");
      s.textContent = pair[0] + ": " + pair[1];
      chips.appendChild(s);
    });
    $("detailDesc").textContent = v.description || "";
    var lang = v.language || $("langFilter").value || "en";
    $("previewLang").value = lang;
    var primary = lang.split(/[-_]/)[0] || "en";
    $("previewText").value = sampleByLang[primary] || sampleByLang.en;
    renderGrid(clientFilter(allVoices));
  }

  async function playFreePreview(v) {
    if (!v.preview_file_url) return;
    var key = apiKey();
    if (!key) { showErr("Enter x-api-key"); return; }
    try {
      var url = root() + "/voice/cartesia/preview-file?url=" + encodeURIComponent(v.preview_file_url);
      var res = await fetch(url, { headers: { "x-api-key": key } });
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

  function buildQuery(cursor) {
    var qs = new URLSearchParams();
    qs.set("limit", $("pageSize").value || "50");
    var q = $("search").value.trim();
    if (q) qs.set("q", q);
    var lang = $("langFilter").value;
    if (lang) qs.set("language", lang);
    var gender = $("genderFilter").value;
    if (gender) qs.set("gender", gender);
    var owner = $("ownerFilter").value;
    if (owner === "true") qs.set("is_owner", "true");
    if (owner === "false") qs.set("is_owner", "false");
    if (cursor) qs.set("starting_after", cursor);
    return qs.toString();
  }

  async function fetchPage(cursor, append) {
    var key = apiKey();
    if (!key) throw new Error("Enter x-api-key");
    localStorage.setItem("cartVoiceBase", root());
    localStorage.setItem("cartVoiceKey", key);
    var res = await fetch(root() + "/voice/cartesia/voices?" + buildQuery(cursor), {
      headers: { "x-api-key": key }
    });
    var json = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
    var batch = Array.isArray(json.voices) ? json.voices : [];
    if (append) {
      var seen = {};
      allVoices.forEach(function (v) { seen[v.id] = true; });
      batch.forEach(function (v) { if (!seen[v.id]) allVoices.push(v); });
    } else {
      allVoices = batch;
    }
    hasMore = !!json.has_more;
    nextPage = json.next_page || null;
    return batch;
  }

  async function loadVoices(append) {
    showErr("");
    $("stats").textContent = append ? "Loading more…" : "Loading…";
    try {
      await fetchPage(append ? nextPage : null, !!append);
      rebuildCountryOptions();
      var shown = clientFilter(allVoices);
      $("stats").textContent =
        shown.length + " shown · " + allVoices.length + " loaded" +
        (hasMore ? " · more available" : "");
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
    var body = {
      voice_id: selectedVoice.id,
      model_id: $("previewModel").value,
      text: $("previewText").value.trim() || undefined,
      language: $("previewLang").value.trim() || selectedVoice.language || "en",
      emotion: $("previewEmotion").value
    };
    try {
      var res = await fetch(root() + "/voice/cartesia/preview", {
        method: "POST",
        headers: { "x-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        var err = await res.json().catch(function () { return {}; });
        throw new Error(err.error || ("HTTP " + res.status));
      }
      var credits = res.headers.get("X-Credits-Estimated");
      if (credits) $("stats").textContent = "Last preview ~" + credits + " credits";
      var blob = await res.blob();
      $("player").src = URL.createObjectURL(blob);
      $("player").play().catch(function () {});
    } catch (e) {
      showErr(e.message || String(e));
    }
  }

  $("btnLoad").onclick = function () { loadVoices(false); };
  $("btnLoadMore").onclick = function () {
    if (!hasMore || !nextPage) {
      showErr("No more pages — run Search again or change filters.");
      return;
    }
    loadVoices(true);
  };
  $("btnClear").onclick = function () {
    $("search").value = "";
    $("langFilter").value = "";
    $("genderFilter").value = "";
    $("ownerFilter").value = "";
    $("countryFilter").value = "";
    $("visibilityFilter").value = "";
    allVoices = [];
    nextPage = null;
    hasMore = false;
    renderGrid([]);
    $("stats").textContent = "Filters cleared.";
  };
  ["countryFilter", "visibilityFilter"].forEach(function (id) {
    $(id).onchange = function () {
      var shown = clientFilter(allVoices);
      renderGrid(shown);
      $("stats").textContent = shown.length + " shown · " + allVoices.length + " loaded";
    };
  });
  $("search").onkeydown = function (e) {
    if (e.key === "Enter") loadVoices(false);
  };
  $("btnCustomPreview").onclick = generateCustomPreview;
  $("btnCopyId").onclick = function () {
    if (!selectedVoice || !selectedVoice.id) return;
    navigator.clipboard.writeText(selectedVoice.id).catch(function () {});
  };
  $("btnOpenSimulator").onclick = function () {
    if (!selectedVoice || !selectedVoice.id) return;
    var url = root() + "/voice/cartesia/simulator";
    var cid = new URLSearchParams(window.location.search).get("customer_id");
    if (cid) url += "?customer_id=" + encodeURIComponent(cid);
    url += (url.indexOf("?") >= 0 ? "&" : "?") + "voice_id=" + encodeURIComponent(selectedVoice.id);
    window.open(url, "_blank");
  };

  var params = new URLSearchParams(window.location.search);
  var preVoice = params.get("voice_id");
  if (preVoice) {
    $("search").value = preVoice;
  }
})();
  </script>
</body>
</html>`;
