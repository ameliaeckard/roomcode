# RoomCode

Live at **code.ameliaeckard.com**.

A tiny multi-session coding environment. Run the server once (locally or
deployed); anyone can then create their own session and invite others to
join it. Live shared editing, running code, and host controls, all
scoped per session.

SECURITY NOTE: This app lets connected users execute code wherever it's
running via the Run button — there's no container/chroot, so a run has the
same filesystem and network access as the server process itself and *can*
read or write outside its session folder. Run subprocesses do get some
best-effort hardening (they don't inherit the server's own environment
variables/secrets, and on Linux they're capped on CPU time, memory, and
max file size), but that's not a sandbox. Only run this on networks you
trust, and only share session passwords with people you trust.

## How it works

- **Server**: runs `server.py`, pointed at a base directory where
  session folders get created.
- **Everyone else**: just needs a browser and the address, no install
  required on their side.
- Each session gets its own subfolder, file tree, terminal, and list of
  connected users.
- When the last person leaves a session, it's deleted automatically, so make sure to
- press the download button to save your work!

## Setup (server machine only)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Running

```bash
python3 server.py --dir /path/to/sessions
```

`--dir` (env `PROJECT_DIR`) is the *base* directory sessions live under —
not a single shared project folder. It defaults to `./sessions` next to
`server.py` if omitted.

Visit the address it prints:
- **Create Room**: pick a session password and your name, and you're in
  as that session's **host**. A fresh folder is created for you
  automatically.
- **Join Room**: enter an existing session's password and your name to
  join it as a regular user.

Other flags (env vars in parentheses):
- `--port` (`PORT`)
- `--host` (default `0.0.0.0`)
- `--dir` (`PROJECT_DIR`)

On your LAN, find your IP with:
- macOS/Linux: `ifconfig | grep inet` or `ipconfig getifaddr en0`
- Windows: `ipconfig` (look for "IPv4 Address")

## Features

- **Live shared editing**, powered by Yjs (a CRDT): everyone's edits
  merge automatically, nobody can overwrite someone else's changes, and
  opening a file always shows its current live content — even edits made
  before you joined. Auto-saves continuously in the background.
- **Live cursors**: see where everyone else is typing, with their name
  attached, fading out after they've been idle a bit.
- **Run**: the host can run a file for everyone (output shows in
  everyone's terminal).
- **Run Local**: Everyone, host included, can run the code locally, but the output only shows up for them.
- **Lock**: the host can lock editing for everyone else, and it locks
  automatically if the main host disconnects. Locking back off is manual.
- **Add Hosts**: the host can promote another connected user to host
  status from Settings. Only the *original* host leaving triggers the
  auto-lock — a promoted host leaving doesn't.
- **Settings panel**: participants list (scrolls, so it's fine with big
  rooms), room password (for sharing), add hosts, theme/layout, and Leave.
- **Edit history**: per file, click "History" in the tab bar to see who's
  edited that file and when.
- **File/folder permissions**: anyone can create files, but you can only
  delete or rename things you created yourself. The host can delete or
  rename anything.
- **Drag and drop** files/folders to move them around.
- Dark/light theme (follows your system by default), resizable
  editor/terminal split, collapsible sidebar.

- **New "Run" language**: add an entry to `RUNNERS` in `server.py`
  mapping the file extension to a command template.
