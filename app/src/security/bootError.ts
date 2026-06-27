/** Surface uncaught boot errors instead of a blank IWA window. */
export function showBootError(message: string): void {
  const root = document.getElementById('app');
  if (!root) return;
  root.innerHTML = `
    <div class="boot-error" role="alert">
      <h1>Gosh failed to start</h1>
      <pre>${escapeHtml(message)}</pre>
      <p class="muted">Open DevTools on this window for the full stack trace.</p>
    </div>
  `;
}

export function installBootErrorHandler(): void {
  window.addEventListener('error', (event) => {
    const detail =
      event.error instanceof Error ? event.error.stack ?? event.error.message : event.message;
    showBootError(String(detail));
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const detail = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    showBootError(detail);
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
