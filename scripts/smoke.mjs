/**
 * End-to-end smoke test against a running server.
 *   npm start        (separate terminal)
 *   npm run smoke
 *
 * Does not use a real camera or WebRTC; it verifies signaling, viewer
 * counting, MJPEG distribution and the snapshot flow.
 */
import WebSocket from 'ws';

const BASE = process.env.CAMNET_BASE || 'http://127.0.0.1:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');
const results = [];

function ok(name, extra = '') {
  results.push({ name, ok: true, extra });
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
}

function fail(name, message) {
  results.push({ name, ok: false, message });
  console.log(`  ✗ ${name} — ${message}`);
}

async function api(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) }
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(`${res.status} ${data?.message ?? data?.error ?? ''}`);
  return data;
}

function connect(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  ws.on('message', (data, isBinary) => {
    const msg = isBinary ? { binary: Buffer.from(data) } : { json: JSON.parse(data.toString()) };
    const index = waiters.findIndex((waiter) => waiter.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
      return;
    }
    messages.push(msg);
  });

  const ready = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  return {
    ws,
    ready,
    send(value) {
      ws.send(typeof value === 'string' ? value : JSON.stringify(value));
    },
    sendBinary(buffer) {
      ws.send(buffer);
    },
    waitFor(predicate, timeout = 5000) {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiters.findIndex((w) => w.timer === timer);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error('timeout'));
        }, timeout);
        waiters.push({ predicate, resolve, timer });
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  };
}

async function readUntil(reader, needle, timeout = 4000) {
  const chunks = [];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining))
    ]);
    if (result.timeout) throw new Error('no MJPEG data received');
    if (result.done) throw new Error('stream closed');
    chunks.push(Buffer.from(result.value));
    const all = Buffer.concat(chunks);
    if (all.includes(needle)) return all;
  }
  throw new Error('no MJPEG data received');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let camera = null;
let token = null;
const sockets = [];

