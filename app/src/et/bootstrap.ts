import type { TerminalSink, TerminalSubscription, TerminalViewport } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { saveEtSession, type EtSessionRecord } from '../storage/indexedDb';
import type { ConnectionIntent } from '../connections/ConnectionIntent';
import { isKnownHostReadyForConnect } from '../ssh/nasshKnownHosts';
import { wrapEtPasskey } from './sessionStore';
import { buildEtBootstrapCommand } from './bootstrapCommand';
import { resolveSettings } from '../pwa/settingsProfiles';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomText(length: number): string {
  const random = crypto.getRandomValues(new Uint8Array(length));
  return [...random].map((value) => ALPHANUMERIC[value % ALPHANUMERIC.length]).join('');
}

class CaptureTerminal implements TerminalSink {
  // The bootstrap subscription regex-scans the captured output on every write.
  // Keeping the full buffer makes that O(n²) over a chatty MOTD; cap it to a
  // tail window large enough to hold any IDPASSKEY token (49 chars) or failure
  // line so each scan is O(window) instead of O(total output so far).
  private static readonly MAX_SCAN = 1 << 16; // 64 KiB
  private output = '';
  private readonly listeners = new Set<(value: string) => void>();
  // One decoder instance so `stream: true` correctly carries a multi-byte
  // character split across writes (a fresh decoder per write cannot).
  private readonly decoder = new TextDecoder();

  open(): void {}
  write(data: string | Uint8Array): void {
    this.output += typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    if (this.output.length > CaptureTerminal.MAX_SCAN) {
      this.output = this.output.slice(-CaptureTerminal.MAX_SCAN);
    }
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

/** Parse `IDPASSKEY:clientId/passkey` emitted by etterminal after registration. */
export function parseEtBootstrapIdPasskey(output: string): { clientId: string; passkey: string } | null {
  const match = output.match(/IDPASSKEY:([A-Za-z0-9]{16})\/([A-Za-z0-9]{32})/);
  if (!match) return null;
  return { clientId: match[1]!, passkey: match[2]! };
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

async function runEtBootstrapPreflight(spec: ConnectionIntent): Promise<void> {
  const host = spec.hostname;
  const port = spec.port ?? 22;
  if (await isKnownHostReadyForConnect(host, port)) {
    return;
  }
  const terminal = new CaptureTerminal();
  const bridge = new NasshCommandBridge({
    protocol: 'ssh',
    host,
    port,
    username: spec.username ?? '',
    identityId: spec.identityId,
    connectionArgs: spec.argstr,
    allowHostKeyTtyResponse: false,
  });
  bridge.attachTerminal(terminal);
  try {
    await bridge.connect();
  } finally {
    await bridge.disconnect().catch(() => undefined);
    bridge.dispose();
    terminal.dispose();
  }
}

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

  await runEtBootstrapPreflight(spec);

  const terminal = new CaptureTerminal();
  const command = buildEtBootstrapCommand(clientId, passkey, resolveSettings(spec.settingsProfileId).termType);
  let resolveOutput!: () => void;
  let rejectOutput!: (error: Error) => void;
  const outputReady = new Promise<void>((resolve, reject) => {
    resolveOutput = resolve;
    rejectOutput = reject;
  });
  const timeout = window.setTimeout(() => rejectOutput(bootstrapError(terminal.getOutput(), clientId, passkey)), 30_000);
  const subscription = terminal.onOutput((output) => {
    const parsed = parseEtBootstrapIdPasskey(output);
    if (parsed) {
      resolveOutput();
    } else if (isEtBootstrapFailure(output)) {
      rejectOutput(bootstrapError(output, clientId, passkey));
    }
  });
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
    const parsed = parseEtBootstrapIdPasskey(terminal.getOutput());
    const finalClientId = parsed?.clientId ?? clientId;
    const finalPasskey = parsed?.passkey ?? passkey;
    const credentials = finalPasskey !== passkey
      ? { ...(await wrapEtPasskey(finalPasskey)) }
      : { iv: record.passkeyIv, ciphertext: record.wrappedPasskey };
    await saveEtSession({
      ...record,
      clientId: finalClientId,
      wrappedPasskey: credentials.ciphertext,
      passkeyIv: credentials.iv,
      phase: 'detached',
      updatedAt: Date.now(),
    });
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
