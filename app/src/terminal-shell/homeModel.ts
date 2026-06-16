import type { Profile } from '../settings/types';
import { profileToConnectionSpec, type TerminalConnectionSpec } from '../connections/TerminalConnectionSpec';

export type TerminalHomeAction = 'connect' | 'profiles' | 'settings' | 'debug';

export type TerminalHomeProfile = {
  id: string;
  label: string;
  description: string;
  connection: TerminalConnectionSpec;
};

export type TerminalHomeModel = {
  recentProfiles: TerminalHomeProfile[];
  actions: TerminalHomeAction[];
};

export function createTerminalHomeModel(profiles: Profile[], includeDebug: boolean): TerminalHomeModel {
  return {
    recentProfiles: profiles.slice(0, 8).map((profile) => ({
      id: profile.id,
      label: profile.name,
      description: `${profile.username}@${profile.host}:${profile.port}`,
      connection: profileToConnectionSpec(profile),
    })),
    actions: includeDebug ? ['connect', 'profiles', 'settings', 'debug'] : ['connect', 'profiles', 'settings'],
  };
}
