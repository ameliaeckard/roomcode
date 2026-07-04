import argparse
import io
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import uuid
import zipfile
from pathlib import Path

from flask import (
    Flask, render_template, request, session, redirect,
    url_for, jsonify, send_file, abort
)
from flask_socketio import SocketIO, emit, join_room, leave_room

class Config:
    root_dir: Path = None
    password: str = None
    port: int = 5000


app = Flask(__name__)
app.secret_key = uuid.uuid4().hex
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="threading")

connected_users = {}
users_lock = threading.Lock()

# Per-login-session bookkeeping so closing a tab fully logs the user out
# (session token invalidated) without punishing an ordinary page refresh
# (a live socket reconnects within the grace period below).
session_conn_counts = {}
invalidated_stokens = set()
SESSION_EXPIRE_GRACE_SECONDS = 10.0

RUNNERS = {
    ".py": [sys.executable, "{file}"],
    ".js": ["node", "{file}"],
    ".ts": ["ts-node", "{file}"],
    ".sh": ["bash", "{file}"],
    ".rb": ["ruby", "{file}"],
    ".go": ["go", "run", "{file}"],
    ".java": None,
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

def safe_resolve(rel_path: str) -> Path:
    rel_path = (rel_path or "").lstrip("/\\")
    candidate = (Config.root_dir / rel_path).resolve()
    root = Config.root_dir.resolve()
    if candidate != root and root not in candidate.parents:
        abort(400, "Invalid path")
    return candidate


def is_logged_in() -> bool:
    if not (session.get("authed") is True and session.get("username")):
        return False
    stoken = session.get("stoken")
    if stoken and stoken in invalidated_stokens:
        return False
    return True

@app.route("/", methods=["GET"])
def index():
    if not is_logged_in():
        return redirect(url_for("join"))
    return render_template("ide.html", username=session["username"], root_name=Config.root_dir.name)


@app.route("/join", methods=["GET", "POST"])
def join():
    error = None
    if request.method == "POST":
        pw = request.form.get("password", "")
        name = request.form.get("username", "").strip()[:32]
        if pw != Config.password:
            error = "Incorrect password."
        elif not name:
            error = "Please enter a name."
        else:
            session["authed"] = True
            session["username"] = name
            session["stoken"] = uuid.uuid4().hex
            return redirect(url_for("index"))
    return render_template("join.html", error=error)

@app.route("/logout")
def logout():
    stoken = session.get("stoken")
    if stoken:
        with users_lock:
            invalidated_stokens.add(stoken)
            session_conn_counts.pop(stoken, None)
    session.clear()
    return redirect(url_for("join"))

@app.route("/api/tree")
def api_tree():
    if not is_logged_in():
        abort(403)

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
            rel = str(child.relative_to(Config.root_dir))
            if child.is_dir():
                entries.append({
                    "name": child.name, "path": rel, "type": "dir",
                    "children": build(child)
                })
            else:
                entries.append({"name": child.name, "path": rel, "type": "file"})
        return entries

    return jsonify(build(Config.root_dir))

@app.route("/api/file")
def api_file():
    if not is_logged_in():
        abort(403)
    rel = request.args.get("path", "")
    path = safe_resolve(rel)
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

@app.route("/api/save", methods=["POST"])
def api_save():
    if not is_logged_in():
        abort(403)
    data = request.get_json(force=True)
    rel = data.get("path", "")
    content = data.get("content", "")
    path = safe_resolve(rel)
    if path.is_dir():
        abort(400)
    path.write_text(content, encoding="utf-8")
    socketio.emit("file_changed", {"path": rel, "content": content}, room=rel)
    return jsonify({"ok": True})

@app.route("/api/download-file")
def api_download_file():
    if not is_logged_in():
        abort(403)
    rel = request.args.get("path", "")
    path = safe_resolve(rel)
    if not path.is_file():
        abort(404)
    return send_file(path, as_attachment=True, download_name=path.name)

@app.route("/api/download-project")
def api_download_project():
    if not is_logged_in():
        abort(403)
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for dirpath, dirnames, filenames in os.walk(Config.root_dir):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES and not d.startswith(".")]
            for fname in filenames:
                full = Path(dirpath) / fname
                arcname = full.relative_to(Config.root_dir)
                zf.write(full, arcname)
    buf.seek(0)
    return send_file(buf, as_attachment=True,
                      download_name=f"{Config.root_dir.name}.zip",
                      mimetype="application/zip")

@app.route("/api/new", methods=["POST"])
def api_new():
    if not is_logged_in():
        abort(403)
    data = request.get_json(force=True)
    rel = data.get("path", "")
    kind = data.get("type", "file")
    path = safe_resolve(rel)
    if path.exists():
        abort(400, "Already exists")
    if kind == "dir":
        path.mkdir(parents=True)
    else:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.touch()
    socketio.emit("tree_update", {})
    return jsonify({"ok": True})

@app.route("/api/move", methods=["POST"])
def api_move():
    if not is_logged_in():
        abort(403)
    data = request.get_json(force=True)
    src_rel = data.get("src", "")
    dest_dir_rel = data.get("destDir", "")
    src_path = safe_resolve(src_rel)
    dest_dir = safe_resolve(dest_dir_rel)
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
    socketio.emit("tree_update", {})
    return jsonify({"ok": True})


