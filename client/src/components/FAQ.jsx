const ITEMS = [
  {
    q: 'Which platforms are supported?',
    a: 'MediaDrop is specifically built for Instagram and Facebook. You can download publicly accessible Instagram Reels, videos, photos, and highlights, as well as Facebook Reels, videos, and public photos.',
  },
  {
    q: 'How does the downloader work?',
    a: 'Paste any public Instagram or Facebook link. MediaDrop analyzes the public metadata to retrieve the available video or image stream and lets you download the original quality file directly.',
  },
  {
    q: 'Can I download videos and reels on mobile?',
    a: 'Yes, MediaDrop is fully responsive and works seamlessly on iOS Safari, Android Chrome, and any modern mobile browser.',
  },
  {
    q: 'Can I download photos and images?',
    a: 'Yes! Public Instagram photos and Facebook photos are detected and made available in their original high-resolution format.',
  },
  {
    q: 'Are private accounts or private groups supported?',
    a: 'No. MediaDrop strictly respects privacy and security policies. Only content that is publicly accessible without login or authentication can be downloaded.',
  },
  {
    q: 'Why did an Instagram or Facebook link show a limitation message?',
    a: 'If a post is from a private profile or group, requires login to view, or is temporarily challenged by platform security, MediaDrop does not bypass those protections.',
  },
  {
    q: 'How long are download links available?',
    a: 'Media streams and download tokens expire automatically after a short window (15 minutes) for security and privacy.',
  },
];

export default function FAQ() {
  return (
    <section id="faq" className="mx-auto max-w-2xl px-4 sm:px-6 py-12 sm:py-16">
      <h2 className="mb-6 text-xl sm:text-2xl font-bold text-slate-900 dark:text-white text-center sm:text-left">
        Frequently Asked Questions
      </h2>
      <div className="divide-y divide-slate-200/70 dark:divide-slate-800">
        {ITEMS.map((item) => (
          <details key={item.q} className="group py-4">
            <summary className="focus-ring flex cursor-pointer list-none items-center justify-between text-sm sm:text-base font-semibold text-slate-900 dark:text-slate-100">
              <span>{item.q}</span>
              <span className="text-slate-400 dark:text-slate-500 transition-transform duration-200 group-open:rotate-45 text-lg font-light ml-4">
                +
              </span>
            </summary>
            <p className="mt-2.5 text-xs sm:text-sm text-slate-600 dark:text-slate-400 leading-relaxed pr-6">
              {item.a}
            </p>
          </details>
        ))}
      </div>
    </section>
  );
}
