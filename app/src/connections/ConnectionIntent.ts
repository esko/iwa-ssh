import type { Profile } from '../settings/types';

export type ConnectionProtocol = 'ssh' | 'mosh' | 'et';

export type ConnectionIntent = {
  protocol: ConnectionProtocol;
  username?: string;
  hostname: string;
  port?: number;
  etPort?: number;
  /** Opaque local ET resume handle; never wire credentials. */
  etSessionId?: string;
  args: string[];
  argstr?: string;
  profileId?: string;
  identityId?: string;
  settingsProfileId?: string;
  startupCommand?: string;
  rawCommand?: string;
};

export type TestConnectionIntent = Omit<ConnectionIntent, 'protocol'> & {
  protocol: 'echo';
  testOnly: true;
};

export type LaunchConnectionIntent = ConnectionIntent | TestConnectionIntent;

export type ResumableEtSession = {
  id: string;
  phase: string;
  username?: string;
  host: string;
  sshPort?: number;
  etPort?: number;
  connectionArgs?: string;
  profileId?: string;
  identityId?: string;
  settingsProfileId?: string;
  startupCommand?: string;
};

const clean = (value: string | undefined): string | undefined => value?.trim() || undefined;

function validPort(value: number | undefined): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0 && value <= 65_535);
}

export function normalizeConnectionIntent<T extends LaunchConnectionIntent>(intent: T): T {
  const protocol = intent.protocol;
  return {
    ...intent,
    username: clean(intent.username),
    hostname: intent.hostname.trim(),
    port: intent.port ?? (protocol === 'ssh' || protocol === 'et' ? 22 : undefined),
    etPort: protocol === 'et' ? intent.etPort ?? 2022 : undefined,
    etSessionId: clean(intent.etSessionId),
    args: [...intent.args],
    argstr: clean(intent.argstr),
    profileId: clean(intent.profileId),
    identityId: clean(intent.identityId),
    settingsProfileId: clean(intent.settingsProfileId),
    startupCommand: clean(intent.startupCommand),
    rawCommand: clean(intent.rawCommand),
  } as T;
}

export function connectionIntentFromProfile(profile: Profile): ConnectionIntent {
  return normalizeConnectionIntent({
    protocol: profile.protocol ?? 'ssh',
    username: profile.username,
    hostname: profile.host,
    port: profile.port,
    etPort: profile.etPort,
    args: [],
    argstr: profile.connectionArgs,
    profileId: profile.id,
    identityId: profile.identityId,
    settingsProfileId: profile.settingsProfileId,
    startupCommand: profile.startupCommand,
  });
}

export function connectionIntentTitle(intent: LaunchConnectionIntent): string {
  return `${intent.protocol} ${formatConnectionTarget(intent)}`;
}

export function formatConnectionTarget(intent: LaunchConnectionIntent): string {
  const user = intent.username ? `${intent.username}@` : '';
  const displayPort = intent.protocol === 'et' ? intent.etPort : intent.port;
  const defaultPort = intent.protocol === 'et' ? 2022 : 22;
  return `${user}${intent.hostname}${displayPort && displayPort !== defaultPort ? `:${displayPort}` : ''}`;
}

export function connectionLayoutKey(intent: LaunchConnectionIntent | null | undefined): string {
  if (!intent) return '';
  const value = normalizeConnectionIntent(intent);
  return JSON.stringify({
    protocol: value.protocol, username: value.username ?? '', hostname: value.hostname,
    port: value.port ?? null, etPort: value.etPort ?? null, argstr: value.argstr ?? '',
    identityId: value.identityId ?? '', settingsProfileId: value.settingsProfileId ?? '',
    startupCommand: value.startupCommand ?? '', etSessionId: value.etSessionId ?? '',
  });
}

export function connectionIntentToQuery(intent: LaunchConnectionIntent): string {
  const value = normalizeConnectionIntent(intent);
  const query = new URLSearchParams({ protocol: value.protocol, host: value.hostname });
  if (value.username) query.set('username', value.username);
  if (value.port) query.set('port', String(value.port));
  if (value.etPort) query.set('etPort', String(value.etPort));
  if (value.etSessionId) query.set('resume', value.etSessionId);
  if (value.argstr) query.set('args', value.argstr);
  if (value.profileId) query.set('profile', value.profileId);
  if (value.identityId) query.set('identity', value.identityId);
  if (value.settingsProfileId) query.set('sp', value.settingsProfileId);
  if (value.startupCommand) query.set('startup', value.startupCommand);
  return query.toString();
}

function parsePort(query: URLSearchParams, name: string): number | undefined | null {
  const raw = query.get(name)?.trim();
  if (!raw) return undefined;
  const port = Number(raw);
  return validPort(port) ? port : null;
}

export function connectionIntentFromQuery(
  query: URLSearchParams,
  options: { allowTestIntent?: boolean } = {},
): LaunchConnectionIntent | null {
  const rawProtocol = query.get('protocol')?.trim().toLowerCase() || 'ssh';
  const hostname = query.get('host')?.trim();
  if (!hostname || /\s|[\u0000-\u001f]/.test(hostname)) return null;
  const port = parsePort(query, 'port');
  const etPort = parsePort(query, 'etPort');
  if (port === null || etPort === null) return null;
  if (rawProtocol === 'echo') {
    if (!(options.allowTestIntent ?? import.meta.env.DEV)) return null;
    return normalizeConnectionIntent({ protocol: 'echo', testOnly: true, hostname, port, args: [] });
  }
  if (rawProtocol !== 'ssh' && rawProtocol !== 'mosh' && rawProtocol !== 'et') return null;
  return normalizeConnectionIntent({
    protocol: rawProtocol,
    username: query.get('username') ?? undefined,
    hostname,
    port,
    etPort,
    etSessionId: query.get('resume') ?? undefined,
    args: [],
    argstr: query.get('args') ?? undefined,
    profileId: query.get('profile') ?? undefined,
    identityId: query.get('identity') ?? undefined,
    settingsProfileId: query.get('sp') ?? undefined,
    startupCommand: query.get('startup') ?? undefined,
  });
}

export function connectionIntentFromEtSession(session: ResumableEtSession): ConnectionIntent | null {
  if (session.phase !== 'active' && session.phase !== 'detached') return null;
  return normalizeConnectionIntent({
    protocol: 'et', username: session.username, hostname: session.host,
    port: session.sshPort, etPort: session.etPort, etSessionId: session.id,
    args: [], argstr: session.connectionArgs, profileId: session.profileId,
    identityId: session.identityId, settingsProfileId: session.settingsProfileId,
    startupCommand: session.startupCommand,
  });
}

export async function resolveConnectionIntent(
  query: URLSearchParams,
  sources: {
    getEtSession(id: string): Promise<ResumableEtSession | undefined>;
    getProfile(id: string): Promise<Profile | undefined>;
    allowTestIntent?: boolean;
  },
): Promise<LaunchConnectionIntent | null> {
  const resume = clean(query.get('resume') ?? undefined);
  if (resume) {
    const session = await sources.getEtSession(resume);
    return session ? connectionIntentFromEtSession(session) : null;
  }
  const profileId = clean(query.get('profile') ?? undefined);
  if (profileId) {
    const profile = await sources.getProfile(profileId);
    if (profile) return connectionIntentFromProfile(profile);
  }
  return connectionIntentFromQuery(query, { allowTestIntent: sources.allowTestIntent });
}
