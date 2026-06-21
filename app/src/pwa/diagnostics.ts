import { areMoshAssetsReady, areUpstreamAssetsReady } from '../ssh/upstreamAssets';

export type ReadinessDiagnostics = {
  crossOriginIsolated: boolean;
  directSockets: boolean;
  directSocketsPrivate: boolean;
  /** UDPSocket (Direct Sockets UDP) — the transport Mosh requires. */
  udp: boolean;
  upstreamAssets: boolean;
  /** mosh-client.wasm is present alongside the upstream nassh/wassh assets. */
  moshAssets: boolean;
  /** Both the UDP transport and mosh-client.wasm are available. */
  moshReady: boolean;
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
  const udp = typeof global.UDPSocket === 'function';
  const moshAssets = await areMoshAssetsReady();
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    directSockets: typeof global.TCPSocket === 'function',
    directSocketsPrivate: typeof global.TCPServerSocket === 'function' || udp,
    udp,
    upstreamAssets: await areUpstreamAssetsReady(),
    moshAssets,
    moshReady: udp && moshAssets,
    launchQueue: Boolean(global.launchQueue),
    tabbedDisplayMode:
      typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: tabbed)').matches
        : false,
  };
}
