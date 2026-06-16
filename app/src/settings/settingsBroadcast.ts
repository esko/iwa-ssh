import type { AppSettings } from './types';

const SETTINGS_CHANNEL = 'iwa-ssh-settings';

export type SettingsBroadcastHandle = {
  dispose(): void;
};

export function publishSettingsChanged(settings: AppSettings): void {
  if (!('BroadcastChannel' in window)) return;
  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.postMessage({
    type: 'settings-changed',
    settings,
  });
  channel.close();
}

export function subscribeSettingsChanged(
  callback: (settings: AppSettings) => void,
): SettingsBroadcastHandle {
  if (!('BroadcastChannel' in window)) {
    return { dispose: () => undefined };
  }

  const channel = new BroadcastChannel(SETTINGS_CHANNEL);
  channel.addEventListener('message', (event: MessageEvent) => {
    const data = event.data as { type?: string; settings?: AppSettings };
    if (data?.type === 'settings-changed' && data.settings) {
      callback(data.settings);
    }
  });

  return {
    dispose: () => channel.close(),
  };
}
