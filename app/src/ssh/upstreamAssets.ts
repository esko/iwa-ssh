/**
 * Runtime helpers for Phase 1 upstream assets under /upstream (app/upstream/).
 */

const UPSTREAM_BASE =
  typeof __IWA_UPSTREAM_BASE__ !== 'undefined' ? __IWA_UPSTREAM_BASE__ : '/upstream';

const WASSH_WORKER_URL =
  typeof __IWA_WASSH_WORKER_URL__ !== 'undefined'
    ? __IWA_WASSH_WORKER_URL__
    : `${UPSTREAM_BASE}/wassh/js/worker.js`;

const PLUGIN_BASE =
  typeof __IWA_PLUGIN_BASE__ !== 'undefined' ? __IWA_PLUGIN_BASE__ : `${UPSTREAM_BASE}/plugin`;

/** Minimum files required before NasshCommandBridge can load CommandInstance. */
export const REQUIRED_UPSTREAM_ASSET_PATHS = [
  `${UPSTREAM_BASE}/manifest.json`,
  WASSH_WORKER_URL,
  `${PLUGIN_BASE}/wasm/ssh.wasm`,
  `${UPSTREAM_BASE}/nassh/js/nassh_command_instance.js`,
  `${UPSTREAM_BASE}/libdot/index.js`,
  `${UPSTREAM_BASE}/hterm/index.js`,
] as const;

export const MOSH_UPSTREAM_ASSET_PATHS = [
  `${PLUGIN_BASE}/wasm/mosh-client.wasm`,
] as const;

/** Public URL base for copied libapps assets (e.g. `/upstream`). */
export function getPluginBase(): string {
  return PLUGIN_BASE;
}

/** Module worker entry for wassh WASM runtime. */
export function getWasshWorkerUrl(): string {
  return WASSH_WORKER_URL;
}

async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

/** True when wassh worker, plugin WASM, and nassh bridge modules are all present. */
export async function areUpstreamAssetsReady(): Promise<boolean> {
  const checks = await checkUpstreamAssets();
  return checks.every((entry) => entry.ok);
}

export async function checkUpstreamAssets(): Promise<Array<{ path: string; ok: boolean }>> {
  return Promise.all(
    REQUIRED_UPSTREAM_ASSET_PATHS.map(async (path) => ({
      path,
      ok: await assetExists(path),
    })),
  );
}

export async function checkMoshAssets(): Promise<Array<{ path: string; ok: boolean }>> {
  return Promise.all(
    MOSH_UPSTREAM_ASSET_PATHS.map(async (path) => ({
      path,
      ok: await assetExists(path),
    })),
  );
}

export async function areMoshAssetsReady(): Promise<boolean> {
  const checks = await checkMoshAssets();
  return checks.every((entry) => entry.ok);
}
