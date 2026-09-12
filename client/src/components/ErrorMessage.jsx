export default function ErrorMessage({ message }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="mx-auto max-w-2xl rounded-2xl border border-rose-200/80 bg-rose-50/80 px-5 py-3.5 text-center text-sm font-medium text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300 shadow-sm"
    >
      {message}
    </div>
  );
}
