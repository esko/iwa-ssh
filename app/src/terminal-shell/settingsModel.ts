import type { AppSettings, Identity, KnownHost } from '../settings/types';

export type TerminalSettingsModel = {
  settings: AppSettings;
  knownHosts: KnownHost[];
  identities: Identity[];
  popup: boolean;
};

export function createTerminalSettingsModel(
  settings: AppSettings,
  knownHosts: KnownHost[],
  identities: Identity[],
  popup: boolean,
): TerminalSettingsModel {
  return {
    settings,
    knownHosts,
    identities,
    popup,
  };
}
