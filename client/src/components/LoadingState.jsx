import { useEffect, useState } from 'react';

const MESSAGES = ['Analyzing media...', 'Fetching metadata...', 'Finding available formats...'];

export default function LoadingState() {
  const [index, setIndex] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setIndex((i) => (i + 1) % MESSAGES.length), 1200);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="mx-auto max-w-2xl animate-pulse rounded-2xl border border-slate-200/80 bg-white p-6 sm:p-8 text-center dark:border-slate-800 dark:bg-slate-900 shadow-sm">
      <div className="mx-auto mb-4 h-36 w-full max-w-sm rounded-xl bg-slate-100 dark:bg-slate-800" />
      <div className="flex items-center justify-center gap-2 text-sm font-medium text-slate-600 dark:text-slate-400">
        <svg className="h-4 w-4 animate-spin text-emerald-500" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
        </svg>
        <span>{MESSAGES[index]}</span>
      </div>
    </div>
  );
}
