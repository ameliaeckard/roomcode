"""
RoomCode — a tiny host-and-join coding environment.

Anyone can open the server's address, hit /create to spin up a new
session (their own isolated project folder, protected by a password they
choose), and land in as that session's host. Anyone else who knows the
password can /join the same session as a regular collaborator. Multiple
sessions can run side by side on one server — each gets its own folder,
file tree, terminal, and connected users.

Live editing is backed by Yjs (a CRDT): each open file has an
authoritative Y.Doc held in memory here, patched by everyone's edits and
periodically flushed to disk, so opening a file always shows the current
live state (even if you weren't the one editing it) and nothing requires
a manual, host-only save anymore.

Usage:
    python3 server.py [--dir /path/to/sessions] [--port 5000]

Then share http://<host-lan-ip>:<port> — the first visitor creates a
session there.

SECURITY NOTE: This app lets connected users execute code on the host
machine via the Run button (host-only). Only run it on networks you
trust, and only share passwords with people you trust. Do not expose
this directly to the public internet without accepting that risk.
"""

import argparse
import hmac
import io
import ipaddress
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import urlparse

try:
    import resource  # POSIX only -- used for best-effort Run resource limits
except ImportError:
    resource = None

import y_py as Y
from flask import (
    Flask, render_template, request, session, redirect,
    url_for, jsonify, send_file, abort
)
from flask_socketio import SocketIO, emit, join_room, leave_room

# --------------------------------------------------------------------------
# Config (populated from CLI args in main())
# --------------------------------------------------------------------------
class Config:
    sessions_dir: Path = None
    port: int = 5000


app = Flask(__name__)
app.secret_key = uuid.uuid4().hex


def _is_allowed_origin(origin):
    """Accept localhost, RFC-1918 private-address origins, and any origin
    listed (comma-separated) in the ALLOWED_ORIGINS env var.  Set that var
    on Railway/cloud deployments where the public domain would otherwise be
    rejected by the private-IP heuristic."""
    if not origin:
        return True  # same-origin navigations omit the header
    extra = os.environ.get("ALLOWED_ORIGINS", "")
    if extra:
        allowed = {o.strip().rstrip("/") for o in extra.split(",")}
        if origin.rstrip("/") in allowed:
            return True
    try:
        host = urlparse(origin).hostname or ""
        if host in ("localhost", "127.0.0.1", "::1"):
            return True
        addr = ipaddress.ip_address(host)
        return addr.is_private
    except ValueError:
        return False  # non-IP public hostnames rejected unless in ALLOWED_ORIGINS


socketio = SocketIO(app, cors_allowed_origins=_is_allowed_origin, async_mode="threading")

# session_id -> {
#   "password": str, "root_dir": Path, "locked": bool,
#   "ownership": {rel_path: username},       # who created each file/folder
#   "promoted_hosts": {username, ...},       # hosts besides the main host
#   "ydocs": {rel_path: Y.YDoc},             # authoritative live document
#   "dirty_docs": {rel_path, ...},           # awaiting the next autosave flush
#   "last_editor": {rel_path: username},     # for the edit-history log
#   "history": [{"ts", "username", "path"}], # recent save events, capped
#   "awareness_states": {rel_path: {client_id: bytes}},  # latest cursor blobs
# }
sessions = {}
password_index = {}  # password -> session_id
sessions_lock = threading.Lock()

# --------------------------------------------------------------------------
# CSRF
# --------------------------------------------------------------------------
def _csrf_token() -> str:
    """Return (creating if needed) the CSRF token for this browser session."""
    if "csrf_token" not in session:
        session["csrf_token"] = uuid.uuid4().hex
    return session["csrf_token"]


def _check_csrf():
    """Abort 403 if the request does not carry a valid CSRF token.
    Form POSTs send it as the hidden field '_csrf'; JSON requests send it
    as the X-CSRF-Token header."""
    token = request.headers.get("X-CSRF-Token") or request.form.get("_csrf", "")
    expected = session.get("csrf_token", "")
    if not token or not expected or not hmac.compare_digest(token, expected):
        abort(403, "CSRF check failed")


@app.context_processor
def _inject_csrf():
    return {"csrf_token": _csrf_token}


# --------------------------------------------------------------------------
# Rate limiting for /join
# --------------------------------------------------------------------------
_join_attempts: dict[str, list[float]] = {}  # ip -> [timestamps of recent attempts]
_join_lock = threading.Lock()
JOIN_RATE_WINDOW = 60.0   # seconds
JOIN_MAX_ATTEMPTS = 10    # per window per IP


def _is_join_rate_ok(ip: str) -> bool:
    """Return True if this IP has not exceeded the failed-attempt limit."""
    now = time.time()
    with _join_lock:
        attempts = [t for t in _join_attempts.get(ip, []) if now - t < JOIN_RATE_WINDOW]
        return len(attempts) < JOIN_MAX_ATTEMPTS


def _record_join_failure(ip: str) -> None:
    """Record a failed (wrong-password) join attempt for rate limiting."""
    now = time.time()
    with _join_lock:
        attempts = [t for t in _join_attempts.get(ip, []) if now - t < JOIN_RATE_WINDOW]
        attempts.append(now)
        _join_attempts[ip] = attempts


# sid -> {"username", "path", "stoken", "session_id", "is_host", "is_main_host"}
connected_users = {}
users_lock = threading.Lock()

