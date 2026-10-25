<script>
  import { onMount } from 'svelte';
  import { api, getToken, removeToken, setToken, snapshotUrl } from '../lib/api.js';
  import { copyText, deviceLabel, formatRelative, isSecureEnough, resolutionLabel, slugify } from '../lib/util.js';
  import { navigate } from '../lib/router.svelte.js';

  let cameras = $state([]);
  let info = $state(null);
  let loading = $state(true);
  let error = $state('');
  let creating = $state(false);
  let newName = $state('');
  let busy = $state(false);
  let copiedId = $state('');
  let showPair = $state(false);
  let failedThumbs = $state({});

  const httpsHome = $derived(
    info?.httpsPort ? `https://${info.primaryIp}:${info.httpsPort}/` : ''
  );
  const pairUrl = $derived(httpsHome || `${location.protocol}//${location.host}/`);
  const qrSrc = $derived(`/api/qr.svg?text=${encodeURIComponent(pairUrl)}`);
  const cameraCount = $derived(cameras.length);
  const onlineCount = $derived(cameras.filter((c) => c.online).length);
  const pathPreview = $derived(`/c/${slugify(newName.trim() || deviceLabel()) || 'camera'}`);

  function httpBase() {
    const ip =
      info?.primaryIp && info.primaryIp !== '127.0.0.1' ? info.primaryIp : location.hostname;
    const port = info?.httpPort ?? (location.port || 80);
    const suffix = port === 80 ? '' : `:${port}`;
    return `http://${ip}${suffix}`;
  }

  function obsUrl(id) {
    return `${httpBase()}/c/${id}`;
  }

  function shareHref(id) {
    if (isSecureEnough()) return `/share/${id}`;
    if (!info?.httpsPort) return `/share/${id}`;
    return `https://${info.primaryIp}:${info.httpsPort}/share/${id}`;
  }

  function thumbKey(camera) {
    return `${camera.id}:${camera.snapshotTs}`;
  }

  function thumbFailed(key) {
    failedThumbs = { ...failedThumbs, [key]: true };
  }

  async function refresh() {
    try {
      const data = await api('/api/cameras');
      cameras = data.cameras ?? [];
      error = '';
    } catch (err) {
      if (!loading) console.warn('failed to load camera list', err);
      error = 'Cannot reach the server.';
    }
  }

  onMount(() => {
    (async () => {
      try {
        info = await api('/api/info');
      } catch {
        /* continue without server info */
      }
      await refresh();
      loading = false;
    })();

    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 2500);

    const onVisible = () => {
      if (!document.hidden) refresh();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  });

  function openCreate() {
    error = '';
    if (!isSecureEnough()) {
      error = 'Camera sharing requires the HTTPS address.';
      return;
    }
    newName = deviceLabel();
    creating = true;
  }

  async function createCamera() {
    if (busy) return;
    busy = true;
    error = '';
    try {
      const data = await api('/api/cameras', {
        method: 'POST',
        body: JSON.stringify({ name: newName.trim() || deviceLabel() })
      });
      setToken(data.camera.id, data.token);
      creating = false;
      navigate(`/share/${data.camera.id}?start=1`);
    } catch (err) {
      error = err.message || 'Could not create the camera.';
    } finally {
      busy = false;
    }
  }

  async function removeCamera(camera) {
    const token = getToken(camera.id);
    if (!token) return;
    if (!confirm(`Delete "${camera.name}"?`)) return;
    try {
      await api(`/api/cameras/${camera.id}`, {
        method: 'DELETE',
        headers: { 'x-camera-token': token }
      });
      removeToken(camera.id);
      await refresh();
    } catch (err) {
      error = err.message;
    }
  }

  async function copyObs(camera) {
    const ok = await copyText(obsUrl(camera.id));
    if (ok) {
      copiedId = camera.id;
      setTimeout(() => {
        if (copiedId === camera.id) copiedId = '';
      }, 1700);
    }
  }
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
      <span>CamNet<small>local camera network</small></span>
    </a>
    <div class="grow"></div>
    {#if info}
      <span class="net-pill mono">{info.primaryIp}:{info.httpPort}</span>
    {/if}
    <button class="btn" onclick={() => (showPair = true)}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
        <path d="M14 14h3v3h-3zM20 14v2M14 20h2M20 20h1" />
      </svg>
      Connect phone
    </button>
    <button class="btn btn-primary" onclick={openCreate}>
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true">
        <path d="M12 5v14M5 12h14" />
      </svg>
      Share camera
    </button>
  </div>
</header>

<main class="wrap">
  <section class="hero">
    <div class="hero-copy">
      <div class="eyebrow">
        <span class="dot dot-pulse" style="color: var(--accent)"></span>
        Local network · no setup · no database
      </div>
      <h1>
        Every device a camera.<br />
        <span class="grad">Every camera an OBS source.</span>
      </h1>
      <p>
        Phones, tablets and computers on the same Wi-Fi share their cameras.
        Each device gets a fixed path, and you add each one as a separate Browser Source in OBS.
      </p>
      <div class="hero-actions">
        <button class="btn btn-primary" onclick={openCreate}>Share camera</button>
        {#if httpsHome && !isSecureEnough()}
          <a class="btn" href={httpsHome}>Secure connection (HTTPS)</a>
        {/if}
      </div>
    </div>

    <aside class="hero-card card">
      <div class="hero-card-head">
        <span class="badge badge-live"><span class="dot dot-pulse"></span>Server online</span>
        <span class="dim">{cameraCount} cameras</span>
      </div>
      <div class="server-rows">
        <div class="server-row">
          <span>Local address</span>
          <b class="mono">{info?.primaryIp ?? '—'}</b>
        </div>
        <div class="server-row">
          <span>HTTP</span>
          <b class="mono">{info?.httpPort ?? '—'}</b>
        </div>
        <div class="server-row">
          <span>HTTPS</span>
          <b class="mono">{info?.httpsPort ?? 'off'}</b>
        </div>
        <div class="server-row">
          <span>Live</span>
          <b>{onlineCount} cameras</b>
        </div>
      </div>
      <div class="hero-hint">
        OBS source path
        <code class="mono">{httpBase()}/c/&lt;camera-id&gt;</code>
      </div>
    </aside>
  </section>

  {#if !isSecureEnough()}
    <div class="alert alert-warn">
      <span class="alert-icon">!</span>
      <div>
        <b>HTTPS is required to share a camera.</b>
        Browsers only allow camera access in a secure context (HTTPS or localhost).
        On your phone, open <span class="mono">{httpsHome || 'https://…'}</span> and choose
        <b>Advanced → Proceed</b> on the certificate warning.
      </div>
    </div>
  {/if}

  {#if error}
    <div class="alert alert-danger">
      <span class="alert-icon">!</span>
      <div>{error}</div>
    </div>
  {/if}

  <section class="section">
    <div class="section-head">
      <h2>Cameras</h2>
      <span class="muted">{onlineCount} online · {cameraCount} registered</span>
    </div>

    {#if loading}
      <div class="loading"><span class="spinner"></span> Loading…</div>
    {:else if cameras.length === 0}
      <div class="empty card">
        <div class="empty-art">
          <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
            <rect x="2.5" y="6" width="13" height="12" rx="3.4" />
            <path d="M16.5 10.2 21.5 7v10l-5-3.2z" />
            <circle cx="9" cy="12" r="2.6" />
          </svg>
        </div>
        <h3>No cameras yet</h3>
        <p class="muted">
          Create your first camera on this computer or on a phone connected to the same network.
          As soon as you start streaming, the OBS link is ready.
        </p>
        <div class="empty-actions">
          <button class="btn btn-primary" onclick={openCreate}>Create camera</button>
          <button class="btn" onclick={() => (showPair = true)}>Connect phone</button>
        </div>
      </div>
    {:else}
      <div class="cam-grid">
        {#each cameras as camera (camera.id)}
          <article class="cam-card card">
            <div class="thumb">
              {#if camera.snapshotTs && !failedThumbs[thumbKey(camera)]}
                <img
                  src={snapshotUrl(camera.id, camera.snapshotTs)}
                  alt={`${camera.name} preview`}
                  loading="lazy"
                  onerror={() => thumbFailed(thumbKey(camera))}
                />
              {:else}
                <div class="thumb-empty">
                  <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                    <rect x="2.5" y="6" width="13" height="12" rx="3.4" />
                    <path d="M16.5 10.2 21.5 7v10l-5-3.2z" />
                  </svg>
                  <span>{camera.online ? 'Preparing video…' : 'No stream yet'}</span>
                </div>
              {/if}

              <div class="thumb-badges">
                {#if camera.online}
                  <span class="badge badge-live"><span class="dot dot-pulse"></span>Live</span>
                {:else}
                  <span class="badge badge-off">Offline</span>
                {/if}
                {#if camera.online && camera.viewers > 0}
                  <span class="badge badge-info">{camera.viewers} viewers</span>
                {/if}
              </div>

              {#if camera.status?.width}
                <div class="thumb-meta mono">
                  {resolutionLabel(camera.status)} · {camera.status.fps} fps
                </div>
              {/if}
            </div>

            <div class="cam-body">
              <div class="cam-head">
                <h3 title={camera.name}>{camera.name}</h3>
                <code class="cam-id mono">/c/{camera.id}</code>
              </div>
              <div class="cam-sub">
                {#if camera.online}
                  <span class="live-text">Live</span>
                {:else}
                  <span>{camera.lastSeen ? `Last seen ${formatRelative(camera.lastSeen)}` : 'Never connected'}</span>
                {/if}
              </div>

              <div class="cam-actions">
                <button class="btn btn-sm" onclick={() => copyObs(camera)}>
                  {#if copiedId === camera.id}
                    <span class="ok">✓ Copied</span>
                  {:else}
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <rect x="9" y="9" width="11" height="11" rx="2.5" />
                      <path d="M15 5.5A2.5 2.5 0 0 0 12.5 3h-7A2.5 2.5 0 0 0 3 5.5v7A2.5 2.5 0 0 0 5.5 15" />
                    </svg>
                    OBS link
                  {/if}
                </button>
                <a class="btn btn-sm btn-ghost" href={`/c/${camera.id}`} target="_blank" rel="noreferrer">
                  Watch
                </a>
                {#if getToken(camera.id)}
                  <a class="btn btn-sm btn-ghost" href={shareHref(camera.id)} data-link>Share</a>
                  <button class="btn btn-sm btn-danger" onclick={() => removeCamera(camera)} title="Delete camera">
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                      <path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.5h9.4L17.5 7" />
                    </svg>
                  </button>
                {/if}
              </div>
            </div>
          </article>
        {/each}
      </div>
    {/if}
  </section>

  <section class="steps">
    <div class="step card">
      <span class="step-no">1</span>
      <h4>Connect your phone</h4>
      <p class="muted">Scan the QR code or open the network address. Accept the certificate warning once.</p>
    </div>
    <div class="step card">
      <span class="step-no">2</span>
      <h4>Start streaming</h4>
      <p class="muted">Give the device a name and allow camera access. Each device gets its own path.</p>
    </div>
    <div class="step card">
      <span class="step-no">3</span>
      <h4>Add to OBS</h4>
      <p class="muted">Browser Source → paste the <span class="mono">/c/&lt;id&gt;</span> path as the URL.</p>
    </div>
  </section>

  <footer class="foot">
    <span>CamNet v{info?.version ?? '1.0.0'}</span>
    <span class="dim">·</span>
    <span>Video never leaves your devices; it only travels over your local network.</span>
    <span class="grow"></span>
    <a class="dim" href="/api/cameras" target="_blank" rel="noreferrer">API</a>
  </footer>
</main>

{#if creating}
  <div class="modal-wrap">
    <div class="modal card card-pad">
      <h3>New camera</h3>
      <p class="muted">Choose a name for this device. The path is generated automatically.</p>
      <div class="field">
        <label for="cam-name">Camera name</label>
        <input
          id="cam-name"
          class="input"
          bind:value={newName}
          maxlength="40"
          placeholder="e.g. Phone"
          onkeydown={(e) => e.key === 'Enter' && createCamera()}
        />
      </div>
      <div class="path-preview">
        <span>Path</span>
        <code class="mono">{pathPreview}</code>
      </div>
      <div class="modal-actions">
        <button class="btn" onclick={() => (creating = false)} disabled={busy}>Cancel</button>
        <button class="btn btn-primary" onclick={createCamera} disabled={busy}>
          {#if busy}<span class="spinner"></span>{/if}
          Create and start
        </button>
      </div>
    </div>
  </div>
{/if}

{#if showPair}
  <div class="modal-wrap">
    <div class="modal card card-pad">
      <h3>Connect a phone</h3>
      <p class="muted">
        Scan this QR code with your phone camera to share it.
        On the certificate warning, choose <b>Advanced → Proceed</b>.
      </p>
      <div class="qr-box">
        <img src={qrSrc} alt="QR code for the connection" />
      </div>
      <div class="code-row"><code>{pairUrl}</code></div>
      <div class="modal-actions">
        <button class="btn" onclick={() => (showPair = false)}>Close</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .net-pill {
    padding: 5px 10px;
    border-radius: 8px;
    border: 1px solid var(--line);
    background: #0a1018;
    font-size: 12px;
    color: var(--muted);
  }

  .hero {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    gap: 30px;
    align-items: center;
    padding: 54px 0 38px;
  }

  .eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 11.5px;
    font-weight: 650;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 16px;
  }

  h1 {
    font-size: clamp(30px, 4.4vw, 50px);
    line-height: 1.08;
    letter-spacing: -0.035em;
    font-weight: 720;
  }

  .hero-copy p {
    max-width: 560px;
    margin-top: 18px;
    color: var(--muted);
    font-size: 15.5px;
    line-height: 1.65;
  }

  .hero-actions {
    display: flex;
    gap: 10px;
    margin-top: 26px;
    flex-wrap: wrap;
  }

  .hero-card {
    padding: 18px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .hero-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    font-size: 12.5px;
  }

  .server-rows {
    display: flex;
    flex-direction: column;
    gap: 1px;
    border-radius: 10px;
    overflow: hidden;
    border: 1px solid var(--line-soft);
  }

  .server-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 12px;
    background: #0a1018;
    font-size: 13px;
  }

  .server-row span {
    color: var(--dim);
  }

  .server-row b {
    font-weight: 600;
  }

  .hero-hint {
    font-size: 11.5px;
    color: var(--dim);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .hero-hint code {
    display: block;
    padding: 8px 10px;
    border-radius: 8px;
    background: #070b11;
    border: 1px solid var(--line-soft);
    color: #9fd6c0;
    font-size: 11.5px;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .section {
    margin-top: 34px;
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 14px;
  }

  .section-head h2 {
    font-size: 19px;
    letter-spacing: -0.01em;
  }

  .section-head span {
    font-size: 13px;
  }

  .loading {
    display: flex;
    align-items: center;
    gap: 10px;
    color: var(--muted);
    padding: 40px 0;
    justify-content: center;
  }

  .empty {
    padding: 46px 24px;
    text-align: center;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
  }

  .empty-art {
    width: 76px;
    height: 76px;
    border-radius: 20px;
    display: grid;
    place-items: center;
    color: #46617c;
    background: #0b121b;
    border: 1px solid var(--line);
    margin-bottom: 8px;
  }

  .empty h3 {
    font-size: 18px;
  }

  .empty p {
    max-width: 460px;
    font-size: 14px;
  }

  .empty-actions {
    display: flex;
    gap: 10px;
    margin-top: 14px;
    flex-wrap: wrap;
    justify-content: center;
  }

  .cam-card {
    overflow: hidden;
    display: flex;
    flex-direction: column;
    transition: border-color 0.18s, transform 0.18s;
  }

  .cam-card:hover {
    border-color: #2b4058;
    transform: translateY(-1px);
  }

  .thumb {
    position: relative;
    aspect-ratio: 16 / 9;
    background:
      radial-gradient(120% 90% at 50% 0%, #16222f 0%, #0a0f16 70%);
    border-bottom: 1px solid var(--line-soft);
    overflow: hidden;
  }

  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .thumb-empty {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 9px;
    color: #4b6379;
    font-size: 12.5px;
  }

  .thumb-badges {
    position: absolute;
    top: 9px;
    left: 9px;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .thumb-meta {
    position: absolute;
    right: 9px;
    bottom: 9px;
    padding: 4px 8px;
    border-radius: 7px;
    background: rgba(5, 9, 14, 0.72);
    backdrop-filter: blur(6px);
    color: #c6d7e8;
    font-size: 11px;
  }

  .cam-body {
    padding: 13px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    flex: 1;
  }

  .cam-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
  }

  .cam-head h3 {
    font-size: 15.5px;
    font-weight: 640;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cam-id {
    font-size: 10.5px;
    color: var(--dim);
    background: #0a1018;
    border: 1px solid var(--line-soft);
    padding: 3px 7px;
    border-radius: 6px;
    white-space: nowrap;
    max-width: 52%;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .cam-sub {
    font-size: 12.5px;
    color: var(--dim);
  }

  .live-text {
    color: #6fe0a8;
  }

  .cam-actions {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-top: auto;
    padding-top: 4px;
    flex-wrap: wrap;
  }

  .ok {
    color: #6fe0a8;
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
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.45);
    background: rgba(251, 191, 36, 0.1);
  }

  .alert-danger .alert-icon {
    color: #f87171;
    border-color: rgba(248, 113, 113, 0.5);
    background: rgba(248, 113, 113, 0.12);
  }

  .alert {
    margin-top: 16px;
  }

  .steps {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin: 34px 0 10px;
  }

  .step {
    padding: 16px;
    position: relative;
  }

  .step-no {
    display: inline-grid;
    place-items: center;
    width: 23px;
    height: 23px;
    border-radius: 7px;
    font-size: 11.5px;
    font-weight: 700;
    color: #062116;
    background: linear-gradient(180deg, #4ae6a4, #31cf8b);
    margin-bottom: 10px;
  }

  .step h4 {
    font-size: 14px;
    margin-bottom: 5px;
  }

  .step p {
    font-size: 12.5px;
    line-height: 1.6;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    padding: 28px 0 34px;
    font-size: 12px;
    color: var(--dim);
    border-top: 1px solid var(--line-soft);
    margin-top: 28px;
  }

  .modal-wrap {
    position: fixed;
    inset: 0;
    z-index: 80;
    display: grid;
    place-items: center;
    padding: 20px;
    background: rgba(4, 7, 11, 0.72);
    backdrop-filter: blur(6px);
  }

  .modal {
    width: min(420px, 100%);
    display: flex;
    flex-direction: column;
    gap: 13px;
    box-shadow: var(--shadow);
    animation: modal-in 0.16s ease-out;
  }

  @keyframes modal-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.99);
    }
  }

  .modal h3 {
    font-size: 18px;
  }

  .modal p {
    font-size: 13px;
    line-height: 1.6;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 4px;
  }

  .path-preview {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    padding: 9px 11px;
    border-radius: 9px;
    background: #070b11;
    border: 1px solid var(--line-soft);
    font-size: 12px;
    color: var(--dim);
  }

  .path-preview code {
    color: #9fd6c0;
    font-size: 12px;
  }

  .qr-box {
    background: #fff;
    padding: 12px;
    border-radius: 12px;
    display: grid;
    place-items: center;
    align-self: center;
  }

  .qr-box img {
    width: 220px;
    height: 220px;
    display: block;
  }

  @media (max-width: 900px) {
    .hero {
      grid-template-columns: 1fr;
      gap: 22px;
      padding-top: 34px;
    }
    .hero-card {
      max-width: 520px;
    }
    .steps {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 620px) {
    .net-pill {
      display: none;
    }
    .topbar-inner {
      gap: 8px;
    }
    .topbar-inner .btn {
      padding: 0 11px;
      font-size: 13px;
    }
    .hero {
      padding-top: 26px;
    }
    .cam-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
