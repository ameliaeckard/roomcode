# RoomCode

A tiny multi-session coding environment. Run the server once (locally or
deployed); anyone can then create their own session — an isolated
project folder protected by a password they pick — and invite others to
join it. Live shared editing, a run button, and host controls, all
scoped per session.

SECURITY NOTE: This app lets connected users execute code wherever it's
running via the Run button (host-only). Only run it on networks you
trust, and only share session passwords with people you trust.

## How it works

- **Server**: runs `server.py`, pointed at a base directory where
  session folders get created.
- **Everyone else**: just needs a browser and the address — no install
  required on their side.
- Each session gets its own subfolder, file tree, terminal, and list of
  connected users — sessions don't see or affect each other.

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
- **`/create`** — pick a session password and your name, and you're in
  as that session's **host**. A fresh folder is created for you
  automatically.
- **`/join`** — enter an existing session's password and your name to
  join it as a regular user (never host — `/join` can't grant that).

The host is the only one who can Run code (output is broadcast to
everyone in that session) and lock/unlock editing for everyone else.

Other flags (env vars in parentheses):
- `--port` (`PORT`)
- `--host` (default `0.0.0.0`)
- `--dir` (`PROJECT_DIR`)

On your LAN, find your IP with:
- macOS/Linux: `ifconfig | grep inet` or `ipconfig getifaddr en0`
- Windows: `ipconfig` (look for "IPv4 Address")

## Deploying (e.g. Railway)

This runs fine as a normal long-lived Railway service (Flask-SocketIO,
no special adapter needed):

1. New Railway service from this repo — it picks up the `Procfile`.
2. Add a **Volume** and mount it somewhere like `/data`, so session
   folders survive redeploys (Railway's regular filesystem is ephemeral).
3. Set the `PROJECT_DIR` env var to that mount path (e.g. `/data`).
4. Deploy, then visit the URL Railway gives you and hit `/create`.

Keep in mind: this puts a remote-code-execution tool on the open
internet, gated only by whatever session passwords get chosen. That's
the whole point of the app, but it's worth being deliberate about who
you share the URL and passwords with.

## Extending it

- **New "Run" language**: add an entry to `RUNNERS` in `server.py`
  mapping the file extension to a command template.
