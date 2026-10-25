<script>
  import { onMount } from 'svelte';
  import { api, getToken } from '../lib/api.js';
  import { Broadcaster } from '../lib/broadcaster.js';
  import { copyText, formatBitrate, isSecureEnough } from '../lib/util.js';

  let { id } = $props();

  let camera = $state(null);
  let info = $state(null);
  let token = $state('');
  let loading = $state(true);
  let notFound = $state(false);
  let forbidden = $state(false);

  let stream = $state(null);
  let live = $state(false);
  let starting = $state(false);
  let changing = $state(false);
  let error = $state('');
  let connState = $state('idle');
  let viewers = $state(0);
  let peers = $state(0);
  let bitrate = $state(0);
  let sentFps = $state(0);
  let pump = $state(false);
  let actual = $state(null);

  let devices = $state([]);
  let selectedDevice = $state('');
  let copied = $state('');

  let settings = $state({
    width: 1280,
    height: 720,
    fps: 24,
    quality: 0.72,
    audio: false,
    mirror: false,
    rotation: 0,
    preview: false,
    facing: 'user'
  });

  let videoEl = $state(null);
  let broadcaster = null;
  let wakeLock = null;
  let saveTimer = null;

  const canShare = $derived(
    typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)
  );
  const httpsShare = $derived(
    info?.httpsPort ? `https://${info.primaryIp}:${info.httpsPort}${location.pathname}` : ''
  );
  const obsUrl = $derived(
    info ? `http://${info.primaryIp}:${info.httpPort}/c/${id}` : ''
  );
  const mjpegUrl = $derived(obsUrl ? `${obsUrl}.mjpeg` : '');
  const qrSrc = $derived(`/api/qr.svg?text=${encodeURIComponent(obsUrl)}`);
  const connLabel = $derived(
    ({
      idle: 'Ready',
      connecting: 'Connecting',
      online: 'Live',
      reconnecting: 'Reconnecting',
      replaced: 'Replaced'
    })[connState] ?? connState
  );

  $effect(() => {
    const video = videoEl;
    const media = stream;
    if (!video) return;
    if (video.srcObject !== media) video.srcObject = media;
    if (media && live && settings.preview) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  });

  $effect(() => {
    const track = stream?.getVideoTracks?.()[0];
    if (!track) {
      actual = null;
      return;
    }
    const s = track.getSettings?.() ?? {};
    if (s.width && s.height) {
      actual = {
        width: s.width,
        height: s.height,
        frameRate: Math.round(s.frameRate || settings.fps)
      };
    }
  });

  $effect(() => {
    if (!live) return;
    const handler = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  });

  onMount(() => {
    token = getToken(id) ?? '';

    (async () => {
      try {
        info = await api('/api/info');
      } catch {
        /* ignore */
      }

      try {
        const data = await api(`/api/cameras/${id}`);
        camera = data.camera;
        if (data.camera?.settings) {
          settings = { ...settings, ...data.camera.settings };
          selectedDevice = data.camera.settings.deviceId ?? '';
        }
      } catch {
        notFound = true;
        loading = false;
        return;
      }

      if (!token) {
        forbidden = true;
        loading = false;
        return;
      }

      loading = false;

      const wantsStart = new URLSearchParams(location.search).get('start') === '1';
      if (wantsStart && canShare && isSecureEnough()) {
        try {
          await start();
        } catch {
          /* fall back to showing the start button */
        }
      }
    })();

    const onVisible = () => {
      if (document.visibilityState === 'visible' && live) requestWakeLock();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(saveTimer);
      try {
        broadcaster?.stop();
      } catch {
        /* ignore */
      }
      for (const track of stream?.getTracks() ?? []) track.stop();
      releaseWakeLock();
    };
  });

  function constraints() {
    const video = {
      width: { ideal: settings.width },
      height: { ideal: settings.height },
      frameRate: { ideal: settings.fps, max: 60 }
    };
    if (selectedDevice) video.deviceId = { exact: selectedDevice };
    else if (settings.facing) video.facingMode = { ideal: settings.facing };

    const audio = settings.audio
      ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      : false;

    return { video, audio };
  }

  async function getMedia() {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints());
    } catch (err) {
      if (err?.name === 'OverconstrainedError' && selectedDevice) {
        selectedDevice = '';
        return await navigator.mediaDevices.getUserMedia(constraints());
      }
      throw err;
    }
  }

  async function start() {
    if (starting || live) return;
    starting = true;
    error = '';

    try {
      if (!canShare) {
        throw Object.assign(new Error('insecure'), { name: 'SecurityError' });
      }
      const media = await getMedia();
      stream = media;
      live = true;
      connState = 'connecting';

      const deviceId = media.getVideoTracks()[0]?.getSettings?.().deviceId;
      if (deviceId) selectedDevice = deviceId;

      settings.audio = media.getAudioTracks().length > 0;

      broadcaster = new Broadcaster({
        id,
        token,
        onEvent: handleEvent,
        onStats: handleStats
      });
      broadcaster.start(media, settings);

      await requestWakeLock();
      await loadDevices();
      saveSettings();
    } catch (err) {
      error = describeError(err);
      live = false;
      connState = 'idle';
      for (const track of stream?.getTracks() ?? []) track.stop();
      stream = null;
    } finally {
      starting = false;
    }
  }

  function stop() {
    live = false;
    connState = 'idle';
    viewers = 0;
    peers = 0;
    bitrate = 0;
    sentFps = 0;
    try {
      broadcaster?.stop();
    } catch {
      /* ignore */
    }
    broadcaster = null;
    for (const track of stream?.getTracks() ?? []) track.stop();
    stream = null;
    releaseWakeLock();
  }

  async function changeMedia() {
    if (!live || changing) {
      saveSettings();
      return;
    }
    changing = true;
    error = '';
    try {
      const media = await getMedia();
      stream = media;
      broadcaster?.setStream(media);
      settings.audio = media.getAudioTracks().length > 0;
      await loadDevices();
      saveSettings();
    } catch (err) {
      error = describeError(err);
    } finally {
      changing = false;
    }
  }

  function changeQuality(event) {
    settings.quality = Number(event.currentTarget.value);
    broadcaster?.updateSettings(settings);
    saveSettings();
  }

  function changeFps(event) {
    settings.fps = Number(event.currentTarget.value);
    broadcaster?.updateSettings(settings);
    saveSettings();
  }

  function changeRotation(event) {
    settings.rotation = Number(event.currentTarget.value);
    broadcaster?.setRotation(settings.rotation);
    saveSettings();
  }

  function setResolution(value) {
    const [width, height] = value.split('x').map(Number);
    if (!width || !height) return;
    settings.width = width;
    settings.height = height;
    changeMedia();
  }

  function toggleAudio(event) {
    settings.audio = event.currentTarget.checked;
    changeMedia();
  }

  async function loadDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const list = await navigator.mediaDevices.enumerateDevices();
      devices = list
        .filter((device) => device.kind === 'videoinput')
        .map((device, index) => ({
          id: device.deviceId,
          label: device.label || `Camera ${index + 1}`
        }));
    } catch {
      /* ignore */
    }
  }

  function saveSettings() {
    if (!token) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      api(`/api/cameras/${id}`, {
        method: 'PATCH',
        headers: { 'x-camera-token': token },
        body: JSON.stringify({
          settings: { ...settings, deviceId: selectedDevice || undefined }
        })
      }).catch(() => {});
    }, 500);
  }

  function handleEvent({ type, payload }) {
    switch (type) {
      case 'open':
      case 'hello':
        connState = 'online';
        if (payload?.viewerCount !== undefined) viewers = payload.viewerCount;
        break;
      case 'close':
        if (!live) break;
        connState = payload?.replaced ? 'replaced' : 'reconnecting';
        break;
      case 'reconnecting':
        connState = 'reconnecting';
        break;
      case 'viewers':
        if (payload?.count !== undefined) viewers = payload.count;
        else viewers = Math.max(0, viewers + (payload?.delta ?? 0));
        break;
      case 'replaced':
        connState = 'replaced';
        error = payload || 'Another device took over this camera.';
        break;
      case 'fatal':
        stop();
        connState = 'replaced';
        error = payload?.message || 'The streaming session ended.';
        break;
      case 'pump':
        pump = Boolean(payload);
        break;
      case 'error':
        error = payload;
        break;
      default:
        break;
    }
  }

  function handleStats(stats) {
    bitrate = stats.bitrate;
    sentFps = Math.round(stats.fps || 0);
    peers = stats.peers;
    pump = Boolean(stats.pump);
  }

  async function rename() {
    const name = prompt('Camera name', camera?.name ?? '');
    if (!name?.trim()) return;
    try {
      const data = await api(`/api/cameras/${id}`, {
        method: 'PATCH',
        headers: { 'x-camera-token': token },
        body: JSON.stringify({ name })
      });
      camera = data.camera;
    } catch (err) {
      error = err.message;
    }
  }

  async function copy(text, key) {
    if (!text) return;
    const ok = await copyText(text);
    if (!ok) return;
    copied = key;
    setTimeout(() => {
      if (copied === key) copied = '';
    }, 1600);
  }

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
    } catch {
      /* not supported */
    }
  }

  function releaseWakeLock() {
    try {
      wakeLock?.release?.();
    } catch {
      /* ignore */
    }
    wakeLock = null;
  }

  function describeError(err) {
    const name = err?.name;
    if (name === 'SecurityError' || err?.message === 'insecure') {
      return 'Camera access requires HTTPS. Open this page over a secure connection.';
    }
    switch (name) {
      case 'NotAllowedError':
        return 'Camera permission was denied. Allow access from the camera icon in the address bar and try again.';
      case 'NotFoundError':
        return 'No available camera was found.';
      case 'NotReadableError':
        return 'The camera is being used by another application. Close other apps and try again.';
      case 'OverconstrainedError':
        return 'This camera does not support the selected resolution. Choose a different one.';
      default:
        return err?.message || 'Could not start the camera.';
    }
  }

  const resolutionOptions = [
    { value: '1920x1080', label: '1080p · 1920×1080' },
    { value: '1280x720', label: '720p · 1280×720' },
    { value: '960x540', label: '540p · 960×540' },
    { value: '640x360', label: '360p · 640×360' }
  ];
  const resolutionValue = $derived(`${settings.width}x${settings.height}`);
  const previewTransform = $derived(() => {
    const parts = [];
    if (settings.mirror) parts.push('scaleX(-1)');
    const rotation = settings.rotation || 0;
    if (rotation === 90 || rotation === 270) parts.push(`rotate(${rotation}deg) scale(0.5625)`);
    else if (rotation) parts.push(`rotate(${rotation}deg)`);
    return parts.join(' ') || 'none';
  });
