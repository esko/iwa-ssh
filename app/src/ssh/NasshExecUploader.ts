import type { ConnectionIntent } from '../connections/ConnectionIntent';
import type { TerminalSink, TerminalSubscription, TerminalViewport } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from './NasshCommandBridge';
import type { RemoteUploadProgress } from './RemoteImageUploader';

const FRAME_BYTES = 3072;

function extension(type: string): string {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[type] ?? 'bin';
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

class ExecSink implements TerminalSink {
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly outputListeners = new Set<(data: string) => void>();
  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.outputListeners.forEach((cb) => cb(text));
  }
  onInput(cb: (data: string) => void): TerminalSubscription { this.inputListeners.add(cb); return { dispose: () => this.inputListeners.delete(cb) }; }
  onResize(): TerminalSubscription { return { dispose: () => undefined }; }
  focus(): void {}
  getSize(): TerminalViewport { return { cols: 80, rows: 24, widthPx: 0, heightPx: 0 }; }
  input(data: string): void { this.inputListeners.forEach((cb) => cb(data)); }
  onOutput(cb: (data: string) => void): () => void { this.outputListeners.add(cb); return () => this.outputListeners.delete(cb); }
}

export function buildPortableExecUploadCommand(filename: string, marker: string): string {
  return `umask 077; d="$HOME/.cache/gosh/pastes"; mkdir -p "$d" || exit 73; find "$d" -type f -name 'iwa-paste-*' -mtime +7 -exec rm -f {} + 2>/dev/null || :; f="$d/${filename}"; p="$f.part"; trap 'rm -f "$p"' EXIT HUP INT TERM; if printf '' | base64 --decode >/dev/null 2>&1; then flag=--decode; elif printf '' | base64 -D >/dev/null 2>&1; then flag=-D; else exit 69; fi; { while IFS= read -r line; do [ "$line" = '${marker}' ] && break; printf %s "$line"; done; } | base64 "$flag" >"$p" && chmod 600 "$p" && mv -f "$p" "$f" || exit 74; trap - EXIT HUP INT TERM; printf '\\nIWA_UPLOAD_OK:%s\\n' "$(printf %s "$f" | base64 | tr -d '\\n')"`;
}

/** Portable Linux/macOS SSH-exec upload used only when SFTP is unavailable. */
export async function uploadViaNasshExec(spec: ConnectionIntent, blob: Blob, signal?: AbortSignal, onProgress?: (progress: RemoteUploadProgress) => void): Promise<string> {
  signal?.throwIfAborted();
  const token = crypto.randomUUID().replaceAll('-', '');
  const marker = `__IWA_UPLOAD_EOF_${token}__`;
  const filename = `iwa-paste-${token}.${extension(blob.type)}`;
  const command = buildPortableExecUploadCommand(filename, marker);
  const sink = new ExecSink();
  let rejectResult: (reason?: unknown) => void = () => undefined;
  let cleanupResult = (): void => undefined;
  const bridge = new NasshCommandBridge({
    protocol: 'ssh', host: spec.hostname, port: spec.port ?? 22,
    username: spec.username ?? '', identityId: spec.identityId,
    connectionArgs: spec.argstr, startupCommand: command,
    onStatus: (status, error) => {
      if (status === 'error') rejectResult(new Error(error ?? 'SSH upload failed.'));
      else if (status === 'disconnected') rejectResult(new Error('SSH upload ended before completion.'));
    },
  });
  bridge.attachTerminal(sink);
  const result = new Promise<string>((resolve, reject) => {
    let output = '';
    const onAbort = () => rejectResult(signal?.reason);
    const timeout = window.setTimeout(() => rejectResult(new Error('SSH upload timed out.')), 120_000);
    const offOutput = sink.onOutput((chunk) => {
      output = (output + chunk).slice(-16_384);
      const match = /IWA_UPLOAD_OK:([A-Za-z0-9+/=]+)/.exec(output);
      if (!match) return;
      cleanupResult();
      try { resolve(atob(match[1])); } catch (error) { reject(error); }
    });
    cleanupResult = () => {
      offOutput();
      window.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    };
    rejectResult = (reason) => { cleanupResult(); reject(reason); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await bridge.connect();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    for (let offset = 0; offset < bytes.length; offset += FRAME_BYTES) {
      signal?.throwIfAborted();
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + FRAME_BYTES));
      sink.input(`${base64(chunk)}\n`);
      onProgress?.({ uploaded: offset + chunk.length, total: bytes.length });
    }
    sink.input(`${marker}\n`);
    return await result;
  } finally {
    cleanupResult();
    await bridge.disconnect().catch(() => undefined);
    bridge.dispose();
  }
}
