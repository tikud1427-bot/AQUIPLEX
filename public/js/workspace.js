/**
 * workspace.js — Aquiplex Editor Frontend [v5]
 *
 * CHANGELOG v5:
 * - [FIX] Debounced live preview: editor input → refreshPreview() with 300ms debounce.
 *         Prevents iframe thrashing on every keystroke.
 * - [FIX] Single addEventListener("load") init block — no duplicate listeners.
 * - [FIX] Preview indicator: "Updating preview…" shown during debounce window.
 * - [FIX] refreshPreview() uses correct /preview/ route with cache-busting ?t=.
 * - [FIX] loadFile() + saveFile() + applyEdit() all guard CURRENT_PROJECT_ID.
 * - [FIX] Mobile tab switching: switchTab() correctly shows/hides panes.
 * - [FIX] saveCurrentFile() / focusAiEdit() exposed globally for command palette.
 */

/* ================= GLOBAL STATE ================= */
const STATE = {
  activeFile: null,
  files:      {},
  activeTab:  "editor",
  busy:       false,      // true during AI edit — blocks concurrent calls
};

// Injected by EJS: <script>window.PROJECT_ID = "<%= openProjectId %>";</script>
const CURRENT_PROJECT_ID = window.PROJECT_ID || null;


/* ================= TAB SYSTEM (mobile) ================= */
function switchTab(tab) {
  STATE.activeTab = tab;

  document.querySelectorAll(".mobile-view").forEach(el => {
    el.classList.remove("active");
  });

  if (tab === "editor") {
    document.getElementById("editorPane")?.classList.add("active");
  }

  if (tab === "preview") {
    document.getElementById("previewPane")?.classList.add("active");
    // Refresh preview whenever user manually switches to preview tab
    refreshPreview();
  }

  if (tab === "files") {
    toggleSidebar(true);
  }
}


/* ================= SIDEBAR ================= */
function toggleSidebar(forceOpen = false) {
  const sb = document.getElementById("sidebar");
  if (!sb) return;
  if (forceOpen) sb.classList.add("open");
  else sb.classList.toggle("open");
}


/* ================= PREVIEW ================= */

/**
 * refreshPreview — reloads iframe from the /preview/ static-serving route.
 * Cache-busted with ?t=Date.now() to guarantee fresh content.
 */
function refreshPreview() {
  const iframe = document.getElementById("previewFrame");
  if (!iframe || !CURRENT_PROJECT_ID) return;

  const base = `/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/preview/index.html`;
  iframe.src  = base + "?t=" + Date.now();
}

/**
 * _setPreviewStatus — show/hide a lightweight "Updating preview…" label.
 * Requires a <div id="previewStatus"> near the iframe in the template.
 * Silently skips if the element isn't present.
 */
function _setPreviewStatus(active) {
  const el = document.getElementById("previewStatus");
  if (!el) return;
  el.textContent = active ? "Updating preview…" : "";
  el.style.display = active ? "block" : "none";
}

/**
 * _makeDebounced — returns a debounced wrapper for fn.
 * Prevents calling fn more than once per `delay` ms burst.
 */
function _makeDebounced(fn, delay) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

// Debounced preview refresh — 300ms after last keystroke.
// Preview status is shown during the debounce window.
let _previewDebounceTimer = null;

function _schedulePreviewRefresh() {
  _setPreviewStatus(true);
  clearTimeout(_previewDebounceTimer);
  _previewDebounceTimer = setTimeout(() => {
    _setPreviewStatus(false);
    refreshPreview();
  }, 300);
}


/* ================= LOAD FILE ================= */
async function loadFile(name) {
  if (!CURRENT_PROJECT_ID) {
    toast("No project loaded", "error");
    return;
  }

  try {
    STATE.activeFile = name;

    const res = await fetch(
      `/workspace/file/${CURRENT_PROJECT_ID}/${encodeURIComponent(name)}`
    );

    if (!res.ok) throw new Error("Failed to load file");

    const data = await res.json();
    const content = data.file?.content ?? "";

    STATE.files[name] = content;

    const editor = document.getElementById("editor");
    const label  = document.getElementById("currentFile");

    if (editor) editor.value = content;
    if (label)  label.innerText = name;

    // Switch to editor tab on mobile
    if (window.innerWidth < 768) {
      switchTab("editor");
    }

  } catch (err) {
    toast(err.message || "Load failed", "error");
  }
}


