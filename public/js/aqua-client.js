/**
 * aqua-client.js — Frontend bridge for POST /chat + file upload support
 *
 * Usage (with file):
 *   const aqua = new AquaClient({ baseUrl: "/" });
 *   aqua.send("summarize this pdf", {
 *     file:     fileInput.files[0],
 *     onMessage: (msg) => appendToChatUI(msg),
 *     onFileAttached: (info) => showAttachmentBadge(info.fileName),
 *   });
 *
 * Usage (follow-up, server remembers file in session):
 *   aqua.send("what was the main topic?", { onMessage: (msg) => appendToChatUI(msg) });
 */

class AquaClient {
  constructor({ baseUrl = "/" } = {}) {
    this.baseUrl        = baseUrl.replace(/\/$/, "");
    this.sessionHistory = [];
    this._sessionFiles  = [];
  }

  /**
   * send(message, options)
   *
   * @param {string} message
   * @param {object} opts
   *   file              : File?     — File object from <input type="file">
   *   projectId         : string?
   *   fileName          : string?
   *   mode              : string?   "chat"|"image"|"search"|"code"
   *   stream            : boolean?
   *   onMessage         : fn(text)
   *   onChunk           : fn(chunk) — streaming chunks
   *   onPreviewRefresh  : fn()
   *   onIntent          : fn(intent)
   *   onFiles           : fn(files)
   *   onFileAttached    : fn({fileName}) — called after file parsed
   *   onError           : fn(err)
   */
  async send(message, opts = {}) {
    const {
      file, projectId, fileName, mode,
      stream = false,
      onMessage, onChunk, onPreviewRefresh,
      onIntent, onFiles, onFileAttached, onError,
    } = opts;

    this.sessionHistory.push({ role: "user", content: message });
    if (this.sessionHistory.length > 20) this.sessionHistory = this.sessionHistory.slice(-20);

    // Build request — FormData if file present, JSON otherwise
    let fetchOpts;
    if (file) {
      const form = new FormData();
      form.append("message",        message);
      form.append("sessionHistory", JSON.stringify(this.sessionHistory.slice(0, -1)));
      if (projectId) form.append("projectId", projectId);
      if (fileName)  form.append("fileName",  fileName);
      if (mode)      form.append("mode",      mode || "chat");
      if (stream)    form.append("stream",    "true");
      form.append("file", file, file.name);
      fetchOpts = { method: "POST", body: form };
    } else {
      fetchOpts = {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({
          message,
          projectId:      projectId || null,
          fileName:       fileName  || null,
          mode:           mode      || "chat",
          stream:         stream    || false,
          sessionHistory: this.sessionHistory.slice(0, -1),
        }),
      };
    }

    // Streaming path
    if (stream) {
      return this._sendStream(message, fetchOpts, { onChunk, onMessage, onError, onFileAttached, file });
    }

    // JSON path
    let data;
    try {
      const res = await fetch(`${this.baseUrl}/chat`, fetchOpts);
      data = await res.json();
      if (!res.ok) throw new Error(data.reply || data.error || `HTTP ${res.status}`);
    } catch (err) {
      if (typeof onError === "function") onError(err.message || "Request failed");
      return null;
    }

    if (file && typeof onFileAttached === "function") {
      onFileAttached({ fileName: file.name, ...(data.fileAttached || {}) });
      this._syncSessionFiles();
    }

    this.sessionHistory.push({ role: "assistant", content: data.reply || data.message || "" });

    if (typeof onIntent  === "function" && data.intent)        onIntent(data.intent);
    if (typeof onMessage === "function" && (data.reply || data.message)) onMessage(data.reply || data.message);
    if (typeof onFiles   === "function" && data.files?.length) onFiles(data.files);
    if (data.previewRefresh && typeof onPreviewRefresh === "function") setTimeout(onPreviewRefresh, 600);

    return data;
  }

