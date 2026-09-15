// ============================================================
// Static HTML/CSS/JS shell for the temporary Ganeshotsav KB admin page.
// Served as-is by kb-admin-ganeshotsav.ts; embedded here as one string
// (no frontend build pipeline in this repo, and `tsc` doesn't copy static
// assets — see that file's header comment) so `npm run build` needs no
// changes to ship it.
// ============================================================

export const KB_ADMIN_GANESHOTSAV_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="robots" content="noindex, nofollow" />
<title>Ganeshotsav Project — Knowledgebase</title>
<style>
  :root {
    --bg: #f4f5f7;
    --surface: #ffffff;
    --surface-2: #fafbfc;
    --border: #e2e5ea;
    --text: #1a1d23;
    --text-dim: #5b6270;
    --text-faint: #8890a0;
    --primary: #4338ca;
    --primary-hover: #3730a3;
    --primary-bg: #eef0fe;
    --danger: #dc2626;
    --danger-hover: #b91c1c;
    --danger-bg: #fef2f2;
    --success: #15803d;
    --success-bg: #f0fdf4;
    --shadow-sm: 0 1px 2px rgba(16,24,40,.06);
    --shadow-md: 0 4px 12px rgba(16,24,40,.10);
    --shadow-lg: 0 12px 36px rgba(16,24,40,.18);
    --radius: 10px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
  }
  [hidden] { display: none !important; }
  a { color: var(--primary); }

  /* ---------- Login screen ---------- */
  #login-screen {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: radial-gradient(1200px 600px at 50% -10%, #eef0fe 0%, var(--bg) 55%);
  }
  .login-card {
    width: 100%;
    max-width: 380px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow-lg);
    padding: 36px 32px 30px;
  }
  .login-badge {
    width: 44px; height: 44px;
    border-radius: 10px;
    background: linear-gradient(135deg, var(--primary), #6366f1);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-weight: 700; font-size: 18px;
    margin-bottom: 18px;
  }
  .login-card h1 { font-size: 18px; margin: 0 0 4px; }
  .login-card p.sub { color: var(--text-dim); font-size: 13px; margin: 0 0 24px; }
  .field { margin-bottom: 16px; }
  .field label { display: block; font-size: 12.5px; font-weight: 600; color: var(--text-dim); margin-bottom: 6px; }
  .field input {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 14px; background: var(--surface-2); color: var(--text);
    transition: border-color .15s, box-shadow .15s;
  }
  .field input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); background: #fff; }
  .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    border: 1px solid transparent; border-radius: 8px; font-size: 13.5px; font-weight: 600;
    padding: 9px 16px; cursor: pointer; transition: background .15s, border-color .15s, opacity .15s;
    white-space: nowrap;
  }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn-primary { background: var(--primary); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: var(--primary-hover); }
  .btn-block { width: 100%; }
  .btn-secondary { background: var(--surface); border-color: var(--border); color: var(--text); }
  .btn-secondary:hover:not(:disabled) { background: var(--surface-2); }
  .btn-danger { background: var(--danger); color: #fff; }
  .btn-danger:hover:not(:disabled) { background: var(--danger-hover); }
  .btn-ghost { background: transparent; color: var(--text-dim); border-color: transparent; }
  .btn-ghost:hover:not(:disabled) { background: var(--surface-2); color: var(--text); }
  .btn-sm { padding: 5px 10px; font-size: 12.5px; }
  .login-error {
    background: var(--danger-bg); color: var(--danger); border: 1px solid #fecaca;
    border-radius: 8px; padding: 9px 12px; font-size: 12.5px; margin-bottom: 16px;
  }

  /* ---------- App shell ---------- */
  #app-screen { min-height: 100vh; display: flex; flex-direction: column; }
  header.topbar {
    background: var(--surface); border-bottom: 1px solid var(--border);
    padding: 14px env(safe-area-inset-top, 0px) 14px 0;
    padding-top: max(14px, env(safe-area-inset-top, 0px));
    display: flex; align-items: center; justify-content: space-between;
    position: sticky; top: 0; z-index: 20;
  }
  .topbar-inner { display: flex; align-items: center; justify-content: space-between; width: 100%; padding: 0 20px; }
  .brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .brand .mark {
    width: 32px; height: 32px; border-radius: 8px; flex: none;
    background: linear-gradient(135deg, var(--primary), #6366f1);
    display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700; font-size: 14px;
  }
  .brand .titles { min-width: 0; }
  .brand h1 { font-size: 14.5px; margin: 0; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .brand .subtitle { font-size: 11.5px; color: var(--text-faint); }
  .user-chip { display: flex; align-items: center; gap: 10px; }
  .user-chip .name { font-size: 12.5px; color: var(--text-dim); }

  main { flex: 1; padding: 22px 20px 48px; max-width: 1180px; width: 100%; margin: 0 auto; }

  .toolbar {
    display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-bottom: 16px;
  }
  .toolbar .spacer { flex: 1; }
  .search-wrap { position: relative; flex: 1; min-width: 200px; max-width: 340px; }
  .search-wrap svg { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); color: var(--text-faint); }
  .search-wrap input {
    width: 100%; padding: 9px 12px 9px 34px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 13.5px; background: var(--surface);
  }
  .search-wrap input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); }

  .stat-row { display: flex; gap: 10px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 12px 16px; min-width: 120px;
  }
  .stat-card .num { font-size: 20px; font-weight: 700; }
  .stat-card .label { font-size: 11.5px; color: var(--text-faint); margin-top: 2px; }

  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); box-shadow: var(--shadow-sm); overflow: hidden; }

  table.kb-table { width: 100%; border-collapse: collapse; }
  table.kb-table thead th {
    text-align: left; font-size: 11.5px; text-transform: uppercase; letter-spacing: .03em;
    color: var(--text-faint); font-weight: 700; padding: 10px 14px; border-bottom: 1px solid var(--border);
    background: var(--surface-2); position: sticky; top: 61px; z-index: 5;
  }
  table.kb-table td { padding: 12px 14px; border-bottom: 1px solid var(--border); vertical-align: top; font-size: 13.3px; }
  table.kb-table tbody tr:last-child td { border-bottom: none; }
  table.kb-table tbody tr:hover { background: #fbfbfd; }
  table.kb-table tbody tr.selected { background: var(--primary-bg); }
  td.col-check, th.col-check { width: 38px; }
  td.col-actions, th.col-actions { width: 92px; text-align: right; white-space: nowrap; }
  .q-cell { font-weight: 600; max-width: 320px; }
  .a-cell { color: var(--text-dim); max-width: 420px; }
  .clamp-2 {
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .row-date { color: var(--text-faint); font-size: 12px; white-space: nowrap; }
  input[type=checkbox] { width: 16px; height: 16px; accent-color: var(--primary); cursor: pointer; }

  .icon-btn {
    width: 30px; height: 30px; border-radius: 7px; border: 1px solid transparent; background: transparent;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer; color: var(--text-dim);
  }
  .icon-btn:hover { background: var(--surface-2); border-color: var(--border); color: var(--text); }
  .icon-btn.danger:hover { background: var(--danger-bg); color: var(--danger); border-color: #fecaca; }

  .empty-state { padding: 60px 20px; text-align: center; color: var(--text-faint); }
  .empty-state .big { font-size: 32px; margin-bottom: 8px; }

  /* ---------- Modal ---------- */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(16,20,30,.45); backdrop-filter: blur(1px);
    display: flex; align-items: center; justify-content: center; padding: 20px; z-index: 100;
  }
  .modal {
    background: var(--surface); border-radius: 14px; box-shadow: var(--shadow-lg);
    width: 100%; max-width: 520px; max-height: min(88vh, 720px); display: flex; flex-direction: column; overflow: hidden;
  }
  .modal.modal-wide { max-width: 620px; }
  .modal-header { padding: 18px 22px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .modal-header h2 { font-size: 15.5px; margin: 0; }
  .modal-body { padding: 20px 22px; overflow-y: auto; }
  .modal-footer { padding: 16px 22px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 10px; }
  .field textarea {
    width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px;
    font-size: 13.5px; font-family: inherit; resize: vertical; min-height: 84px; background: var(--surface-2);
  }
  .field textarea:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-bg); background: #fff; }
  .confirm-summary {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px;
    font-size: 13px; color: var(--text-dim); margin-top: 4px; max-height: 160px; overflow-y: auto;
  }
  .confirm-summary div + div { margin-top: 6px; padding-top: 6px; border-top: 1px dashed var(--border); }

  .dropzone {
    border: 1.5px dashed var(--border); border-radius: 10px; padding: 28px 16px; text-align: center;
    background: var(--surface-2); cursor: pointer; transition: border-color .15s, background .15s;
  }
  .dropzone.drag { border-color: var(--primary); background: var(--primary-bg); }
  .dropzone .icon { font-size: 26px; margin-bottom: 8px; }
  .dropzone .hint { color: var(--text-faint); font-size: 12px; margin-top: 4px; }
  .file-chip {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; margin-top: 10px; font-size: 13px;
  }
  .upload-result { margin-top: 14px; border-radius: 8px; padding: 12px 14px; font-size: 13px; }
  .upload-result.ok { background: var(--success-bg); color: var(--success); border: 1px solid #bbf7d0; }
  .upload-result.err { background: var(--danger-bg); color: var(--danger); border: 1px solid #fecaca; white-space: pre-wrap; }

  /* ---------- Toasts ---------- */
  #toast-stack {
    position: fixed; right: 20px; bottom: max(20px, env(safe-area-inset-bottom, 0px)); z-index: 200;
    display: flex; flex-direction: column; gap: 8px; max-width: 340px;
  }
  .toast {
    background: var(--text); color: #fff; padding: 11px 14px; border-radius: 9px; font-size: 13px;
    box-shadow: var(--shadow-md); display: flex; align-items: center; gap: 8px;
  }
  .toast.ok { background: #15803d; }
  .toast.err { background: #b91c1c; }

  .spinner {
    width: 15px; height: 15px; border-radius: 50%; border: 2px solid rgba(255,255,255,.4); border-top-color: #fff;
    animation: spin .7s linear infinite; display: inline-block;
  }
  .spinner.dark { border: 2px solid rgba(67,56,202,.25); border-top-color: var(--primary); }
  @keyframes spin { to { transform: rotate(360deg); } }

  .loading-row td { text-align: center; padding: 40px; color: var(--text-faint); }

  @media (max-width: 640px) {
    .topbar-inner { padding: 0 14px; }
    main { padding: 16px 14px 40px; }
    .a-cell { display: none; }
    th:nth-child(4), td:nth-child(4) { display: none; } /* updated date column */
  }
</style>
</head>
<body>

<div id="login-screen">
  <form class="login-card" id="login-form" autocomplete="off">
    <div class="login-badge">GB</div>
    <h1>Ganeshotsav Project</h1>
    <p class="sub">Knowledgebase admin — sign in to continue</p>
    <div id="login-error" class="login-error" hidden></div>
    <div class="field">
      <label for="login-username">Username</label>
      <input id="login-username" name="username" type="text" autocomplete="username" required />
    </div>
    <div class="field">
      <label for="login-password">Password</label>
      <input id="login-password" name="password" type="password" autocomplete="current-password" required />
    </div>
    <button type="submit" class="btn btn-primary btn-block" id="login-submit">Sign in</button>
  </form>
</div>

<div id="app-screen" hidden>
  <header class="topbar">
    <div class="topbar-inner">
      <div class="brand">
        <div class="mark">GB</div>
        <div class="titles">
          <h1>Ganeshotsav Project</h1>
          <div class="subtitle">Knowledgebase admin</div>
        </div>
      </div>
      <div class="user-chip">
        <span class="name" id="whoami"></span>
        <button class="btn btn-ghost btn-sm" id="logout-btn">Log out</button>
      </div>
    </div>
  </header>

  <main>
    <div class="stat-row">
      <div class="stat-card"><div class="num" id="stat-total">—</div><div class="label">Total entries</div></div>
      <div class="stat-card"><div class="num" id="stat-selected">0</div><div class="label">Selected</div></div>
      <div class="stat-card"><div class="num" id="stat-filtered">—</div><div class="label">Showing</div></div>
    </div>

    <div class="toolbar">
      <div class="search-wrap">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input id="search-input" type="text" placeholder="Search questions or answers…" />
      </div>
      <div class="spacer"></div>
      <button class="btn btn-secondary" id="template-btn">Download template</button>
      <button class="btn btn-secondary" id="bulk-upload-btn">Bulk upload</button>
      <button class="btn btn-danger" id="bulk-delete-btn" disabled>Delete selected (<span id="bulk-delete-count">0</span>)</button>
      <button class="btn btn-primary" id="add-entry-btn">+ Add entry</button>
    </div>

    <div class="panel">
      <table class="kb-table">
        <thead>
          <tr>
            <th class="col-check"><input type="checkbox" id="select-all" /></th>
            <th>Question</th>
            <th>Answer</th>
            <th>Updated</th>
            <th class="col-actions">Actions</th>
          </tr>
        </thead>
        <tbody id="kb-tbody">
          <tr class="loading-row"><td colspan="5"><span class="spinner dark"></span> Loading entries…</td></tr>
        </tbody>
      </table>
      <div class="empty-state" id="empty-state" hidden>
        <div class="big">🗒️</div>
        <div>No entries match your search.</div>
      </div>
    </div>
  </main>
</div>

<!-- Add / Edit entry modal -->
<div class="modal-overlay" id="entry-modal-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 id="entry-modal-title">Add entry</h2>
      <button class="icon-btn" data-close-modal="entry-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label for="entry-question">Question</label>
        <textarea id="entry-question" placeholder="e.g. Where can I park near Dagdusheth Ganpati?"></textarea>
      </div>
      <div class="field" style="margin-bottom:0">
        <label for="entry-answer">Answer</label>
        <textarea id="entry-answer" placeholder="Answer shown/spoken to callers…" style="min-height:120px"></textarea>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="entry-modal-overlay">Cancel</button>
      <button class="btn btn-primary" id="entry-save-btn">Save entry</button>
    </div>
  </div>
</div>

<!-- Confirm delete modal -->
<div class="modal-overlay" id="confirm-modal-overlay" hidden>
  <div class="modal">
    <div class="modal-header">
      <h2 id="confirm-modal-title">Delete entry?</h2>
      <button class="icon-btn" data-close-modal="confirm-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p id="confirm-modal-text" style="margin:0 0 6px">This cannot be undone.</p>
      <div class="confirm-summary" id="confirm-modal-summary"></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="confirm-modal-overlay">Cancel</button>
      <button class="btn btn-danger" id="confirm-modal-action">Delete</button>
    </div>
  </div>
</div>

<!-- Bulk upload modal -->
<div class="modal-overlay" id="upload-modal-overlay" hidden>
  <div class="modal modal-wide">
    <div class="modal-header">
      <h2>Bulk upload</h2>
      <button class="icon-btn" data-close-modal="upload-modal-overlay">✕</button>
    </div>
    <div class="modal-body">
      <p style="margin:0 0 14px;color:var(--text-dim)">
        Upload an <strong>.xlsx</strong> file with exactly two columns named
        <strong>Questions</strong> and <strong>Answers</strong> (first row = header).
        Need the exact format? <a href="#" id="upload-template-link">Download the template</a>.
      </p>
      <div class="dropzone" id="dropzone">
        <div class="icon">📄</div>
        <div>Click to choose a file, or drag one here</div>
        <div class="hint">.xlsx only</div>
        <input type="file" id="file-input" accept=".xlsx" hidden />
      </div>
      <div class="file-chip" id="file-chip" hidden>
        <span id="file-chip-name"></span>
        <button class="icon-btn danger" id="file-chip-remove">✕</button>
      </div>
      <div id="upload-result" class="upload-result" hidden></div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" data-close-modal="upload-modal-overlay">Close</button>
      <button class="btn btn-primary" id="upload-submit-btn" disabled>Upload</button>
    </div>
  </div>
</div>

<div id="toast-stack"></div>

<script>
(function () {
  'use strict';

  var API = '/kb-admin/ganeshotsav';
  var state = { entries: [], selected: new Set(), filtered: [], editingId: null, sessionTimer: null };

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function toast(msg, kind) {
    var el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    $('toast-stack').appendChild(el);
    setTimeout(function () {
      el.style.transition = 'opacity .25s';
      el.style.opacity = '0';
      setTimeout(function () { el.remove(); }, 260);
    }, 3400);
  }
  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }
  document.querySelectorAll('[data-close-modal]').forEach(function (btn) {
    btn.addEventListener('click', function () { closeModal(btn.getAttribute('data-close-modal')); });
  });
  document.querySelectorAll('.modal-overlay').forEach(function (ov) {
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.hidden = true; });
  });

  async function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    opts.headers = Object.assign({}, opts.headers || {});
    if (opts.body && !(opts.body instanceof FormData)) {
      opts.headers['Content-Type'] = 'application/json';
    }
    var res = await fetch(API + path, opts);
    if (res.status === 401) {
      handleSessionExpired();
      throw new Error('session_expired');
    }
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var msg = (data && data.error) || ('Request failed (' + res.status + ')');
      throw new Error(msg);
    }
    return data;
  }

  function handleSessionExpired() {
    if (state.sessionTimer) { clearInterval(state.sessionTimer); state.sessionTimer = null; }
    $('app-screen').hidden = true;
    $('login-screen').hidden = false;
    $('login-error').hidden = false;
    $('login-error').textContent = 'You were signed out — signed in from another window/browser.';
  }

  // ---------- login ----------
  $('login-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    var btn = $('login-submit');
    var username = $('login-username').value.trim();
    var password = $('login-password').value;
    $('login-error').hidden = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Signing in…';
    try {
      var res = await fetch(API + '/api/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || 'Invalid username or password');
      $('login-screen').hidden = true;
      $('app-screen').hidden = false;
      $('whoami').textContent = data.username || username;
      startSessionPolling();
      loadEntries();
    } catch (err) {
      $('login-error').textContent = err.message || 'Invalid username or password';
      $('login-error').hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });

  $('logout-btn').addEventListener('click', async function () {
    try { await api('/api/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    window.location.reload();
  });

  function startSessionPolling() {
    if (state.sessionTimer) clearInterval(state.sessionTimer);
    state.sessionTimer = setInterval(function () {
      fetch(API + '/api/session', { credentials: 'same-origin' }).then(function (res) {
        if (res.status === 401) handleSessionExpired();
      }).catch(function () {});
    }, 8000);
  }

  // ---------- entries: load + render ----------
  async function loadEntries() {
    $('kb-tbody').innerHTML = '<tr class="loading-row"><td colspan="5"><span class="spinner dark"></span> Loading entries…</td></tr>';
    try {
      var data = await api('/api/entries');
      state.entries = data.entries || [];
      state.selected.clear();
      applyFilter();
    } catch (err) {
      if (err.message !== 'session_expired') toast('Failed to load entries: ' + err.message, 'err');
    }
  }

  function applyFilter() {
    var q = $('search-input').value.trim().toLowerCase();
    state.filtered = !q ? state.entries.slice() : state.entries.filter(function (e) {
      return (e.question || '').toLowerCase().indexOf(q) !== -1 || (e.answer || '').toLowerCase().indexOf(q) !== -1;
    });
    render();
  }
  $('search-input').addEventListener('input', applyFilter);

  function render() {
    $('stat-total').textContent = state.entries.length;
    $('stat-filtered').textContent = state.filtered.length;
    updateSelectionUi();

    var tbody = $('kb-tbody');
    if (state.filtered.length === 0) {
      tbody.innerHTML = '';
      $('empty-state').hidden = state.entries.length !== 0 ? false : true;
      if (state.entries.length === 0) $('empty-state').hidden = false;
      return;
    }
    $('empty-state').hidden = true;

    tbody.innerHTML = state.filtered.map(function (e) {
      var checked = state.selected.has(e.id) ? 'checked' : '';
      var sel = state.selected.has(e.id) ? 'selected' : '';
      return '' +
        '<tr class="' + sel + '" data-id="' + esc(e.id) + '">' +
          '<td class="col-check"><input type="checkbox" class="row-check" data-id="' + esc(e.id) + '" ' + checked + ' /></td>' +
          '<td class="q-cell"><div class="clamp-2">' + esc(e.question) + '</div></td>' +
          '<td class="a-cell"><div class="clamp-2">' + esc(e.answer) + '</div></td>' +
          '<td class="row-date">' + esc(fmtDate(e.updated_at || e.created_at)) + '</td>' +
          '<td class="col-actions">' +
            '<button class="icon-btn" title="Edit" data-edit="' + esc(e.id) + '">✎</button>' +
            '<button class="icon-btn danger" title="Delete" data-delete="' + esc(e.id) + '">🗑</button>' +
          '</td>' +
        '</tr>';
    }).join('');

    tbody.querySelectorAll('.row-check').forEach(function (cb) {
      cb.addEventListener('change', function () {
        var id = cb.getAttribute('data-id');
        if (cb.checked) state.selected.add(id); else state.selected.delete(id);
        cb.closest('tr').classList.toggle('selected', cb.checked);
        updateSelectionUi();
      });
    });
    tbody.querySelectorAll('[data-edit]').forEach(function (b) {
      b.addEventListener('click', function () { openEditModal(b.getAttribute('data-edit')); });
    });
    tbody.querySelectorAll('[data-delete]').forEach(function (b) {
      b.addEventListener('click', function () { confirmDeleteSingle(b.getAttribute('data-delete')); });
    });
  }

  function updateSelectionUi() {
    var n = state.selected.size;
    $('stat-selected').textContent = n;
    $('bulk-delete-count').textContent = n;
    $('bulk-delete-btn').disabled = n === 0;
    var allVisible = state.filtered.length > 0 && state.filtered.every(function (e) { return state.selected.has(e.id); });
    $('select-all').checked = allVisible;
  }

  $('select-all').addEventListener('change', function () {
    if ($('select-all').checked) {
      state.filtered.forEach(function (e) { state.selected.add(e.id); });
    } else {
      state.filtered.forEach(function (e) { state.selected.delete(e.id); });
    }
    render();
  });

  // ---------- add / edit ----------
  $('add-entry-btn').addEventListener('click', function () {
    state.editingId = null;
    $('entry-modal-title').textContent = 'Add entry';
    $('entry-question').value = '';
    $('entry-answer').value = '';
    openModal('entry-modal-overlay');
    $('entry-question').focus();
  });

  function openEditModal(id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    if (!e) return;
    state.editingId = id;
    $('entry-modal-title').textContent = 'Edit entry';
    $('entry-question').value = e.question;
    $('entry-answer').value = e.answer;
    openModal('entry-modal-overlay');
  }

  $('entry-save-btn').addEventListener('click', async function () {
    var question = $('entry-question').value.trim();
    var answer = $('entry-answer').value.trim();
    if (!question || !answer) { toast('Question and answer are both required', 'err'); return; }
    var btn = $('entry-save-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    try {
      if (state.editingId) {
        await api('/api/entries/' + encodeURIComponent(state.editingId), {
          method: 'PUT', body: JSON.stringify({ question: question, answer: answer })
        });
        toast('Entry updated', 'ok');
      } else {
        await api('/api/entries', { method: 'POST', body: JSON.stringify({ question: question, answer: answer }) });
        toast('Entry added', 'ok');
      }
      closeModal('entry-modal-overlay');
      loadEntries();
    } catch (err) {
      if (err.message !== 'session_expired') toast('Save failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  // ---------- delete (single + bulk), always confirmed ----------
  var pendingDeleteIds = [];

  function confirmDeleteSingle(id) {
    var e = state.entries.find(function (x) { return x.id === id; });
    pendingDeleteIds = [id];
    $('confirm-modal-title').textContent = 'Delete this entry?';
    $('confirm-modal-text').textContent = 'This cannot be undone.';
    $('confirm-modal-summary').innerHTML = e ? '<div><strong>' + esc(e.question) + '</strong></div>' : '';
    openModal('confirm-modal-overlay');
  }

  $('bulk-delete-btn').addEventListener('click', function () {
    pendingDeleteIds = Array.from(state.selected);
    if (pendingDeleteIds.length === 0) return;
    $('confirm-modal-title').textContent = 'Delete ' + pendingDeleteIds.length + ' entries?';
    $('confirm-modal-text').textContent = 'This cannot be undone.';
    var list = state.entries.filter(function (e) { return state.selected.has(e.id); }).slice(0, 12);
    var html = list.map(function (e) { return '<div>' + esc(e.question) + '</div>'; }).join('');
    if (pendingDeleteIds.length > 12) html += '<div>…and ' + (pendingDeleteIds.length - 12) + ' more</div>';
    $('confirm-modal-summary').innerHTML = html;
    openModal('confirm-modal-overlay');
  });

  $('confirm-modal-action').addEventListener('click', async function () {
    if (pendingDeleteIds.length === 0) return;
    var btn = $('confirm-modal-action');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Deleting…';
    try {
      await api('/api/entries/bulk-delete', { method: 'POST', body: JSON.stringify({ ids: pendingDeleteIds }) });
      toast(pendingDeleteIds.length + ' entr' + (pendingDeleteIds.length === 1 ? 'y' : 'ies') + ' deleted', 'ok');
      pendingDeleteIds.forEach(function (id) { state.selected.delete(id); });
      closeModal('confirm-modal-overlay');
      loadEntries();
    } catch (err) {
      if (err.message !== 'session_expired') toast('Delete failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
      pendingDeleteIds = [];
    }
  });

  // ---------- bulk upload ----------
  var selectedFile = null;

  $('bulk-upload-btn').addEventListener('click', function () {
    selectedFile = null;
    $('file-input').value = '';
    $('file-chip').hidden = true;
    $('upload-result').hidden = true;
    $('upload-submit-btn').disabled = true;
    openModal('upload-modal-overlay');
  });
  $('template-btn').addEventListener('click', function () { window.location.href = API + '/api/template.xlsx'; });
  $('upload-template-link').addEventListener('click', function (e) { e.preventDefault(); window.location.href = API + '/api/template.xlsx'; });

  var dz = $('dropzone');
  dz.addEventListener('click', function () { $('file-input').click(); });
  dz.addEventListener('dragover', function (e) { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', function () { dz.classList.remove('drag'); });
  dz.addEventListener('drop', function (e) {
    e.preventDefault(); dz.classList.remove('drag');
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setSelectedFile(e.dataTransfer.files[0]);
  });
  $('file-input').addEventListener('change', function () {
    if ($('file-input').files[0]) setSelectedFile($('file-input').files[0]);
  });
  $('file-chip-remove').addEventListener('click', function () {
    selectedFile = null;
    $('file-input').value = '';
    $('file-chip').hidden = true;
    $('upload-submit-btn').disabled = true;
  });

  function setSelectedFile(file) {
    if (!/\\.xlsx$/i.test(file.name)) { toast('Please choose a .xlsx file', 'err'); return; }
    selectedFile = file;
    $('file-chip-name').textContent = file.name;
    $('file-chip').hidden = false;
    $('upload-result').hidden = true;
    $('upload-submit-btn').disabled = false;
  }

  $('upload-submit-btn').addEventListener('click', async function () {
    if (!selectedFile) return;
    var btn = $('upload-submit-btn');
    btn.disabled = true;
    var originalHtml = btn.innerHTML;
    btn.innerHTML = '<span class="spinner"></span> Uploading…';
    $('upload-result').hidden = true;
    try {
      var fd = new FormData();
      fd.append('file', selectedFile);
      var res = await fetch(API + '/api/entries/bulk-upload', { method: 'POST', credentials: 'same-origin', body: fd });
      if (res.status === 401) { handleSessionExpired(); return; }
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        $('upload-result').className = 'upload-result err';
        $('upload-result').textContent = data.error || 'Upload failed';
        $('upload-result').hidden = false;
        return;
      }
      $('upload-result').className = 'upload-result ok';
      $('upload-result').textContent = data.inserted + ' entries added' +
        (data.skipped ? ' (' + data.skipped + ' blank rows skipped)' : '') + '.';
      $('upload-result').hidden = false;
      toast(data.inserted + ' entries added from file', 'ok');
      loadEntries();
    } catch (err) {
      $('upload-result').className = 'upload-result err';
      $('upload-result').textContent = 'Upload failed: ' + err.message;
      $('upload-result').hidden = false;
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  });

  // ---------- boot ----------
  (async function boot() {
    try {
      var res = await fetch(API + '/api/session', { credentials: 'same-origin' });
      if (res.ok) {
        var data = await res.json();
        $('login-screen').hidden = true;
        $('app-screen').hidden = false;
        $('whoami').textContent = data.username || '';
        startSessionPolling();
        loadEntries();
        return;
      }
    } catch (e) { /* fall through to login */ }
    $('login-screen').hidden = false;
  })();
})();
</script>
</body>
</html>
`;
