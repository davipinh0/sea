// Tema claro/escuro. A escolha fica no navegador; sem escolha, segue o sistema.

const KEY = 'sea_theme';

function systemPrefersDark() {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  let saved = null;
  try {
    saved = window.localStorage.getItem(KEY);
  } catch {
    // Armazenamento bloqueado: segue o sistema.
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
    // A escolha vale só para esta visita.
  }
  return applyTheme(theme);
}