/* ================= SAVE FILE ================= */
async function saveFile() {
  if (!STATE.activeFile || !CURRENT_PROJECT_ID) return;

  const content = document.getElementById("editor")?.value ?? "";

  try {
    const res = await fetch("/workspace/save-file", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        projectId: CURRENT_PROJECT_ID,
        fileName:  STATE.activeFile,
        content,
      }),
    });

    if (!res.ok) throw new Error("Save failed");

    toast("Saved ✓", "success");

    // Refresh preview immediately after save (content is now mirrored)
    refreshPreview();

  } catch (err) {
    toast(err.message || "Save error", "error");
  }
}

/** Alias used by command palette */
function saveCurrentFile() { saveFile(); }


/* ================= AI EDIT ================= */
async function applyEdit() {
  if (!STATE.activeFile || !CURRENT_PROJECT_ID) {
    toast("No file selected", "error");
    return;
  }

  const btn   = document.getElementById("aiEditBtn");
  const input = document.getElementById("aiEditInput");

  const prompt = input?.value?.trim();
  if (!prompt) return;

  STATE.busy    = true;
  btn.disabled  = true;
  btn.innerText = "Applying…";

  try {
    const res = await fetch("/workspace/edit-file", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        projectId:   CURRENT_PROJECT_ID,
        fileName:    STATE.activeFile,
        instruction: prompt,
      }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) throw new Error(data.error || "Edit failed");

    if (!data.updatedFiles || data.updatedFiles.length === 0) {
      throw new Error("No changes applied");
    }

    await loadFile(STATE.activeFile);
    refreshPreview();

    if (input) input.value = "";

    toast("Edit applied ✓", "success");

  } catch (err) {
    toast(err.message || "Edit error", "error");
  } finally {
    STATE.busy    = false;
    btn.disabled  = false;
    btn.innerText = "Edit";
  }
}

/** Alias used by command palette */
function focusAiEdit() {
  const input = document.getElementById("aiEditInput");
  if (input) input.focus();
}

/** Open preview in a new tab */
function openPreviewInTab() {
  if (!CURRENT_PROJECT_ID) return;
  const url = `/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/preview/index.html`;
  window.open(url, "_blank");
}

/* ================= EXPORT PROJECT ZIP ================= */
async function exportProjectZip() {
  if (!CURRENT_PROJECT_ID) {
    toast("No project open to export", "error");
    return;
  }

  const btn = document.getElementById("exportZipBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "⏳ Zipping…";
  }

  try {
    const url = `/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/export`;
    const res = await fetch(url, { credentials: "same-origin" });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      throw new Error(err.error || `Export failed (${res.status})`);
    }

    // Extract filename from Content-Disposition header
    const disposition = res.headers.get("Content-Disposition") || "";
    const nameMatch   = disposition.match(/filename="?([^";\n]+)"?/i);
    const zipName     = nameMatch?.[1] || "project.zip";

    // Trigger browser download
    const blob    = await res.blob();
    const objUrl  = URL.createObjectURL(blob);
    const anchor  = document.createElement("a");
    anchor.href   = objUrl;
    anchor.download = zipName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(objUrl);

    toast(`✅ Exported as ${zipName}`, "success");
  } catch (e) {
    console.error("[exportProjectZip]", e);
    toast(`Export failed: ${e.message}`, "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = "⬇ Export";
    }
  }
}

