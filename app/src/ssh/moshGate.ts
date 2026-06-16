import { areMoshAssetsReady } from './upstreamAssets';

export type MoshGateResult =
  | { ok: true }
  | { ok: false; reason: 'missing-udp'; message: string }
  | { ok: false; reason: 'missing-mosh-wasm'; message: string };

export async function checkMoshPrerequisites(): Promise<MoshGateResult> {
  if (typeof (window as Window & { UDPSocket?: unknown }).UDPSocket !== 'function') {
    return {
      ok: false,
      reason: 'missing-udp',
      message: 'Mosh requires UDPSocket. Install as an IWA with Direct Sockets UDP support.',
    };
  }

  if (!(await areMoshAssetsReady())) {
    return {
      ok: false,
      reason: 'missing-mosh-wasm',
      message: 'Mosh requires /upstream/plugin/wasm/mosh-client.wasm. Run npm run fetch-assets.',
    };
  }

  return { ok: true };
}
