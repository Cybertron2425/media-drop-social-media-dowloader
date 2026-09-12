import UrlInput from './UrlInput.jsx';

export default function Hero({ onAnalyze, isLoading, onClear }) {
  return (
    <section id="top" className="mx-auto max-w-3xl px-4 sm:px-6 pt-12 pb-8 sm:pt-16 sm:pb-10 text-center">
      {/* Main Heading */}
      <h1 className="text-2xl sm:text-4xl md:text-[2.65rem] font-bold leading-tight tracking-tight text-slate-900 dark:text-white">
        Download Media from Instagram &amp; Facebook
      </h1>

      {/* Subtitle */}
      <p className="mx-auto mt-3 max-w-xl text-sm sm:text-base text-slate-600 dark:text-slate-400">
        Paste any public URL below and download photos, videos, reels and more.
      </p>

      {/* URL Input Card */}
      <div className="mt-7 sm:mt-8">
        <UrlInput onSubmit={onAnalyze} isLoading={isLoading} onClear={onClear} />
      </div>
    </section>
  );
}
