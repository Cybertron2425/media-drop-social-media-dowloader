export default function ThemeToggle({ theme, onToggle }) {
  return (
    <button
      onClick={onToggle}
      aria-label="Toggle color theme"
      className="focus-ring flex h-8 w-8 items-center justify-center rounded border border-ink-700/20 text-ink-700 transition-colors hover:border-signal/50 hover:text-signal dark:border-paper-100/15 dark:text-paper-100/70"
    >
      <span className="font-mono text-xs">{theme === 'dark' ? '☾' : '☀'}</span>
    </button>
  );
}
