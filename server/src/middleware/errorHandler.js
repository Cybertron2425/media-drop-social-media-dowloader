export function notFoundHandler(_req, res) {
  res.status(404).json({ success: false, error: 'Not found.' });
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, _req, res, _next) {
  console.error(JSON.stringify({ timestamp: new Date().toISOString(), error: err.message }));
  if (res.headersSent) return;
  res.status(500).json({ success: false, error: 'Something went wrong. Please try again.' });
}
