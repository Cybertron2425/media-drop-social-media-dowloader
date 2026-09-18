import { useState } from 'react';
import Navbar from './components/Navbar.jsx';
import Hero from './components/Hero.jsx';
import LoadingState from './components/LoadingState.jsx';
import ErrorMessage from './components/ErrorMessage.jsx';
import MediaPreview from './components/MediaPreview.jsx';
import PlatformGrid from './components/PlatformGrid.jsx';
import FAQ from './components/FAQ.jsx';
import Footer from './components/Footer.jsx';
import { useTheme } from './hooks/useTheme.js';
import { analyzeUrl, downloadFormat, downloadBulk } from './services/api.js';

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [status, setStatus] = useState('idle'); // idle | loading | success | error
  const [media, setMedia] = useState(null);
  const [error, setError] = useState('');
  const [downloadError, setDownloadError] = useState('');
  const [downloadingId, setDownloadingId] = useState(null);
  const [downloadStage, setDownloadStage] = useState(null); // 'preparing' | 'processing' | 'ready' | 'complete'
  const [isBulkDownloading, setIsBulkDownloading] = useState(false);

  async function handleAnalyze(url) {
    setStatus('loading');
    setError('');
    setDownloadError('');
    setMedia(null);
    try {
      const result = await analyzeUrl(url);
      setMedia(result);
      setStatus('success');
    } catch (err) {
      setError(err.message);
      setStatus('error');
    }
  }

  function handleClear() {
    setError('');
    setDownloadError('');
    setStatus('idle');
    setMedia(null);
    setIsBulkDownloading(false);
  }

  async function handleDownload(downloadId) {
    console.log('[MediaDrop Download] handleDownload triggered for downloadId:', downloadId);
    if (downloadingId || isBulkDownloading) {
      console.warn('[MediaDrop Download] Click ignored: already downloading', { downloadingId, isBulkDownloading });
      return;
    }
    setDownloadingId(downloadId);
    setDownloadError('');
    try {
      await downloadFormat(downloadId, setDownloadStage);
      console.log('[MediaDrop Download] downloadFormat resolved successfully');
      setDownloadingId(null);
      setDownloadStage(null);
    } catch (err) {
      console.error('[MediaDrop Download] downloadFormat failed:', err);
      setDownloadError(err.message || 'Download failed. Please try again.');
      setDownloadingId(null);
      setDownloadStage(null);
    }
  }

  async function handleDownloadBulk(downloadIds, title) {
    if (isBulkDownloading || downloadingId) return;
    setIsBulkDownloading(true);
    setDownloadError('');
    try {
      await downloadBulk(downloadIds, title);
      setTimeout(() => {
        setIsBulkDownloading(false);
      }, 2000);
    } catch (err) {
      setDownloadError(err.message);
      setIsBulkDownloading(false);
    }
  }

  return (
    <div className="min-h-screen flex flex-col justify-between selection:bg-emerald-500/20">
      <div>
        <Navbar theme={theme} onToggleTheme={toggleTheme} />

        {/* HERO SECTION WITH URL INPUT */}
        <Hero onAnalyze={handleAnalyze} isLoading={status === 'loading'} onClear={handleClear} />

        <main className="px-4 sm:px-6">
          {/* RESULT SECTION (strictly above Supported Platforms) */}
          {status === 'loading' && (
            <div className="mb-10">
              <LoadingState />
            </div>
          )}

          {status === 'error' && (
            <div className="mb-10">
              <ErrorMessage message={error} />
            </div>
          )}

          {status === 'success' && media && (
            <div className="mb-12">
              {downloadError && (
                <div className="mb-4">
                  <ErrorMessage message={downloadError} />
                </div>
              )}
              <MediaPreview
                media={media}
                onDownload={handleDownload}
                onDownloadBulk={handleDownloadBulk}
                downloadingId={downloadingId}
                downloadStage={downloadStage}
                isBulkDownloading={isBulkDownloading}
              />
            </div>
          )}

          {/* SUPPORTED PLATFORMS (strictly below Result section) */}
          <section id="platforms" className="py-6 sm:py-8">
            <PlatformGrid />
          </section>

          {/* ABOUT / HOW IT WORKS */}
          <section id="about" className="mx-auto max-w-2xl px-4 sm:px-6 py-10 sm:py-12 text-center">
            <h2 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white mb-2.5">
              About MediaDrop
            </h2>
            <p className="text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
              MediaDrop is a fast, clean, and modern online media downloader designed specifically for publicly accessible Instagram and Facebook media. Paste any public link to preview and download videos, reels, photos, and highlights in their original quality with zero hassle.
            </p>
          </section>

          {/* FAQ */}
          <FAQ />
        </main>
      </div>

      {/* FOOTER */}
      <Footer />
    </div>
  );
}