</script>

<header class="topbar">
  <div class="topbar-inner">
    <a class="brand" href="/" data-link>
      <span class="brand-mark">
        <svg width="19" height="19" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="2.5" y="6" width="13" height="12" rx="3.4" fill="#3ddc97" />
          <path d="M16.5 10.2 21.5 7v10l-5-3.2z" fill="#38bdf8" />
          <circle cx="9" cy="12" r="2.6" fill="#0b1017" />
        </svg>
      </span>
      <span>CamNet<small>camera sharing</small></span>
    </a>
    <div class="grow"></div>
    {#if camera}
      <button class="cam-name" onclick={rename} title="Rename camera">
        {camera.name}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <path d="M4 20h4l10-10-4-4L4 16v4z" />
        </svg>
      </button>
    {/if}
    <span class="badge" class:badge-live={live && connState === 'online'} class:badge-off={!live || connState !== 'online'}>
      <span class="dot" class:dot-pulse={live && connState === 'online'}></span>
      {live ? connLabel : 'Off'}
    </span>
    <a class="btn btn-sm btn-ghost" href="/" data-link>Home</a>
  </div>
</header>

<main class="wrap">
  {#if loading}
    <div class="state-screen"><span class="spinner"></span> Loading…</div>
  {:else if notFound}
    <div class="state-screen">
      <div class="card card-pad state-card">
        <h2>Camera not found</h2>
        <p class="muted">This path is not registered or the camera was deleted.</p>
        <a class="btn btn-primary" href="/" data-link>Back to home</a>
      </div>
    </div>
  {:else if forbidden}
    <div class="state-screen">
      <div class="card card-pad state-card">
        <h2>This camera belongs to another device</h2>
        <p class="muted">
          The key stored in the browser that created this camera is missing on this device.
          Use the original device to start streaming, or create a new camera from the home page.
        </p>
        <a class="btn btn-primary" href="/" data-link>Back to home</a>
      </div>
    </div>
  {:else}
    {#if !isSecureEnough()}
      <div class="alert alert-danger">
        <span class="alert-icon">!</span>
        <div>
          <b>Secure connection required.</b> Camera access on phones and tablets only works over HTTPS.
          {#if httpsShare}
            <a class="btn btn-sm" href={httpsShare}>Open with HTTPS</a>
          {/if}
        </div>
      </div>
    {/if}

    {#if error}
      <div class="alert alert-danger">
        <span class="alert-icon">!</span>
        <div>{error}</div>
      </div>
    {/if}

    <div class="share-layout">
      <section class="main-col">
        <div class="stage card">
          <div class="preview">
            <video
              bind:this={videoEl}
              autoplay
              playsinline
              muted
              style:transform={previewTransform}
              class:hidden={live && !settings.preview}
            ></video>

            {#if live && !settings.preview}
              <div class="preview-off">
                <span class="dot dot-pulse"></span>
                <span>Streaming · preview off</span>
              </div>
            {/if}

            {#if !live}
              <div class="start-overlay">
                {#if starting}
                  <span class="spinner big"></span>
                  <h3>Preparing camera…</h3>
                  <p>Choose <b>Allow</b> if your browser asks for permission.</p>
                {:else}
                  <div class="start-icon">
                    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                      <rect x="2.5" y="6" width="13" height="12" rx="3.4" />
                      <path d="M16.5 10.2 21.5 7v10l-5-3.2z" />
                    </svg>
                  </div>
                  <h3>Stream your camera</h3>
                  <p>The stream runs in this tab until you stop it.</p>
                  <button class="btn btn-primary" onclick={start} disabled={!canShare}>
                    Start streaming
                  </button>
                  {#if !canShare}
                    <p class="tiny">Camera access unavailable. Use the HTTPS address.</p>
                  {/if}
                {/if}
              </div>
            {/if}

            {#if live}
              <div class="live-pill"><span class="dot dot-pulse"></span>LIVE</div>
              <div class="preview-meta mono">
                {#if actual}{actual.width}×{actual.height} · {sentFps || actual.frameRate} fps{:else}—{/if}
              </div>
            {/if}
          </div>

          <div class="stage-foot">
            {#if live}
              <button class="btn btn-danger" onclick={stop}>Stop streaming</button>
            {:else}
              <button class="btn btn-primary" onclick={start} disabled={starting || !canShare}>Start streaming</button>
            {/if}
            <span class="hint">Keep this tab open · streaming stops if the phone screen locks</span>
          </div>
        </div>

        <div class="card card-pad controls">
          <div class="card-title">Stream settings</div>
          <div class="control-grid">
            <div class="field">
              <label for="device">Camera</label>
              <select id="device" class="select" bind:value={selectedDevice} onchange={changeMedia} disabled={!live}>
                <option value="">Default camera</option>
                {#each devices as device (device.id)}
                  <option value={device.id}>{device.label}</option>
                {/each}
              </select>
            </div>

            <div class="field">
              <label for="resolution">Resolution</label>
              <select
                id="resolution"
                class="select"
                value={resolutionValue}
                onchange={(e) => setResolution(e.currentTarget.value)}
                disabled={!live}
              >
                {#each resolutionOptions as option (option.value)}
                  <option value={option.value}>{option.label}</option>
                {/each}
              </select>
            </div>

            <div class="field">
              <label for="fps">Frame rate</label>
              <select id="fps" class="select" value={String(settings.fps)} onchange={changeFps} disabled={!live}>
                <option value="30">30 fps</option>
                <option value="24">24 fps</option>
                <option value="15">15 fps</option>
                <option value="10">10 fps</option>
              </select>
            </div>

            <div class="field">
              <label for="quality">Quality</label>
              <select id="quality" class="select" value={String(settings.quality)} onchange={changeQuality} disabled={!live}>
                <option value="0.9">High</option>
                <option value="0.72">Balanced</option>
                <option value="0.55">Low bandwidth</option>
              </select>
            </div>

            <div class="field">
              <label for="rotation">Rotation</label>
              <select id="rotation" class="select" value={String(settings.rotation)} onchange={changeRotation} disabled={!live}>
                <option value="0">0° (normal)</option>
                <option value="90">90° clockwise</option>
                <option value="180">180°</option>
                <option value="270">270° clockwise</option>
              </select>
            </div>
          </div>

          <div class="toggles">
            <label class="switch">
              <input type="checkbox" checked={settings.audio} onchange={toggleAudio} disabled={!live} />
              <span>Microphone</span>
            </label>
            <label class="switch">
              <input type="checkbox" bind:checked={settings.mirror} />
              <span>Mirror preview</span>
            </label>
            <label class="switch">
              <input type="checkbox" bind:checked={settings.preview} onchange={saveSettings} />
              <span>Show preview</span>
            </label>
            <span class="grow"></span>
            {#if pump}
              <span class="badge badge-info">MJPEG active</span>
            {/if}
          </div>
        </div>
      </section>

      <aside class="side-col">
        <div class="card card-pad">
          <div class="card-title">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M4 6h16v12H4z" />
              <path d="M8 21h8M12 18v3" />
            </svg>
            OBS connection
          </div>

          <div class="field">
            <span class="field-label">Browser Source URL</span>
            <div class="code-row">
              <code>{obsUrl || '…'}</code>
              <button class="btn btn-sm" onclick={() => copy(obsUrl, 'obs')}>
                {copied === 'obs' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>
          <p class="hint">
            OBS → Add Source → <b>Browser</b> → paste the URL. Width/height 1280×720.
            Add <span class="mono">?mute=0</span> for audio, <span class="mono">?fit=cover</span> to fill the frame.
          </p>

          <div class="field mt">
            <span class="field-label">MJPEG (Media Source / VLC)</span>
            <div class="code-row">
              <code>{mjpegUrl || '…'}</code>
              <button class="btn btn-sm" onclick={() => copy(mjpegUrl, 'mjpeg')}>
                {copied === 'mjpeg' ? '✓' : 'Copy'}
              </button>
            </div>
          </div>
          <p class="hint">
            If WebRTC gives you trouble, use this address with Media Source or VLC Source in OBS.
          </p>

          <div class="qr-mini">
            <div class="qr-frame">
              <img src={qrSrc} alt="QR code for the watch link" />
            </div>
            <div>
              <b>Preview on phone</b>
              <p class="hint">Scan the QR code on another device to check the stream.</p>
            </div>
          </div>
        </div>

        <div class="card card-pad">
          <div class="card-title">Status</div>
          <div class="stat-rows">
            <div class="stat-row">
              <span>Connection</span>
              <b class:ok={connState === 'online'} class:bad={connState === 'replaced'}>
                {live ? connLabel : 'Off'}
              </b>
            </div>
            <div class="stat-row">
              <span>Viewers</span>
              <b>{viewers}</b>
            </div>
            <div class="stat-row">
              <span>Sent</span>
              <b>{formatBitrate(bitrate)}</b>
            </div>
            <div class="stat-row">
              <span>Camera</span>
              <b>{actual ? `${actual.width}×${actual.height}` : '—'}</b>
            </div>
            <div class="stat-row">
              <span>WebRTC peers</span>
              <b>{peers}</b>
            </div>
            <div class="stat-row">
              <span>Path</span>
              <b class="mono copy-path" title={obsUrl}>/c/{id}</b>
            </div>
          </div>
        </div>

        <div class="card card-pad tips">
          <div class="card-title">Tips</div>
          <ul>
            <li>Keep the phone charging and the screen on; background tabs may stop the camera.</li>
            <li>If a second device connects to the same camera, the latest one takes over.</li>
            <li>If latency matters, try <span class="mono">?mode=ws</span> instead of Browser Source.</li>
            <li>Nothing is recorded; the image is only transmitted live.</li>
          </ul>
        </div>
      </aside>
    </div>
  {/if}
</main>

{#if copied === 'toast'}
  <div class="toast">Copied</div>
{/if}

<style>
  .state-screen {
    min-height: 60vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    color: var(--muted);
    padding: 40px 0;
  }

  .state-card {
    max-width: 460px;
    display: flex;
    flex-direction: column;
    gap: 13px;
  }

  .state-card h2 {
    font-size: 20px;
    color: var(--text);
  }

  .cam-name {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    height: 32px;
    padding: 0 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: #0a1018;
    color: var(--text);
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    max-width: 240px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cam-name:hover {
    border-color: #2f445d;
  }

  .share-layout {
    display: grid;
    grid-template-columns: minmax(0, 1.55fr) minmax(320px, 0.75fr);
    gap: 18px;
    padding: 24px 0 40px;
    align-items: start;
  }

  .main-col,
  .side-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-width: 0;
  }

  .stage {
    overflow: hidden;
  }

  .preview {
    position: relative;
    aspect-ratio: 16 / 9;
    background: #04070b;
    overflow: hidden;
  }

  .preview video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    background: #04070b;
  }

  .preview video.hidden {
    display: none;
  }

  .preview-off {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    color: var(--muted);
    font-size: 13px;
  }

  .preview-off .dot {
    width: 9px;
    height: 9px;
    color: var(--accent);
  }

  .start-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 9px;
    text-align: center;
    padding: 24px;
    background:
      radial-gradient(80% 100% at 50% 0%, rgba(29, 48, 66, 0.65), rgba(5, 8, 12, 0.92));
  }

  .start-overlay h3 {
    font-size: 18px;
  }

  .start-overlay p {
    color: var(--muted);
    font-size: 13px;
    max-width: 340px;
  }

  .start-icon {
    width: 64px;
    height: 64px;
    border-radius: 18px;
    display: grid;
    place-items: center;
    color: #6ee7b7;
    background: rgba(61, 220, 151, 0.08);
    border: 1px solid rgba(61, 220, 151, 0.25);
    margin-bottom: 6px;
  }

  .spinner.big {
    width: 26px;
    height: 26px;
    border-width: 3px;
  }

  .live-pill {
    position: absolute;
    top: 12px;
    left: 12px;
    display: inline-flex;
    align-items: center;
    gap: 7px;
    padding: 5px 10px;
    border-radius: 7px;
    background: rgba(8, 12, 18, 0.72);
    border: 1px solid rgba(61, 220, 151, 0.35);
    color: #7bf0bb;
    font-size: 11px;
    font-weight: 750;
    letter-spacing: 0.09em;
    backdrop-filter: blur(8px);
  }

  .preview-meta {
    position: absolute;
    right: 12px;
    bottom: 12px;
    padding: 4px 8px;
    border-radius: 7px;
    background: rgba(8, 12, 18, 0.7);
    color: #b7cadf;
    font-size: 11px;
    backdrop-filter: blur(6px);
  }

  .stage-foot {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 12px 14px;
    border-top: 1px solid var(--line-soft);
    flex-wrap: wrap;
  }

  .hint {
    font-size: 12px;
    color: var(--dim);
    line-height: 1.55;
  }

  .tiny {
    font-size: 11.5px;
  }

  .controls {
    margin-top: 0;
  }

  .control-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 13px;
  }

  .toggles {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-top: 16px;
    padding-top: 14px;
    border-top: 1px solid var(--line-soft);
    flex-wrap: wrap;
  }

  .switch {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--muted);
    cursor: pointer;
    user-select: none;
  }

  .switch input {
    appearance: none;
    width: 34px;
    height: 20px;
    border-radius: 999px;
    background: #1b2836;
    border: 1px solid #2a3b50;
    position: relative;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
    flex: none;
  }

  .switch input::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: #8199b1;
    transition: transform 0.15s, background 0.15s;
  }

  .switch input:checked {
    background: rgba(61, 220, 151, 0.25);
    border-color: rgba(61, 220, 151, 0.55);
  }

  .switch input:checked::after {
    transform: translateX(14px);
    background: #4ae6a4;
  }

  .switch input:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .mt {
    margin-top: 14px;
  }

  .qr-mini {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--line-soft);
  }

  .qr-frame {
    background: #fff;
    padding: 6px;
    border-radius: 9px;
    flex: none;
  }

  .qr-frame img {
    width: 118px;
    height: 118px;
    display: block;
  }

  .qr-mini b {
    font-size: 13px;
  }

  .stat-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 9px;
    overflow: hidden;
    border: 1px solid var(--line-soft);
  }

  .stat-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 9px 11px;
    background: #0a1018;
    font-size: 12.5px;
  }

  .stat-row span {
    color: var(--dim);
  }

  .stat-row b {
    font-weight: 600;
    font-size: 12.5px;
  }

  .stat-row b.ok {
    color: #6fe0a8;
  }

  .stat-row b.bad {
    color: var(--danger);
  }

  .copy-path {
    color: #9fd6c0 !important;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 60%;
  }

  .tips ul {
    margin: 0;
    padding-left: 17px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--muted);
    font-size: 12.5px;
    line-height: 1.55;
  }

  .alert {
    margin-top: 18px;
  }

  .alert-icon {
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    flex: none;
    font-size: 12px;
    font-weight: 800;
    color: #f87171;
    border: 1px solid rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.12);
  }

  @media (max-width: 1020px) {
    .share-layout {
      grid-template-columns: 1fr;
    }
    .side-col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
    }
  }

  @media (max-width: 640px) {
    .control-grid {
      grid-template-columns: 1fr;
    }
    .cam-name {
      max-width: 130px;
    }
    .topbar-inner {
      gap: 8px;
    }
  }
</style>
