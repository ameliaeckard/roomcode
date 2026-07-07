# RoomCode

Live at **code.ameliaeckard.com**.

A tiny multi-session coding environment. Run the server once (locally or
deployed); anyone can then create their own session and invite others to
join it. Live shared editing, running code, and host controls, all
scoped per session.

SECURITY NOTE: This app lets connected users execute code wherever it's
running via the Run button. Only run it on networks you trust, and only
share session passwords with people you trust.

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

- **Live shared editing** and live selection highlighting, per file.
- **Run**: the host can run a file for everyone (output shows in
  everyone's terminal).
- **Run Local**: Everyone, host included, can run the code locally, but the output only shows up for them.
- **Lock**: the host can lock editing for everyone else, and it locks
  automatically if the host disconnects. Locking back off is manual.
- **File/folder permissions**: anyone can create files, but you can only
  delete or rename things you created yourself. The host can delete or
  rename anything.
- **Drag and drop** files/folders to move them around.
- Dark/light theme (follows your system by default), resizable
  editor/terminal split, collapsible sidebar.

- **New "Run" language**: add an entry to `RUNNERS` in `server.py`
  mapping the file extension to a command template.
