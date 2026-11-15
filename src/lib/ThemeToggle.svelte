<script>
  import { theme, toggleTheme } from './theme.svelte.js';

  const label = $derived(
    theme.resolved === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'
  );
</script>

<button
  type="button"
  class="btn btn-icon theme-toggle"
  onclick={toggleTheme}
  title={label}
  aria-label={label}
>
  {#if theme.resolved === 'dark'}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4.2" />
      <path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" />
    </svg>
  {:else}
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M20.2 14.6A8.6 8.6 0 0 1 9.4 3.8 8.6 8.6 0 1 0 20.2 14.6Z" />
    </svg>
  {/if}
</button>

<style>
  .theme-toggle {
    flex: none;
    color: var(--dim);
  }

  .theme-toggle:hover {
    color: var(--text);
  }
</style>
