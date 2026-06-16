import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { createApp } from './app-shell/createApp';
import { initLaunchHandler } from './app-shell/launchHandler';
import { initSessionCloseGuard } from './app-shell/sessionCloseGuard';
import { getRuntimeLabel } from './app-shell/tabMode';
import { initDebugFlagsFromUrl } from './debug/flags';
import { log } from './debug/logger';
import './styles/app.css';

installBootErrorHandler();

try {
  const shell = document.getElementById('app');
  if (!shell) {
    throw new Error('Missing #app root element');
  }

  initDebugFlagsFromUrl();
  initSessionCloseGuard();
  initLaunchHandler();
  log.app.info('boot', {
    runtime: getRuntimeLabel(),
    origin: window.location.origin,
  });

  const content = document.createElement('div');
  content.id = 'app-content';
  content.className = 'app-content';
  shell.appendChild(content);

  const router = createApp(content);
  router.start();
  document.documentElement.dataset.tabMode = getRuntimeLabel();
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
}
