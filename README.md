```
 ╦ ╦╔═╗   ╔═╗ ╦═╗   ╦ ╦╔═╗╔╗
 ║║║╠═╣───║═╬╗╠╦╝───║║║║╣ ╠╩╗
 ╚╩╝╩ ╩   ╚═╝╚╩╚═   ╚╩╝╚═╝╚═╝
```

# wa-qr-web

Serve the WhatsApp pairing QR code on a web page so you can scan it from your phone browser. Built for Baileys — fixes the 3 bugs that make pairing fail.

## The Problem

Pairing WhatsApp with [Baileys](https://github.com/WhiskeySockets/Baileys) is painful:

1. **Terminal QR codes break** — SSH sessions, narrow terminals, and tmux mangle the ASCII QR pattern. Your phone can't scan a deformed QR.
2. **HTTP 405 errors** — Baileys ships with a hardcoded protocol version that goes stale. WhatsApp rejects it silently.
3. **`registered: false` bug** — After successful pairing, Baileys sometimes forgets to mark credentials as registered. Next restart = pairing loop.

This tool fixes all three.

## How It Works

```
node pair-server.mjs
   │
   ├─ Starts WhatsApp connection with Baileys
   ├─ Captures QR from connection.update event
   ├─ Renders QR as PNG image (not ASCII)
   ├─ Serves it on http://localhost:8899
   │
   ├─ On successful scan:
   │   ├─ Handles exit code 515 (restart after pairing — NOT an error)
   │   ├─ Auto-fixes registered:false in creds.json
   │   └─ Reconnects with saved credentials
   │
   └─ On 405 error:
       └─ Shows clear message with link to find the latest version
```

## Quick Start

```bash
git clone https://github.com/Nadav-Fux/wa-qr-web.git
cd wa-qr-web
npm install
node pair-server.mjs
```

Open `http://localhost:8899` in your browser. Scan the QR with WhatsApp > Linked Devices > Link a Device.

### Remote Server (SSH)

If you're running on a remote server, use a Cloudflare quick tunnel:

```bash
# Terminal 1
node pair-server.mjs

# Terminal 2
cloudflared tunnel --url http://localhost:8899
```

This gives you a temporary `https://xxxxx.trycloudflare.com` URL to open on your phone. No DNS or config needed — it disappears when you stop cloudflared.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `8899` | HTTP server port |
| `AUTH_DIR` | `./auth` | Where credentials are saved |
| `BROWSER_NAME` | `WA-QR-Web` | Browser name shown in WhatsApp linked devices |
| `WA_VERSION` | `[2,3000,1034074495]` | WhatsApp protocol version (update when 405 errors appear) |

```bash
# Custom port
PORT=3456 node pair-server.mjs

# Custom auth directory
AUTH_DIR=/path/to/creds node pair-server.mjs

# Updated protocol version (when default goes stale)
WA_VERSION="[2,3000,NEW_NUMBER]" node pair-server.mjs
```

## Bugs This Tool Fixes

### Bug 1: Terminal QR Codes Are Unscannable

**What happens**: Baileys prints QR codes as ASCII art in the terminal. But SSH sessions, narrow terminals, screen/tmux, and non-monospace fonts break the pattern. Your phone camera can't read a mangled QR.

**Our fix**: Render QR as a PNG image using the `qrcode` library. Serve it on an HTTP page. Clean, scannable every time.

### Bug 2: HTTP 405 — Protocol Version Outdated

**What happens**: Baileys v7 hardcodes a WhatsApp protocol version number. WhatsApp periodically deprecates old versions. When this happens, every connection attempt returns `405 Method Not Allowed` — but the error message is useless. You'll think you're rate-limited or banned.

**Our fix**: The version is configurable via `WA_VERSION` env var. When you hit 405, the web UI shows a clear error with a link to find the latest version number. No digging through GitHub issues.

**How to find the latest version**:
1. Go to [Baileys issues](https://github.com/WhiskeySockets/Baileys/issues?q=405)
2. Look for recent reports with the working version number
3. Set: `WA_VERSION="[2,3000,NEW_NUMBER]" node pair-server.mjs`

**Version history**:
| Date | Version | Notes |
|------|---------|-------|
| March 2026 | `1034074495` | Current working version |
| Pre-March 2026 | `1027934701` | Baileys default (outdated, causes 405) |

### Bug 3: `registered: false` After Successful Pairing

**What happens**: You scan the QR, your phone shows "WhatsApp Web" in linked devices, Baileys writes credentials... but sets `"registered": false` in `creds.json`. On the next restart, Baileys tries to pair again instead of using the saved session. Infinite pairing loop.

**Our fix**: After connecting, we check `creds.json` and auto-set `registered: true` if it's wrong.

### Bonus: Exit Code 515 Is NOT an Error

**What happens**: After scanning the QR, the Baileys socket disconnects with code `515`. It looks like an error. Your script crashes. You panic.

**Reality**: 515 means "restart required" — pairing succeeded, now reconnect with the new credentials. It's expected behavior.

**Our fix**: Auto-reconnect on 515 with a 2-second delay.

## Transferring Credentials

After pairing, your credentials are in the `auth/` directory. To use them with your WhatsApp bot:

```bash
# Copy to your bot's credentials directory
cp -r auth/* /path/to/your/bot/credentials/

# Or for Docker containers
docker cp auth/. my-container:/app/credentials/
```

## API

| Endpoint | Description |
|---|---|
| `GET /` | Web page with QR code and status |
| `GET /qr.png` | Raw QR code as PNG image |
| `GET /health` | JSON status: `{ status, connectedId, qrCount }` |

## License

MIT
