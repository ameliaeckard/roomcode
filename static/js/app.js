(function () {
  "use strict";

  const socket = io();
  let currentPath = null;
  let currentMode = "null";
  let applyingRemoteChange = false;
  let cm = null;
  let roomLocked = false;

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

  cm.on("change", (instance, changeObj) => {
    if (applyingRemoteChange || !currentPath) return;
    if (changeObj.origin === "setValue") return;
    socket.emit("edit", {
      path: currentPath,
      change: {
        from: changeObj.from,
        to: changeObj.to,
        text: changeObj.text,
        removed: changeObj.removed,
        origin: changeObj.origin,
      },
    });
  });

  socket.on("edit", (data) => {
    if (data.path !== currentPath) return;
    const c = data.change;
    applyingRemoteChange = true;
    cm.replaceRange(c.text.join("\n"), c.from, c.to, "remote");
    applyingRemoteChange = false;
  });

  socket.on("file_changed", (data) => {
    if (data.path !== currentPath || applyingRemoteChange) return;
    if (cm.getValue() === data.content) return;
    const cursor = cm.getCursor();
    applyingRemoteChange = true;
    cm.setValue(data.content);
    cm.setCursor(cursor);
    applyingRemoteChange = false;
  });

  socket.on("tree_update", loadTree);

  function moveItem(src, destDir) {
    fetch("/api/move", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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

  function renderTree(nodes, container) {
    nodes.forEach((node) => {
      const wrap = document.createElement("div");
      wrap.className = "tree-node";

      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = node.path;
      row.draggable = true;
      const icon = node.type === "dir" ? "&#9656;" : "-";
      row.innerHTML = `<span class="tree-icon">${icon}</span><span class="tree-label"></span><span class="tree-delete" title="Delete">x</span>`;
      row.querySelector(".tree-label").textContent = node.name;
      wrap.appendChild(row);

      row.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/plain", node.path);
        e.dataTransfer.effectAllowed = "move";
        row.classList.add("dragging");
      });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));

      row.querySelector(".tree-delete").addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`Delete "${node.name}"? This cannot be undone.`)) {
          fetch("/api/delete", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path: node.path }),
          }).then(loadTree);
        }
      });

      if (node.type === "dir") {
        makeDropTarget(row, node.path);
        const childrenDiv = document.createElement("div");
        childrenDiv.className = "tree-children";
        childrenDiv.style.display = "none";
        renderTree(node.children || [], childrenDiv);
        wrap.appendChild(childrenDiv);
        const iconEl = row.querySelector(".tree-icon");
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
      container.innerHTML = "";
      renderTree(data, container);
    });
  }

  makeDropTarget(el("fileTree"), "");

  function markActiveRow(path) {
    document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("active"));
    const row = document.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`);
    if (row) row.classList.add("active");
  }

  function openFile(path) {
    saveFile(); // persist whatever's open before we discard it for the new file
    fetch("/api/file?path=" + encodeURIComponent(path)).then((r) => r.json()).then((data) => {
      if (data.binary) {
        alert("This file doesn't look like text. You can't open it in the editor.");
        return;
      }
      currentPath = data.path;
      currentMode = data.mode;
      applyingRemoteChange = true;
      cm.setValue(data.content);
      cm.setOption("mode", currentMode);
      applyingRemoteChange = false;
      el("tabLabel").textContent = data.path;
      el("tabLabel").classList.remove("tab-empty");
      markActiveRow(path);
      clearRemoteSelections();
      socket.emit("open_file", { path: data.path });
    });
  }

  const remoteSelectionMarks = {};
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

  function clearRemoteSelections() {
    Object.values(remoteSelectionMarks).forEach((mark) => mark.clear());
    Object.keys(remoteSelectionMarks).forEach((k) => delete remoteSelectionMarks[k]);
  }

  cm.on("cursorActivity", () => {
    if (!currentPath || applyingRemoteChange) return;
    socket.emit("cursor", {
      path: currentPath,
      anchor: cm.getCursor("anchor"),
      head: cm.getCursor("head"),
    });
  });

  socket.on("cursor", (data) => {
    if (data.path !== currentPath || !data.username) return;
    if (remoteSelectionMarks[data.username]) {
      remoteSelectionMarks[data.username].clear();
      delete remoteSelectionMarks[data.username];
    }
    const { anchor, head } = data;
    if (anchor.line === head.line && anchor.ch === head.ch) return;
    const backwards = CodeMirror.cmpPos(anchor, head) > 0;
    const from = backwards ? head : anchor;
    const to = backwards ? anchor : head;
    remoteSelectionMarks[data.username] = cm.markText(from, to, {
      css: `background: ${colorForUser(data.username)}55;`,
      title: data.username,
    });
  });

  function saveFile() {
    if (!window.__IS_HOST__) return; // only the host has a Save button
    if (!currentPath) return;
    fetch("/api/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: currentPath, content: cm.getValue() }),
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

  function appendTermLine(text, cls) {
    const out = el("terminalOutput");
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (i === lines.length - 1 && line === "" && lines.length > 1) return;
      const row = document.createElement("div");
      row.className = "term-line" + (cls ? " " + cls : "");
      row.textContent = line;
      out.appendChild(row);
    });
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
    const clsMap = { stderr: "line-stderr", error: "line-error", system: "line-system" };
    appendTermLine(data.text, clsMap[data.stream]);
  });
  socket.on("run_done", (data) => {
    const btn = document.getElementById(data.scope === "all" ? "runBtn" : "runLocalBtn");
    if (btn) btn.disabled = false;
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
        headers: { "Content-Type": "application/json" },
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
  socket.on("presence", (list) => {
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
  });

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

  el("settingsBtn").addEventListener("click", () => el("settingsPanel").classList.toggle("hidden"));
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
