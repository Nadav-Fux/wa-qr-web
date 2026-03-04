#!/usr/bin/env node

/**
 * wa-qr-web — WhatsApp QR Pairing Server
 *
 * Serves the WhatsApp QR code as a web page so you can scan it
 * from your phone browser instead of fighting with terminal QR codes.
 *
 * Usage:
 *   node pair-server.mjs [--port 8899] [--auth-dir ./auth]
 *
 * Then open http://localhost:8899 in your browser (or use a Cloudflare tunnel
 * if running on a remote server).
 */

import { makeWASocket, useMultiFileAuthState, makeCacheableSignalKeyStore, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import fs from 'fs';
import http from 'http';
import { Boom } from '@hapi/boom';

// ─── Config ──────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '8899');
const AUTH_DIR = process.env.AUTH_DIR || './auth';
const BROWSER_NAME = process.env.BROWSER_NAME || 'WA-QR-Web';

// WhatsApp protocol version — this is the #1 reason pairing fails.
// If you get HTTP 405 errors, update this number.
// Check: https://github.com/WhiskeySockets/Baileys/issues?q=405
//
// As of March 2026: 1034074495
// Previous (broken):  1027934701
const WA_VERSION = process.env.WA_VERSION
  ? JSON.parse(process.env.WA_VERSION)
  : [2, 3000, 1034074495];

// ─── State ───────────────────────────────────────────────────────────────────

let latestQRBase64 = '';
let status = 'waiting';     // waiting | scan | reconnecting | connected | rate-limited
let connectedId = '';
let qrCount = 0;

// ─── Anti-Crash-Loop / Rate Limit Protection ─────────────────────────────────
//
// Without this, a misconfigured supervisor or process manager will restart
// the script hundreds of times, hammering WhatsApp's servers. This gets your
// IP soft-banned and makes the problem 10x worse.
//
// Real incident: Spark server crash-looped for 7 days because supervisor had
// autorestart=true with no retry limit. Hundreds of reconnection attempts.
//
const MAX_RECONNECTS = parseInt(process.env.MAX_RECONNECTS || '5');  // max retries before cooldown
const COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000');   // 5 min cooldown after max retries
let reconnectCount = 0;
let lastReconnect = 0;

// ─── WhatsApp Connection ─────────────────────────────────────────────────────

function safeReconnect(delaySec, reason) {
  reconnectCount++;
  const now = Date.now();

  // Reset counter if enough time passed since last reconnect (successful cooldown)
  if (now - lastReconnect > COOLDOWN_MS) {
    reconnectCount = 1;
  }
  lastReconnect = now;

  if (reconnectCount > MAX_RECONNECTS) {
    const cooldownMin = Math.round(COOLDOWN_MS / 60000);
    console.error(`\n[RATE LIMIT] ${reconnectCount} reconnects — cooling down for ${cooldownMin} minutes.`);
    console.error('[RATE LIMIT] This prevents WhatsApp from soft-banning your IP.');
    console.error('[RATE LIMIT] If you keep hitting this, check your process manager config.\n');
    status = 'rate-limited';

    setTimeout(() => {
      console.log('[RATE LIMIT] Cooldown over — retrying...');
      reconnectCount = 0;
      connect();
    }, COOLDOWN_MS);
    return;
  }

  console.log(`[RECONNECT ${reconnectCount}/${MAX_RECONNECTS}] ${reason} — retrying in ${delaySec}s...`);
  setTimeout(connect, delaySec * 1000);
}

async function connect() {
  // Clean auth dir on first run
  if (qrCount === 0) {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    fs.mkdirSync(AUTH_DIR, { recursive: true });
  }

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, console),
    },
    printQRInTerminal: false,
    browser: [BROWSER_NAME, 'Chrome', '22.0'],
    version: WA_VERSION,
    qrTimeout: 60000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    // ── New QR code generated ──
    if (update.qr) {
      qrCount++;
      const png = await QRCode.toBuffer(update.qr, { scale: 8 });
      latestQRBase64 = png.toString('base64');
      status = 'scan';
      console.log(`[QR #${qrCount}] New QR code ready — open http://localhost:${PORT} to scan`);
    }

    // ── Connected ──
    if (update.connection === 'open') {
      status = 'connected';
      connectedId = sock.user?.id || 'unknown';
      reconnectCount = 0;  // Reset on successful connection
      console.log(`[OK] Connected as ${connectedId}`);

      // Fix the "registered: false" bug — Baileys doesn't always set this
      const credsPath = `${AUTH_DIR}/creds.json`;
      if (fs.existsSync(credsPath)) {
        try {
          const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'));
          if (!creds.registered) {
            creds.registered = true;
            fs.writeFileSync(credsPath, JSON.stringify(creds, null, 2));
            console.log('[FIX] Set registered=true in creds.json (Baileys bug workaround)');
          }
        } catch (e) {
          console.warn('[WARN] Could not patch creds.json:', e.message);
        }
      }
    }

    // ── Disconnected ──
    if (update.connection === 'close') {
      const reason = new Boom(update.lastDisconnect?.error)?.output?.statusCode;
      console.log(`[CLOSE] code=${reason}`);

      if (reason === DisconnectReason.restartRequired || reason === 515) {
        // 515 = successful pairing, restart required. THIS IS NOT AN ERROR.
        status = 'reconnecting';
        safeReconnect(2, 'Pairing successful (515) — reconnecting with new credentials');

      } else if (reason === DisconnectReason.loggedOut || reason === 401) {
        // Session expired or device was unlinked
        status = 'waiting';
        latestQRBase64 = '';
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        fs.mkdirSync(AUTH_DIR, { recursive: true });
        safeReconnect(2, 'Logged out (401) — generating new QR');

      } else if (reason === 405) {
        // Protocol version outdated — this is the most common issue
        // Do NOT reconnect — it will never work with the wrong version
        console.error('\n[ERROR] HTTP 405 — WhatsApp rejected the protocol version.');
        console.error('Your WA_VERSION is outdated. Check for the latest version:');
        console.error('  https://github.com/WhiskeySockets/Baileys/issues?q=405');
        console.error('Then restart with: WA_VERSION="[2,3000,NEW_NUMBER]" node pair-server.mjs\n');
        status = 'error-405';

      } else {
        safeReconnect(5, `Unknown close reason (${reason})`);
    }
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

const HTML_PAGE = (statusClass, statusText, qrImg, extra) => `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>WhatsApp QR Pairing</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
*{box-sizing:border-box}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;
  min-height:100vh;margin:0;background:#0b1120;color:#e2e8f0;font-family:-apple-system,sans-serif}
.card{background:#1e293b;border-radius:16px;padding:32px;max-width:420px;width:90%;text-align:center;
  box-shadow:0 8px 32px rgba(0,0,0,0.4)}
h1{margin:0 0 4px;font-size:1.5em;color:#fff}
.subtitle{opacity:0.6;margin-bottom:20px;font-size:0.9em}
img{max-width:300px;width:100%;border-radius:12px;background:#fff;padding:12px}
.status{font-size:1.1em;margin:16px 0;padding:10px 24px;border-radius:8px;font-weight:600}
.scan{background:#25D366;color:#000}
.connected{background:#00c853;color:#000}
.waiting{background:#334155;color:#94a3b8}
.reconnecting{background:#f59e0b;color:#000}
.error-405{background:#ef4444;color:#fff}
.rate-limited{background:#f97316;color:#000}
.steps{text-align:left;margin-top:16px;font-size:0.85em;opacity:0.7;line-height:1.8}
.check{font-size:4em}
.footer{margin-top:16px;opacity:0.4;font-size:0.8em}
</style></head><body>
<div class="card">
<h1>WhatsApp QR Pairing</h1>
<div class="subtitle">wa-qr-web</div>
<div class="status ${statusClass}">${statusText}</div>
${qrImg}
${extra}
</div>
<div class="footer">Auto-refreshes every 8 seconds</div>
<script>setInterval(()=>location.reload(),8000)</script>
</body></html>`;

const STEPS = `<div class="steps">
<strong>How to scan:</strong><br>
1. Open WhatsApp on your phone<br>
2. Tap <strong>Settings</strong> (or &#8942;) &rarr; <strong>Linked Devices</strong><br>
3. Tap <strong>Link a Device</strong><br>
4. Point camera at the QR code above
</div>`;

const RATE_LIMIT_MSG = `<div class="steps" style="color:#fed7aa">
<strong>Too many reconnection attempts.</strong><br>
The server is cooling down to avoid getting your IP soft-banned by WhatsApp.<br><br>
This usually means your process manager (supervisor, pm2, systemd) is restarting the script in a loop.<br><br>
<strong>Fix:</strong> Set <code style="background:#334155;padding:2px 6px;border-radius:4px">autorestart=false</code> or limit retries in your process manager config.
</div>`;

const ERROR_405_MSG = `<div class="steps" style="color:#fca5a5">
<strong>Protocol version is outdated.</strong><br>
WhatsApp rejected the connection. You need to update the version number:<br><br>
1. Check <a href="https://github.com/WhiskeySockets/Baileys/issues?q=405" style="color:#93c5fd">Baileys GitHub issues</a> for the latest version<br>
2. Restart with: <code style="background:#334155;padding:2px 6px;border-radius:4px">WA_VERSION="[2,3000,NEW]" node pair-server.mjs</code>
</div>`;

const server = http.createServer((req, res) => {
  // Serve QR as raw PNG
  if (req.url?.startsWith('/qr.png') && latestQRBase64) {
    const buf = Buffer.from(latestQRBase64, 'base64');
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
    res.end(buf);
    return;
  }

  // Health check endpoint (for monitoring)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status, connectedId, qrCount, reconnectCount, maxReconnects: MAX_RECONNECTS }));
    return;
  }

  // Main page
  let statusText, qrImg, extra;

  switch (status) {
    case 'connected':
      statusText = `Connected as ${connectedId}`;
      qrImg = '<div class="check">&#9989;</div>';
      extra = '<p style="opacity:0.7">Credentials saved to <code>' + AUTH_DIR + '/</code></p>';
      break;
    case 'scan':
      statusText = 'Scan this QR code with WhatsApp';
      qrImg = `<img src="/qr.png?t=${Date.now()}" alt="QR Code">`;
      extra = STEPS;
      break;
    case 'reconnecting':
      statusText = 'Pairing successful! Reconnecting...';
      qrImg = '<div class="check">&#128260;</div>';
      extra = '<p style="opacity:0.7">This is normal — wait a few seconds</p>';
      break;
    case 'error-405':
      statusText = 'Error 405 — Version Outdated';
      qrImg = '<div class="check">&#10060;</div>';
      extra = ERROR_405_MSG;
      break;
    case 'rate-limited':
      statusText = `Rate Limited — Cooling Down (${Math.round(COOLDOWN_MS/60000)} min)`;
      qrImg = '<div class="check">&#9200;</div>';
      extra = RATE_LIMIT_MSG;
      break;
    default:
      statusText = 'Waiting for QR code...';
      qrImg = '<div class="check" style="opacity:0.3">&#9202;</div>';
      extra = '<p style="opacity:0.5">Starting WhatsApp connection...</p>';
  }

  const html = HTML_PAGE(status, statusText, qrImg, extra);
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(html);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  wa-qr-web running on http://localhost:${PORT}\n`);
  console.log('  Open this URL in your browser to scan the QR code.');
  console.log('  For remote servers, use: cloudflared tunnel --url http://localhost:' + PORT);
  console.log('');
});

connect();

// Safety timeout — 10 minutes
setTimeout(() => {
  if (status !== 'connected') {
    console.log('[TIMEOUT] No successful connection after 10 minutes. Exiting.');
    process.exit(1);
  }
}, 600000);