try {
  console.log(`\nCamNet smoke test → ${BASE}\n`);

  const info = await api('/api/info');
  ok('API /info', `ip=${info.primaryIp} http=${info.httpPort} https=${info.httpsPort}`);

  const created = await api('/api/cameras', {
    method: 'POST',
    body: JSON.stringify({ name: 'Smoke Test' })
  });
  camera = created.camera;
  token = created.token;
  ok('camera creation', camera.id);

  const pub = connect(
    `${WS_BASE}/ws?role=publisher&id=${camera.id}&token=${encodeURIComponent(token)}`
  );
  sockets.push(pub);
  await pub.ready;
  const pubHello = await pub.waitFor((m) => m.json?.t === 'hello');
  if (pubHello.json.camera.id !== camera.id) throw new Error('wrong camera in hello');
  ok('publisher auth');

  const bad = new WebSocket(
    `${WS_BASE}/ws?role=publisher&id=${camera.id}&token=wrong`
  );
  const badCode = await new Promise((resolve) => {
    bad.on('close', (code) => resolve(code));
    bad.on('error', () => resolve(0));
  });
  if (badCode !== 4003) throw new Error(`unauthorized publisher accepted (${badCode})`);
  ok('unauthorized publisher rejected');

  const view = connect(`${WS_BASE}/ws?role=viewer&id=${camera.id}&mode=webrtc`);
  sockets.push(view);
  await view.ready;
  const viewHello = await view.waitFor((m) => m.json?.t === 'hello');
  if (!viewHello.json.online) throw new Error('publisher appears offline');
  const join = await pub.waitFor((m) => m.json?.t === 'viewer-join');
  ok('viewer joined', `peer=${join.json.peerId}`);

  const offer = { type: 'offer', sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };
  pub.send({ t: 'signal', peerId: join.json.peerId, data: { sdp: offer } });
  const received = await view.waitFor((m) => m.json?.t === 'signal');
  if (received.json.data.sdp.type !== 'offer') throw new Error('offer not relayed');
  ok('SDP offer relay');

  view.send({ t: 'signal', data: { sdp: { type: 'answer', sdp: 'v=0\r\n' } } });
  const answer = await pub.waitFor(
    (m) => m.json?.t === 'signal' && m.json.data?.sdp?.type === 'answer'
  );
  if (answer.json.peerId !== join.json.peerId) throw new Error('peerId mismatch');
  ok('SDP answer relay');

  view.send({ t: 'mode', mode: 'ws' });
  await pub.waitFor((m) => m.json?.t === 'viewer-mode' && m.json.mode === 'ws');
  await pub.waitFor((m) => m.json?.t === 'mjpeg-demand' && m.json.on === true);
  ok('MJPEG demand notified to publisher');

  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0xff, 0xd9]);
  const frame = Buffer.concat([Buffer.from([0x01]), jpeg]);

  const controller = new AbortController();
  const mjpegRes = await fetch(`${BASE}/c/${camera.id}.mjpeg`, { signal: controller.signal });
  if (mjpegRes.status !== 200) throw new Error(`MJPEG HTTP ${mjpegRes.status}`);
  if (!String(mjpegRes.headers.get('content-type')).startsWith('multipart/x-mixed-replace')) {
    throw new Error('wrong MJPEG content-type');
  }
  ok('MJPEG HTTP stream opened');
  const reader = mjpegRes.body.getReader();

  await sleep(150);
  pub.sendBinary(frame);
  const wsFrame = await view.waitFor((m) => m.binary);
  if (!wsFrame.binary.equals(frame)) throw new Error('WS frame corrupted');
  ok('WS frame relay', `${jpeg.length} bytes`);

  const multipart = await readUntil(reader, jpeg);
  const text = multipart.toString('latin1');
  if (!text.includes('Content-Type: image/jpeg')) throw new Error('missing multipart header');
  ok('MJPEG multipart frame');

  controller.abort();
  await sleep(200);

  const snapshotJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 9, 9, 9, 0xff, 0xd9]);
  pub.sendBinary(Buffer.concat([Buffer.from([0x02]), snapshotJpeg]));
  await sleep(250);
  const snapshotRes = await fetch(`${BASE}/api/cameras/${camera.id}/snapshot.jpg`);
  const snapshotBytes = Buffer.from(await snapshotRes.arrayBuffer());
  if (!snapshotBytes.equals(snapshotJpeg)) throw new Error('snapshot mismatch');
  ok('snapshot stored');

  const list = await api('/api/cameras');
  const entry = list.cameras.find((c) => c.id === camera.id);
  if (!entry?.online) throw new Error('API does not report online');
  if (entry.viewers !== 1) throw new Error(`viewer count ${entry.viewers}`);
  ok('API status', `online=${entry.online} viewers=${entry.viewers}`);

  const pub2Viewer = connect(`${WS_BASE}/ws?role=viewer&id=${camera.id}&mode=ws`);
  sockets.push(pub2Viewer);
  await pub2Viewer.ready;
  await pub2Viewer.waitFor((m) => m.json?.t === 'hello');

  view.close();
  await pub.waitFor((m) => m.json?.t === 'viewer-leave');
  ok('viewer left');

  pub.close();
  const offline = await pub2Viewer.waitFor((m) => m.json?.t === 'publisher-offline');
  if (!offline) throw new Error('publisher-offline not received');
  ok('publisher offline notification');

  const pub3 = connect(
    `${WS_BASE}/ws?role=publisher&id=${camera.id}&token=${encodeURIComponent(token)}`
  );
  sockets.push(pub3);
  await pub3.ready;
  await pub3.waitFor((m) => m.json?.t === 'hello');
  await pub2Viewer.waitFor((m) => m.json?.t === 'publisher-online');
  const rejoin = await pub3.waitFor((m) => m.json?.t === 'viewer-join');
  if (rejoin.json.mode !== 'ws') throw new Error('viewer mode not preserved');
  ok('publisher reconnected, viewer preserved');

  pub2Viewer.close();
  pub3.close();
  await sleep(200);

  await api(`/api/cameras/${camera.id}`, {
    method: 'DELETE',
    headers: { 'x-camera-token': token }
  });
  ok('camera deleted');
  camera = null;

  await sleep(200);
  const after = await api('/api/cameras');
  if (after.cameras.some((c) => c.id === created.camera.id)) {
    throw new Error('deleted camera still listed');
  }
  ok('data file updated');
} catch (err) {
  fail('test', err.message);
} finally {
  for (const socket of sockets) socket.close();
  if (camera && token) {
    try {
      await api(`/api/cameras/${camera.id}`, {
        method: 'DELETE',
        headers: { 'x-camera-token': token }
      });
    } catch {
      /* ignore */
    }
  }
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} tests passed\n`);
process.exit(failed ? 1 : 0);
