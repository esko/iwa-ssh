import type { Profile } from '../settings/types';

export type TerminalProtocol = 'ssh' | 'mosh' | 'et';

export type TerminalConnectionSpec = {
  protocol: TerminalProtocol;
  username?: string;
  hostname: string;
  port?: number;
  etPort?: number;
  args: string[];
  argstr?: string;
  profileId?: string;
  identityId?: string;
  startupCommand?: string;
  rawCommand?: string;
};

export function profileToConnectionSpec(profile: Profile): TerminalConnectionSpec {
  return {
    protocol: profile.protocol ?? 'ssh',
    username: profile.username,
    hostname: profile.host,
    port: profile.port,
    ...(profile.protocol === 'et' ? { etPort: profile.etPort ?? 2022 } : {}),
    args: [],
    argstr: profile.connectionArgs,
    profileId: profile.id,
    identityId: profile.identityId,
    startupCommand: profile.startupCommand,
  };
}

export function connectionSpecToSessionTitle(spec: TerminalConnectionSpec): string {
  const user = spec.username ? `${spec.username}@` : '';
  const port = spec.port && spec.port !== 22 ? `:${spec.port}` : '';
  return `${spec.protocol} ${user}${spec.hostname}${port}`;
}

export function normalizeConnectionSpec(spec: TerminalConnectionSpec): TerminalConnectionSpec {
  return {
    ...spec,
    protocol: spec.protocol,
    username: spec.username?.trim() || undefined,
    hostname: spec.hostname.trim(),
    port: spec.port ?? (spec.protocol === 'ssh' || spec.protocol === 'et' ? 22 : undefined),
    ...(spec.protocol === 'et' ? { etPort: spec.etPort ?? 2022 } : {}),
    args: [...spec.args],
    argstr: spec.argstr?.trim() || undefined,
    profileId: spec.profileId?.trim() || undefined,
    identityId: spec.identityId?.trim() || undefined,
    startupCommand: spec.startupCommand?.trim() || undefined,
    rawCommand: spec.rawCommand?.trim() || undefined,
  };
}
