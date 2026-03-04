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
   ├─ Auto-fetches latest WhatsApp protocol version from Baileys API
   ├─ Starts WhatsApp connection with Baileys
   ├─ Captures QR from connection.update event
   ├─ Renders QR as PNG image (not ASCII)
   ├─ Serves it on http://localhost:8899
   │
   ├─ On successful scan:
   │   ├─ Handles exit code 515 (restart after pairing — NOT an error)
   │   ├─ Auto-fixes registered:false in creds.json
   │   ├─ Reconnects with saved credentials
   │   └─ Shows "Download Credentials" button on the web page
   │
   ├─ On 405 error:
   │   └─ Shows clear message with link to find the latest version
   │
   ├─ Anti-crash-loop:
   │   └─ Max 5 retries → 5-min cooldown → prevents IP soft-ban
   │
   └─ Graceful shutdown (Ctrl+C):
       └─ Closes WebSocket cleanly so WhatsApp doesn't think you're still connected
```

## Quick Start

```bash
git clone https://github.com/Nadav-Fux/wa-qr-web.git
cd wa-qr-web
npm install
node pair-server.mjs
```

Open `http://localhost:8899` in your browser. Scan the QR with WhatsApp > Linked Devices > Link a Device.

### Remote Server

If you're running on a remote server, you need a public URL so your phone can reach the QR page. Pick any option:

#### Option A: Built-in tunnel (easiest — no signup, no extra tools)

```bash
node pair-server.mjs --tunnel
```

This uses [localtunnel](https://github.com/localtunnel/localtunnel) to create a temporary public URL. It prints the URL in the terminal — open it on your phone and scan.

#### Option B: Cloudflare quick tunnel (if you have cloudflared)

```bash
# Terminal 1
node pair-server.mjs

# Terminal 2
cloudflared tunnel --url http://localhost:8899
```

#### Option C: SSH reverse tunnel (works anywhere with SSH)

```bash
# From your local machine, forward the remote server's port
ssh -L 8899:localhost:8899 user@your-server

# Then open http://localhost:8899 on your local browser
```

#### Option D: npx one-liner (no install needed)

```bash
# Terminal 1
node pair-server.mjs

# Terminal 2
npx localtunnel --port 8899
```

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `PORT` | `8899` | HTTP server port |
| `AUTH_DIR` | `./auth` | Where credentials are saved |
| `BROWSER_NAME` | `WA-QR-Web` | Browser name shown in WhatsApp linked devices |
| `WA_VERSION` | `[2,3000,1034074495]` | WhatsApp protocol version (update when 405 errors appear) |
| `MAX_RECONNECTS` | `5` | Max reconnection attempts before cooldown kicks in |
| `COOLDOWN_MS` | `300000` (5 min) | How long to wait after hitting the reconnect limit |
| `TUNNEL` | `0` | Set to `1` to auto-start tunnel (same as `--tunnel` flag) |

```bash
# Custom port
PORT=3456 node pair-server.mjs

# Custom auth directory
AUTH_DIR=/path/to/creds node pair-server.mjs

# Updated protocol version (when default goes stale)
WA_VERSION="[2,3000,NEW_NUMBER]" node pair-server.mjs
```

## Anti-Crash-Loop Protection

This is the feature that would have saved us a week of downtime.

**The problem**: If you run Baileys behind a process manager (supervisor, pm2, systemd) with `autorestart=true` and something goes wrong (bad version, expired creds, network issue), the process manager will restart the script hundreds of times. Each restart = a new connection attempt to WhatsApp's servers. After enough attempts, WhatsApp soft-bans your IP. Now you can't connect even with the right code.

**What happened to us**: Supervisor with `autorestart=true` and unlimited retries crash-looped wa_daemon for 7 days. Hundreds of reconnection attempts. We thought we were rate-limited, but the real problem was an outdated protocol version — we just couldn't tell because the crash loop was burying the real error.

**How wa-qr-web protects you**:
- Max 5 reconnection attempts (configurable via `MAX_RECONNECTS`)
- After hitting the limit, waits 5 minutes before trying again (`COOLDOWN_MS`)
- Resets the counter after a successful connection
- **Never retries on 405** — the version is wrong, retrying won't help
- Shows a clear warning on the web UI when rate-limited
- Tells you to fix your process manager config

**Supervisor config that won't crash-loop**:
```ini
[program:wa_daemon]
autorestart=unexpected    ; NOT true — prevents infinite loops
startretries=3            ; limit restart attempts
startsecs=10              ; minimum uptime before considered "started"
```

## Auto Version Detection

The #1 failure mode is an outdated protocol version causing 405 errors. This tool **auto-fetches the latest version** from the Baileys API on startup. If the fetch fails (no internet, API down), it falls back to the hardcoded version.

You can still override manually if needed:
```bash
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

After pairing, your credentials are in the `auth/` directory.

### Option 1: Download Button (remote servers)

After successful pairing, the web page shows a **Download Credentials** button. Click it to get a `wa-credentials.tar.gz` file, then extract on your target machine:

```bash
tar -xzf wa-credentials.tar.gz -C /path/to/your/bot/credentials/
```

### Option 2: Copy manually

```bash
# Local copy
cp -r auth/* /path/to/your/bot/credentials/

# SCP from remote server
scp -r user@server:~/wa-qr-web/auth/* ./credentials/

# Docker containers
docker cp auth/. my-container:/app/credentials/
```

### Bug 4: Ghost Sessions After Ctrl+C

**What happens**: You kill the pairing server with Ctrl+C. The WebSocket doesn't close properly. WhatsApp thinks you're still connected. Next time you try to pair, you get weird errors like "device already linked" or the QR won't generate.

**Our fix**: SIGINT/SIGTERM handlers that close the WebSocket cleanly before exiting. WhatsApp is properly notified that the session ended.

## Other Common Pitfalls

### QR Code Expires Too Fast

WhatsApp QR codes expire after ~60 seconds. If you're slow to scan, the server generates a new one automatically. The page auto-refreshes every 8 seconds so you'll always see the latest QR.

### Multiple Devices / Existing Session

If you already have a "WhatsApp Web" session linked on your phone, you may need to unlink it first before this tool can pair. Go to WhatsApp > Settings > Linked Devices and remove old sessions.

### Firewall / Port Issues on Remote Servers

If running on a VPS, port 8899 might be blocked by the firewall. Instead of opening the port, use a Cloudflare tunnel — it's temporary, secure, and requires zero config:
```bash
cloudflared tunnel --url http://localhost:8899
```

### Node.js Version

Baileys v7 requires **Node.js 18+**. If you're on an older version, you'll get cryptic import errors.

### WhatsApp Business vs Regular

This tool works with both WhatsApp and WhatsApp Business. The pairing flow is identical.

## API

| Endpoint | Description |
|---|---|
| `GET /` | Web page with QR code and status |
| `GET /qr.png` | Raw QR code as PNG image |
| `GET /health` | JSON: `{ status, connectedId, qrCount, reconnectCount, maxReconnects }` |
| `GET /download-creds` | Download credentials as `tar.gz` (only available after successful pairing) |

## Disclaimer

This tool uses [Baileys](https://github.com/WhiskeySockets/Baileys), an unofficial WhatsApp Web API library. Using unofficial clients may violate WhatsApp's Terms of Service and could result in your account being banned. Use at your own risk.

The credentials saved in `auth/` provide full access to your WhatsApp session (reading messages, sending messages, etc.). **Treat them like passwords.** Never expose the `/download-creds` endpoint to the public internet. To revoke access, go to WhatsApp > Settings > Linked Devices and unlink the session.

## License

MIT