# Guards the *dict structure* holding each session's ydocs (so two threads
# can't both decide a file has no doc yet and create two separate ones for
# it) — separate from the single-thread rule below, which guards the actual
# Y.Doc objects themselves.
ydocs_lock = threading.Lock()
AUTOSAVE_INTERVAL_SECONDS = 2.0
HISTORY_LIMIT = 200

# y_py's YDoc is a Rust object (via PyO3) that is NOT safe to touch from any
# thread other than the one that created it -- it hard-panics ("YDoc is
# unsendable, but sent to another thread") if you do, which takes down
# whatever request thread hit it. Flask-SocketIO's threading mode hands
# different requests to different worker threads, so every single call into
# a Y.Doc (construction, apply_update, encode_state_as_update, get_text...)
# is funneled through one dedicated worker thread via this queue instead of
# being called directly.
_yjs_queue = queue.Queue()


def _yjs_worker_loop():
    while True:
        fn, result_box, done = _yjs_queue.get()
        try:
            result_box["value"] = fn()
        except Exception as e:
            result_box["error"] = e
        done.set()


def run_on_yjs_thread(fn):
    result_box = {}
    done = threading.Event()
    _yjs_queue.put((fn, result_box, done))
    done.wait()
    if "error" in result_box:
        raise result_box["error"]
    return result_box.get("value")

# Per-login-session bookkeeping so closing a tab fully logs the user out
# (session token invalidated) without punishing an ordinary page refresh
# (a live socket reconnects within the grace period below).
session_conn_counts = {}
invalidated_stokens: dict[str, float] = {}  # stoken -> time.time() when invalidated
SESSION_EXPIRE_GRACE_SECONDS = 10.0
STOKEN_PRUNE_AFTER = 3600.0  # drop invalidated tokens from memory after 1 hour

# target_room -> the Popen currently running for that room, so typed input
# can be routed to the right process's stdin.
running_processes = {}
running_processes_lock = threading.Lock()

RUNNERS = {
    ".py": [sys.executable, "{file}"],
    ".js": ["node", "{file}"],
    ".ts": ["ts-node", "{file}"],
    ".sh": ["bash", "{file}"],
    ".rb": ["ruby", "{file}"],
    ".go": ["go", "run", "{file}"],
    ".java": None,  # needs compile step, handled specially
}

CODEMIRROR_MODES = {
    ".py": "python", ".js": "javascript", ".jsx": "jsx", ".ts": "javascript",
    ".json": "javascript", ".html": "htmlmixed", ".htm": "htmlmixed",
    ".css": "css", ".md": "markdown", ".java": "text/x-java",
    ".c": "text/x-csrc", ".h": "text/x-csrc", ".cpp": "text/x-c++src",
    ".sh": "shell", ".rb": "ruby", ".go": "go", ".sql": "sql",
    ".xml": "xml", ".yml": "yaml", ".yaml": "yaml", ".txt": "null",
}

EXCLUDED_DIR_NAMES = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}

# --------------------------------------------------------------------------
# Run-feature hardening
#
# There's no real sandbox here (no container/chroot/restricted OS user) --
# a script run via Run/Run Local has the same filesystem/network access as
# the server process itself, and reaching real isolation would need actual
# containers or per-session OS accounts, a much bigger infra change. This is
# a best-effort layer that closes two concrete gaps that don't need that:
# leaking the server's own environment (secrets, DB URLs, etc.) into
# arbitrary user code, and unbounded CPU/memory/disk usage from a runaway
# or malicious script.
# --------------------------------------------------------------------------
RUN_ENV_PASSTHROUGH = {"path", "systemroot", "windir", "comspec", "pathext", "lang", "lc_all", "temp", "tmp"}
RUN_CPU_SECONDS = 30
RUN_MEMORY_BYTES = 1024 * 1024 * 1024  # 1 GB address space
RUN_MAX_FILE_BYTES = 200 * 1024 * 1024  # 200 MB for any single file the script writes


def _build_run_env(home_dir):
    """A minimal environment for Run subprocesses -- explicitly NOT a copy
    of the server's own os.environ, which could otherwise hand a malicious
    script access to secrets (DB URLs, API keys, etc.) that have nothing to
    do with running code."""
    env = {"PYTHONUNBUFFERED": "1", "HOME": str(home_dir)}
    for key, value in os.environ.items():
        if key.lower() in RUN_ENV_PASSTHROUGH:
            env[key] = value
    return env


def _limit_run_resources():
    """Runs inside the child, right after fork and before exec -- POSIX
    only (subprocess.Popen rejects preexec_fn entirely on Windows, so this
    is never even passed there). Deliberately does NOT set RLIMIT_NPROC:
    that's charged against the whole real UID, which every thread of the
    main server process shares, so a low value here could start failing
    unrelated to anything this particular run does."""
    try:
        os.setsid()  # own process group, so we can reliably kill the whole tree later
    except Exception:
        pass
    for limit, value in (
        (resource.RLIMIT_CPU, RUN_CPU_SECONDS),
        (resource.RLIMIT_AS, RUN_MEMORY_BYTES),
        (resource.RLIMIT_FSIZE, RUN_MAX_FILE_BYTES),
    ):
        try:
            resource.setrlimit(limit, (value, value))
        except Exception:
            pass


