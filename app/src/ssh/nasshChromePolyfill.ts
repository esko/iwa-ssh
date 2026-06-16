/**
 * Minimal chrome.* stubs so upstream CommandInstance can run in an IWA
 * without extension APIs. Direct Sockets is used when chrome.sockets is absent.
 */

type ChromeWindowsStub = {
  getCurrent: (callback: (win: { id: number; state: string }) => void) => void;
};

type ChromeTabsStub = {
  getCurrent: (callback: (tab: { id: number }) => void) => void;
  get: (id: number, callback: (tab: { id: number } | undefined) => void) => void;
};

type ChromeRuntimeStub = {
  getManifest?: () => { name: string; version: string; icons?: Record<string, string> };
  sendMessage?: (...args: unknown[]) => Promise<Record<string, never>> | void;
  getURL?: (path: string) => string;
  connect?: () => never;
};

type ChromeStub = {
  windows?: ChromeWindowsStub;
  tabs?: ChromeTabsStub;
  runtime?: ChromeRuntimeStub;
  sockets?: Record<string, unknown>;
};

declare global {
  interface Window {
    chrome?: ChromeStub;
  }
}

let installed = false;

/** Install no-op chrome stubs required by nassh CommandInstance lifecycle code. */
export function installNasshChromePolyfill(): void {
  if (installed) return;
  installed = true;

  const chromeRef: ChromeStub = (window.chrome ??= {});

  if (!chromeRef.windows?.getCurrent) {
    chromeRef.windows = {
      getCurrent: (callback: (win: { id: number; state: string }) => void) => {
        callback({ id: 0, state: 'normal' });
      },
    };
  }

  // wassh's cleanupChromeSockets() calls chrome.tabs.getCurrent unconditionally on
  // terminate (before its chrome.sockets isSupported guards), so disconnect crashes
  // in an IWA without this stub. We never use chrome.sockets (Direct Sockets only),
  // so the cleanup itself is a no-op once past getCurrent.
  if (!chromeRef.tabs?.getCurrent) {
    chromeRef.tabs = {
      getCurrent: (callback: (tab: { id: number }) => void) => {
        callback({ id: 0 });
      },
      get: (_id: number, callback: (tab: { id: number } | undefined) => void) => {
        callback(undefined);
      },
    };
  }

  chromeRef.runtime ??= {};
  if (!chromeRef.runtime.sendMessage) {
    chromeRef.runtime.sendMessage = (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        setTimeout(() => callback({}), 0);
        return;
      }
      return Promise.resolve({});
    };
  }

  if (!chromeRef.runtime.getURL) {
    chromeRef.runtime.getURL = (path: string) => {
      if (path.startsWith('/')) {
        return `${globalThis.location.origin}${path}`;
      }
      return path;
    };
  }

  if (!chromeRef.runtime.connect) {
    chromeRef.runtime.connect = () => {
      throw new Error('chrome.runtime.connect is unavailable in IWA mode');
    };
  }

  // Leave chrome.sockets unset so wassh uses Direct Sockets (WebTcpSocket).
  delete chromeRef.sockets;
}
