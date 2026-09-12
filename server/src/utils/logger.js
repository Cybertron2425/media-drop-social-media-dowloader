export function logEvent({ requestId, platform, operation, durationMs, success }) {
  // Structured JSON logging. Deliberately excludes cookies, tokens, and any
  // request body/headers that could contain sensitive user data.
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId,
      platform,
      operation,
      durationMs,
      success,
    })
  );
}