def _kill_running_process(target_room):
    """Force-kill (whole process group, on POSIX) whatever Run process is
    tracked under target_room, if any. Used so a run doesn't keep consuming
    resources after the session it belongs to is gone."""
    with running_processes_lock:
        proc = running_processes.pop(target_room, None)
    if proc is None or proc.poll() is not None:
        return
    try:
        if hasattr(os, "killpg"):
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        else:
            proc.kill()
    except Exception:
        pass


# --------------------------------------------------------------------------
# Session/auth helpers
# --------------------------------------------------------------------------
def safe_resolve(root_dir: Path, rel_path: str) -> Path:
    """Resolve a client-supplied relative path under root_dir, refusing to
    let it escape that session's folder."""
    rel_path = (rel_path or "").lstrip("/\\")
    candidate = (root_dir / rel_path).resolve()
    root = root_dir.resolve()
    if candidate != root and root not in candidate.parents:
        abort(400, "Invalid path")
    return candidate


def current_session():
    sid = session.get("session_id")
    return sessions.get(sid) if sid else None


def is_logged_in() -> bool:
    if not (session.get("authed") is True and session.get("username")):
        return False
    stoken = session.get("stoken")
    if stoken and stoken in invalidated_stokens:  # dict membership — O(1), same as set
        return False
    return current_session() is not None


def is_main_host() -> bool:
    return session.get("is_main_host") is True


def is_host() -> bool:
    if is_main_host():
        return True
    sess = current_session()
    return bool(sess and session.get("username") in sess.get("promoted_hosts", set()))


def generate_session_id() -> str:
    while True:
        sid = uuid.uuid4().hex[:8]
        if sid not in sessions:
            return sid


# --------------------------------------------------------------------------
# Yjs document helpers
# --------------------------------------------------------------------------
def _get_or_create_ydoc_unlocked(sess, rel):
    """Caller must already hold ydocs_lock. The Y.Doc itself is always
    constructed on the dedicated Yjs worker thread (see run_on_yjs_thread)."""
    ydoc = sess.setdefault("ydocs", {}).get(rel)
    if ydoc is None:
        initial = ""
        try:
            path = safe_resolve(sess["root_dir"], rel)
            if path.is_file():
                initial = path.read_text(encoding="utf-8")
        except Exception:
            initial = ""

        def create():
            doc = Y.YDoc()
            if initial:
                ytext = doc.get_text("content")
                with doc.begin_transaction() as txn:
                    ytext.insert(txn, 0, initial)
            return doc

        ydoc = run_on_yjs_thread(create)
        sess["ydocs"][rel] = ydoc
    return ydoc


def get_doc_text(sess, rel):
    """Current authoritative content for rel, if it's being live-edited."""
    with ydocs_lock:
        ydoc = sess.get("ydocs", {}).get(rel)
    if ydoc is None:
        return None
    return run_on_yjs_thread(lambda: str(ydoc.get_text("content")))


def _flush_doc(sess, rel):
    with ydocs_lock:
        ydoc = sess.get("ydocs", {}).get(rel)
    if ydoc is None:
        return
    content = run_on_yjs_thread(lambda: str(ydoc.get_text("content")))
    try:
        path = safe_resolve(sess["root_dir"], rel)
        path.write_text(content, encoding="utf-8")
    except Exception:
        return
    history = sess.setdefault("history", [])
    history.append({
        "ts": time.time(),
        "username": sess.get("last_editor", {}).get(rel, "?"),
        "path": rel,
    })
    if len(history) > HISTORY_LIMIT:
        del history[:len(history) - HISTORY_LIMIT]


def _autosave_loop():
    while True:
        time.sleep(AUTOSAVE_INTERVAL_SECONDS)
        with sessions_lock:
            items = list(sessions.items())
        for _sid, sess in items:
            dirty = sess.get("dirty_docs")
            if not dirty:
                continue
            to_flush = list(dirty)
            dirty.clear()
            for rel in to_flush:
                _flush_doc(sess, rel)
        # Prune invalidated stokens that are old enough to never appear in an
        # active browser session, so the dict doesn't grow without bound.
        cutoff = time.time() - STOKEN_PRUNE_AFTER
        with users_lock:
            stale = [t for t, ts in invalidated_stokens.items() if ts < cutoff]
            for t in stale:
                del invalidated_stokens[t]


# --------------------------------------------------------------------------
# HTTP routes
# --------------------------------------------------------------------------
@app.route("/", methods=["GET"])
def index():
    if not is_logged_in():
        return redirect(url_for("join"))
    sess = current_session()
    return render_template(
        "ide.html", username=session["username"], root_name=sess["root_dir"].name,
        is_host=is_host(),
    )


@app.route("/create", methods=["GET", "POST"])
def create():
    error = None
    if request.method == "POST":
        _check_csrf()
        pw = request.form.get("password", "").strip()
        name = request.form.get("username", "").strip()[:32]
        if not pw:
            error = "Choose a session password."
        elif not name:
            error = "Please enter your name."
        else:
            with sessions_lock:
                if pw in password_index:
                    error = "That password is already in use — pick a different one."
                else:
                    sid = generate_session_id()
                    root_dir = Config.sessions_dir / sid
                    root_dir.mkdir(parents=True, exist_ok=True)
                    sessions[sid] = {
                        "password": pw, "root_dir": root_dir, "locked": False,
                        "ownership": {}, "promoted_hosts": set(),
                        "ydocs": {}, "dirty_docs": set(), "last_editor": {},
                        "history": [], "awareness_states": {},
                    }
                    password_index[pw] = sid
            if not error:
                session["authed"] = True
                session["username"] = name
                session["stoken"] = uuid.uuid4().hex
                session["is_main_host"] = True
                session["session_id"] = sid
                return redirect(url_for("index"))
    return render_template("login.html", error=error, active_tab="create")


