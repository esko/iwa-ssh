const SESSION_ID = 'a26731';
const INGEST = 'http://127.0.0.1:7869/ingest/5b03efa9-2224-4a73-9a56-c6a816107ee6';

/** Visible in Chrome DevTools console on the machine running the IWA (filter: hk-debug). */
export function agentDebugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  const payload = {
    sessionId: SESSION_ID,
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  };
  console.warn('[iwa-ssh hk-debug]', JSON.stringify(payload));
  fetch(INGEST, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': SESSION_ID },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
