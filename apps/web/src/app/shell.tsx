import { useEffect, useRef, useState } from 'react';
import { Menu, Moon, Sun } from 'lucide-react';
import { Outlet, useLocation } from 'react-router';
import { Button } from '@leadops/ui';
import { Navigation } from './navigation';
import { useTheme } from './use-theme';

export function AppShell() {
  const { theme, toggleTheme } = useTheme();
  const dialog = useRef<HTMLDialogElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (menuOpen) dialog.current?.showModal();
    else dialog.current?.close();
  }, [menuOpen]);
  useEffect(() => {
    const media = window.matchMedia?.('(min-width: 1024px)');
    const close = () => {
      if (media?.matches) setMenuOpen(false);
    };
    media?.addEventListener('change', close);
    return () => media?.removeEventListener('change', close);
  }, []);
  return (
    <div className="min-h-screen">
      <a
        href="#main-content"
        className="fixed top-3 left-3 z-50 -translate-y-24 rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground focus:translate-y-0"
      >
        Skip to content
      </a>
      <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col overflow-y-auto border-r border-border bg-sidebar lg:flex">
        <Navigation onNavigate={() => setMenuOpen(false)} />
      </aside>
      <dialog
        ref={dialog}
        onClose={() => setMenuOpen(false)}
        aria-label="Workspace navigation"
        className="fixed inset-y-0 right-auto left-0 m-0 h-dvh max-h-none w-72 max-w-[90vw] border-0 border-r border-border bg-sidebar p-0 text-foreground backdrop:bg-black/40"
      >
        <div className="flex h-full flex-col overflow-y-auto">
          <Navigation onNavigate={() => setMenuOpen(false)} />
        </div>
      </dialog>
      <div className="lg:pl-60">
        <header className="flex h-20 items-center justify-between gap-4 border-b border-border px-5 sm:px-8 lg:px-10">
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              aria-label="Open navigation"
              aria-haspopup="dialog"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              <Menu aria-hidden="true" />
            </Button>
            <p className="text-sm">
              <span className="hidden text-muted-foreground sm:inline">
                Workspace
                <span aria-hidden="true" className="mx-3 text-border">
                  /
                </span>
              </span>
              <span className="font-medium">
                {location.pathname === '/status' ? 'Platform status' : 'Overview'}
              </span>
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-muted-foreground">
              Foundation preview
            </span>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Switch to ${theme === 'light' ? 'dark' : 'light'} theme`}
              onClick={toggleTheme}
            >
              {theme === 'light' ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}
            </Button>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className="mx-auto max-w-7xl px-5 py-9 outline-none sm:px-8 lg:px-10 lg:py-11"
        >
          <Outlet />
        </main>
        <footer className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-2 px-5 pb-8 text-xs text-muted-foreground sm:px-8 lg:px-10">
          <span>LeadOps AI</span>
          <span>Foundation preview · No business data connected</span>
        </footer>
      </div>
    </div>
  );
}
