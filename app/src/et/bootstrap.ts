import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import { NasshCommandBridge } from '../ssh/NasshCommandBridge';
import { saveEtSession, type EtSessionRecord } from '../storage/indexedDb';
import type { PwaConnectionSpec } from '../pwa/types';
import { wrapEtPasskey } from './sessionStore';
import { buildEtBootstrapCommand } from './bootstrapCommand';

const ALPHANUMERIC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function randomText(length: number): string {
  const random = crypto.getRandomValues(new Uint8Array(length));
  return [...random].map((value) => ALPHANUMERIC[value % ALPHANUMERIC.length]).join('');
}

class CaptureTerminal implements TerminalAdapter {
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
  getSize(): { cols: number; rows: number } { return { cols: 80, rows: 24 }; }
  onOutput(listener: (value: string) => void): TerminalSubscription {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  getOutput(): string { return this.output; }
}

function bootstrapError(output: string, clientId: string, passkey: string): Error {
  const redacted = output
    .replaceAll(clientId, '[client-id]')
    .replaceAll(passkey, '[passkey]')
    .trim()
    .slice(-2000);
  return new Error(redacted ? `etterminal registration failed:\n${redacted}` : 'Timed out waiting for etterminal registration');
}

export async function createEtSession(spec: PwaConnectionSpec): Promise<string> {
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
    if (output.includes(expected)) resolveOutput();
    else if (/command not found|No such file|Error connecting to router|\bFATAL\b/i.test(output)) {
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
