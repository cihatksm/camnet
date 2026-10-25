# CamNet

Turn phones, tablets and computers on your local network into **live cameras for OBS** — no database, no cloud, no recording.

CamNet runs a small local server. Any device on the same network opens the web app, shares its camera, and gets a stable path (`/c/<camera-id>`) that OBS can consume. Video flows directly from the device to OBS over WebRTC, with an automatic MJPEG fallback.

---

## Features

- **Multi-device camera sharing** over the local network.
- **WebRTC** for low latency, with an automatic **MJPEG** fallback.
- **Stable per-device paths** — every camera gets `/c/<camera-id>`.
- **OBS Browser Source** and **Media Source / VLC Source** support.
- Live thumbnails, viewer counts and **QR pairing** on the home page.
- Per-camera settings: resolution, frame rate, quality, microphone, **rotation** (0°/90°/180°/270°) and preview mirror.
- **Preview off by default** on phones to save battery.
- **Portable desktop app** (single `.exe`) with a control panel and QR code.
- **Installable PWA** for phones ("Add to Home Screen").
- **HTTPS certificate generated automatically** on first run.
- **No database** — camera data lives in `data/cameras.json`.
- **Nothing is recorded**; the image is only transmitted live.
- Automatic reconnect when the connection drops.

---

## Requirements

- **Node.js** `^20.19.0` or `>=22.12.0` (development and building only).
- **Windows 10/11** to build the portable `.exe` (the web server itself is cross-platform).
- A modern browser on the devices (Chrome, Edge, Safari, Firefox).

---

## Quick start

```bash
npm install
npm run build
npm start
```

The terminal prints the addresses:

```
This computer      : http://localhost:3000
Devices on your LAN: http://192.168.x.x:3000
Camera sharing     : https://192.168.x.x:3443
```

- **Watch / OBS:** `http://<server-ip>:3000`
- **Camera sharing (phones):** `https://<server-ip>:3443`

### Phone / tablet

1. Open `https://<server-ip>:3443` on the phone.
2. Accept the certificate warning once:
   - **Android/Chrome:** Advanced → Proceed
   - **iPhone/Safari:** Show Details → visit this website → Continue
3. Click **Share camera**, name the device, allow camera access.
4. Copy the OBS link from the share page.

> Camera access on phones only works over HTTPS (or `localhost`). That is why the server also runs HTTPS on port 3443 with a self-signed certificate.

---

## Desktop app (portable `.exe`)

Build a single, double-clickable Windows executable:

```bash
npm run dist:win
```

This produces **`release/CamNet.exe`** (portable, no Node.js required on the target machine).

What it does:

- **Requires administrator privileges.** If launched normally, it asks for elevation via UAC and exits if you decline. This is needed to open the firewall.
- **Automatically allows TCP 3000 and 3443 on all network profiles** at startup (`Set-NetFirewallRule -Profile Any`, creating the rule if missing). This fixes the common case where Windows marks the LAN as “Public” and blocks inbound traffic.
- Starts the HTTP + HTTPS server automatically.
- Opens a small control panel with the addresses, copy buttons, a **QR code** for phones, the camera count, and **Open in browser** / **Quit**.
- Stores cameras, settings and certificates in a **`data` folder next to the executable** (portable).

**First launch notes:**

- Windows SmartScreen may warn because the executable is unsigned: choose **More info → Run anyway**.
- Make sure ports 3000/3443 are free (stop `npm run dev` / `npm start` before launching the app).
- If you prefer not to use the desktop app, `allow-firewall.bat` is still available as a standalone firewall fix.

---

## PWA (phones)

The web app can be installed like a native app:

- **Android / Chrome:** menu → **Install app** / **Add to Home screen**
- **iPhone / Safari:** Share → **Add to Home Screen**

It opens full-screen without the browser address bar and loads faster thanks to the service worker. The first visit still requires accepting the self-signed HTTPS certificate.

---

## OBS

### Method 1 — Browser Source (recommended)

1. Sources → **+** → **Browser**
2. URL: `http://<server-ip>:3000/c/<camera-id>`
3. Width / height: `1280` / `720` (match your camera)
4. Turn **off** “Shutdown source when not visible”.

### Method 2 — Media Source / VLC (if WebRTC misbehaves)

```
http://<server-ip>:3000/c/<camera-id>.mjpeg
```

Add it as **Media Source** or **VLC Video Source** in OBS. MJPEG needs no browser and is usually lower latency, but uses more bandwidth.

