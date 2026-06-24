/**
 * OpenSSH known_hosts line parsing and SHA256 fingerprint helpers.
 */

export type KnownHostMarker = { host: string; port: number };

export type ParsedKnownHostLine = {
  markers: KnownHostMarker[];
  keyType: string;
  base64Key: string;
  opensshLine: string;
};

/** Bracketed `[host]:port` when port ≠ 22, else plain hostname. */
export function formatKnownHostTarget(host: string, port: number): string {
  return port === 22 ? host : `[${host}]:${port}`;
}

function hostPortFromTarget(target: string): KnownHostMarker {
  const bracketed = target.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracketed) {
    return { host: bracketed[1]!, port: Number(bracketed[2]) };
  }
  return { host: target, port: 22 };
}

/** Split the first known_hosts field into host:port markers (comma-separated aliases). */
export function parseKnownHostMarkers(markersField: string): KnownHostMarker[] {
  return markersField
    .split(',')
    .map((part) => hostPortFromTarget(part.trim()))
    .filter((marker) => marker.host.length > 0);
}

/**
 * Parse a single non-comment, non-hashed known_hosts line.
 * Skips `#` comments and `|1|…` hashed-host lines (OpenSSH markers).
 */
export function parseKnownHostsLine(line: string): ParsedKnownHostLine | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('|')) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length < 3) return null;

  const [markersField, keyType, base64Key] = parts;
  if (!markersField || !keyType || !base64Key) return null;

  const markers = parseKnownHostMarkers(markersField);
  if (markers.length === 0) return null;

  return { markers, keyType, base64Key, opensshLine: trimmed };
}

/** True when any marker on the line matches host and port exactly. */
export function knownHostLineMatchesTarget(
  line: ParsedKnownHostLine,
  host: string,
  port: number,
): boolean {
  return line.markers.some((marker) => marker.host === host && marker.port === port);
}

/** OpenSSH SHA256 fingerprint (`SHA256:…`, no padding). */
export async function fingerprintFromBase64Key(base64Key: string): Promise<string> {
  const binary = atob(base64Key);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/=+$/, '');
  return `SHA256:${b64}`;
}

export async function fingerprintFromOpensshLine(line: string): Promise<string | null> {
  const parsed = parseKnownHostsLine(line);
  if (!parsed) return null;
  return fingerprintFromBase64Key(parsed.base64Key);
}

/** Lines in known_hosts that apply to host:port (exact host+port per marker). */
export function knownHostLinesForTarget(
  fileText: string,
  host: string,
  port: number,
): ParsedKnownHostLine[] {
  const results: ParsedKnownHostLine[] = [];

  for (const line of fileText.split(/\r?\n/)) {
    const parsed = parseKnownHostsLine(line);
    if (!parsed) continue;
    if (knownHostLineMatchesTarget(parsed, host, port)) {
      results.push(parsed);
    }
  }

  return results;
}

/**
 * Resolve known_hosts lines to sync for a profile target. OpenSSH may record a
 * resolved IP (192.168.1.60) while the profile uses a hostname (mini.local).
 */
export function knownHostLinesForSync(
  fileText: string,
  host: string,
  port: number,
): ParsedKnownHostLine[] {
  const exact = knownHostLinesForTarget(fileText, host, port);
  if (exact.length > 0) return exact;
  const all = fileText
    .split(/\r?\n/)
    .map((line) => parseKnownHostsLine(line))
    .filter((line): line is ParsedKnownHostLine => line !== null);
  return all.length === 1 ? all : [];
}
