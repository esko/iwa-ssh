import type { Identity, Profile } from '../settings/types';
import { profileToConnectionSpec, type TerminalConnectionSpec, type TerminalProtocol } from '../connections/TerminalConnectionSpec';

export type SshMoshDialogModel = {
  protocol: TerminalProtocol;
  host: string;
  port: number;
  username: string;
  identityId?: string;
  startupCommand: string;
  saveProfile: boolean;
  profileName: string;
  identities: Identity[];
  profile?: Profile;
};

export function createSshMoshDialogModel(profile: Profile | undefined, identities: Identity[]): SshMoshDialogModel {
  return {
    protocol: profile?.protocol ?? 'ssh',
    host: profile?.host ?? '',
    port: profile?.port ?? 22,
    username: profile?.username ?? '',
    identityId: profile?.identityId,
    startupCommand: profile?.startupCommand ?? '',
    saveProfile: Boolean(profile),
    profileName: profile?.name ?? '',
    identities,
    profile,
  };
}

export function dialogModelToConnectionSpec(model: SshMoshDialogModel): TerminalConnectionSpec {
  if (model.profile) {
    return profileToConnectionSpec(model.profile);
  }

  return {
    protocol: model.protocol,
    username: model.username,
    hostname: model.host,
    port: model.port,
    args: [],
    identityId: model.identityId,
    startupCommand: model.startupCommand || undefined,
  };
}
