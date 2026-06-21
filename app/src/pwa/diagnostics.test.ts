import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDiagnostics, resetDiagnosticsAssetCache } from './diagnostics';

/**
 * Exercises the Mosh-related fields of the platform diagnostic path across the
 * disabled / unavailable / ready states. `readDiagnostics` probes asset URLs via
 * `fetch(HEAD)` and reads capability globals, so we stub both.
 */

const originalFetch = globalThis.fetch;

function stubAssets(present: Set<string>): void {
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    expect(init?.method).toBe('HEAD');
    return { ok: present.has(String(url)) } as Response;
  });
}

afterEach(() => {
  resetDiagnosticsAssetCache();
  vi.unstubAllGlobals();
  globalThis.fetch = originalFetch;
});

describe('readDiagnostics — Mosh capability', () => {
  it('reports UDP and mosh-client unavailable when neither is present', async () => {
    vi.stubGlobal('window', {}); // no UDPSocket
    stubAssets(new Set()); // nothing fetchable

    const diag = await readDiagnostics();
    expect(diag.udp).toBe(false);
    expect(diag.moshAssets).toBe(false);
    expect(diag.moshReady).toBe(false);
  });

  it('stays not-ready when UDP exists but mosh-client.wasm is missing', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('UDPSocket', function UDPSocket() {});
    stubAssets(new Set()); // mosh-client.wasm absent

    const diag = await readDiagnostics();
    expect(diag.udp).toBe(true);
    expect(diag.directSocketsPrivate).toBe(true);
    expect(diag.moshAssets).toBe(false);
    expect(diag.moshReady).toBe(false);
  });

  it('reports ready only when both UDP and mosh-client.wasm are present', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('UDPSocket', function UDPSocket() {});
    stubAssets(new Set(['/upstream/plugin/wasm/mosh-client.wasm']));

    const diag = await readDiagnostics();
    expect(diag.udp).toBe(true);
    expect(diag.moshAssets).toBe(true);
    expect(diag.moshReady).toBe(true);
  });

  it('memoizes asset probes for the page lifetime', async () => {
    vi.stubGlobal('window', {});
    const fetch = vi.fn(async () => ({ ok: true }) as Response);
    vi.stubGlobal('fetch', fetch);

    await readDiagnostics();
    const firstProbeCount = fetch.mock.calls.length;
    await readDiagnostics();

    expect(firstProbeCount).toBeGreaterThan(0);
    expect(fetch).toHaveBeenCalledTimes(firstProbeCount);
  });
});
