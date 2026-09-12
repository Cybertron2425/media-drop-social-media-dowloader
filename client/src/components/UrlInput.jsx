import { useState } from 'react';

export default function UrlInput({ onSubmit, isLoading, onClear }) {
  const [value, setValue] = useState('');

  function handleSubmit(e) {
    e.preventDefault();
    if (value.trim()) {
      onSubmit(value.trim());
    }
  }

  function handleClear() {
    setValue('');
    if (onClear) onClear();
  }

  return (
    <div className="w-full max-w-2xl mx-auto">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col sm:flex-row items-stretch gap-2.5 sm:gap-3 rounded-2xl bg-white dark:bg-slate-900 p-2 sm:p-2.5 shadow-sm border border-slate-200/80 dark:border-slate-800"
      >
        {/* Input field with Link Icon and Clear X inside */}
        <div className="relative flex flex-1 items-center bg-slate-50/70 dark:bg-slate-800/60 rounded-xl px-3 sm:px-3.5 border border-slate-200/60 dark:border-slate-700/60 focus-within:border-emerald-500 focus-within:ring-2 focus-within:ring-emerald-500/20 transition-all">
          {/* Link Icon */}
          <svg
            className="h-5 w-5 text-slate-400 dark:text-slate-500 shrink-0"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>

          {/* Text Input */}
          <input
            type="url"
            required
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste YouTube, Instagram, Facebook, Snapchat, TikTok, or X URL here..."
            aria-label="Paste YouTube, Instagram, Facebook, Snapchat, TikTok, or X URL"
            className="w-full bg-transparent px-2.5 py-3 text-base text-slate-900 placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500 focus:outline-none"
          />

          {/* Clear "X" Button (only visible when input has content) */}
          {value.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear URL"
              className="p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 rounded-full hover:bg-slate-200/60 dark:hover:bg-slate-700 transition-colors shrink-0"
            >
              <svg
                className="w-4 h-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Analyze Button */}
        <button
          type="submit"
          disabled={isLoading}
          className="focus-ring inline-flex items-center justify-center gap-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 active:bg-emerald-700 px-6 py-3 font-medium text-sm sm:text-base text-white shadow-sm transition-all disabled:opacity-60 shrink-0 w-full sm:w-auto cursor-pointer"
        >
          {isLoading ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z" />
              </svg>
              <span>Analyzing…</span>
            </>
          ) : (
            <>
              <svg
                className="h-4 w-4"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
              <span>Analyze</span>
            </>
          )}
        </button>
      </form>

      {/* Info text below input */}
      <div className="mt-3.5 flex items-center justify-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 text-center px-2">
        <svg
          className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="16" x2="12" y2="12" />
          <line x1="12" y1="8" x2="12.01" y2="8" />
        </svg>
        <span>Supports public YouTube, Instagram, Facebook, Snapchat, TikTok & X links only. No login or account required.</span>
      </div>
    </div>
  );
}
