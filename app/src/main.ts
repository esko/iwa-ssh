import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { getRecentLogs, setVerboseLogging } from './debug/logger';
import { startRouter } from './pwa/views';
import { installWindowControls } from './pwa/windowControls';
import './pwa/styles.css';

declare global {
  interface Window {
    /** DevTools: copy(JSON.stringify(__IWA_SSH_DEBUG__.getRecentLogs(), null, 2)) */
    __IWA_SSH_DEBUG__?: {
      getRecentLogs: typeof getRecentLogs;
      enableVerbose: () => void;
    };
  }
}

window.__IWA_SSH_DEBUG__ = {
  getRecentLogs,
  enableVerbose: () => setVerboseLogging(true),
};

installBootErrorHandler();

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app root element');
  installWindowControls();
  // SPA router: launching a profile swaps to the terminal view in place instead
  // of reloading the document, so there's no white flash or bundle re-parse.
  await startRouter(root);
}

boot().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
});