/* ================= DEPLOY CONFIG GENERATOR ================= */
async function generateDeployConfigs() {
  if (!CURRENT_PROJECT_ID) {
    toast("No project open", "error");
    return;
  }

  const btn = document.getElementById("deployConfigBtn");

  // Fetch available targets for this project
  let targets = ["vercel", "render", "railway", "docker"];
  let isFullstack = false;
  try {
    const r = await fetch(`/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/deploy-targets`, { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      targets     = d.targets || targets;
      isFullstack = d.isFullstack || false;
    }
  } catch { /* use defaults */ }

  // Simple inline picker using existing aq-confirm modal pattern
  const picked = await new Promise(resolve => {
    const opts  = targets.map(t => `<label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="checkbox" value="${t}" checked style="accent-color:var(--aq-accent)"> ${t}
    </label>`).join("");

    const modal = document.createElement("div");
    modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;";
    modal.innerHTML = `
      <div style="background:var(--aq-bg-2,#1a1a2e);border:1px solid var(--aq-border,#333);border-radius:16px;padding:28px;min-width:300px;max-width:400px;">
        <h3 style="margin:0 0 8px;font-size:1rem;">🚀 Generate Deploy Configs</h3>
        <p style="margin:0 0 18px;font-size:.85rem;opacity:.7;">${isFullstack ? "Fullstack project" : "Frontend project"} — select targets:</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px;">${opts}</div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button id="_dCancel" style="padding:8px 18px;border-radius:8px;border:1px solid var(--aq-border,#333);background:transparent;color:inherit;cursor:pointer;">Cancel</button>
          <button id="_dGenerate" style="padding:8px 18px;border-radius:8px;border:none;background:var(--aq-accent,#6366f1);color:#fff;cursor:pointer;font-weight:600;">Generate</button>
        </div>
      </div>`;

    document.body.appendChild(modal);
    document.getElementById("_dCancel").onclick   = () => { document.body.removeChild(modal); resolve(null); };
    document.getElementById("_dGenerate").onclick = () => {
      const checked = [...modal.querySelectorAll("input:checked")].map(el => el.value);
      document.body.removeChild(modal);
      resolve(checked.length ? checked : null);
    };
  });

  if (!picked) return;

  if (btn) { btn.disabled = true; btn.textContent = "⏳ Generating…"; }

  try {
    const res = await fetch(`/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/deploy-configs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ targets: picked }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const names = (data.saved || []).join(", ");
    toast(`✅ Deploy configs added: ${names}`, "success");

    // Refresh file list so new config files appear
    if (typeof loadFileList === "function") loadFileList();

  } catch (e) {
    console.error("[generateDeployConfigs]", e);
    toast(`Deploy config failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🚀 Deploy"; }
  }
}


/* ================= SHARE PROJECT ================= */

let _currentShareUrl = null;

async function shareProject() {
  if (!CURRENT_PROJECT_ID) { toast("No project open", "error"); return; }

  const btn = document.getElementById("shareBtn");
  if (btn) { btn.disabled = true; btn.textContent = "⏳ Sharing…"; }

  try {
    const res  = await fetch(`/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/share`, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    _currentShareUrl = data.shareUrl;
    _showShareModal(data);

  } catch (e) {
    console.error("[shareProject]", e);
    toast(`Share failed: ${e.message}`, "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "🔗 Share"; }
  }
}

async function revokeShare() {
  if (!CURRENT_PROJECT_ID) return;
  if (!confirm("Revoke share link? Anyone with the link will lose access.")) return;

  try {
    const res  = await fetch(`/workspace/project/${encodeURIComponent(CURRENT_PROJECT_ID)}/share`, {
      method: "DELETE", credentials: "same-origin",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    _currentShareUrl = null;
    _closeShareModal();
    toast("✅ Share link revoked", "success");
  } catch (e) {
    toast(`Revoke failed: ${e.message}`, "error");
  }
}

function _showShareModal(data) {
  const existing = document.getElementById("_shareModal");
  if (existing) existing.remove();

  const modal = document.createElement("div");
  modal.id = "_shareModal";
  modal.style.cssText = "position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;";
  modal.innerHTML = `
    <div style="background:var(--aq-bg-2,#1a1a2e);border:1px solid var(--aq-border,#333);border-radius:16px;padding:28px;min-width:340px;max-width:480px;width:90%;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">
        <span style="font-size:1.3rem;">🔗</span>
        <h3 style="margin:0;font-size:1rem;">Project Shared!</h3>
      </div>
      <p style="margin:0 0 16px;font-size:.82rem;opacity:.65;">${data.name} is now publicly viewable</p>
      <div style="display:flex;gap:8px;margin-bottom:18px;">
        <input id="_shareUrlInput" value="${data.shareUrl}" readonly
          style="flex:1;padding:9px 12px;border-radius:8px;border:1px solid var(--aq-border,#333);background:rgba(255,255,255,.05);color:inherit;font-size:.8rem;outline:none;" />
        <button onclick="_copyShareUrl()" style="padding:9px 14px;border-radius:8px;border:none;background:var(--aq-accent,#6366f1);color:#fff;cursor:pointer;font-weight:600;white-space:nowrap;">Copy</button>
      </div>
      <div style="display:flex;gap:10px;justify-content:space-between;align-items:center;">
        <button onclick="revokeShare()" style="padding:7px 14px;border-radius:8px;border:1px solid rgba(239,68,68,.4);background:rgba(239,68,68,.1);color:#f87171;cursor:pointer;font-size:.8rem;">🗑 Revoke</button>
        <div style="display:flex;gap:8px;">
          <a href="${data.shareUrl}" target="_blank" style="padding:7px 14px;border-radius:8px;border:1px solid var(--aq-border,#333);background:transparent;color:inherit;text-decoration:none;font-size:.8rem;display:inline-flex;align-items:center;gap:4px;">↗ Open</a>
          <button onclick="_closeShareModal()" style="padding:7px 14px;border-radius:8px;border:none;background:var(--aq-accent,#6366f1);color:#fff;cursor:pointer;font-size:.8rem;">Done</button>
        </div>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener("click", e => { if (e.target === modal) _closeShareModal(); });

  // Select URL on click
  document.getElementById("_shareUrlInput").addEventListener("click", e => e.target.select());
}

function _copyShareUrl() {
  const url = _currentShareUrl || document.getElementById("_shareUrlInput")?.value;
  if (!url) return;
  navigator.clipboard.writeText(url).then(() => toast("🔗 Share link copied!", "success"));
}

function _closeShareModal() {
  const m = document.getElementById("_shareModal");
  if (m) m.remove();
}


async function loadFileList() {
  if (!CURRENT_PROJECT_ID) return;

  try {
    const res = await fetch(`/workspace/files/${CURRENT_PROJECT_ID}`);
    if (!res.ok) throw new Error("Failed to load files");

    const data = await res.json();

    const list = document.getElementById("fileList");
    if (!list) return;

    list.innerHTML = "";

    (data.files || []).forEach(file => {
      const item      = document.createElement("div");
      item.className  = "file-item";
      item.innerText  = file;
      item.onclick    = () => loadFile(file);
      list.appendChild(item);
    });

    // Auto-load first file
    if (data.files?.length) {
      loadFile(data.files[0]);
    }

  } catch (err) {
    toast(err.message || "File list error", "error");
  }
}


/* ================= TOAST ================= */
function toast(msg, type = "info") {
  const root = document.getElementById("aq-toast-root") || _createToastRoot();

  const el      = document.createElement("div");
  el.className  = "aq-toast " + type;
  el.innerText  = msg;

  root.appendChild(el);

  setTimeout(() => {
    el.classList.add("fadeout");
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

function _createToastRoot() {
  const div = document.createElement("div");
  div.id    = "aq-toast-root";
  document.body.appendChild(div);
  return div;
}


/* ================= INIT ================= */
window.addEventListener("load", () => {
  if (!CURRENT_PROJECT_ID) {
    toast("No project loaded", "error");
    return;
  }

  // Initial render
  refreshPreview();
  loadFileList();

  if (window.innerWidth < 768) {
    switchTab("editor");
  }

  // ── Live preview: debounced on editor input ─────────────────────────────
  // Uses "input" event (fires on every character change).
  // _schedulePreviewRefresh debounces 300ms + shows status indicator.
  // This is the ONLY place this listener is attached — no duplicates.
  const editor = document.getElementById("editor");
  if (editor) {
    editor.addEventListener("input", _schedulePreviewRefresh);
  }

  // ── Keyboard shortcut: Ctrl/Cmd + S → save ────────────────────────────
  document.addEventListener("keydown", e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
      e.preventDefault();
      saveFile();
    }
  });

  // ── Socket.io: live preview on AI file changes ─────────────────────────
  // Listens for project:files-changed emitted by server after AI edits.
  // Auto-reloads iframe + reloads file list so sidebar stays in sync.
  try {
    if (typeof io !== "undefined") {
      const socket = io();

      socket.on("project:files-changed", (data) => {
        // Only react if the event is for our current project
        if (data.projectId && data.projectId !== CURRENT_PROJECT_ID) return;

        // Reload file list sidebar
        loadFileList();

        // Reload the currently open file if it was modified
        const changed = [...(data.updatedFiles || []), ...(data.files?.map(f => f.fileName || f) || [])];
        if (STATE.activeFile && changed.includes(STATE.activeFile)) {
          loadFile(STATE.activeFile);
        }

        // Refresh iframe preview
        refreshPreview();

        // Show toast with changed file names
        const names = changed.slice(0, 3).join(", ");
        const more  = changed.length > 3 ? ` +${changed.length - 3} more` : "";
        toast(`✨ Preview updated: ${names}${more}`, "success");
      });
    }
  } catch (e) {
    console.warn("[workspace] socket.io not available:", e.message);
  }
});