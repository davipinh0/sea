// Light / dark theme of the panel. The choice is kept per browser; with
// no choice the panel follows the system. The theme is a data-theme
// attribute on <html>; the colours are CSS variables (App.css).

const KEY = 'sea_theme';

function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  let saved = null;
  try {
    saved = window.localStorage.getItem(KEY);
  } catch {
    // Storage blocked: follow the system.
  }
  if (saved === 'dark' || saved === 'light') return saved;
  return systemPrefersDark() ? 'dark' : 'light';
}

export function applyTheme(theme = currentTheme()) {
  document.documentElement.setAttribute('data-theme', theme);
  return theme;
}

export function setTheme(theme) {
  try {
    window.localStorage.setItem(KEY, theme);
  } catch {
    // The choice then lasts only for this visit.
  }
  return applyTheme(theme);
}
