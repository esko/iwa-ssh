import { DEFAULT_PWA_SETTINGS, SETTINGS_KEY as LEGACY_SETTINGS_KEY, normalizePwaSettings } from './settings';
import type { PwaTerminalSettings } from './types';

/**
 * A settings profile is a named set of terminal settings. Connection profiles
 * reference one by id. There is always a `default`; the picker only appears
 * once a second profile exists.
 */
export type SettingsProfile = {
  id: string;
  name: string;
  settings: PwaTerminalSettings;
};

const STORE_KEY = 'iwa-ssh-settings-profiles';
export const DEFAULT_SETTINGS_PROFILE_ID = 'default';

export function loadSettingsProfiles(): SettingsProfile[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { profiles?: unknown };
      if (Array.isArray(parsed.profiles) && parsed.profiles.length > 0) {
        return parsed.profiles.map(normalizeStored);
      }
    }
  } catch {
    // fall through to migration / default
  }

  // Migrate a pre-existing single settings blob into the default profile.
  let settings = { ...DEFAULT_PWA_SETTINGS };
  try {
    const legacy = localStorage.getItem(LEGACY_SETTINGS_KEY);
    if (legacy) settings = normalizePwaSettings(JSON.parse(legacy));
  } catch {
    // ignore malformed legacy settings
  }
  const seeded: SettingsProfile[] = [{ id: DEFAULT_SETTINGS_PROFILE_ID, name: 'default', settings }];
  saveSettingsProfiles(seeded);
  return seeded;
}

export function saveSettingsProfiles(profiles: SettingsProfile[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify({ profiles }));
}

export function getSettingsProfile(id?: string): SettingsProfile {
  const profiles = loadSettingsProfiles();
  return profiles.find((profile) => profile.id === id) ?? profiles[0];
}

/** Resolve the terminal settings a connection should run with. */
export function resolveSettings(settingsProfileId?: string): PwaTerminalSettings {
  return getSettingsProfile(settingsProfileId).settings;
}

export function upsertSettingsProfile(profile: SettingsProfile): void {
  const profiles = loadSettingsProfiles();
  const index = profiles.findIndex((item) => item.id === profile.id);
  if (index >= 0) profiles[index] = profile;
  else profiles.push(profile);
  saveSettingsProfiles(profiles);
}

export function renameSettingsProfile(id: string, name: string): void {
  const profile = loadSettingsProfiles().find((item) => item.id === id);
  if (!profile) return;
  const next = name.trim();
  if (next) upsertSettingsProfile({ ...profile, name: next });
}

/** Delete a settings profile. The default is protected; connections that
 * referenced a deleted profile resolve back to the default. */
export function deleteSettingsProfile(id: string): void {
  if (id === DEFAULT_SETTINGS_PROFILE_ID) return;
  const remaining = loadSettingsProfiles().filter((item) => item.id !== id);
  if (remaining.length > 0) saveSettingsProfiles(remaining);
}

export function createSettingsProfile(name: string): SettingsProfile {
  const profile: SettingsProfile = {
    id: crypto.randomUUID(),
    name: name.trim() || 'settings',
    settings: { ...DEFAULT_PWA_SETTINGS },
  };
  upsertSettingsProfile(profile);
  return profile;
}

function normalizeStored(raw: unknown): SettingsProfile {
  const value = (raw ?? {}) as Record<string, unknown>;
  return {
    id: typeof value.id === 'string' && value.id ? value.id : crypto.randomUUID(),
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'default',
    settings: normalizePwaSettings((value.settings as Record<string, unknown>) ?? {}),
  };
}
