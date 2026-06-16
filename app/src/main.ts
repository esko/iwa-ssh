import './security/trustedTypes';
import { installBootErrorHandler, showBootError } from './security/bootError';
import { createApp } from './app-shell/createApp';
import { initTabManager } from './app-shell/TabManager';
import { Router } from './app-shell/router';
import { usesSimulatedTabs } from './app-shell/tabMode';
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
  log.app.info('boot', {
    tabMode: usesSimulatedTabs() ? 'simulated' : 'native',
    origin: window.location.origin,
  });

  const content = document.createElement('div');
  content.id = 'app-content';
  content.className = 'app-content';
  shell.appendChild(content);

  const tabManager = initTabManager((path) => Router.go(path), shell);

  Router.setNavigateHook((path) => {
    tabManager?.syncFromPath(path);
  });

  const router = createApp(content);
  router.start();

  if (usesSimulatedTabs()) {
    document.documentElement.dataset.tabMode = 'simulated';
  } else {
    document.documentElement.dataset.tabMode = 'native';
  }
} catch (error) {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  showBootError(detail);
  console.error('Boot failed', error);
}
