/** nassh/wassh status lines printed before the remote shell sends data. */

export function outputText(data: string | Uint8Array): string {
  return typeof data === 'string' ? data : new TextDecoder().decode(data);
}

export function isNasshBootstrapOutput(data: string | Uint8Array): boolean {
  const text = outputText(data);
  if (!text.trim()) return false;
  if (/PLUGIN_(LOADING|LOADING_COMPLETE)/.test(text)) return true;
  if (/Loading .+ program\.\.\./i.test(text)) return true;
  if (/Loading .+ program\.\.\. done\./i.test(text)) return true;
  if (/Connecting to .+\.\.\./i.test(text)) return true;
  if (/\bCONNECTING\b/.test(text) && !text.includes('Last login')) return true;
  return false;
}
