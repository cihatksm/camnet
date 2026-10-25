<script>
  import { parseRoute, route, installRouter } from './lib/router.svelte.js';
  import Home from './routes/Home.svelte';
  import Share from './routes/Share.svelte';
  import Watch from './routes/Watch.svelte';

  $effect(() => installRouter());

  const parsed = $derived(parseRoute(route.path));
</script>

{#if parsed.name === 'watch'}
  {#key parsed.id}
    <Watch id={parsed.id} />
  {/key}
{:else if parsed.name === 'share'}
  {#key parsed.id}
    <Share id={parsed.id} />
  {/key}
{:else if parsed.name === 'home'}
  <Home />
{:else}
  <div class="notfound">
    <div class="card card-pad">
      <h1>Page not found</h1>
      <p class="muted">The path you are looking for does not exist.</p>
      <a class="btn btn-primary" href="/" data-link>Back to home</a>
    </div>
  </div>
{/if}

<style>
  .notfound {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }
  .card {
    max-width: 420px;
    display: flex;
    flex-direction: column;
    gap: 12px;
    text-align: center;
    align-items: center;
  }
  h1 {
    font-size: 22px;
  }
</style>
