<script>
  import { onMount } from 'svelte';
  import { ViewerClient } from '../lib/viewer.js';

  let { id } = $props();

  const params = new URLSearchParams(location.search);
  const modeParam = params.get('mode');
  const preferred = modeParam === 'ws' || modeParam === 'mjpeg' ? 'ws' : modeParam === 'webrtc' ? 'webrtc' : 'auto';
  const fit = params.get('fit') === 'cover' ? 'cover' : 'contain';
  const muted = params.get('mute') !== '0';
  const hud = params.get('hud') !== '0';

  let videoEl = $state(null);
  let canvasEl = $state(null);
  let client = null;

  let status = $state('connecting');
  let detail = $state('');
  let camName = $state('');
  let usingMode = $state(preferred === 'ws' ? 'ws' : 'webrtc');
  let fallback = $state(false);
  let hudFaded = $state(false);
  let resolution = $state('');

  let drawing = false;

  onMount(() => {
    document.body.classList.add('obs-mode');

    client = new ViewerClient({
      id,
      mode: preferred,
      onEvent: handleEvent,
      onStream: handleStream,
      onFrame: handleFrame,
      onStatus: (s) => {
        if (s?.width && s?.height) resolution = `${s.width}×${s.height}`;
      }
    });
    client.connect();

    const fadeTimer = setTimeout(() => {
      hudFaded = true;
    }, 6000);

    // Fallback check for CEF versions without requestVideoFrameCallback.
    const liveTimer = setInterval(() => {
      if (client?.live) return;
      if (usingMode !== 'webrtc') return;
      const video = videoEl;
      if (video?.srcObject && video.currentTime > 0.05) client?.markLive();
    }, 700);

    return () => {
      clearTimeout(fadeTimer);
      clearInterval(liveTimer);
      client?.destroy();
      client = null;
      document.body.classList.remove('obs-mode');
    };
  });

  function handleStream(stream) {
    const video = videoEl;
    if (!video) return;
    video.srcObject = stream;
    video.play().catch(() => {});
    if (typeof video.requestVideoFrameCallback === 'function') {
      const onFrame = () => client?.markLive();
      try {
        video.requestVideoFrameCallback(onFrame);
      } catch {
        /* ignore */
      }
    }
  }

  function handleEvent({ type, payload }) {
    switch (type) {
      case 'hello':
        camName = payload?.camera?.name ?? '';
        if (payload?.status?.width) resolution = `${payload.status.width}×${payload.status.height}`;
        break;
      case 'online':
        if (!client?.live) status = 'connecting';
        break;
      case 'waiting':
        status = 'waiting';
        if (videoEl) videoEl.srcObject = null;
        break;
      case 'live':
        status = 'live';
        usingMode = payload?.mode ?? usingMode;
        break;
      case 'connected':
        break;
      case 'mode':
        usingMode = payload;
        if (payload === 'ws') {
          if (videoEl) videoEl.srcObject = null;
        } else {
          status = client?.live ? 'live' : 'connecting';
        }
        break;
      case 'fallback':
        fallback = true;
        break;
      case 'webrtc-error':
        if (!client?.live) status = 'connecting';
        break;
      case 'fatal':
        status = 'error';
        detail = payload?.message ?? 'Stream not found.';
        break;
      case 'error':
        detail = payload ?? '';
        break;
      case 'frame':
        break;
      default:
        break;
    }
  }

  async function handleFrame(blob) {
    if (drawing) return;
    const canvas = canvasEl;
    if (!canvas) return;
    drawing = true;
    try {
      const bitmap = await createImageBitmap(blob);
      const width = canvas.clientWidth || window.innerWidth || 1280;
      const height = canvas.clientHeight || window.innerHeight || 720;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const cw = Math.max(2, Math.round(width * dpr));
      const ch = Math.max(2, Math.round(height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, cw, ch);

      const scale =
        fit === 'cover'
          ? Math.max(cw / bitmap.width, ch / bitmap.height)
          : Math.min(cw / bitmap.width, ch / bitmap.height);
      const dw = bitmap.width * scale;
      const dh = bitmap.height * scale;
      ctx.drawImage(bitmap, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
      bitmap.close?.();

      if (status !== 'live') {
        status = 'live';
        usingMode = 'ws';
      }
      client?.markLive();
    } catch {
      /* corrupt frame: skip */
    } finally {
      drawing = false;
    }
  }
</script>

<main class="watch">
  <video
    bind:this={videoEl}
    class:hidden={usingMode === 'ws'}
    class:cover={fit === 'cover'}
    autoplay
    playsinline
    muted={muted}
    onplaying={() => client?.markLive()}
  >
    <track kind="captions" />
  </video>

  <canvas bind:this={canvasEl} class:hidden={usingMode !== 'ws'}></canvas>

  {#if status !== 'live'}
    <div class="status">
      {#if status === 'waiting'}
        <span class="pulse"></span>
        <span>Waiting for stream…</span>
      {:else if status === 'error'}
        <span class="err">{detail || 'Stream not found.'}</span>
      {:else}
        <span class="spinner"></span>
        <span>Connecting…</span>
      {/if}
    </div>
  {/if}

  {#if hud}
    <div class="hud" class:faded={hudFaded && status === 'live'}>
      <span class="live-dot" class:on={status === 'live'}></span>
      <span class="hud-name">{camName || id}</span>
      {#if resolution}<span class="hud-meta">{resolution}</span>{/if}
      <span class="hud-mode">{usingMode === 'ws' ? 'MJPEG' : 'WebRTC'}</span>
      {#if fallback && status === 'live'}<span class="hud-warn">backup mode</span>{/if}
    </div>
  {/if}
</main>

<style>
  :global(body.obs-mode) {
    overflow: hidden;
    background: #000;
  }

  .watch {
    position: fixed;
    inset: 0;
    background: #000;
    overflow: hidden;
    user-select: none;
    cursor: default;
  }

  video,
  canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }

  video {
    z-index: 2;
    object-fit: contain;
  }

  video.cover {
    object-fit: cover;
  }

  canvas {
    z-index: 1;
  }

  .hidden {
    display: none;
  }

  .status {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 11px;
    color: rgba(232, 238, 247, 0.62);
    font-family: var(--font);
    font-size: 14px;
    letter-spacing: 0.01em;
    pointer-events: none;
  }

  .status .err {
    color: #fca5a5;
    max-width: 70vw;
    text-align: center;
  }

  .pulse {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #fbbf24;
    animation: blink 1.8s ease-in-out infinite;
  }

  @keyframes blink {
    0%,
    100% {
      opacity: 0.35;
      box-shadow: 0 0 0 0 rgba(251, 191, 36, 0);
    }
    50% {
      opacity: 1;
      box-shadow: 0 0 0 6px rgba(251, 191, 36, 0.12);
    }
  }

  .spinner {
    width: 17px;
    height: 17px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.16);
    border-top-color: #3ddc97;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .hud {
    position: absolute;
    z-index: 4;
    top: 14px;
    left: 14px;
    display: inline-flex;
    align-items: center;
    gap: 9px;
    max-width: calc(100vw - 28px);
    padding: 7px 12px;
    border-radius: 9px;
    background: rgba(5, 9, 14, 0.55);
    border: 1px solid rgba(255, 255, 255, 0.08);
    backdrop-filter: blur(10px);
    font-family: var(--font);
    font-size: 12px;
    color: #cddbea;
    transition: opacity 0.8s ease;
    pointer-events: none;
  }

  .hud.faded {
    opacity: 0;
  }

  .hud-name {
    font-weight: 620;
    max-width: 40vw;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .hud-meta {
    color: #8fa6bd;
    font-family: var(--mono);
    font-size: 10.5px;
  }

  .hud-mode {
    font-family: var(--mono);
    font-size: 9.5px;
    letter-spacing: 0.07em;
    padding: 2px 6px;
    border-radius: 5px;
    background: rgba(56, 189, 248, 0.12);
    border: 1px solid rgba(56, 189, 248, 0.25);
    color: #9ad8fb;
  }

  .hud-warn {
    font-size: 9.5px;
    letter-spacing: 0.05em;
    padding: 2px 6px;
    border-radius: 5px;
    background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.28);
    color: #fcd34d;
  }

  .live-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #62748a;
    flex: none;
  }

  .live-dot.on {
    background: #3ddc97;
    box-shadow: 0 0 0 0 rgba(61, 220, 151, 0.5);
    animation: live-pulse 2s ease-out infinite;
  }

  @keyframes live-pulse {
    0% {
      box-shadow: 0 0 0 0 rgba(61, 220, 151, 0.5);
    }
    70% {
      box-shadow: 0 0 0 7px rgba(61, 220, 151, 0);
    }
    100% {
      box-shadow: 0 0 0 0 rgba(61, 220, 151, 0);
    }
  }
</style>
