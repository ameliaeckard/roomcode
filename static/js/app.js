// app.js
// updated 2026-07-14 by Amelia Eckard
// Client-side logic for the RoomCode IDE - editor, file tree, terminal, presence, Yjs live sync, and settings.

import * as Y from "/static/vendor/yjs/yjs.mjs";
import { CodemirrorBinding } from "/static/vendor/yjs/y-codemirror.js";
import { Awareness, encodeAwarenessUpdate, applyAwarenessUpdate } from "/static/vendor/yjs/y-protocols-awareness.js";

(function () {
  "use strict";

  const csrfToken = document.querySelector('meta[name="csrf-token"]').getAttribute("content");
  const socket = io({
    auth: { csrf_token: csrfToken },
    // The dev server's WebSocket handling can drop a connection silently
    // (no error shown to the user, edits just stop reaching the server) --
    // reconnect aggressively rather than leaving someone editing into a
    // void, and force a full state resync below once back online.
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5000,
  });
  let currentPath = null;
  let currentMode = "null";
  let cm = null;
  let roomLocked = false;

  let yState = null;

  /** @param {string} id */
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
    // CodeMirror's default keymap binds Insert to toggle overwrite mode --
    // if that gets hit by accident, typing starts replacing the character
    // ahead of the cursor instead of inserting. Always stay in insert mode.
    extraKeys: { Insert: false },
  });

  // Line-comment prefix per CodeMirror mode name (mirrors CODEMIRROR_MODES
  // in server.py). Modes with no simple single-line comment syntax are
  // left out -- "/" just types a literal slash for those, same as normal.
  const LINE_COMMENT_BY_MODE = {
    python: "#", ruby: "#", shell: "#", yaml: "#", null: "#",
    javascript: "//", jsx: "//", go: "//",
    "text/x-csrc": "//", "text/x-c++src": "//", "text/x-java": "//",
    sql: "--",
  };

  /** Toggle a line-comment prefix on every selected line (or do nothing without a selection). */
  function toggleLineComments() {
    if (!cm.somethingSelected()) return;
    const prefix = LINE_COMMENT_BY_MODE[cm.getOption("mode")];
    if (!prefix) return;
    const from = cm.getCursor("from");
    const to = cm.getCursor("to");
    const lastLine = to.ch === 0 && to.line > from.line ? to.line - 1 : to.line;
    const lines = [];
    for (let i = from.line; i <= lastLine; i++) lines.push(cm.getLine(i));
    const commentable = lines.filter((l) => l.trim() !== "");
    const allCommented = commentable.length > 0 && commentable.every((l) => l.trimStart().startsWith(prefix));
    cm.operation(() => {
      for (let i = from.line; i <= lastLine; i++) {
        const line = cm.getLine(i);
        if (line.trim() === "") continue;
        if (allCommented) {
          const idx = line.indexOf(prefix);
          if (idx === -1) continue;
          let end = idx + prefix.length;
          if (line[end] === " ") end += 1;
          cm.replaceRange("", { line: i, ch: idx }, { line: i, ch: end });
        } else {
          cm.replaceRange(`${prefix} `, { line: i, ch: 0 }, { line: i, ch: 0 });
        }
      }
    });
  }
  cm.on("keydown", (instance, e) => {
    if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey && cm.somethingSelected()) {
      e.preventDefault();
      toggleLineComments();
    }
  });

  socket.on("tree_update", loadTree);

  // Surface connection drops instead of failing silently, and force a full
  // Yjs resync on reconnect -- a dropped connection means edits may have
  // been missed in both directions while offline, and the local Yjs doc
  // alone can't tell that happened.
  let hasConnectedBefore = false;
  function setConnectionStatus(connected) {
    const indicator = el("connectionStatus");
    if (indicator) indicator.classList.toggle("hidden", connected);
  }
  socket.on("connect", () => {
    setConnectionStatus(true);
    if (hasConnectedBefore && currentPath) {
      setupYjsState(currentPath);
      socket.emit("open_file", { path: currentPath });
    }
    hasConnectedBefore = true;
  });
  socket.on("disconnect", () => setConnectionStatus(false));

  /** @returns {Object} headers for JSON API requests including CSRF token */
  const jsonHeaders = () => ({ "Content-Type": "application/json", "X-CSRF-Token": csrfToken });

  /**
   * Move a file or folder to a new parent directory via the API.
   * @param {string} src - relative path of the item to move
   * @param {string} destDir - relative path of the destination folder
   */
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

  /**
   * Attach drag-and-drop drop-target behaviour to a tree element.
   * @param {HTMLElement} el_ - element to make a drop target
   * @param {string} destDirPath - the session-relative path this element represents
   */
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

  /**
   * Replace a tree label with an inline rename input, committing on Enter or blur.
   * @param {HTMLElement} row - the .tree-row element
   * @param {{ name: string, path: string }} node - the file/dir node being renamed
   */
  function startRenameItem(row, node) {
    if (row.querySelector(".tree-rename-input")) return;
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
        else alert("Couldn't rename that. The name may already be taken.");
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

  /**
   * Recursively render a file-tree array into a container element.
   * @param {Array} nodes - tree nodes from /api/tree
   * @param {HTMLElement} container - element to append rendered nodes into
   * @param {Set<string>} expandedPaths - paths whose folder children should start open
   */
  function renderTree(nodes, container, expandedPaths = new Set()) {
    nodes.forEach((node) => {
      const wrap = document.createElement("div");
      wrap.className = "tree-node";

      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = node.path;
      row.draggable = true;
      const icon = node.type === "dir" ? "&#9656;" : "-";
      const addHtml = node.type === "dir" ? '<span class="tree-add" title="New file in this folder">+</span>' : "";
      const deleteHtml = node.owned ? '<span class="tree-delete" title="Delete">x</span>' : "";
      row.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-label"></span>${addHtml}${deleteHtml}`;
      row.querySelector(".tree-label").textContent = node.name;
      wrap.appendChild(row);

      const addEl = row.querySelector(".tree-add");
      if (addEl) {
        addEl.addEventListener("click", (e) => {
          e.stopPropagation();
          startCreateItem("file", node.path);
        });
      }

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

  /** Fetch the current file tree from the server and re-render it, preserving folder open state. */
  function loadTree() {
    fetch("/api/tree").then((r) => r.json()).then((data) => {
      const container = el("fileTree");
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

  /**
   * Highlight the tree row for the given path and clear all others.
   * @param {string} path
   */
  function markActiveRow(path) {
    document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("active"));
    const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.add("active");
  }

  const remoteUserColors = {};
  const USER_COLOR_PALETTE = ["#e06c75", "#98c379", "#e5c07b", "#c678dd", "#56b6c2", "#d19a66"];

  /**
   * Return a stable color for a username, derived from a hash of the name.
   * @param {string} name
   * @returns {string} hex color
   */
  function colorForUser(name) {
    if (remoteUserColors[name]) return remoteUserColors[name];
    let hash = 0;
    for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    const color = USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length];
    remoteUserColors[name] = color;
    return color;
  }

  /** Destroy the Yjs binding, awareness, and doc for the current file. */
  function teardownYjsState() {
    if (!yState) return;
    if (yState.binding) yState.binding.destroy();
    if (yState.awareness) yState.awareness.destroy();
    yState = null;
  }

  /**
   * Set up a new Yjs doc + awareness + CodemirrorBinding for the given file path,
   * then request the server's current state via yjs_sync.
   * @param {string} path
   */
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

  /**
   * Open a file in the editor: fetch its metadata, set CodeMirror mode, and initiate Yjs sync.
   * @param {string} path
   */
  function openFile(path) {
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

  /** Save the current file via /api/save and flash the result in the tab bar. */
  function saveFile() {
    if (!currentPath) return;
    fetch("/api/save", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ path: currentPath }),
    }).then((r) => flashTab(r.ok ? "Saved" : "Locked"));
  }

  let flashTimeout = null;

  /**
   * Briefly append a status message to the tab label, then restore the path.
   * @param {string} msg
   */
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

  let openTermLine = null;

  /**
   * Return the current open terminal line div, creating one if needed.
   * @param {string} cls - CSS class to apply to a newly created line
   * @returns {HTMLElement}
   */
  function ensureTermLine(cls) {
    if (!openTermLine) {
      openTermLine = document.createElement("div");
      openTermLine.className = "term-line" + (cls ? " " + cls : "");
      el("terminalOutput").appendChild(openTermLine);
    }
    return openTermLine;
  }

  /**
   * Append text to the terminal, splitting on newlines to open/close line elements.
   * @param {string} text
   * @param {string} cls - CSS class for the line type (e.g. "line-stderr")
   */
  function appendTermLine(text, cls) {
    const parts = text.split("\n");
    parts.forEach((part, i) => {
      if (part !== "") ensureTermLine(cls).textContent += part;
      if (i < parts.length - 1) openTermLine = null;
    });
    const out = el("terminalOutput");
    out.scrollTop = out.scrollHeight;
  }

  /**
   * Trigger a file run via the socket. Scope 'all' broadcasts to the session (host only);
   * 'local' is visible only to the current user.
   * @param {"all"|"local"} scope
   */
  function runFile(scope) {
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

  /**
   * Trigger a browser download by briefly appending an <a> to the DOM.
   * @param {string} url
   */
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

  /**
   * Inject a new-item input row and create the item on commit.
   * @param {"file"|"dir"} type
   * @param {string} [parentPath] - if given, the item is created inside this folder
   *   (which is auto-expanded) instead of at the tree root.
   */
  function startCreateItem(type, parentPath = "") {
    let container = el("fileTree");
    if (parentPath) {
      const parentRow = document.querySelector(`.tree-row[data-path="${CSS.escape(parentPath)}"]`);
      const childrenDiv = parentRow && parentRow.nextElementSibling;
      if (childrenDiv && childrenDiv.classList.contains("tree-children")) {
        childrenDiv.style.display = "flex";
        const iconEl = parentRow.querySelector(".tree-icon");
        if (iconEl) iconEl.innerHTML = "&#9662;";
        container = childrenDiv;
      }
    }
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
      const fullPath = parentPath ? `${parentPath}/${name}` : name;
      fetch("/api/new", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ path: fullPath, type }),
      }).then((r) => {
        if (r.ok) {
          loadTree();
          if (type === "file") openFile(fullPath);
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

  /**
   * Escape a string for safe insertion into HTML.
   * @param {string} str
   * @returns {string}
   */
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
    renderCurrentHosts(list);
  });

  /**
   * Render the full participant list inside the settings panel.
   * @param {Array} list - presence list from the server
   */
  function renderParticipants(list) {
    const target = el("participantsList");
    const label = el("participantsLabel");
    if (!target) return;
    if (label) label.textContent = `Participants (${list.length} online)`;
    target.innerHTML = list.map((u) => {
      const hostTag = u.is_host ? ' <span class="presence-host">(host)</span>' : "";
      return `<div class="participant-row">${escapeHtml(u.username)}${hostTag}</div>`;
    }).join("") || '<div class="participant-row">Just you.</div>';
  }

  /**
   * Populate the "Make host" dropdown with non-host participants.
   * @param {Array} list - presence list from the server
   */
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

  /**
   * Apply or remove host-related CSS classes from the body.
   * @param {boolean} isHost
   */
  function applyHostUI(isHost) {
    window.__IS_HOST__ = isHost;
    document.body.classList.toggle("is-host", isHost);
  }
  applyHostUI(window.__IS_HOST__);
  document.body.classList.toggle("is-main-host", !!window.__IS_MAIN_HOST__);
  socket.on("host_status_changed", (data) => applyHostUI(!!data.is_host));

  const promoteHostBtn = el("promoteHostBtn");
  if (promoteHostBtn) {
    promoteHostBtn.addEventListener("click", () => {
      const select = el("promoteHostSelect");
      if (!select || !select.value) return;
      socket.emit("promote_host", { username: select.value });
    });
  }

  /**
   * Render the list of currently promoted hosts with "Revoke host" buttons.
   * Only shown to the main host. Hidden when there are no promoted hosts.
   * @param {Array} list - presence list from the server
   */
  function renderCurrentHosts(list) {
    const row = el("currentHostsRow");
    const container = el("currentHostsList");
    if (!row || !container) return;
    const promoted = list.filter((u) => u.is_host && u.username !== window.__USERNAME__);
    row.style.display = promoted.length ? "" : "none";
    container.innerHTML = promoted.map((u) =>
      `<div class="current-host-row">
        <span>${escapeHtml(u.username)}</span>
        <button class="btn btn-ghost btn-small btn-revoke" data-username="${escapeHtml(u.username)}">Revoke host</button>
      </div>`
    ).join("");
    container.querySelectorAll(".btn-revoke").forEach((btn) => {
      btn.addEventListener("click", () => {
        socket.emit("demote_host", { username: btn.dataset.username });
      });
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

  /**
   * Fetch and display the save history for the given file path.
   * @param {string} path
   */
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
      el("historyPanelTitle").textContent = `History: ${currentPath}`;
      loadFileHistory(currentPath);
      el("historyPanel").classList.remove("hidden");
    });
  }
  const closeHistoryBtn = el("closeHistory");
  if (closeHistoryBtn) closeHistoryBtn.addEventListener("click", () => el("historyPanel").classList.add("hidden"));

  /**
   * Switch the editor theme, update CodeMirror, and optionally persist the choice.
   * @param {"dark"|"light"} theme
   * @param {boolean} [persist=true]
   */
  function applyTheme(theme, persist) {
    document.body.classList.remove("theme-dark", "theme-light");
    document.body.classList.add("theme-" + theme);
    cm.setOption("theme", theme === "light" ? "roomcode-light" : "roomcode-dark");
    document.querySelectorAll('[data-theme]').forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === theme);
    });
    if (persist !== false) localStorage.setItem("roomcode-theme", theme);
  }

  /**
   * Switch the editor/terminal split layout and persist the choice.
   * @param {"vertical"|"horizontal"} layout
   */
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
      renderCurrentHosts(lastPresenceList);
    }
  });
  el("closeSettings").addEventListener("click", () => el("settingsPanel").classList.add("hidden"));

  /**
   * Collapse or expand the file explorer sidebar and persist the state.
   * @param {boolean} collapsed
   */
  function applySidebarCollapsed(collapsed) {
    el("sidebar").classList.toggle("collapsed", collapsed);
    el("sidebarToggle").innerHTML = collapsed ? "&#9654;" : "&#9664;";
    localStorage.setItem("roomcode-sidebar-collapsed", collapsed ? "1" : "0");
  }
  el("sidebarToggle").addEventListener("click", () => {
    applySidebarCollapsed(!el("sidebar").classList.contains("collapsed"));
  });
  applySidebarCollapsed(localStorage.getItem("roomcode-sidebar-collapsed") === "1");

  /**
   * Reflect the current lock state in the editor, tab bar, and lock indicator.
   * @param {boolean} locked
   */
  function applyLockState(locked) {
    roomLocked = locked;
    const iAmLocked = locked && !window.__IS_HOST__;
    // "nocursor" (rather than plain true) also stops a locked-out user from
    // placing/seeing their own cursor in the editor at all, not just typing.
    cm.setOption("readOnly", iAmLocked ? "nocursor" : false);
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

  /** @returns {string} localStorage key for the current layout's split position */
  function splitStorageKey() {
    return el("main").classList.contains("split-vertical")
      ? "roomcode-split-vertical" : "roomcode-split-horizontal";
  }

  /** Restore a previously saved editor pane size from localStorage. */
  function restoreSplit() {
    const saved = localStorage.getItem(splitStorageKey());
    el("editorPane").style.flex = saved ? `0 0 ${saved}px` : "";
  }

  /** Set up mouse drag resizing on the split handle between the editor and terminal. */
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

  /** @returns {"dark"|"light"} the OS-level preferred color scheme */
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
