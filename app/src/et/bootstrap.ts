import type { TerminalSink, TerminalSubscription, TerminalViewport } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { saveEtSession, type EtSessionRecord } from '../storage/indexedDb';
import type { ConnectionIntent } from '../connections/ConnectionIntent';
import { wrapEtPasskey } from './sessionStore';
import { buildEtBootstrapCommand } from './bootstrapCommand';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomText(length: number): string {
  const random = crypto.getRandomValues(new Uint8Array(length));
  return [...random].map((value) => ALPHANUMERIC[value % ALPHANUMERIC.length]).join('');
}

class CaptureTerminal implements TerminalSink {
  private output = '';
  private readonly listeners = new Set<(value: string) => void>();

  open(): void {}
  write(data: string | Uint8Array): void {
    this.output += typeof data === 'string' ? data : new TextDecoder().decode(data, { stream: true });
    for (const listener of this.listeners) listener(this.output);
  }
  onInput(): TerminalSubscription { return { dispose() {} }; }
  onResize(): TerminalSubscription { return { dispose() {} }; }
  focus(): void {}
  dispose(): void { this.listeners.clear(); }
  getSize(): TerminalViewport { return { cols: 80, rows: 24, widthPx: 0, heightPx: 0 }; }
  onOutput(listener: (value: string) => void): TerminalSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  getOutput(): string { return this.output; }
}

/**
 * OpenSSH prints maintenance warnings to the same stream as command output —
 * notably `hostfile_replace_entries: hostkeys_foreach: No such file or
 * directory` when it updates a not-yet-existent known_hosts file, and the
 * `Warning: Permanently added ...` host-key notice. These are benign and must
 * not be mistaken for an etterminal failure (the bare "No such file" substring
 * otherwise trips the error scan and aborts a working connection).
 */
const BENIGN_SSH_NOISE =
  /^(?:hostfile_replace_entries|hostkeys_foreach|update_known_hosts|Warning: Permanently added)\b.*$/gim;

/** Match etterminal/etserver failures, not generic OpenSSH "No such file" housekeeping. */
const ET_BOOTSTRAP_FAILURE =
  /(?:^|\n)(?:Error:\s*)?(?:Connection error communicating with et daemon|Error connecting to router)|(?:^|\n)(?:env:|sh:)\s*[^\n]*etterminal[^\n]*(?:not found|No such file)|command not found|\bFATAL\b/i;

/** True when the captured SSH output indicates the etterminal bootstrap failed. */
export function isEtBootstrapFailure(output: string): boolean {
  return ET_BOOTSTRAP_FAILURE.test(output.replace(BENIGN_SSH_NOISE, ''));
}

function bootstrapError(output: string, clientId: string, passkey: string): Error {
  const redacted = output
    .replaceAll(clientId, '[client-id]')
    .replaceAll(passkey, '[passkey]')
    .trim()
    .slice(-2000);
  const hint = /Connection error communicating with et daemon/i.test(redacted)
    ? '\n\nEnsure etserver is running on the remote host (e.g. brew services start et).'
    : '';
  return new Error(
    redacted
      ? `etterminal registration failed:\n${redacted}${hint}`
      : 'Timed out waiting for etterminal registration',
  );
}

// #region agent log
function etBootstrapDebugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  fetch('http://127.0.0.1:7869/ingest/5b03efa9-2224-4a73-9a56-c6a816107ee6', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'a26731' },
    body: JSON.stringify({
      sessionId: 'a26731',
      location,
      message,
      data,
      hypothesisId,
      timestamp: Date.now(),
      runId: 'et-bootstrap',
    }),
  }).catch(() => {});
  console.info('[iwa-ssh et-debug]', location, message, data);
}
// #endregion

export async function createEtSession(spec: ConnectionIntent): Promise<string> {
  const clientId = randomText(16);
  const passkey = randomText(32);
  const localId = crypto.randomUUID();
  const wrapped = await wrapEtPasskey(passkey);
  const now = Date.now();
  const record: EtSessionRecord = {
    id: localId,
    clientId,
    host: spec.hostname,
    sshPort: spec.port ?? 22,
    etPort: spec.etPort ?? 2022,
    username: spec.username ?? '',
    profileId: spec.profileId,
    identityId: spec.identityId,
    settingsProfileId: spec.settingsProfileId,
    connectionArgs: spec.argstr,
    startupCommand: spec.startupCommand,
    wrappedPasskey: wrapped.ciphertext,
    passkeyIv: wrapped.iv,
    phase: 'bootstrapping',
    protocolVersion: 6,
    storageFormatVersion: 1,
    rxSequence: 0,
    txSequence: 0,
    txAcknowledged: 0,
    outboundBytes: 0,
    journalBytes: 0,
    journalTruncated: false,
    cols: 80,
    rows: 24,
    createdAt: now,
    updatedAt: now,
  };
  await saveEtSession(record);
  void navigator.storage?.persist?.().catch(() => false);

  const terminal = new CaptureTerminal();
  const expected = `IDPASSKEY:${clientId}/${passkey}`;
  const command = buildEtBootstrapCommand(clientId, passkey);
  let resolveOutput!: () => void;
  let rejectOutput!: (error: Error) => void;
  const outputReady = new Promise<void>((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });
  const timeout = window.setTimeout(() => rejectOutput(bootstrapError(terminal.getOutput(), clientId, passkey)), 30_000);
  const subscription = terminal.onOutput((output) => {
    if (output.includes(expected)) {
      etBootstrapDebugLog('bootstrap.ts:onOutput', 'IDPASSKEY seen', { outputLen: output.length }, 'D');
      resolveOutput();
    } else if (isEtBootstrapFailure(output)) {
      etBootstrapDebugLog('bootstrap.ts:onOutput', 'bootstrap failure pattern', {
        outputLen: output.length,
        hasLeadingYes: /^\s*yes\s*$/m.test(output),
        hasEtDaemonError: /Connection error communicating with et daemon/i.test(output),
        tail: output.slice(-500),
      }, 'A');
      rejectOutput(bootstrapError(output, clientId, passkey));
    }
  });
  etBootstrapDebugLog('bootstrap.ts:createEtSession', 'starting ET bootstrap SSH', {
    host: spec.hostname,
    port: spec.port ?? 22,
    allowHostKeyTtyResponse: false,
  }, 'D');
  const bridge = new NasshCommandBridge({
    protocol: 'ssh',
    host: spec.hostname,
    port: spec.port ?? 22,
    username: spec.username ?? '',
    identityId: spec.identityId,
    connectionArgs: spec.argstr,
    startupCommand: command,
    // ET bootstrap pipes registration into etterminal stdin; a TTY "yes" from
    // HostKeyGuard corrupts that pipe (regression from host-key TTY injection).
    allowHostKeyTtyResponse: false,
  });
  bridge.attachTerminal(terminal);
  try {
    await bridge.connect();
    await outputReady;
    await saveEtSession({ ...record, phase: 'detached', updatedAt: Date.now() });
    return localId;
  } catch (error) {
    await saveEtSession({ ...record, phase: 'stale', lastError: error instanceof Error ? error.message : String(error), updatedAt: Date.now() });
    throw error;
  } finally {
    window.clearTimeout(timeout);
    subscription.dispose();
    await bridge.disconnect().catch(() => undefined);
    bridge.dispose();
    terminal.dispose();
  }
}
