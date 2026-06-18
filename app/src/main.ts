import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { renderHome } from './pwa/views';
import { installWindowControls } from './pwa/windowControls';
import './pwa/styles.css';

installBootErrorHandler();

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('Missing #app root element');
  installWindowControls();
  await renderHome(root);
}

boot().catch((error: unknown) => {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
});
