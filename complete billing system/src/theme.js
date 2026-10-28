// Per-device appearance: light or the dark premium theme. Stored on the
// device only (localStorage) — it is a preference, not shop data.
const KEY = 'martbill_theme';

export function currentTheme() {
  try { return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'; }
  catch { return 'light'; }
}

export function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem(KEY, t); } catch { /* storage blocked */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', t === 'dark' ? '#0b1220' : '#0f172a');
  window.dispatchEvent(new CustomEvent('shopbill:theme', { detail: t }));
  return t;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

// called before the first paint so the page never flashes the wrong colour
export function initTheme() {
  applyTheme(currentTheme());
}
