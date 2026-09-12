import { useState, useEffect, useRef } from 'react';
import ThemeToggle from './ThemeToggle.jsx';

export default function Navbar({ theme, onToggleTheme }) {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const menuRef = useRef(null);

  // Close menu when clicking outside or pressing Escape
  useEffect(() => {
    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setIsMenuOpen(false);
      }
    }

    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        setIsMenuOpen(false);
      }
    }

    if (isMenuOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isMenuOpen]);

  return (
    <header className="sticky top-0 z-40 border-b border-slate-200/70 bg-white/80 backdrop-blur-md dark:border-slate-800 dark:bg-[#0b1120]/80">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 sm:px-6 py-3.5">
        {/* LEFT: Logo + Title + Subtitle */}
        <a href="#top" className="flex items-center gap-3 group">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-tr from-emerald-600 to-emerald-400 text-white shadow-sm shadow-emerald-500/20">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3v12" />
              <path d="m8 11 4 4 4-4" />
              <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
            </svg>
          </div>
          <div>
            <span className="text-base sm:text-lg font-bold tracking-tight text-slate-900 dark:text-white block leading-tight">
              MediaDrop
            </span>
            <span className="hidden sm:block text-[11px] text-slate-500 dark:text-slate-400 leading-tight">
              Download your favorite media, easily.
            </span>
          </div>
        </a>

        {/* RIGHT: Navigation (Desktop) + Theme Toggle + Hamburger (Mobile) */}
        <div className="flex items-center gap-3 sm:gap-6" ref={menuRef}>
          {/* Desktop Navigation */}
          <nav className="hidden sm:flex items-center gap-5 sm:gap-6 text-sm font-medium text-slate-600 dark:text-slate-300">
            <a
              href="#top"
              className="transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
            >
              Home
            </a>
            <a
              href="#about"
              className="transition-colors hover:text-emerald-600 dark:hover:text-emerald-400"
            >
              About
            </a>
          </nav>

          <ThemeToggle theme={theme} onToggle={onToggleTheme} />

          {/* Mobile Hamburger Button */}
          <button
            type="button"
            onClick={() => setIsMenuOpen((prev) => !prev)}
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isMenuOpen}
            className="sm:hidden flex h-9 w-9 items-center justify-center rounded-xl border border-slate-200/80 bg-slate-50 text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:bg-slate-800 transition-colors"
          >
            {isMenuOpen ? (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            ) : (
              <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="4" y1="12" x2="20" y2="12" />
                <line x1="4" y1="18" x2="20" y2="18" />
              </svg>
            )}
          </button>

          {/* Mobile Dropdown Menu (Contains exactly: 🏠 Home, ℹ️ About) */}
          {isMenuOpen && (
            <div className="sm:hidden absolute top-full right-4 mt-2 w-48 rounded-2xl border border-slate-200 bg-white p-1.5 shadow-xl dark:border-slate-800 dark:bg-slate-900 z-50 animate-in fade-in slide-in-from-top-2 duration-150">
              <nav className="flex flex-col gap-0.5">
                <a
                  href="#top"
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-emerald-400 transition-colors"
                >
                  <span className="text-base" role="img" aria-label="Home">🏠</span>
                  <span>Home</span>
                </a>
                <a
                  href="#about"
                  onClick={() => setIsMenuOpen(false)}
                  className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-medium text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 dark:text-slate-200 dark:hover:bg-slate-800 dark:hover:text-emerald-400 transition-colors"
                >
                  <span className="text-base" role="img" aria-label="About">ℹ️</span>
                  <span>About</span>
                </a>
              </nav>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
