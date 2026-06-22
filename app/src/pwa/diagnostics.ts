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
};

let assetReadinessPromise: Promise<{ upstreamAssets: boolean; moshAssets: boolean }> | null = null;

function readAssetReadiness(): Promise<{ upstreamAssets: boolean; moshAssets: boolean }> {
  assetReadinessPromise ??= Promise.all([areUpstreamAssetsReady(), areMoshAssetsReady()]).then(
    ([upstreamAssets, moshAssets]) => ({ upstreamAssets, moshAssets }),
  );
  return assetReadinessPromise;
}

/** Test/dev hook for a page whose asset tree is intentionally replaced in place. */
export function resetDiagnosticsAssetCache(): void {
  assetReadinessPromise = null;
}

export async function readDiagnostics(): Promise<ReadinessDiagnostics> {
  const global = globalThis as typeof globalThis & {
    TCPSocket?: unknown;
    TCPServerSocket?: unknown;
    UDPSocket?: unknown;
    launchQueue?: unknown;
  };
  const udp = typeof global.UDPSocket === 'function';
  const { upstreamAssets, moshAssets } = await readAssetReadiness();
  return {
    crossOriginIsolated: globalThis.crossOriginIsolated,
    directSockets: typeof global.TCPSocket === 'function',
    directSocketsPrivate: typeof global.TCPServerSocket === 'function' || udp,
    udp,
    upstreamAssets,
    moshAssets,
    moshReady: udp && moshAssets,
    launchQueue: Boolean(global.launchQueue),
  };
}