  async _sendStream(message, fetchOpts, { onChunk, onMessage, onError, onFileAttached, file }) {
    let fullText = "";
    try {
      const res = await fetch(`${this.baseUrl}/chat`, fetchOpts);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader  = res.body.getReader();
      const decoder = new TextDecoder();
      let   buffer  = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload);
            const chunk  = parsed.choices?.[0]?.delta?.content || parsed.chunk || "";
            if (chunk) {
              fullText += chunk;
              if (typeof onChunk   === "function") onChunk(chunk);
              if (typeof onMessage === "function") onMessage(fullText);
            }
          } catch { /* partial chunk */ }
        }
      }

      this.sessionHistory.push({ role: "assistant", content: fullText });
      if (file && typeof onFileAttached === "function") {
        onFileAttached({ fileName: file.name });
        this._syncSessionFiles();
      }
    } catch (err) {
      if (typeof onError === "function") onError(err.message || "Stream failed");
    }
    return fullText;
  }

  async _syncSessionFiles() {
    try {
      const res  = await fetch(`${this.baseUrl}/files/list`);
      const data = await res.json();
      if (data.success) this._sessionFiles = data.files || [];
    } catch { /* non-fatal */ }
  }

  getSessionFiles() { return this._sessionFiles; }

  async clearFiles() {
    try { await fetch(`${this.baseUrl}/files/clear`, { method: "DELETE" }); } catch {}
    this._sessionFiles = [];
  }

  async checkIntent(message, context = {}) {
    try {
      const res = await fetch(`${this.baseUrl}/api/aqua/intent-check`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message, ...context }),
      });
      return await res.json();
    } catch { return { intent: "chat", confidence: 0, targetFiles: [] }; }
  }

  async loadContext(projectId, fileName = null) {
    try {
      const url = `${this.baseUrl}/api/aqua/context/${projectId}${fileName ? `?file=${encodeURIComponent(fileName)}` : ""}`;
      return await (await fetch(url)).json();
    } catch { return null; }
  }

  clearHistory() { this.sessionHistory = []; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-wire: standard AQUIPLEX workspace layout
// ─────────────────────────────────────────────────────────────────────────────
(function autoWire() {
  if (typeof document === "undefined") return;

  document.addEventListener("DOMContentLoaded", () => {
    const chatInput     = document.getElementById("aqua-chat-input");
    const sendBtn       = document.getElementById("aqua-send-btn");
    const chatLog       = document.getElementById("aqua-chat-log");
    const fileInput     = document.getElementById("aqua-file-input");
    const attachmentBar = document.getElementById("aqua-attachment-bar");
    const previewIframe = document.getElementById("preview-iframe");

    if (!chatInput || !sendBtn) return;

    const aqua = new AquaClient({ baseUrl: "/" });
    let pendingFile = null;

    // File input wiring
    if (fileInput) {
      fileInput.addEventListener("change", (e) => {
        const f = e.target.files?.[0];
        if (f) { pendingFile = f; showAttachmentBadge(f.name); }
      });
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    }

    function showAttachmentBadge(fileName) {
      if (!attachmentBar) return;
      attachmentBar.innerHTML = `<span class="aqua-attachment-badge">📎 ${escapeHtml(fileName)} <button onclick="window._aquaClearAttachment()" title="Remove">✕</button></span>`;
      attachmentBar.style.display = "flex";
    }

    window._aquaClearAttachment = () => {
      pendingFile = null;
      if (fileInput)     fileInput.value = "";
      if (attachmentBar) { attachmentBar.innerHTML = ""; attachmentBar.style.display = "none"; }
    };

    function getProjectId() {
      return document.body.dataset.projectId || document.getElementById("project-id-input")?.value || null;
    }

    function getFileName() {
      return document.querySelector(".file-tab.active")?.dataset?.filename ||
             document.getElementById("active-file-name")?.textContent?.trim() || null;
    }

    function appendMessage(role, text) {
      if (!chatLog) return;
      const el = document.createElement("div");
      el.className = `aqua-msg aqua-msg--${role}`;
      el.textContent = text;
      chatLog.appendChild(el);
      chatLog.scrollTop = chatLog.scrollHeight;
    }

    function showIntentBadge(intent) {
      const badge = document.getElementById("aqua-intent-badge");
      if (badge) { badge.textContent = intent.replace(/_/g, " "); badge.dataset.intent = intent; }
    }

    async function onSend() {
      const msg = chatInput.value.trim();
      if (!msg && !pendingFile) return;

      chatInput.value = "";
      appendMessage("user", msg || `📎 ${pendingFile?.name}`);

      const fileToSend = pendingFile;
      window._aquaClearAttachment();

      const result = await aqua.send(msg || "Please analyze and summarize this file.", {
        file:      fileToSend,
        projectId: getProjectId(),
        fileName:  getFileName(),

        onMessage: (text) => appendMessage("assistant", text),

        onFileAttached: (info) => {
          console.log(`[AQUA] File parsed: ${info.fileName}`);
        },

        onPreviewRefresh: () => {
          if (previewIframe) { const s = previewIframe.src; previewIframe.src = ""; previewIframe.src = s; }
        },

        onError: (err) => appendMessage("error", `⚠️ ${err}`),
      });

      if (result?.intent) showIntentBadge(result.intent);
      if (result?.projectId && !getProjectId() && document.body.dataset) {
        document.body.dataset.projectId = result.projectId;
      }
    }

    sendBtn.addEventListener("click", onSend);
    chatInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onSend(); }
    });

    // Drag-and-drop support
    if (chatLog) {
      chatLog.addEventListener("dragover", (e) => e.preventDefault());
      chatLog.addEventListener("drop",     (e) => {
        e.preventDefault();
        const f = e.dataTransfer?.files?.[0];
        if (f) { pendingFile = f; showAttachmentBadge(f.name); }
      });
    }

    console.log("[AQUA] Client auto-wired ✅ (file support + session memory enabled)");
  });
})();
