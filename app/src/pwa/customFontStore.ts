/**
 * Local store for user-provided terminal fonts (uploaded files or fonts
 * downloaded from a URL). Bytes live in IndexedDB; restty consumes them as a
 * `buffer` font source, so nothing here depends on `@font-face` / `font-src`.
 */
import { openDB, type IDBPDatabase } from 'idb';

export type CustomFontMeta = {
  id: string;
  name: string;
  /** restty/CSS format hint: 'truetype' | 'opentype' | 'woff' | 'woff2'. */
  format: string;
  byteLength: number;
  source: 'upload' | 'url';
  createdAt: number;
};

type CustomFontRecord = CustomFontMeta & { data: ArrayBuffer };

const DB_NAME = 'iwa-ssh-fonts';
const DB_VERSION = 1;
const STORE = 'fonts';
/** Reject absurdly large uploads early (10 MB is generous for a single face). */
const MAX_FONT_BYTES = 10 * 1024 * 1024;

let dbPromise: Promise<IDBPDatabase> | null = null;
function getDb(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

function stripMeta(record: CustomFontRecord): CustomFontMeta {
  const { data: _data, ...meta } = record;
  return meta;
}

export async function listCustomFonts(): Promise<CustomFontMeta[]> {
  const db = await getDb();
  const all = (await db.getAll(STORE)) as CustomFontRecord[];
  return all.map(stripMeta).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getCustomFontData(id: string): Promise<ArrayBuffer | undefined> {
  const db = await getDb();
  const record = (await db.get(STORE, id)) as CustomFontRecord | undefined;
  return record?.data;
}

export async function deleteCustomFont(id: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, id);
}

function fontFormat(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  if (ext === 'woff2') return 'woff2';
  if (ext === 'woff') return 'woff';
  if (ext === 'otf') return 'opentype';
  return 'truetype';
}

/** Sniff the sfnt/woff magic so we reject non-font uploads with a clear error. */
function looksLikeFont(data: ArrayBuffer): boolean {
  if (data.byteLength < 4) return false;
  const tag = new Uint8Array(data, 0, 4);
  const ascii = String.fromCharCode(...tag);
  // OpenType ('OTTO'), TrueType (0x00010000), 'true'/'ttcf', or WOFF/WOFF2.
  if (ascii === 'OTTO' || ascii === 'true' || ascii === 'ttcf' || ascii === 'wOFF' || ascii === 'wOF2') return true;
  return tag[0] === 0x00 && tag[1] === 0x01 && tag[2] === 0x00 && tag[3] === 0x00;
}

function cleanName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? raw;
  return base.replace(/\.(ttf|otf|woff2?|TTF|OTF|WOFF2?)$/i, '').trim().slice(0, 80) || 'Custom font';
}

async function store(name: string, format: string, source: CustomFontMeta['source'], data: ArrayBuffer): Promise<CustomFontMeta> {
  if (data.byteLength === 0) throw new Error('Font file is empty.');
  if (data.byteLength > MAX_FONT_BYTES) throw new Error('Font is too large (max 10 MB).');
  if (!looksLikeFont(data)) throw new Error('That file does not look like a font (.ttf/.otf/.woff/.woff2).');
  const id = crypto.randomUUID?.() ?? `f-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const meta: CustomFontMeta = { id, name: cleanName(name), format, byteLength: data.byteLength, source, createdAt: Date.now() };
  const db = await getDb();
  await db.put(STORE, { ...meta, data } satisfies CustomFontRecord);
  return meta;
}

export async function addCustomFontFromFile(file: File): Promise<CustomFontMeta> {
  const data = await file.arrayBuffer();
  return store(file.name, fontFormat(file.name), 'upload', data);
}

export async function addCustomFontFromUrl(url: string): Promise<CustomFontMeta> {
  let parsed: URL;
  try {
    parsed = new URL(url, window.location.href);
  } catch {
    throw new Error('Enter a valid font URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Font URL must be http(s).');
  }
  // Fetch goes through CSP connect-src (which allows https:), not font-src.
  const response = await fetch(parsed.href);
  if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
  const data = await response.arrayBuffer();
  return store(parsed.pathname, fontFormat(parsed.pathname), 'url', data);
}