@app.route("/join", methods=["GET", "POST"])
def join():
    error = None
    if request.method == "POST":
        _check_csrf()
        ip = request.remote_addr or ""
        if not _is_join_rate_ok(ip):
            error = "Too many attempts — please wait a minute."
        else:
            pw = request.form.get("password", "")
            name = request.form.get("username", "").strip()[:32]
            with sessions_lock:
                sid = password_index.get(pw)
            if not sid:
                _record_join_failure(ip)
                error = "Incorrect password."
            elif not name:
                error = "Please enter a name."
            else:
                # Enforce unique display names within a session so promote_host
                # (which matches by name) can't accidentally target two people.
                with users_lock:
                    name_taken = any(
                        u.get("session_id") == sid and u.get("username") == name
                        for u in connected_users.values()
                    )
                if name_taken:
                    error = "That name is already taken in this session — pick another."
                else:
                    session["authed"] = True
                    session["username"] = name
                    session["stoken"] = uuid.uuid4().hex
                    session["is_main_host"] = False
                    session["session_id"] = sid
                    return redirect(url_for("index"))
    return render_template("login.html", error=error, active_tab="join")


@app.route("/logout")
def logout():
    stoken = session.get("stoken")
    if stoken:
        with users_lock:
            invalidated_stokens[stoken] = time.time()
            session_conn_counts.pop(stoken, None)
    session.clear()
    return redirect(url_for("join"))


@app.route("/api/tree")
def api_tree():
    if not is_logged_in():
        abort(403)
    sess = current_session()
    host = is_host()
    ownership = sess.get("ownership", {})
    username = session["username"]

    def build(dir_path: Path):
        entries = []
        try:
            children = sorted(
                dir_path.iterdir(),
                key=lambda p: (p.is_file(), p.name.lower())
            )
        except PermissionError:
            return entries
        for child in children:
            if child.name in EXCLUDED_DIR_NAMES or child.name.startswith("."):
                continue
            rel = str(child.relative_to(sess["root_dir"]))
            owned = host or ownership.get(rel) == username
            if child.is_dir():
                entries.append({
                    "name": child.name, "path": rel, "type": "dir", "owned": owned,
                    "children": build(child)
                })
            else:
                entries.append({"name": child.name, "path": rel, "type": "file", "owned": owned})
        return entries

    return jsonify(build(sess["root_dir"]))


@app.route("/api/file")
def api_file():
    if not is_logged_in():
        abort(403)
    sess = current_session()
    rel = request.args.get("path", "")
    path = safe_resolve(sess["root_dir"], rel)
    live = get_doc_text(sess, rel)
    if live is not None:
        content, binary = live, False
    else:
        if not path.is_file():
            abort(404)
        try:
            content = path.read_text(encoding="utf-8")
            binary = False
        except (UnicodeDecodeError, ValueError):
            content = ""
            binary = True
    ext = path.suffix.lower()
    return jsonify({
        "path": rel, "content": content, "binary": binary,
        "mode": CODEMIRROR_MODES.get(ext, "null"),
    })


@app.route("/api/file-meta")
def api_file_meta():
    """Return only syntax-mode and binary flag for a path — no file content.
    Used by the editor to set up CodeMirror mode; the actual text comes
    from the Yjs sync response, so we don't need to transmit it twice."""
    if not is_logged_in():
        abort(403)
    sess = current_session()
    rel = request.args.get("path", "")
    path = safe_resolve(sess["root_dir"], rel)
    in_memory = get_doc_text(sess, rel) is not None
    if not in_memory and not path.is_file():
        abort(404)
    binary = False
    if not in_memory and path.is_file():
        try:
            path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, ValueError):
            binary = True
    ext = path.suffix.lower()
    return jsonify({
        "path": rel,
        "binary": binary,
        "mode": CODEMIRROR_MODES.get(ext, "null"),
    })


@app.route("/api/save", methods=["POST"])
def api_save():
    """Force an immediate flush. Auto-save already runs continuously in the
    background — this is just a manual 'do it now' for peace of mind."""
    if not is_logged_in():
        abort(403)
    _check_csrf()
    sess = current_session()
    if sess["locked"] and not is_host():
        abort(403, "Editing is locked by the host")
    data = request.get_json(force=True)
    rel = data.get("path", "")
    path = safe_resolve(sess["root_dir"], rel)
    if path.is_dir():
        abort(400)
    live = get_doc_text(sess, rel)
    if live is not None:
        # Flush the authoritative Yjs document — ignore any content in the request body.
        path.write_text(live, encoding="utf-8")
        sess.get("dirty_docs", set()).discard(rel)
    else:
        # No live doc yet (file was never opened collaboratively). The lock check
        # above already blocked non-hosts, so this path is only reached by hosts
        # or when the session is unlocked.
        path.write_text(data.get("content", ""), encoding="utf-8")
    return jsonify({"ok": True})


