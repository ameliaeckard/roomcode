import * as Y from "/static/vendor/yjs/yjs.mjs";
import { CodemirrorBinding } from "/static/vendor/yjs/y-codemirror.js";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "/static/vendor/yjs/y-protocols-awareness.js";

(function () {
  "use strict";

  const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute("content");
  const socket = io({ auth: { csrf_token: csrfToken } });
  let currentPath = null;
  let currentMode = "null";
  let cm = null;
  let roomLocked = false;

  // Live collaborative state for whichever file is currently open. Torn
  // down and rebuilt from scratch every time the open file changes.
  let yState = null; // { path, ydoc, awareness, binding }

  const el = (id) => document.getElementById(id);

  cm = CodeMirror(el("editorHost"), {
    value: "",
    lineNumbers: true,
    theme: document.body.classList.contains("theme-light") ? "roomcode-light" : "roomcode-dark",
    autoCloseBrackets: true,
    styleActiveLine: true,
    tabSize: 4,
    indentUnit: 4,
    mode: "null",
  });

  socket.on("tree_update", loadTree);

  const jsonHeaders = () => ({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken });

  function moveItem(src, destDir) {
    fetch("/api/move", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ src, destDir }),
    }).then((r) => {
      if (r.ok) loadTree();
      else alert("Couldn't move that item there.");
    });
  }

  function makeDropTarget(el_, destDirPath) {
    el_.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      el_.classList.add("drop-target");
    });
    el_.addEventListener("dragleave", () => el_.classList.remove("drop-target"));
    el_.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      el_.classList.remove("drop-target");
      const src = e.dataTransfer.getData("text/plain");
      if (!src || src === destDirPath) return;
      moveItem(src, destDirPath);
    });
  }

  function startRenameItem(row, node) {
    if (row.querySelector(".tree-rename-input")) return; // already renaming
    const labelEl = row.querySelector(".tree-label");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "tree-rename-input";
    input.value = node.name;
    labelEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    function cleanup() {
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("blur", onBlur);
      input.replaceWith(labelEl);
    }
    function commit() {
      if (done) return;
      done = true;
      const newName = input.value.trim();
      cleanup();
      if (!newName || newName === node.name) return;
      fetch("/api/rename", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ path: node.path, newName }),
      }).then((r) => {
        if (r.ok) loadTree();
        else alert("Couldn't rename that — the name may already be taken.");
      });
    }
    function cancel() {
      if (done) return;
      done = true;
      cleanup();
    }
    function onKeydown(e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    function onBlur() { commit(); }
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("blur", onBlur);
  }

  function renderTree(nodes, container, expandedPaths = new Set()) {
    nodes.forEach((node) => {
      const wrap = document.createElement("div");
      wrap.className = "tree-node";

      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = node.path;
      row.draggable = true;
      const icon = node.type === "dir" ? "&#9656;" : "-";
      const deleteHtml = node.owned ? '<span class="tree-delete" title="Delete">x</span>' : "";
      row.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-label"></span>${deleteHtml}`;
      row.querySelector(".tree-label").textContent = node.name;
      wrap.appendChild(row);

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", node.path);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));

      if (node.owned) {
        row.querySelector(".tree-label").addEventListener("dblclick", (e) => {
          e.stopPropagation();
          startRenameItem(row, node);
        });
      }

      const deleteEl = row.querySelector(".tree-delete");
      if (deleteEl) {
        deleteEl.addEventListener("click", (e) => {
          e.stopPropagation();
          if (confirm(`Delete "${node.name}"? This cannot be undone.`)) {
            fetch("/api/delete", {
              method: "POST",
              headers: jsonHeaders(),
              body: JSON.stringify({ path: node.path }),
            }).then(loadTree);
          }
        });
      }

      if (node.type === "dir") {
        makeDropTarget(row, node.path);
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "tree-children";
        const isExpanded = expandedPaths.has(node.path);
        childrenDiv.style.display = isExpanded ? "flex" : "none";
        const iconEl = row.querySelector(".tree-icon");
        iconEl.innerHTML = isExpanded ? "&#9662;" : "&#9656;";
        renderTree(node.children || [], childrenDiv, expandedPaths);
        wrap.appendChild(childrenDiv);
        row.addEventListener("click", () => {
          const open = childrenDiv.style.display === "none";
          childrenDiv.style.display = open ? "flex" : "none";
          iconEl.innerHTML = open ? "&#9662;" : "&#9656;";
        });
      } else {
        row.addEventListener("click", () => openFile(node.path));
      }
      container.appendChild(wrap);
    });
  }

  function loadTree() {
    fetch("/api/tree").then((r) => r.json()).then((data) => {
      const container = el("fileTree");
      // Remember which folders are open so a tree_update doesn't collapse them.
      const expandedPaths = new Set();
      container.querySelectorAll(".tree-children").forEach((ch) => {
        if (ch.style.display !== "none") {
          const row = ch.closest(".tree-node").querySelector(".tree-row");
          if (row && row.dataset.path) expandedPaths.add(row.dataset.path);
        }
      });
      container.innerHTML = "";
      renderTree(data, container, expandedPaths);
    });
  }

  makeDropTarget(el("fileTree"), "");

  function markActiveRow(path) {
    document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("active"));
    const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.add("active");
  }

  const remoteUserColors = {};
  const USER_COLOR_PALETTE = ["#e06c75", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66"];

  function colorForUser(name) {
    if (remoteUserColors[name]) return remoteUserColors[name];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    const color = USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length];
    remoteUserColors[name] = color;
    return color;
  }

  // Yjs keeps everyone's edits merged live (no more "last save wins"), and
  // y-codemirror's binding renders everyone else's cursor with their name
  // attached directly on top of the editor — this replaces the old
  // hand-rolled change-relay and selection-highlight code entirely.
  function teardownYjsState() {
    if (!yState) return;
    if (yState.binding) yState.binding.destroy();
    if (yState.awareness) yState.awareness.destroy();
    yState = null;
  }

  function setupYjsState(path) {
    teardownYjsState();
    const ydoc = new Y.Doc();
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField("user", { name: window.__USERNAME__, color: colorForUser(window.__USERNAME__) });

    const state = { path, ydoc, awareness, binding: null };
    yState = state;

    ydoc.on("update", (update, origin) => {
      if (origin === "remote" || yState !== state) return;
      socket.emit("yjs_update", { path, update });
    });
    awareness.on("update", ({ added, updated, removed }) => {
      if (yState !== state) return;
      const changed = added.concat(updated, removed);
      const update = encodeAwarenessUpdate(awareness, changed);
      socket.emit("awareness_update", { path, update, clientId: ydoc.clientID });
    });

    socket.emit("yjs_sync", { path });
  }

  socket.on("yjs_sync_response", (data) => {
    if (!yState || data.path !== yState.path || yState.binding) return;
    Y.applyUpdate(yState.ydoc, new Uint8Array(data.state), "remote");
    const ytext = yState.ydoc.getText("content");
    yState.binding = new CodemirrorBinding(ytext, cm, yState.awareness);
  });

  socket.on("yjs_update", (data) => {
    if (!yState || data.path !== yState.path) return;
    Y.applyUpdate(yState.ydoc, new Uint8Array(data.update), "remote");
  });

  socket.on("awareness_update", (data) => {
    if (!yState || data.path !== yState.path) return;
    applyAwarenessUpdate(yState.awareness, new Uint8Array(data.update), "remote");
  });

  function openFile(path) {
    // /api/file-meta returns only mode + binary flag — no file content.
    // Actual text arrives via the Yjs sync response, so there's no point
    // sending it twice over the wire.
    fetch("/api/file-meta?path=" + encodeURIComponent(path)).then((r) => r.json()).then((data) => {
      if (data.binary) {
        alert("This file doesn't look like text. You can't open it in the editor.");
        return;
      }
      currentPath = data.path;
      currentMode = data.mode;
      cm.setOption("mode", currentMode);
      el("tabLabel").textContent = data.path;
      el("tabLabel").classList.remove("tab-empty");
      markActiveRow(path);
      setupYjsState(data.path);
      socket.emit("open_file", { path: data.path });
      const historyBtn = el("fileHistoryBtn");
      if (historyBtn) historyBtn.classList.remove("hidden");
      el("historyPanel").classList.add("hidden");
    });
  }

  function saveFile() {
    if (!currentPath) return;
    fetch("/api/save", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ path: currentPath }),
    }).then((r) => flashTab(r.ok ? "Saved" : "Locked"));
  }

  let flashTimeout = null;
  function flashTab(msg) {
    const label = el("tabLabel");
    if (flashTimeout) clearTimeout(flashTimeout);
    label.textContent = `${currentPath}  •  ${msg}`;
    flashTimeout = setTimeout(() => {
      label.textContent = currentPath;
      flashTimeout = null;
    }, 1200);
  }

  const saveBtnEl = document.getElementById("saveBtn");
  if (saveBtnEl) saveBtnEl.addEventListener("click", saveFile);
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      saveFile();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
      e.preventDefault();
      runFile(window.__IS_HOST__ ? "all" : "local");
    }
  });

  // Output can now arrive in arbitrary chunks (even a single character, so
  // an input() prompt with no trailing newline shows up promptly) rather
  // than one full line at a time. Keep appending to the same open line
  // until an actual "\n" closes it, instead of starting a new block per
  // chunk — otherwise a prompt streamed a character at a time would render
  // as one letter per row instead of a sentence.
  let openTermLine = null;
  function ensureTermLine(cls) {
    if (!openTermLine) {
      openTermLine = document.createElement("div");
      openTermLine.className = "term-line" + (cls ? " " + cls : "");
      el("terminalOutput").appendChild(openTermLine);
    }
    return openTermLine;
  }
  function appendTermLine(text, cls) {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (part !== "") ensureTermLine(cls).textContent += part;
      if (i < parts.length - 1) openTermLine = null; // a newline followed this part
    });
    const out = el("terminalOutput");
    out.scrollTop = out.scrollHeight;
  }

  function runFile(scope) {
    // scope "all" (host-only, broadcasts to the whole session) vs "local"
    // (anyone, but only that one connection ever sees the output).
    if (scope === "all" && !window.__IS_HOST__) return;
    if (!currentPath) {
      appendTermLine("Open a file before running it.\n", "line-error");
      return;
    }
    saveFile();
    const btn = document.getElementById(scope === "all" ? "runBtn" : "runLocalBtn");
    if (btn) btn.disabled = true;
    socket.emit("run", { path: currentPath, scope });
  }

  socket.on("run_output", (data) => {
    const clsMap = { stderr: "line-stderr", error: "line-error", system: "line-system", stdin: "line-stdin" };
    appendTermLine(data.text, clsMap[data.stream]);
  });

  // Tracks which scope ("all" or "local") currently has a live process
  // waiting on input, so the input box knows where to route what you type.
  let activeRunScope = null;
  socket.on("run_started", (data) => {
    activeRunScope = data.scope;
    el("runInputRow").classList.remove("hidden");
    el("runInput").focus();
  });
  socket.on("run_done", (data) => {
    const btn = document.getElementById(data.scope === "all" ? "runBtn" : "runLocalBtn");
    if (btn) btn.disabled = false;
    if (activeRunScope === data.scope) {
      activeRunScope = null;
      el("runInputRow").classList.add("hidden");
    }
  });

  el("runInput").addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !activeRunScope) return;
    e.preventDefault();
    const text = el("runInput").value;
    socket.emit("run_input", { text, scope: activeRunScope });
    el("runInput").value = "";
  });

  const runBtnEl = document.getElementById("runBtn");
  if (runBtnEl) runBtnEl.addEventListener("click", () => runFile("all"));
  const runLocalBtnEl = document.getElementById("runLocalBtn");
  if (runLocalBtnEl) runLocalBtnEl.addEventListener("click", () => runFile("local"));
  el("clearTermBtn").addEventListener("click", () => { el("terminalOutput").innerHTML = ""; });

  function triggerDownload(url) {
    const a = document.createElement("a");
    a.href = url;
    a.download = "";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  el("downloadFileBtn").addEventListener("click", () => {
    if (!currentPath) { alert("Open a file first."); return; }
    saveFile();
    triggerDownload("/api/download-file?path=" + encodeURIComponent(currentPath));
  });
  el("downloadProjectBtn").addEventListener("click", () => {
    triggerDownload("/api/download-project");
  });

  el("leaveBtn").addEventListener("click", (e) => {
    const url = e.currentTarget.dataset.logoutUrl;
    socket.disconnect();
    window.location = url;
  });

  function startCreateItem(type) {
    const container = el("fileTree");
    const existingPending = container.querySelector(".tree-row.editing");
    if (existingPending) existingPending.closest(".tree-node").remove();

    const wrap = document.createElement("div");
    wrap.className = "tree-node";
    const row = document.createElement("div");
    row.className = "tree-row editing";
    const icon = type === "dir" ? "&#9656;" : "-";
    row.innerHTML = `<span class="tree-icon">${icon}</span><input type="text" class="tree-rename-input">`;
    wrap.appendChild(row);
    container.prepend(wrap);

    const input = row.querySelector(".tree-rename-input");
    input.focus();

    let done = false;
    function cleanup() {
      input.removeEventListener("keydown", onKeydown);
      input.removeEventListener("blur", onBlur);
      wrap.remove();
    }
    function commit() {
      if (done) return;
      done = true;
      const name = input.value.trim();
      cleanup();
      if (!name) return;
      fetch("/api/new", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ path: name, type }),
      }).then((r) => {
        if (r.ok) {
          loadTree();
          if (type === "file") openFile(name);
        } else {
          alert("Couldn't create that item; it may already exist.");
        }
      });
    }
    function cancel() {
      if (done) return;
      done = true;
      cleanup();
    }
    function onKeydown(e) {
      if (e.key === "Enter") { e.preventDefault(); commit(); }
      else if (e.key === "Escape") { e.preventDefault(); cancel(); }
    }
    function onBlur() { commit(); }
    input.addEventListener("keydown", onKeydown);
    input.addEventListener("blur", onBlur);
  }

  el("newFileBtn").addEventListener("click", () => startCreateItem("file"));
  el("newFolderBtn").addEventListener("click", () => startCreateItem("dir"));

  function escapeHtml(str) {
    return str.replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  const PRESENCE_VISIBLE = 3;
  let lastPresenceList = [];
  socket.on("presence", (list) => {
    lastPresenceList = list;
    const target = el("presenceList");
    if (!list.length) { target.textContent = ""; return; }
    const shown = list.slice(0, PRESENCE_VISIBLE);
    let html = "Online: " + shown.map((u) => {
      const cls = u.username === window.__USERNAME__ ? ' class="presence-me"' : "";
      const hostTag = u.is_host ? ' <span class="presence-host">(host)</span>' : "";
      return `<span${cls}>${escapeHtml(u.username)}</span>${hostTag}`;
    }).join(", ");
    const extra = list.length - PRESENCE_VISIBLE;
    if (extra > 0) {
      const allNames = list.map((u) => u.username).join(", ");
      html += ` <span class="presence-more" title="${escapeHtml(allNames)}">+${extra}</span>`;
    }
    target.innerHTML = html;
    renderParticipants(list);
    renderPromoteSelect(list);
  });

  function renderParticipants(list) {
    const target = el("participantsList");
    const label = el("participantsLabel");
    if (!target) return;
    if (label) label.textContent = `Participants — ${list.length} online`;
    // The list itself just scrolls (see .participants-list in style.css),
    // so this works the same whether there are 3 people or 300 — nothing
    // gets hidden behind a hover tooltip like the topbar's compact version.
    target.innerHTML = list.map((u) => {
      const hostTag = u.is_host ? ' <span class="presence-host">(host)</span>' : "";
      return `<div class="participant-row">${escapeHtml(u.username)}${hostTag}</div>`;
    }).join("") || '<div class="participant-row">Just you.</div>';
  }

  function renderPromoteSelect(list) {
    const select = el("promoteHostSelect");
    if (!select) return;
    const previous = select.value;
    const candidates = list.filter((u) => !u.is_host);
    select.innerHTML = candidates
      .map((u) => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.username)}</option>`)
      .join("");
    if (candidates.some((u) => u.username === previous)) select.value = previous;
  }

  // ---------------- Host status (main host or promoted) ----------------
  function applyHostUI(isHost) {
    window.__IS_HOST__ = isHost;
    document.body.classList.toggle("is-host", isHost);
  }
  applyHostUI(window.__IS_HOST__);
  socket.on("host_status_changed", (data) => applyHostUI(!!data.is_host));

  const promoteHostBtn = el("promoteHostBtn");
  if (promoteHostBtn) {
    promoteHostBtn.addEventListener("click", () => {
      const select = el("promoteHostSelect");
      if (!select || !select.value) return;
      socket.emit("promote_host", { username: select.value });
    });
  }

  const revealPasswordBtn = el("revealPasswordBtn");
  if (revealPasswordBtn) {
    revealPasswordBtn.addEventListener("click", () => {
      fetch("/api/room-info").then((r) => r.json()).then((data) => {
        el("roomPasswordValue").textContent = data.password;
      });
    });
  }

  // ---------------- Per-file edit history ----------------
  function loadFileHistory(path) {
    const target = el("historyList");
    if (!target) return;
    fetch("/api/history?path=" + encodeURIComponent(path)).then((r) => r.json()).then((list) => {
      if (!list.length) { target.innerHTML = '<div class="history-row">No edits yet.</div>'; return; }
      target.innerHTML = list.map((h) => {
        const when = new Date(h.ts * 1000).toLocaleString();
        return `<div class="history-row"><span>${escapeHtml(h.username)}</span> <span class="history-time">${when}</span></div>`;
      }).join("");
    });
  }

  const fileHistoryBtn = el("fileHistoryBtn");
  if (fileHistoryBtn) {
    fileHistoryBtn.addEventListener("click", () => {
      if (!currentPath) return;
      el("historyPanelTitle").textContent = `History — ${currentPath}`;
      loadFileHistory(currentPath);
      el("historyPanel").classList.remove("hidden");
    });
  }
  const closeHistoryBtn = el("closeHistory");
  if (closeHistoryBtn) closeHistoryBtn.addEventListener("click", () => el("historyPanel").classList.add("hidden"));

function applyTheme(theme, persist) {
    document.body.classList.remove("theme-dark", "theme-light");
    document.body.classList.add("theme-" + theme);
    cm.setOption("theme", theme === "light" ? "roomcode-light" : "roomcode-dark");
    document.querySelectorAll('[data-theme]').forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === theme);
    });
    if (persist !== false) localStorage.setItem("roomcode-theme", theme);
  }

  function applyLayout(layout) {
    const main = el("main");
    main.classList.remove("split-vertical", "split-horizontal");
    main.classList.add("split-" + layout);
    document.querySelectorAll('[data-layout]').forEach((b) => {
      b.classList.toggle("active", b.dataset.layout === layout);
    });
    localStorage.setItem("roomcode-layout", layout);
    restoreSplit();
    cm.refresh();
  }

  document.querySelectorAll('[data-theme]').forEach((b) => {
    b.addEventListener("click", () => applyTheme(b.dataset.theme));
  });
  document.querySelectorAll('[data-layout]').forEach((b) => {
    b.addEventListener("click", () => applyLayout(b.dataset.layout));
  });

  el("settingsBtn").addEventListener("click", () => {
    const panel = el("settingsPanel");
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      renderParticipants(lastPresenceList);
      renderPromoteSelect(lastPresenceList);
    }
  });
  el("closeSettings").addEventListener("click", () => el("settingsPanel").classList.add("hidden"));

  function applySidebarCollapsed(collapsed) {
    el("sidebar").classList.toggle("collapsed", collapsed);
    el("sidebarToggle").innerHTML = collapsed ? "&#9654;" : "&#9664;";
    localStorage.setItem("roomcode-sidebar-collapsed", collapsed ? "1" : "0");
  }
  el("sidebarToggle").addEventListener("click", () => {
    applySidebarCollapsed(!el("sidebar").classList.contains("collapsed"));
  });
  applySidebarCollapsed(localStorage.getItem("roomcode-sidebar-collapsed") === "1");

  // ---------------- Host-controlled edit lock ----------------
  function applyLockState(locked) {
    roomLocked = locked;
    const iAmLocked = locked && !window.__IS_HOST__;
    cm.setOption("readOnly", iAmLocked);
    el("editorPane").classList.toggle("read-only", iAmLocked);
    const indicator = document.getElementById("lockIndicator");
    if (indicator) indicator.classList.toggle("hidden", !locked);
    const toggleBtn = document.getElementById("lockToggleBtn");
    if (toggleBtn) toggleBtn.textContent = locked ? "Unlock" : "Lock";
  }
  socket.on("lock_changed", (data) => applyLockState(!!data.locked));

  const lockToggleBtn = document.getElementById("lockToggleBtn");
  if (lockToggleBtn) {
    lockToggleBtn.addEventListener("click", () => {
      socket.emit("set_lock", { locked: !roomLocked });
    });
  }

  function splitStorageKey() {
    return el("main").classList.contains("split-vertical")
      ? "roomcode-split-vertical" : "roomcode-split-horizontal";
  }

  function restoreSplit() {
    const saved = localStorage.getItem(splitStorageKey());
    el("editorPane").style.flex = saved ? `0 0 ${saved}px` : "";
  }

  (function initSplitter() {
    const handle = el("splitHandle");
    let dragging = false;

    handle.addEventListener("mousedown", (e) => {
      dragging = true;
      document.body.style.userSelect = "none";
      e.preventDefault();
    });

    window.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const main = el("main");
      const rect = main.getBoundingClientRect();
      const isVertical = main.classList.contains("split-vertical");
      let size = isVertical ? (e.clientY - rect.top) : (e.clientX - rect.left);
      const total = isVertical ? rect.height : rect.width;
      size = Math.max(80, Math.min(size, total - 80));
      el("editorPane").style.flex = `0 0 ${size}px`;
      localStorage.setItem(splitStorageKey(), size);
      cm.refresh();
    });

    window.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      document.body.style.userSelect = "";
    });
  })();

  function systemTheme() {
    return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark" : "light";
  }

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
      if (!localStorage.getItem("roomcode-theme")) applyTheme(e.matches ? "dark" : "light");
    });
  }
  const savedTheme = localStorage.getItem("roomcode-theme");
  applyTheme(savedTheme || systemTheme(), !!savedTheme);
  applyLayout(localStorage.getItem("roomcode-layout") || "vertical");

  loadTree();
  cm.refresh();
})();
