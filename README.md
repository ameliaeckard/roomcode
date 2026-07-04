# RoomCode

A tiny host-and-join coding environment. One person (the host) runs the
server pointed at a folder on their machine; everyone else on the same
network opens a browser, enters a password and a name, and gets an IDE backed by the host's files.

SECURITY NOTE: This app lets connected users execute code on the host
machine via the Run button. Only run it on networks you trust, and only
share the password with people you trust. Do not expose this directly
to the public internet.

## How it works

- **Host machine**: runs `server.py`
- **Everyone else**: just needs a browser and the host's local network
  address — no install required on their side.
- All editing, running, and file browsing happens against the host's
  filesystem, inside the one folder the host chose to share.

## Setup (host machine only)

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

## Running

```bash
python3 server.py --dir /path/to/your/project --password choose-a-password
```

Optional flags:
- `--port 5000`
- `--host 0.0.0.0`

The terminal will print the host's bindable address.

- macOS/Linux: `ifconfig | grep inet` or `ipconfig getifaddr en0`
- Windows: `ipconfig` (look for "IPv4 Address")

## Extending it

- **New "Run" language**: add an entry to `RUNNERS` in `server.py`
  mapping the file extension to a command template.
