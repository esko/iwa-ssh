/**
 * Minimal chrome.* stubs so upstream CommandInstance can run in an IWA
 * without extension APIs. Direct Sockets is used when chrome.sockets is absent.
 */

type ChromeWindowsStub = {
  getCurrent: (callback: (win: { id: number; state: string }) => void) => void;
};

type ChromeRuntimeStub = {
  getManifest?: () => { name: string; version: string; icons?: Record<string, string> };
  sendMessage?: (...args: unknown[]) => void;
  getURL?: (path: string) => string;
  connect?: () => never;
};

type ChromeStub = {
  windows?: ChromeWindowsStub;
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

  chromeRef.runtime ??= {};
  if (!chromeRef.runtime.sendMessage) {
    chromeRef.runtime.sendMessage = (...args: unknown[]) => {
      const callback = args.at(-1);
      if (typeof callback === 'function') {
        setTimeout(() => callback({}), 0);
      }
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