@app.route("/api/delete", methods=["POST"])
def api_delete():
    if not is_logged_in():
        abort(403)
    data = request.get_json(force=True)
    rel = data.get("path", "")
    path = safe_resolve(rel)
    if path.is_dir():
        shutil.rmtree(path)
    elif path.is_file():
        path.unlink()
    socketio.emit("tree_update", {})
    return jsonify({"ok": True})

@socketio.on("connect")
def on_connect():
    if not is_logged_in():
        return False  # reject connection
    stoken = session.get("stoken")
    with users_lock:
        connected_users[request.sid] = {"username": session["username"], "path": None, "stoken": stoken}
        if stoken:
            session_conn_counts[stoken] = session_conn_counts.get(stoken, 0) + 1
    emit("presence", _presence_list(), broadcast=True)

@socketio.on("disconnect")
def on_disconnect():
    with users_lock:
        info = connected_users.pop(request.sid, None)
        stoken = info.get("stoken") if info else None
        if stoken:
            session_conn_counts[stoken] = session_conn_counts.get(stoken, 1) - 1
    emit("presence", _presence_list(), broadcast=True)
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
            invalidated_stokens.add(stoken)
            session_conn_counts.pop(stoken, None)

def _presence_list():
    with users_lock:
        return [{"username": u["username"], "path": u["path"]} for u in connected_users.values()]

@socketio.on("open_file")
def on_open_file(data):
    rel = data.get("path")
    with users_lock:
        prev = connected_users.get(request.sid, {}).get("path")
        if prev:
            leave_room(prev)
        if request.sid in connected_users:
            connected_users[request.sid]["path"] = rel
    if rel:
        join_room(rel)
    emit("presence", _presence_list(), broadcast=True)

@socketio.on("edit")
def on_edit(data):
    rel = data.get("path")
    if not rel:
        return
    emit("edit", data, room=rel, include_self=False)

@socketio.on("cursor")
def on_cursor(data):
    rel = data.get("path")
    if not rel:
        return
    data["username"] = session.get("username")
    emit("cursor", data, room=rel, include_self=False)

@socketio.on("run")
def on_run(data):
    rel = data.get("path", "")
    sid = request.sid
    try:
        path = safe_resolve(rel)
    except Exception:
        emit("run_output", {"stream": "error", "text": "Invalid file path.\n"}, room=sid)
        emit("run_done", {}, room=sid)
        return

    ext = path.suffix.lower()
    if not path.is_file():
        emit("run_output", {"stream": "error", "text": "File not found.\n"}, room=sid)
        emit("run_done", {}, room=sid)
        return

    cmd = None
    if ext == ".java":
        compile_proc = subprocess.run(
            ["javac", str(path)], cwd=str(path.parent),
            capture_output=True, text=True
        )
        if compile_proc.returncode != 0:
            emit("run_output", {"stream": "stderr", "text": compile_proc.stderr}, room=sid)
            emit("run_done", {}, room=sid)
            return
        cmd = ["java", path.stem]
    else:
        template = RUNNERS.get(ext)
        if not template:
            emit("run_output", {
                "stream": "error",
                "text": f"Don't know how to run '{ext}' files.\n"
            }, room=sid)
            emit("run_done", {}, room=sid)
            return
        cmd = [part.format(file=str(path)) for part in template]

    def stream_process():
        try:
            proc = subprocess.Popen(
                cmd, cwd=str(path.parent),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, bufsize=1
            )

            def pump(stream, name):
                for line in iter(stream.readline, ""):
                    socketio.emit("run_output", {"stream": name, "text": line}, room=sid)
                stream.close()

            t_out = threading.Thread(target=pump, args=(proc.stdout, "stdout"))
            t_err = threading.Thread(target=pump, args=(proc.stderr, "stderr"))
            t_out.start()
            t_err.start()
            t_out.join()
            t_err.join()
            proc.wait()
            socketio.emit("run_output", {
                "stream": "system"
            }, room=sid)
        except FileNotFoundError:
            socketio.emit("run_output", {
                "stream": "error",
                "text": f"Couldn't find interpreter for this file type (tried: {' '.join(cmd)}).\n"
            }, room=sid)
        except Exception as e:
            socketio.emit("run_output", {"stream": "error", "text": f"Error: {e}\n"}, room=sid)
        finally:
            socketio.emit("run_done", {}, room=sid)

    socketio.start_background_task(stream_process)

def main():
    parser = argparse.ArgumentParser(description="Run the Collab IDE host server.")
    parser.add_argument("--dir", required=True, help="Project directory to open and share.")
    parser.add_argument("--password", required=True, help="Password users must enter to join.")
    parser.add_argument("--port", type=int, default=5000, help="Port to listen on (default 5000).")
    parser.add_argument("--host", default="0.0.0.0", help="Bind address (default 0.0.0.0, i.e. all interfaces).")
    args = parser.parse_args()

    root = Path(args.dir).expanduser().resolve()
    if not root.is_dir():
        raise SystemExit(f"Not a directory: {root}")

    Config.root_dir = root
    Config.password = args.password
    Config.port = args.port

    print(f"Serving directory: {root}")
    print(f"Join password: {args.password}")
    print(f"Listening on http://{args.host}:{args.port}  (share your LAN IP with others)")
    print("Press Ctrl+C to stop.\n")

    socketio.run(app, host=args.host, port=args.port, allow_unsafe_werkzeug=True)


if __name__ == "__main__":
    main()
