import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AppSettings, Identity, KnownHost, Profile } from '../settings/types';
import { DEFAULT_SETTINGS } from '../settings/defaults';

interface IwaSshDb extends DBSchema {
  settings: {
    key: 'app';
    value: AppSettings;
  };
  profiles: {
    key: string;
    value: Profile;
    indexes: { 'by-last-connected': number };
  };
  identities: {
    key: string;
    value: Identity;
  };
  knownHosts: {
    key: string;
    value: KnownHost;
  };
}

const DB_NAME = 'iwa-ssh';
const DB_VERSION = 1;

let dbPromise: Promise<IDBPDatabase<IwaSshDb>> | null = null;

function getDb(): Promise<IDBPDatabase<IwaSshDb>> {
  if (!dbPromise) {
    dbPromise = openDB<IwaSshDb>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore('settings');
        const profiles = db.createObjectStore('profiles', { keyPath: 'id' });
        profiles.createIndex('by-last-connected', 'lastConnectedAt');
        db.createObjectStore('identities', { keyPath: 'id' });
        db.createObjectStore('knownHosts');
      },
    });
  }
  return dbPromise;
}

export async function loadSettings(): Promise<AppSettings> {
  const db = await getDb();
  const stored = await db.get('settings', 'app');
  return stored ?? structuredClone(DEFAULT_SETTINGS);
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const db = await getDb();
  await db.put('settings', settings, 'app');
}

export async function listProfiles(): Promise<Profile[]> {
  const db = await getDb();
  const profiles = await db.getAllFromIndex('profiles', 'by-last-connected');
  return profiles.reverse();
}

export async function getProfile(id: string): Promise<Profile | undefined> {
  const db = await getDb();
  return db.get('profiles', id);
}

export async function saveProfile(profile: Profile): Promise<void> {
  const db = await getDb();
  await db.put('profiles', profile);
}

export async function deleteProfile(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('profiles', id);
}

export async function listIdentities(): Promise<Identity[]> {
  const db = await getDb();
  const raw = await db.getAll('identities');
  return raw.map(normalizeIdentity);
}

function normalizeIdentity(raw: Identity & { encryptedPrivateKey?: ArrayBuffer }): Identity {
  if (raw.privateKeyPemBytesDevOnly) {
    return raw;
  }
  if (raw.encryptedPrivateKey) {
    const { encryptedPrivateKey, ...rest } = raw;
    return { ...rest, privateKeyPemBytesDevOnly: encryptedPrivateKey };
  }
  return raw;
}

export async function getIdentity(id: string): Promise<Identity | undefined> {
  const db = await getDb();
  const raw = await db.get('identities', id);
  return raw ? normalizeIdentity(raw) : undefined;
}

export async function saveIdentity(identity: Identity): Promise<void> {
  const db = await getDb();
  await db.put('identities', identity);
}

export async function deleteIdentity(id: string): Promise<void> {
  const db = await getDb();
  await db.delete('identities', id);
}

export function knownHostKey(host: string, port: number): string {
  return `${host}:${port}`;
}

export async function getKnownHost(host: string, port: number): Promise<KnownHost | undefined> {
  const db = await getDb();
  return db.get('knownHosts', knownHostKey(host, port));
}

export async function saveKnownHost(entry: KnownHost): Promise<void> {
  const db = await getDb();
  await db.put('knownHosts', entry, knownHostKey(entry.host, entry.port));
}

export async function listKnownHosts(): Promise<KnownHost[]> {
  const db = await getDb();
  return db.getAll('knownHosts');
}

export async function exportData(): Promise<string> {
  const [settings, profiles, identities, knownHosts] = await Promise.all([
    loadSettings(),
    listProfiles(),
    listIdentities(),
    listKnownHosts(),
  ]);

  return JSON.stringify(
    {
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      profiles,
      identities: identities.map(({ privateKeyPemBytesDevOnly, ...rest }) => ({
        ...rest,
        hasPrivateKeyDevOnly: Boolean(privateKeyPemBytesDevOnly),
      })),
      knownHosts,
    },
    null,
    2,
  );
}
