export function isIwaOrigin(): boolean {
  return location.protocol === 'isolated-app:';
}

export function usesNativeAppTabs(): boolean {
  if (!isIwaOrigin()) return false;

  const params = new URLSearchParams(location.search);
  if (params.get('simTabs') === '1') return false;
  if (params.get('simTabs') === '0') return true;

  return window.matchMedia('(display-mode: tabbed)').matches;
}

export function getRuntimeLabel(): string {
  if (usesNativeAppTabs()) return 'IWA (native tabs)';
  if (isIwaOrigin()) return 'IWA (standalone)';
  if (import.meta.env.DEV) return 'Dev server';
  return 'Browser';
}
