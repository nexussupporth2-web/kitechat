// Colour themes. "purple" is the built-in look; the others are switched on with <html data-theme="...">.
// The choice is remembered on this phone (each person can pick their own).

export interface ThemeInfo {
  id: string;
  name: string;
  /** Two colours for the little preview circle: background, accent. */
  bg: string;
  accent: string;
}

export const THEMES: ThemeInfo[] = [
  { id: 'purple', name: 'Purple', bg: '#232043', accent: '#86d4e8' },
  { id: 'rose', name: 'Rose', bg: '#3e2531', accent: '#e886a7' },
  { id: 'mint', name: 'Mint', bg: '#253e32', accent: '#86e8c4' },
  { id: 'sky', name: 'Sky', bg: '#25353e', accent: '#86c7e8' },
  { id: 'peach', name: 'Peach', bg: '#3e2d25', accent: '#e8ad86' },
  { id: 'butter', name: 'Butter', bg: '#3e3725', accent: '#e8d086' }
];

const KEY = 'kite-theme';

export function currentTheme(): string {
  try {
    const t = localStorage.getItem(KEY);
    return THEMES.some(x => x.id === t) ? (t as string) : 'purple';
  } catch {
    return 'purple';
  }
}

export function applyTheme(id: string) {
  const root = document.documentElement;
  if (id === 'purple') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', id);
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode: the theme still changes, it just is not remembered */
  }
}
