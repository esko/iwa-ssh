import { areUpstreamAssetsReady } from '../ssh/upstreamAssets';

export type ReadinessDiagnostics = {
  crossOriginIsolated: boolean;
  directSockets: boolean;
  directSocketsPrivate: boolean;
  upstreamAssets: boolean;
  launchQueue: boolean;
  tabbedDisplayMode: boolean;
};

export async function readDiagnostics(): Promise<ReadinessDiagnostics> {
  const global = globalThis as typeof globalThis & {
    TCPSocket?: unknown;
    TCPServerSocket?: unknown;
    UDPSocket?: unknown;
    launchQueue?: unknown;
  };
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    directSockets: typeof global.TCPSocket === 'function',
    directSocketsPrivate: typeof global.TCPServerSocket === 'function' || typeof global.UDPSocket === 'function',
    upstreamAssets: await areUpstreamAssetsReady(),
    launchQueue: Boolean(global.launchQueue),
    tabbedDisplayMode:
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: tabbed)').matches
        : false,
  };
}
