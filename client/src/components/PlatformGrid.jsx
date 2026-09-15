export default function PlatformGrid() {
  return (
    <div className="flex flex-col items-center">
      <p className="font-mono text-xs uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-3">
        Supported Platforms
      </p>

      {/* Responsive layout:
          Mobile (< sm): compact icon-only badges centered in a row, zero text/separators.
          Desktop (sm+): full side-by-side pills with platform name and feature descriptors. */}
      <div className="flex flex-row items-center justify-center gap-2 sm:gap-2.5 max-w-full px-2 flex-wrap">
        {/* Instagram Pill */}
        <div
          title="Instagram: Reels · Posts · Photos · Highlights"
          className="inline-flex flex-row items-center justify-center p-2 sm:px-3 sm:py-1.5 h-10 w-10 sm:h-[42px] sm:w-auto rounded-full border border-pink-500/20 bg-pink-500/5 transition-all hover:border-pink-500/35 hover:bg-pink-500/10 dark:border-pink-400/25 dark:bg-pink-500/10 shadow-sm whitespace-nowrap gap-0 sm:gap-2 shrink-0"
        >
          <svg
            className="h-5 w-5 sm:h-[22px] sm:w-[22px] shrink-0 text-pink-600 dark:text-pink-400"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z" />
          </svg>
          <span className="hidden sm:inline text-[13px] sm:text-[14px] font-bold text-slate-900 dark:text-slate-100 shrink-0 leading-none">
            Instagram
          </span>
          <span className="hidden sm:inline-block h-3 w-px bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-[11px] sm:text-[12px] text-slate-500 dark:text-slate-400 font-normal leading-none shrink-0 whitespace-nowrap">
            Reels · Posts · Photos · Highlights
          </span>
        </div>

        {/* Facebook Pill */}
        <div
          title="Facebook: Reels · Videos · Photos"
          className="inline-flex flex-row items-center justify-center p-2 sm:px-3 sm:py-1.5 h-10 w-10 sm:h-[42px] sm:w-auto rounded-full border border-blue-500/20 bg-blue-500/5 transition-all hover:border-blue-500/35 hover:bg-blue-500/10 dark:border-blue-400/25 dark:bg-blue-500/10 shadow-sm whitespace-nowrap gap-0 sm:gap-2 shrink-0"
        >
          <svg
            className="h-5 w-5 sm:h-[22px] sm:w-[22px] shrink-0 text-blue-600 dark:text-blue-400"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
          </svg>
          <span className="hidden sm:inline text-[13px] sm:text-[14px] font-bold text-slate-900 dark:text-slate-100 shrink-0 leading-none">
            Facebook
          </span>
          <span className="hidden sm:inline-block h-3 w-px bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-[11px] sm:text-[12px] text-slate-500 dark:text-slate-400 font-normal leading-none shrink-0 whitespace-nowrap">
            Reels · Videos · Photos
          </span>
        </div>

        {/* Snapchat Pill */}
        <div
          title="Snapchat: Spotlight · Public Videos · Stories"
          className="inline-flex flex-row items-center justify-center p-2 sm:px-3 sm:py-1.5 h-10 w-10 sm:h-[42px] sm:w-auto rounded-full border border-amber-500/20 bg-amber-500/5 transition-all hover:border-amber-500/35 hover:bg-amber-500/10 dark:border-yellow-400/25 dark:bg-yellow-500/10 shadow-sm whitespace-nowrap gap-0 sm:gap-2 shrink-0"
        >
          <svg
            className="h-5 w-5 sm:h-[22px] sm:w-[22px] shrink-0 text-amber-500 dark:text-yellow-400"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M12.003 2c-3.136 0-5.385 2.193-5.385 5.074 0 .61.161 1.41.42 2.015.08.188.106.326.042.441-.073.13-.263.228-.48.312-1.077.417-1.996 1.05-2.007 2.072 0 .657.416 1.157 1.01 1.487.498.276 1.106.417 1.57.47.165.019.267.112.287.213.067.332.617.438 1.03.498.246.036.438.064.526.155.15.154.084.53-.133.957-.04.079-.115.157-.225.234-.492.348-1.503.737-3.088 1.127-.245.06-.41.282-.395.534.015.25.197.458.441.503 1.123.208 2.378.435 3.327.948.163.088.24.237.212.404-.047.28-.403.468-.828.687-.63.325-1.472.76-1.536 1.442-.036.386.196.72.637.915.63.278 1.547.24 2.658-.11.666-.21 1.418-.517 2.215-.517.784 0 1.53.303 2.195.513 1.12.353 2.045.39 2.68.108.438-.194.67-.527.633-.913-.064-.68-.905-1.116-1.535-1.44-.426-.22-.782-.408-.83-.69-.026-.164.05-.314.212-.401.95-.513 2.204-.74 3.328-.948.244-.045.426-.253.441-.503.015-.252-.15-.474-.395-.534-1.585-.39-2.596-.78-3.088-1.127-.11-.077-.185-.155-.225-.234-.217-.427-.283-.803-.133-.957.088-.09.28-.119.526-.155.413-.06.963-.166 1.03-.498.02-.101.122-.194.287-.213.464-.053 1.072-.194 1.57-.47.594-.33 1.01-.83 1.01-1.487-.01-1.022-.93-1.655-2.007-2.072-.217-.084-.407-.182-.48-.312-.064-.115-.038-.253.042-.441.259-.605.42-1.405.42-2.015C17.388 4.193 15.139 2 12.003 2z" />
          </svg>
          <span className="hidden sm:inline text-[13px] sm:text-[14px] font-bold text-slate-900 dark:text-slate-100 shrink-0 leading-none">
            Snapchat
          </span>
          <span className="hidden sm:inline-block h-3 w-px bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-[11px] sm:text-[12px] text-slate-500 dark:text-slate-400 font-normal leading-none shrink-0 whitespace-nowrap">
            Spotlight · Public Videos · Stories
          </span>
        </div>

        {/* TikTok Pill */}
        <div
          title="TikTok: Videos · Public Content"
          className="inline-flex flex-row items-center justify-center p-2 sm:px-3 sm:py-1.5 h-10 w-10 sm:h-[42px] sm:w-auto rounded-full border border-teal-500/20 bg-teal-500/5 transition-all hover:border-teal-500/35 hover:bg-teal-500/10 dark:border-teal-400/25 dark:bg-teal-500/10 shadow-sm whitespace-nowrap gap-0 sm:gap-2 shrink-0"
        >
          <svg
            className="h-5 w-5 sm:h-[22px] sm:w-[22px] shrink-0 text-teal-600 dark:text-teal-400"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.298-.002.595.042.88.13V9.4a6.84 6.84 0 0 0-1-.05A6.33 6.33 0 0 0 5 20.1a6.34 6.34 0 0 0 10.86-4.43v-7a8.16 8.16 0 0 0 4.77 1.52v-3.4a4.85 4.85 0 0 1-1.04-.1z" />
          </svg>
          <span className="hidden sm:inline text-[13px] sm:text-[14px] font-bold text-slate-900 dark:text-slate-100 shrink-0 leading-none">
            TikTok
          </span>
          <span className="hidden sm:inline-block h-3 w-px bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-[11px] sm:text-[12px] text-slate-500 dark:text-slate-400 font-normal leading-none shrink-0 whitespace-nowrap">
            Videos · Public Content
          </span>
        </div>

        {/* X / Twitter Pill */}
        <div
          title="X / Twitter: Posts · Videos · Images"
          className="inline-flex flex-row items-center justify-center p-2 sm:px-3 sm:py-1.5 h-10 w-10 sm:h-[42px] sm:w-auto rounded-full border border-slate-500/20 bg-slate-500/5 transition-all hover:border-slate-500/35 hover:bg-slate-500/10 dark:border-slate-400/25 dark:bg-slate-500/10 shadow-sm whitespace-nowrap gap-0 sm:gap-2 shrink-0"
        >
          <svg
            className="h-[18px] w-[18px] sm:h-[20px] sm:w-[20px] shrink-0 text-slate-900 dark:text-white"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          <span className="hidden sm:inline text-[13px] sm:text-[14px] font-bold text-slate-900 dark:text-slate-100 shrink-0 leading-none">
            X / Twitter
          </span>
          <span className="hidden sm:inline-block h-3 w-px bg-slate-300 dark:bg-slate-700 shrink-0" aria-hidden="true" />
          <span className="hidden sm:inline text-[11px] sm:text-[12px] text-slate-500 dark:text-slate-400 font-normal leading-none shrink-0 whitespace-nowrap">
            Posts · Videos · Images
          </span>
        </div>
      </div>

      {/* Subtle bottom note */}
      <p className="mt-3 text-center font-mono text-[11px] text-slate-400 dark:text-slate-500">
        Public media only · No login or account required
      </p>
    </div>
  );
}
