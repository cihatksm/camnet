/**
 * Theme preference: 'system' | 'light' | 'dark'.
 *
 * The preference is stored per device (localStorage), so every phone or
 * browser on the LAN can pick its own mode. The early inline script in
 * index.html applies the same rule before first paint to avoid a flash.
 */

export const THEME_KEY = 'camnet-theme';

const VALID = new Set(['system', 'light', 'dark']);

function readPreference() {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored && VALID.has(stored)) return stored;
  } catch {
    /* storage can be unavailable (private mode / blocked) */
  }
  return 'system';
}

function prefersDark() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
}

export const theme = $state({
  pref: readPreference(),
  resolved: 'light'
});

let initialized = false;
let mediaQuery = null;

function updateMetaColor(dark) {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#0b1017' : '#ffffff');
}

function apply() {
  const dark = theme.pref === 'dark' || (theme.pref === 'system' && prefersDark());
  theme.resolved = dark ? 'dark' : 'light';
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme.resolved;
  root.style.colorScheme = theme.resolved;
  root.style.backgroundColor = dark ? '#0b1017' : '#ffffff';
  updateMetaColor(dark);
}

export function initTheme() {
  if (initialized || typeof window === 'undefined') return () => {};
  initialized = true;

  mediaQuery = matchMedia('(prefers-color-scheme: dark)');
  const onSystemChange = () => {
    if (theme.pref === 'system') apply();
  };
  const onStorage = (event) => {
    if (event.key !== THEME_KEY || !event.newValue) return;
    if (!VALID.has(event.newValue) || event.newValue === theme.pref) return;
    theme.pref = event.newValue;
    apply();
  };

  mediaQuery.addEventListener('change', onSystemChange);
  window.addEventListener('storage', onStorage);
  apply();

  return () => {
    mediaQuery?.removeEventListener('change', onSystemChange);
    window.removeEventListener('storage', onStorage);
    initialized = false;
  };
}

export function setTheme(pref) {
  if (!VALID.has(pref)) return;
  theme.pref = pref;
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* ignore */
  }
  apply();
}

/** Light <-> dark. The first click pins the choice instead of following the OS. */
export function toggleTheme() {
  setTheme(theme.resolved === 'dark' ? 'light' : 'dark');
}
