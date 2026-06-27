/**
 * Per-host session liveness, shared across windows via localStorage.
 *
 * Persistent transports (ET, Mosh) write a heartbeat for their host key every
 * {@link HEARTBEAT_INTERVAL_MS} while connected; the launcher reads the registry
 * and shows a host as live only when its heartbeat is fresher than
 * {@link FRESHNESS_MS}. Freshness is the backstop against stale state: a window
 * that closes uncleanly (no clear) simply stops heartbeating, so the entry ages
 * out instead of lingering "connected" forever.
 *
 * localStorage (not IndexedDB) is deliberate — it is synchronous, shared across
 * same-origin tabs/windows, and emits `storage` events so a launcher in another
 * window can refresh its dots the instant a connection appears or drops.
 */

export const LIVENESS_STORAGE_KEY = 'iwa-ssh:session-liveness';
/** How often a live transport refreshes its heartbeat. */
export const HEARTBEAT_INTERVAL_MS = 8_000;
/** A heartbeat older than this is treated as dead (covers unclean window close). */
export const FRESHNESS_MS = 20_000;
/** Entries older than this are pruned on write so the map can't grow unbounded. */
const PRUNE_MS = 5 * 60_000;

type LivenessEntry = { protocol: string; lastHeartbeatAt: number };
type LivenessMap = Record<string, LivenessEntry>;

function read(): LivenessMap {
  try {
    const raw = globalThis.localStorage?.getItem(LIVENESS_STORAGE_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : null;
    return parsed && typeof parsed === 'object' ? (parsed as LivenessMap) : {};
  } catch {
    return {};
  }
}

function write(map: LivenessMap): void {
  try {
    globalThis.localStorage?.setItem(LIVENESS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Private mode / quota — liveness is best-effort, never block a connection.
  }
}

/** Drop entries no transport has refreshed in a long while. */
function prune(map: LivenessMap, now: number): LivenessMap {
  for (const [key, entry] of Object.entries(map)) {
    if (now - entry.lastHeartbeatAt > PRUNE_MS) delete map[key];
  }
  return map;
}

/** Record/refresh the heartbeat for a host key (called on an interval while live). */
export function recordHeartbeat(key: string, protocol: string, now = Date.now()): void {
  const map = prune(read(), now);
  map[key] = { protocol, lastHeartbeatAt: now };
  write(map);
}

/** Remove a host key's heartbeat (called on clean disconnect/dispose). */
export function clearHeartbeat(key: string): void {
  const map = read();
  if (key in map) {
    delete map[key];
    write(map);
  }
}

/** True when the host key has a heartbeat fresher than {@link FRESHNESS_MS}. */
export function isHostLive(key: string, now = Date.now()): boolean {
  const entry = read()[key];
  return !!entry && now - entry.lastHeartbeatAt < FRESHNESS_MS;
}

/** The set of host keys currently considered live (fresh heartbeat). */
export function liveHostKeys(now = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const [key, entry] of Object.entries(read())) {
    if (now - entry.lastHeartbeatAt < FRESHNESS_MS) out.add(key);
  }
  return out;
}
