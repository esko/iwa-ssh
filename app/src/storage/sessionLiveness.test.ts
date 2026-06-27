import { afterEach, describe, expect, it } from 'vitest';
import {
  FRESHNESS_MS,
  LIVENESS_STORAGE_KEY,
  clearHeartbeat,
  isHostLive,
  liveHostKeys,
  recordHeartbeat,
} from './sessionLiveness';

// A tiny synchronous localStorage stand-in for the jsdom-free test env.
class MemoryStorage {
  private store = new Map<string, string>();
  getItem(k: string): string | null { return this.store.has(k) ? this.store.get(k)! : null; }
  setItem(k: string, v: string): void { this.store.set(k, String(v)); }
  removeItem(k: string): void { this.store.delete(k); }
  clear(): void { this.store.clear(); }
}

(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage();

afterEach(() => globalThis.localStorage.clear());

describe('sessionLiveness', () => {
  it('marks a host live within the freshness window and dead after it', () => {
    const t0 = 1_000_000;
    recordHeartbeat('et:esko@mini:22:2022', 'et', t0);
    expect(isHostLive('et:esko@mini:22:2022', t0 + 1_000)).toBe(true);
    expect(isHostLive('et:esko@mini:22:2022', t0 + FRESHNESS_MS - 1)).toBe(true);
    expect(isHostLive('et:esko@mini:22:2022', t0 + FRESHNESS_MS + 1)).toBe(false);
  });

  it('reports only fresh keys from liveHostKeys', () => {
    const t0 = 2_000_000;
    recordHeartbeat('et:a@h:22:2022', 'et', t0);
    recordHeartbeat('mosh:b@h:22:', 'mosh', t0 + FRESHNESS_MS); // refreshes "now"
    const live = liveHostKeys(t0 + FRESHNESS_MS + 1);
    expect(live.has('mosh:b@h:22:')).toBe(true);
    expect(live.has('et:a@h:22:2022')).toBe(false); // aged out
  });

  it('clears a heartbeat immediately on clean disconnect', () => {
    const t0 = 3_000_000;
    recordHeartbeat('et:c@h:22:2022', 'et', t0);
    expect(isHostLive('et:c@h:22:2022', t0)).toBe(true);
    clearHeartbeat('et:c@h:22:2022');
    expect(isHostLive('et:c@h:22:2022', t0)).toBe(false);
  });

  it('survives corrupt storage without throwing', () => {
    globalThis.localStorage.setItem(LIVENESS_STORAGE_KEY, '{not json');
    expect(() => liveHostKeys()).not.toThrow();
    expect(isHostLive('whatever')).toBe(false);
    recordHeartbeat('et:d@h:22:2022', 'et');
    expect(isHostLive('et:d@h:22:2022')).toBe(true);
  });
});
