/**
 * Load nassh/hterm UI strings (PLUGIN_LOADING, CONNECTING, …) for IWA dev.
 */

import { log } from '../debug/logger';
import { upstreamImport } from './upstreamUrls';

type HtermModule = {
  hterm: {
    initPromise: Promise<void>;
    messageManager: {
      useCrlf: boolean;
      findAndLoadMessages: (pattern: string) => Promise<void>;
    };
  };
};

let loaded = false;

export async function loadNasshMessages(): Promise<void> {
  if (loaded) return;
  try {
    const htermMod = await upstreamImport<HtermModule>('hterm/js/hterm.js');
    await htermMod.hterm.initPromise;
    htermMod.hterm.messageManager.useCrlf = true;
    await htermMod.hterm.messageManager.findAndLoadMessages('/upstream/nassh/_locales/$1/messages.json');
    loaded = true;
    log.ssh.debug('nassh locale messages loaded');
  } catch (error) {
    log.ssh.warn('nassh locale messages unavailable', { error });
  }
}
