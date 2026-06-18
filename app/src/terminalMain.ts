import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { disposeTerminal, renderTerminal } from './pwa/views';
import { installWindowControls } from './pwa/windowControls';
import './pwa/styles.css';

installBootErrorHandler();

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app root element');
  installWindowControls();
  await renderTerminal(root);
  // Native-tab close / navigation away is a full document unload; tear the
  // transport down so sockets don't linger.
  window.addEventListener('pagehide', () => disposeTerminal());
}

boot().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
});
