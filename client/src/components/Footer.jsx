import { useState, useEffect } from 'react';

const CREDITS = [
  'Developed by Taskmint Solution',
  'Designed by Abhay Gupta',
];

export default function Footer() {
  const [index, setIndex] = useState(0);
  const [fade, setFade] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setFade(false);
      setTimeout(() => {
        setIndex((prev) => (prev + 1) % CREDITS.length);
        setFade(true);
      }, 300);
    }, 60000);

    return () => clearInterval(interval);
  }, []);

  return (
    <footer className="border-t border-slate-200/70 dark:border-slate-800 py-6 sm:py-7 mt-16 text-xs text-slate-500 dark:text-slate-400">
      <div className="mx-auto flex max-w-5xl flex-col sm:flex-row items-center justify-between gap-2.5 px-4 sm:px-6 text-center sm:text-left">
        <span>© 2026 MediaDrop. All rights reserved.</span>
        <span
          className={`font-medium text-slate-500 dark:text-slate-400 transition-opacity duration-300 ${
            fade ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {CREDITS[index]}
        </span>
      </div>
    </footer>
  );
}