@app.route("/api/download-file")
def api_download_file():
    if not is_logged_in():
        abort(403)
    sess = current_session()
    rel = request.args.get("path", "")
    path = safe_resolve(sess["root_dir"], rel)
    live = get_doc_text(sess, rel)
    if live is not None:
        buf = io.BytesIO(live.encode("utf-8"))
        return send_file(buf, as_attachment=True, download_name=path.name, mimetype="text/plain")
    if not path.is_file():
        abort(404)
    return send_file(path, as_attachment=True, download_name=path.name)


@app.route("/api/download-project")
def api_download_project():
    if not is_logged_in():
        abort(403)
    sess = current_session()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(sess["root_dir"]):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES and not d.startswith(".")]
            for fname in filenames:
                full = Path(dirpath) / fname
                arcname = str(full.relative_to(sess["root_dir"]))
                live = get_doc_text(sess, arcname)
                if live is not None:
                    zf.writestr(arcname, live)
                else:
                    zf.write(full, arcname)
    buf.seek(0)
    return send_file(buf, as_attachment=True,
                      download_name=f"{sess['root_dir'].name}.zip",
                      mimetype="application/zip")


@app.route("/api/new", methods=["POST"])
def api_new():
    if not is_logged_in():
        abort(403)
    _check_csrf()
    sess = current_session()
    data = request.get_json(force=True)
    rel = data.get("path", "")
    kind = data.get("type", "file")
    path = safe_resolve(sess["root_dir"], rel)
    if path.exists():
        abort(400, "Already exists")
    if kind == "dir":
        path.mkdir(parents=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    sess.setdefault("ownership", {})[rel] = session["username"]
    socketio.emit("tree_update", {}, room=session["session_id"])
    return jsonify({"ok": True})


@app.route("/api/move", methods=["POST"])
def api_move():
    if not is_logged_in():
        abort(403)
    _check_csrf()
    sess = current_session()
    data = request.get_json(force=True)
    src_rel = data.get("src", "")
    dest_dir_rel = data.get("destDir", "")
    src_path = safe_resolve(sess["root_dir"], src_rel)
    dest_dir = safe_resolve(sess["root_dir"], dest_dir_rel)
    if not src_path.exists():
        abort(404)
    if not dest_dir.is_dir():
        abort(400, "Destination is not a folder")
    if src_path.is_dir():
        if dest_dir == src_path or src_path in dest_dir.parents:
            abort(400, "Can't move a folder into itself")
    target = dest_dir / src_path.name
    if target.exists():
        abort(400, "Already exists")
    shutil.move(str(src_path), str(target))
    new_rel = str(target.relative_to(sess["root_dir"]))
    ownership = sess.setdefault("ownership", {})
    owner = ownership.pop(src_rel, None)
    if owner:
        ownership[new_rel] = owner
    with ydocs_lock:
        ydoc = sess.get("ydocs", {}).pop(src_rel, None)
        if ydoc is not None:
            sess["ydocs"][new_rel] = ydoc
    socketio.emit("tree_update", {}, room=session["session_id"])
    return jsonify({"ok": True})


@app.route("/api/rename", methods=["POST"])
def api_rename():
    if not is_logged_in():
        abort(403)
    _check_csrf()
    sess = current_session()
    data = request.get_json(force=True)
    rel = data.get("path", "")
    new_name = data.get("newName", "").strip()
    if not is_host() and sess.get("ownership", {}).get(rel) != session["username"]:
        abort(403, "You can only rename things you created")
    if not new_name or new_name in (".", "..") or "/" in new_name or "\\" in new_name:
        abort(400, "Invalid name")
    path = safe_resolve(sess["root_dir"], rel)
    if not path.exists():
        abort(404)
    target = path.parent / new_name
    if target.exists():
        abort(400, "Already exists")
    path.rename(target)
    new_rel = str(target.relative_to(sess["root_dir"]))
    ownership = sess.setdefault("ownership", {})
    owner = ownership.pop(rel, None)
    if owner:
        ownership[new_rel] = owner
    with ydocs_lock:
        ydoc = sess.get("ydocs", {}).pop(rel, None)
        if ydoc is not None:
            sess["ydocs"][new_rel] = ydoc
    socketio.emit("tree_update", {}, room=session["session_id"])
    return jsonify({"ok": True, "path": new_rel})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    if not is_logged_in():
        abort(403)
    _check_csrf()
    sess = current_session()
    data = request.get_json(force=True)
    rel = data.get("path", "")
    if not is_host() and sess.get("ownership", {}).get(rel) != session["username"]:
        abort(403, "You can only delete things you created")
    path = safe_resolve(sess["root_dir"], rel)
    if path.is_dir():
        shutil.rmtree(path)
    elif path.is_file():
        path.unlink()
    sess.get("ownership", {}).pop(rel, None)
    with ydocs_lock:
        sess.get("ydocs", {}).pop(rel, None)
    socketio.emit("tree_update", {}, room=session["session_id"])
    return jsonify({"ok": True})


@app.route("/api/room-info")
def api_room_info():
    if not is_logged_in():
        abort(403)
    if not is_host():
        abort(403)
    sess = current_session()
    return jsonify({"password": sess["password"]})


@app.route("/api/history")
def api_history():
    if not is_logged_in():
        abort(403)
    sess = current_session()
    history = sess.get("history", [])
    path_filter = request.args.get("path")
    if path_filter is not None:
        history = [h for h in history if h["path"] == path_filter]
    return jsonify(list(reversed(history)))


# --------------------------------------------------------------------------
# Socket.IO — presence, live editing (Yjs), run
# --------------------------------------------------------------------------
@socketio.on("connect")
def on_connect(auth=None):
    if not is_logged_in():
        return False
    # CSRF check for the WebSocket upgrade — the browser sends the token in
    # the socket.io auth payload (see app.js io() call).
    csrf = (auth or {}).get("csrf_token", "")
    expected = session.get("csrf_token", "")
    if not csrf or not expected or not hmac.compare_digest(csrf, expected):
        return False
    sid_room = session["session_id"]
    stoken = session.get("stoken")
    join_room(sid_room)
    with users_lock:
        connected_users[request.sid] = {
            "username": session["username"], "path": None, "stoken": stoken,
            "session_id": sid_room, "is_host": is_host(), "is_main_host": is_main_host(),
        }
        if stoken:
            session_conn_counts[stoken] = session_conn_counts.get(stoken, 0) + 1
    emit("presence", _presence_list(sid_room), room=sid_room)
    sess = sessions.get(sid_room)
    emit("lock_changed", {"locked": sess["locked"] if sess else False}, room=request.sid)


@socketio.on("disconnect")
def on_disconnect():
    stoken = None
    sid_room = None
    was_main_host = False
    with users_lock:
        info = connected_users.pop(request.sid, None)
        if info:
            stoken = info.get("stoken")
            sid_room = info.get("session_id")
            was_main_host = info.get("is_main_host", False)
        if stoken:
            session_conn_counts[stoken] = session_conn_counts.get(stoken, 1) - 1
    # A "local" scope run is keyed by this exact socket sid and was only
    # ever visible to this one connection -- once it's gone, nobody can see
    # or interact with that process anymore, so there's no reason to let it
    # keep running (a reconnect gets a fresh sid and would start a new run
    # from scratch anyway, same as clicking Run again).
    _kill_running_process(request.sid)
    if sid_room:
        emit("presence", _presence_list(sid_room), room=sid_room)
        if was_main_host:
            # Lock right away — don't wait for a grace period. If the main
            # host reconnects (e.g. a refresh), they get host status back
            # via their session cookie and can unlock again themselves.
            # Regular users and promoted (non-main) hosts leaving never
            # trigger this.
            with users_lock:
                main_host_still_present = any(
                    u.get("session_id") == sid_room and u.get("is_main_host")
                    for u in connected_users.values()
                )
            if not main_host_still_present:
                sess = sessions.get(sid_room)
                if sess and not sess["locked"]:
                    sess["locked"] = True
                    socketio.emit("lock_changed", {"locked": True}, room=sid_room)
        timer = threading.Timer(SESSION_EXPIRE_GRACE_SECONDS, _delete_session_if_empty, args=(sid_room,))
        timer.daemon = True
        timer.start()
    if stoken:
        timer = threading.Timer(SESSION_EXPIRE_GRACE_SECONDS, _expire_session_if_still_gone, args=(stoken,))
        timer.daemon = True
        timer.start()


def _expire_session_if_still_gone(stoken):
    """Invalidate a login session once its last socket has been gone for the
    grace period — long enough to survive a page refresh, short enough that
    actually closing the tab logs the user out."""
    with users_lock:
        if session_conn_counts.get(stoken, 0) <= 0:
            invalidated_stokens[stoken] = time.time()
            session_conn_counts.pop(stoken, None)


def _delete_session_if_empty(session_id):
    """Fired a grace period after anyone disconnects — long enough to not
    react to a page refresh. If truly nobody is left connected, flush
    anything unsaved, then delete the session's folder and forget the
    session (and its password) entirely."""
    with users_lock:
        still_in_session = any(u.get("session_id") == session_id for u in connected_users.values())
    if still_in_session:
        return
    with sessions_lock:
        sess = sessions.pop(session_id, None)
        if sess:
            password_index.pop(sess["password"], None)
    if sess:
        for rel in list(sess.get("dirty_docs", set())):
            _flush_doc(sess, rel)
        _kill_running_process(session_id)  # a broadcast ("all" scope) run, if any, has no session left to run for
        shutil.rmtree(sess["root_dir"], ignore_errors=True)


def _presence_list(session_id):
    with users_lock:
        seen_stokens = set()
        result = []
        for u in connected_users.values():
            if u.get("session_id") != session_id:
                continue
            stoken = u.get("stoken")
            # Same login open in multiple tabs — only list them once.
            if stoken:
                if stoken in seen_stokens:
                    continue
                seen_stokens.add(stoken)
            result.append({
                "username": u["username"], "path": u["path"],
                "is_host": u.get("is_host", False),
            })
        return result


@socketio.on("open_file")
def on_open_file(data):
    """Track which file each user is viewing so edits route to the right room."""
    rel = data.get("path")
    sid_room = session["session_id"]
    with users_lock:
        prev = connected_users.get(request.sid, {}).get("path")
        if prev:
            leave_room(f"{sid_room}:{prev}")
        if request.sid in connected_users:
            connected_users[request.sid]["path"] = rel
    if rel:
        join_room(f"{sid_room}:{rel}")
    emit("presence", _presence_list(sid_room), room=sid_room)


@socketio.on("yjs_sync")
def on_yjs_sync(data):
    """A client just opened a file — hand them the full current Yjs state
    (this session's authoritative copy) plus any cursors already in it."""
    sess = current_session()
    rel = data.get("path")
    if not sess or not rel:
        return
    with ydocs_lock:
        ydoc = _get_or_create_ydoc_unlocked(sess, rel)
    state = run_on_yjs_thread(lambda: Y.encode_state_as_update(ydoc))
    emit("yjs_sync_response", {"path": rel, "state": state}, room=request.sid)
    for update in sess.get("awareness_states", {}).get(rel, {}).values():
        emit("awareness_update", {"path": rel, "update": update}, room=request.sid)


@socketio.on("yjs_update")
def on_yjs_update(data):
    """Apply an editor's change to this session's authoritative document,
    then relay the same update to everyone else viewing that file."""
    rel = data.get("path")
    update = data.get("update")
    if not rel or update is None:
        return
    sess = current_session()
    if not sess or (sess["locked"] and not is_host()):
        return  # editing is locked for non-hosts — silently drop the change
    with ydocs_lock:
        ydoc = _get_or_create_ydoc_unlocked(sess, rel)
    update_bytes = bytes(update)
    run_on_yjs_thread(lambda: Y.apply_update(ydoc, update_bytes))
    sess.setdefault("dirty_docs", set()).add(rel)
    sess.setdefault("last_editor", {})[rel] = session["username"]
    emit("yjs_update", {"path": rel, "update": update},
         room=f"{session['session_id']}:{rel}", include_self=False)


@socketio.on("awareness_update")
def on_awareness_update(data):
    """Relay cursor/selection presence (Yjs Awareness) to other viewers of
    this file, and remember the latest per-client state so a brand-new
    viewer can see everyone's cursor immediately, not just future moves."""
    rel = data.get("path")
    update = data.get("update")
    client_id = data.get("clientId")
    if not rel or update is None or client_id is None:
        return
    sess = current_session()
    if not sess:
        return
    sess.setdefault("awareness_states", {}).setdefault(rel, {})[client_id] = update
    emit("awareness_update", {"path": rel, "update": update},
         room=f"{session['session_id']}:{rel}", include_self=False)


@socketio.on("set_lock")
def on_set_lock(data):
    if not is_host():
        return
    sess = current_session()
    if not sess:
        return
    sess["locked"] = bool(data.get("locked"))
    emit("lock_changed", {"locked": sess["locked"]}, room=session["session_id"])


@socketio.on("promote_host")
def on_promote_host(data):
    """Grant another connected user host privileges for this session.
    Doesn't touch the auto-lock-on-departure behavior — that's tied
    specifically to the main host, never a promoted one."""
    if not is_host():
        return
    sess = current_session()
    target = (data.get("username") or "").strip()
    if not sess or not target:
        return
    sess.setdefault("promoted_hosts", set()).add(target)
    sid_room = session["session_id"]
    with users_lock:
        affected_sids = [
            sid for sid, u in connected_users.items()
            if u.get("session_id") == sid_room and u.get("username") == target
        ]
        for sid in affected_sids:
            connected_users[sid]["is_host"] = True
    for sid in affected_sids:
        socketio.emit("host_status_changed", {"is_host": True}, room=sid)
    emit("presence", _presence_list(sid_room), room=sid_room)


@socketio.on("run")
def on_run(data):
    rel = data.get("path", "")
    sid = request.sid
    sess = current_session()
    sid_room = session.get("session_id")
    # "all" broadcasts to everyone in the session and is host-only. "local"
    # runs for anyone but only that one connection ever sees the output.
    scope = data.get("scope") if data.get("scope") in ("all", "local") else "local"
    target_room = sid_room if scope == "all" else sid

    if scope == "all" and not is_host():
        emit("run_output", {"stream": "error", "text": "Only the host can run for everyone.\n"}, room=sid)
        emit("run_done", {"scope": scope}, room=sid)
        return
    if not sess:
        emit("run_output", {"stream": "error", "text": "Session not found.\n"}, room=sid)
        emit("run_done", {"scope": scope}, room=sid)
        return

    try:
        path = safe_resolve(sess["root_dir"], rel)
    except Exception:
        emit("run_output", {"stream": "error", "text": "Invalid file path.\n"}, room=sid)
        emit("run_done", {"scope": scope}, room=sid)
        return

    ext = path.suffix.lower()
    if not path.is_file():
        emit("run_output", {"stream": "error", "text": "File not found.\n"}, room=sid)
        emit("run_done", {"scope": scope}, room=sid)
        return

    if ext == ".java":
        # cmd=None signals stream_process to compile first (keeps the socket
        # handler non-blocking — javac on a large file can take a few seconds).
        cmd = None
    else:
        template = RUNNERS.get(ext)
        if not template:
            emit("run_output", {
                "stream": "error",
                "text": f"Don't know how to run '{ext}' files.\n"
            }, room=sid)
            emit("run_done", {"scope": scope}, room=sid)
            return
        cmd = [part.format(file=str(path)) for part in template]

    suffix = "" if scope == "all" else " (local)"
    socketio.emit("run_output", {"stream": "system", "text": f"\n$ run {rel}{suffix}\n"}, room=target_room)

    def stream_process():
        actual_cmd = cmd
        if actual_cmd is None:
            # Java: compile first, then run. Done here so javac doesn't block
            # the SocketIO event thread.
            compile_proc = subprocess.run(
                ["javac", str(path)], cwd=str(path.parent),
                capture_output=True, text=True, env=_build_run_env(path.parent),
            )
            if compile_proc.returncode != 0:
                socketio.emit("run_output", {"stream": "stderr", "text": compile_proc.stderr}, room=target_room)
                socketio.emit("run_done", {"scope": scope}, room=target_room)
                return
            actual_cmd = ["java", path.stem]

        proc = None
        try:
            popen_kwargs = dict(
                cwd=str(path.parent),
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1,
                # Force Python to line-buffer/flush even though stdout is a
                # pipe rather than a real terminal — otherwise input()
                # prompts sit in a buffer and never reach us, deadlocking
                # anything interactive.
                env=_build_run_env(path.parent),
            )
            if resource is not None:
                # preexec_fn is POSIX-only -- subprocess.Popen raises if you
                # even pass it (not just call it) on Windows, so this must
                # stay gated on the same check used to import `resource`.
                popen_kwargs["preexec_fn"] = _limit_run_resources
            proc = subprocess.Popen(actual_cmd, **popen_kwargs)
            with running_processes_lock:
                running_processes[target_room] = proc
            socketio.emit("run_started", {"scope": scope}, room=target_room)

            def pump(stream, name):
                # Read raw, whatever-is-available chunks from the fd directly
                # rather than line-by-line: readline() blocks until it sees a
                # trailing newline, but an input() prompt is written with
                # none, so it would sit buffered forever waiting for input
                # that depends on the prompt actually being shown first — a
                # deadlock. os.read() returns as soon as any data is ready,
                # whether that's a lone prompt or several full lines.
                fd = stream.fileno()
                while True:
                    try:
                        chunk = os.read(fd, 4096)
                    except OSError:
                        break
                    if not chunk:
                        break
                    socketio.emit("run_output", {
                        "stream": name, "text": chunk.decode("utf-8", errors="replace")
                    }, room=target_room)
                stream.close()

            t_out = threading.Thread(target=pump, args=(proc.stdout, "stdout"))
            t_err = threading.Thread(target=pump, args=(proc.stderr, "stderr"))
            t_out.start()
            t_err.start()
            t_out.join()
            t_err.join()
            proc.wait()
        except FileNotFoundError:
            socketio.emit("run_output", {
                "stream": "error",
                "text": f"Couldn't find interpreter for this file type (tried: {' '.join(actual_cmd or [ext])}).\n"
            }, room=target_room)
        except Exception as e:
            socketio.emit("run_output", {"stream": "error", "text": f"Error: {e}\n"}, room=target_room)
        finally:
            with running_processes_lock:
                if running_processes.get(target_room) is proc:
                    del running_processes[target_room]
            if proc is not None and proc.stdin and not proc.stdin.closed:
                try:
                    proc.stdin.close()
                except Exception:
                    pass
            socketio.emit("run_done", {"scope": scope}, room=target_room)

    socketio.start_background_task(stream_process)


@socketio.on("run_input")
def on_run_input(data):
    """Send a typed line to the stdin of whatever's currently running for
    this room, so scripts that call input() can be answered."""
    sess = current_session()
    if not sess:
        return
    sid_room = session.get("session_id")
    scope = data.get("scope") if data.get("scope") in ("all", "local") else "local"
    target_room = sid_room if scope == "all" else request.sid
    text = data.get("text", "")

    with running_processes_lock:
        proc = running_processes.get(target_room)
    if not proc or not proc.stdin or proc.stdin.closed:
        return
    # Echo before writing — the child could print its response the instant
    # stdin unblocks it, racing our own echo if we emitted it second.
    socketio.emit("run_output", {"stream": "stdin", "text": text + "\n"}, room=target_room)
    try:
        proc.stdin.write(text + "\n")
        proc.stdin.flush()
    except Exception:
        return


# --------------------------------------------------------------------------
# Entrypoint
# --------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Run the RoomCode host server.")
    parser.add_argument(
        "--dir", default=os.environ.get("PROJECT_DIR"),
        help="Base directory to store session folders in (each session gets its own "
             "subfolder here, named after its session id). Defaults to ./sessions.",
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", 5000)),
                         help="Port to listen on (default 5000, or $PORT if set).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default 0.0.0.0, i.e. all interfaces).")
    args = parser.parse_args()

    base = Path(args.dir).expanduser().resolve() if args.dir else Path(__file__).parent / "sessions"
    base.mkdir(parents=True, exist_ok=True)

    Config.sessions_dir = base
    Config.port = args.port

    yjs_thread = threading.Thread(target=_yjs_worker_loop, daemon=True)
    yjs_thread.start()

    autosave_thread = threading.Thread(target=_autosave_loop, daemon=True)
    autosave_thread.start()

    print(f"Session folders will be created under: {base}")
    print("Visit the site to /create a session, or /join an existing one.")
    print(f"Listening on http://{args.host}:{args.port}  (share your LAN IP with others)")
    print("Press Ctrl+C to stop.\n")

    socketio.run(app, host=args.host, port=args.port, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
