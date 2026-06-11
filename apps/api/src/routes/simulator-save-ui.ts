/** Shared Save Character modal + script for simulator pages. */

export function buildSimulatorSaveUi(
  simulatorType: "elevenlabs" | "openai_tts",
  savePath: string
): string {
  const typeJson = JSON.stringify(simulatorType);
  const pathJson = JSON.stringify(savePath);
  return `
<div id="simSaveBackdrop" class="sim-save-backdrop" style="display:none" aria-hidden="true">
  <div class="sim-save-modal" role="dialog" aria-labelledby="simSaveTitle">
    <h3 id="simSaveTitle">Save character profile</h3>
    <p class="hint">Emails all current settings and the last output audio to Convixx.</p>
    <label for="simSaveCharName">Character name</label>
    <input type="text" id="simSaveCharName" maxlength="120" placeholder="e.g. Priya support agent" />
    <p class="err" id="simSaveErr" style="display:none"></p>
    <p class="sim-save-ok" id="simSaveOk" style="display:none"></p>
    <div class="sim-save-actions">
      <button type="button" class="secondary" id="simSaveCancel">Cancel</button>
      <button type="button" id="simSaveConfirm">Send email</button>
    </div>
  </div>
</div>
<style>
  .sim-save-backdrop {
    position: fixed; inset: 0; z-index: 9999;
    background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center;
    padding: 1rem;
  }
  .sim-save-modal {
    background: #141b26; border: 1px solid #263246; border-radius: 12px;
    padding: 1.1rem 1.25rem; max-width: 22rem; width: 100%;
    color: #e8eef6; box-shadow: 0 12px 40px rgba(0,0,0,0.45);
  }
  .sim-save-modal h3 { margin: 0 0 0.35rem; font-size: 1rem; }
  .sim-save-modal input {
    width: 100%; padding: 0.5rem; margin: 0.35rem 0 0.75rem;
    border-radius: 6px; border: 1px solid #263246; background: #0b0f14; color: #e8eef6;
  }
  .sim-save-actions { display: flex; gap: 0.5rem; margin-top: 0.5rem; }
  .sim-save-actions button { flex: 1; margin: 0; width: auto; }
  .sim-save-ok { color: #3fb950; font-size: 0.85rem; margin-top: 0.35rem; }
  .sim-save-float {
    position: fixed; top: 0.75rem; right: 0.75rem; z-index: 1000;
    width: auto !important; padding: 0.6rem 1.1rem !important; margin: 0 !important;
    background: #1a5c40 !important; border: 2px solid #3fb950 !important;
    color: #fff !important; box-shadow: 0 4px 24px rgba(0,0,0,0.45);
    font-size: 0.88rem !important;
  }
  .sim-save-float.sim-save-pending { border-color: #d4a534 !important; background: #4a4020 !important; }
  .sim-save-float.sim-save-ready { border-color: #3fb950 !important; background: #1a5c40 !important; }
</style>
<script>
(function () {
  var SIM_TYPE = ${typeJson};
  var SAVE_PATH = ${pathJson};
  var backdrop = document.getElementById("simSaveBackdrop");
  var nameInput = document.getElementById("simSaveCharName");
  var errEl = document.getElementById("simSaveErr");
  var okEl = document.getElementById("simSaveOk");
  var btnOpen = document.getElementById("btnSaveCharacter");
  var btnCancel = document.getElementById("simSaveCancel");
  var btnConfirm = document.getElementById("simSaveConfirm");
  if (!backdrop || !btnOpen) return;

  function showErr(msg) {
    errEl.textContent = msg || "";
    errEl.style.display = msg ? "block" : "none";
  }
  function showOk(msg) {
    okEl.textContent = msg || "";
    okEl.style.display = msg ? "block" : "none";
  }

  function openModal() {
    showErr("");
    showOk("");
    if (!window.__simSaveHasAudio || !window.__simSaveHasAudio()) {
      showErr("Run a simulation first so there is output audio to attach.");
    }
    nameInput.value = "";
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    nameInput.focus();
  }

  function closeModal() {
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    showErr("");
  }

  btnOpen.addEventListener("click", openModal);
  btnCancel.addEventListener("click", closeModal);
  backdrop.addEventListener("click", function (e) {
    if (e.target === backdrop) closeModal();
  });

  btnConfirm.addEventListener("click", async function () {
    showErr("");
    showOk("");
    var name = (nameInput.value || "").trim();
    if (!name) { showErr("Enter a character name"); return; }
    if (!window.__simSaveCollectPayload) {
      showErr("Save hooks not ready");
      return;
    }
    var payload;
    try {
      payload = window.__simSaveCollectPayload(name, SIM_TYPE);
    } catch (e) {
      showErr(e.message || String(e));
      return;
    }
    if (!payload.audio_base64) {
      showErr("No output audio — run a simulation first.");
      return;
    }
    var key = payload._apiKey;
    delete payload._apiKey;
    if (!key) { showErr("Set x-api-key in Connection"); return; }

    btnConfirm.disabled = true;
    btnConfirm.textContent = "Sending…";
    try {
      var base = (window.__simSaveApiBase && window.__simSaveApiBase()) || window.location.origin;
      var res = await fetch(base.replace(/\\/+$/, "") + SAVE_PATH, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key },
        body: JSON.stringify(payload),
      });
      var json = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(json.error || ("HTTP " + res.status));
      showOk("Saved! Email sent to convixx.ai@gmail.com (CC: sandeshr.patil21@gmail.com).");
      setTimeout(closeModal, 2200);
    } catch (e) {
      showErr(e.message || String(e));
    } finally {
      btnConfirm.disabled = false;
      btnConfirm.textContent = "Send email";
    }
  });
})();
</script>`;
}
