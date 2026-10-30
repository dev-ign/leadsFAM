import { useEffect, useState } from 'react';

type Theme = 'light' | 'dark';
function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem('leadops-theme');
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(initialTheme);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem('leadops-theme', theme);
    } catch {
      /* Theme still works without persistence. */
    }
  }, [theme]);
  return { theme, toggleTheme: () => setTheme((value) => (value === 'light' ? 'dark' : 'light')) };
}
