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
  // Same router as the home entry: a direct/new-window load of /terminal.html
  // routes straight to the terminal view, and "Back to menu" swaps in place.
  // (pagehide transport teardown is handled inside startRouter.)
  await startRouter(root);
}

boot().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
});