---

## Watch URL parameters

| Parameter | Values | Description |
|---|---|---|
| `mode` | `auto` (default), `webrtc`, `ws` | Transport. `ws` = MJPEG. |
| `fit` | `contain` (default), `cover` | `cover` fills the frame and crops edges. |
| `mute` | `1` (default), `0` | `0` enables microphone audio. |
| `hud` | `1` (default), `0` | `0` hides the name/status overlay. |

Example:

```
http://192.168.1.20:3000/c/phone-ab12?fit=cover&hud=0
```

The watch page reconnects automatically. If WebRTC produces no frames within 8 seconds, it falls back to MJPEG.

---

## How it works

- **Signaling:** browsers connect over `/ws`; the server only relays SDP/ICE messages. Video flows directly from the device to OBS over WebRTC.
- **MJPEG fallback:** the publisher encodes JPEG frames on a canvas and sends them over WebSocket; the server distributes them to viewers and `.mjpeg` HTTP clients.
- **Rotation:** when set, the video is drawn to a canvas with the requested rotation and the rotated track is used for both WebRTC and MJPEG.
- **Persistence:** only the camera list (`data/cameras.json`). Video, audio and recordings never touch disk.
- **Keys:** each camera's publish key is stored only in the creating browser's `localStorage` and in `data/cameras.json`.

---

## Configuration

`data/config.json` is created on first run:

```json
{
  "httpPort": 3000,
  "httpsPort": 3443,
  "bind": "0.0.0.0",
  "siteName": "CamNet",
  "maxCameras": 100,
  "maxViewersPerCamera": 12,
  "iceServers": [],
  "defaultWidth": 1280,
  "defaultHeight": 720,
  "defaultFps": 24,
  "defaultQuality": 0.72
}
```

- `httpsPort: 0` disables HTTPS (and therefore camera sharing from phones).
- `iceServers` — extra STUN/TURN servers for WebRTC. Usually unnecessary on a LAN.
- Restart the server after changing settings.

---

## Data layout

```
server/            Node.js server (API, WebSocket signaling, MJPEG)
src/               Svelte UI
electron/          Desktop app (Electron main process + control panel)
public/            Static assets (manifest, service worker, icons)
data/cameras.json  Registered cameras (id, name, key, settings)
data/config.json   Server settings
data/certs/        Auto-generated HTTPS certificate (not committed)
dist/              Built UI
release/           Portable desktop build output
```

`data/cameras.json`, `data/certs/` and build outputs are excluded from git.

---

## Troubleshooting

**Phone says “camera access unavailable”**
Use the HTTPS address (`https://<ip>:3443`) and accept the certificate warning.

**Phone cannot reach the server**
- Make sure both devices are on the same Wi-Fi / subnet.
- Allow TCP 3000 and 3443 in Windows Firewall (run `allow-firewall.bat`).
- Guest networks and AP/client isolation block device-to-device traffic.

**Black screen in OBS**
- First check `http://<ip>:3000/c/<id>` in a browser.
- Keep “Shutdown source when not visible” off.
- If WebRTC fails, add `?mode=ws` or use the `.mjpeg` address as Media Source.

**High latency**
- `?mode=ws` usually gives lower latency (at the cost of bandwidth).
- Use 720p and 24 fps.

**Battery drain on the phone**
- The self-preview is off by default; keep it off unless you need framing.
- Lower the screen brightness, use 720p/24 fps, and keep the microphone off.
- Keep the device charging; mobile browsers stop the camera when the screen locks.

**Two devices connect to the same camera**
The latest publisher takes over; the previous device is notified.

---

## Security

CamNet is built for **local networks**. Watch pages (`/c/<id>`) require no key, so anyone on your network can watch the cameras. Do not expose it directly to the internet; use a VPN (for example Tailscale) for remote access.

The HTTPS certificate is generated automatically in `data/certs/`. To use your own, place `cert.pem` and `key.pem` there.

---

## Development

```bash
npm run dev        # backend + Vite dev server together
npm start          # production server (requires a built dist/)
npm run build      # build the UI
npm run icons      # regenerate PWA icons
npm run smoke      # end-to-end protocol test against a running server
npm run dist:win   # build the portable Windows desktop app
```

`npm run dev` starts both the API/WebSocket server (ports 3000/3443) and Vite. Use either `npm run dev` or `npm start`, not both at the same time.

---

## License

[MIT](LICENSE) © Cihat Kösem
