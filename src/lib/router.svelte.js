export const route = $state({
  path: typeof location !== 'undefined' ? location.pathname : '/',
  query: typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams()
});

function sync() {
  route.path = location.pathname;
  route.query = new URLSearchParams(location.search);
}

export function navigate(to, { replace = false } = {}) {
  const url = new URL(to, location.href);
  if (url.pathname === location.pathname && url.search === location.search) return;
  if (replace) history.replaceState({}, '', url);
  else history.pushState({}, '', url);
  sync();
  window.scrollTo({ top: 0 });
}

export function parseRoute(path) {
  if (path === '/' || path === '') return { name: 'home' };
  let match = /^\/share\/([a-z0-9][a-z0-9-]{1,40})\/?$/i.exec(path);
  if (match) return { name: 'share', id: match[1] };
  if (/^\/share\/?$/i.test(path)) return { name: 'home' };
  match = /^\/(?:c|watch)\/([a-z0-9][a-z0-9-]{1,40})\/?$/i.exec(path);
  if (match) return { name: 'watch', id: match[1] };
  return { name: 'notfound' };
}

let installed = false;

export function installRouter() {
  if (installed) return () => {};
  installed = true;

  const onPop = () => sync();
  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = event.target instanceof Element ? event.target.closest('a[data-link]') : null;
    if (!anchor) return;
    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('#') || anchor.target === '_blank') return;
    event.preventDefault();
    navigate(href);
  };

  window.addEventListener('popstate', onPop);
  document.addEventListener('click', onClick);

  return () => {
    installed = false;
    window.removeEventListener('popstate', onPop);
    document.removeEventListener('click', onClick);
  };
}
