import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { startRouter } from './pwa/views';
import { installWindowControls } from './pwa/windowControls';
import './pwa/styles.css';

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
