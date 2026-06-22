import { getProfile, saveProfile } from '../storage/indexedDb';
import type { ConnectionIntent, LaunchConnectionIntent } from '../connections/ConnectionIntent';
import {
  connectionIntentFromProfile as profileToSpec,
  connectionIntentFromQuery as specFromQuery,
  connectionIntentToQuery as specToQuery,
  connectionIntentTitle as specTitle,
  connectionLayoutKey as layoutSpecKey,
  formatConnectionTarget,
} from '../connections/ConnectionIntent';
import type { RecentConnection } from './types';

export { profileToSpec, specFromQuery, specToQuery, specTitle, layoutSpecKey, formatConnectionTarget };

const RECENTS_KEY = 'iwa-ssh-legacy-pwa-recents';

export function loadRecentConnections(): RecentConnection[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]');
    return Array.isArray(value)
      ? (value as RecentConnection[])
          .filter((item) => item.hostname && (item as { protocol?: string }).protocol !== 'echo')
          .slice(0, 12)
      : [];
  } catch {
    return [];
  }
}

/** Test intents are deliberately excluded from recents and profile activity. */
export async function recordConnection(intent: LaunchConnectionIntent): Promise<void> {
  if (intent.protocol === 'echo') return;
  const now = Date.now();
  const recent: RecentConnection = { ...intent, title: specTitle(intent), connectedAt: now };
  const next = [recent, ...loadRecentConnections().filter((item) => connectionKey(item) !== connectionKey(intent))].slice(0, 12);
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  if (intent.profileId) await saveProfileLastConnected(intent.profileId, now);
}

async function saveProfileLastConnected(profileId: string, lastConnectedAt: number): Promise<void> {
  const profile = await getProfile(profileId);
  if (profile) await saveProfile({ ...profile, lastConnectedAt });
}

function connectionKey(intent: Pick<ConnectionIntent, 'protocol' | 'username' | 'hostname' | 'port' | 'etPort'>): string {
  return `${intent.protocol}:${intent.username ?? ''}@${intent.hostname}:${intent.port ?? ''}:${intent.etPort ?? ''}`;
}
