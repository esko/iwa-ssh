import sodium from 'libsodium-wrappers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import type { EtSessionRecord } from '../storage/indexedDb';
import { TerminalBufferSchema, TerminalPacketType } from './proto/ETerminal_pb';

const mocks = vi.hoisted(() => ({ save: vi.fn(), checkpointOutput: vi.fn() }));

vi.mock('../storage/indexedDb', async (importOriginal) => ({
  ...await importOriginal<typeof import('../storage/indexedDb')>(),
  saveEtOutboundFrame: mocks.save,
}));

vi.mock('./sessionStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('./sessionStore')>(),
  checkpointEtOutput: mocks.checkpointOutput,
}));

import { EtClient } from './client';

const session = (): EtSessionRecord => ({
  id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
  username: 'user', wrappedPasskey: new ArrayBuffer(0), passkeyIv: new Uint8Array(),
  phase: 'active', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
  txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
  journalTruncated: false, cols: 80, rows: 24, createdAt: 1, updatedAt: 1,
});

describe('EtClient live terminal latency', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.checkpointOutput.mockReset();
  });

  it('delivers remote Kitty queries to Restty without waiting for journal persistence', async () => {
    await sodium.ready;
    let releaseCheckpoint!: (value: EtSessionRecord) => void;
    mocks.checkpointOutput.mockReturnValue(new Promise<EtSessionRecord>((resolve) => { releaseCheckpoint = resolve; }));
    const onOutput = vi.fn();
    const current = session();
    const client = new (EtClient as unknown as new (
      session: EtSessionRecord,
      passkey: string,
      callbacks: { onOutput(data: Uint8Array): void; onStatus(): void; onStale(): void },
    ) => EtClient)(current, '12345678901234567890123456789012', {
      onOutput, onStatus() {}, onStale() {},
    });
    const query = new TextEncoder().encode('\x1b_Gi=1,a=q,t=d,f=24,s=1,v=1;AAAA\x1b\\');
    const plaintext = toBinary(TerminalBufferSchema, create(TerminalBufferSchema, { buffer: query }));
    const nonce = new Uint8Array(24);
    nonce[0] = 1;
    nonce[23] = 1;
    const encrypted = sodium.crypto_secretbox_easy(
      plaintext,
      nonce,
      new TextEncoder().encode('12345678901234567890123456789012'),
    );
    const accepting = (client as unknown as {
      acceptEncryptedPacket(packet: { encrypted: boolean; type: number; payload: Uint8Array }): Promise<void>;
    }).acceptEncryptedPacket({ encrypted: true, type: TerminalPacketType.TERMINAL_BUFFER, payload: encrypted });

    await vi.waitFor(() => expect(mocks.checkpointOutput).toHaveBeenCalledOnce());
    try {
      expect(onOutput).toHaveBeenCalledWith(query);
    } finally {
      releaseCheckpoint({ ...current, rxSequence: 1 });
      await accepting;
    }
  });

  it('writes Kitty protocol replies to the live socket without waiting for IndexedDB', async () => {
    await sodium.ready;
    let releasePersistence!: (value: EtSessionRecord) => void;
    mocks.save.mockReturnValue(new Promise<EtSessionRecord>((resolve) => { releasePersistence = resolve; }));
    const client = new (EtClient as unknown as new (
      session: EtSessionRecord,
      passkey: string,
      callbacks: { onOutput(): void; onStatus(): void; onStale(): void },
    ) => EtClient)(session(), '12345678901234567890123456789012', {
      onOutput() {}, onStatus() {}, onStale() {},
    });
    const write = vi.fn(async () => undefined);
    (client as unknown as { writer: { write: typeof write } }).writer = { write };

    const sending = client.sendInput('\x1b_Gi=1;OK\x1b\\');
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());
    try {
      expect(write).toHaveBeenCalledOnce();
    } finally {
      releasePersistence({ ...session(), txSequence: 1 });
      await sending;
    }
  });

  it('does not defer Kitty replies through queueMicrotask batching', async () => {
    await sodium.ready;
    let releasePersistence!: (value: EtSessionRecord) => void;
    mocks.save.mockReturnValue(new Promise<EtSessionRecord>((resolve) => { releasePersistence = resolve; }));
    const client = new (EtClient as unknown as new (
      session: EtSessionRecord,
      passkey: string,
      callbacks: { onOutput(): void; onStatus(): void; onStale(): void },
    ) => EtClient)(session(), '12345678901234567890123456789012', {
      onOutput() {}, onStatus() {}, onStale() {},
    });
    const write = vi.fn(async () => undefined);
    (client as unknown as { writer: { write: typeof write } }).writer = { write };
    const queueMicrotaskSpy = vi.spyOn(globalThis, 'queueMicrotask');

    const sending = client.sendInput('\x1b_Gi=1;OK\x1b\\');
    expect(queueMicrotaskSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.save).toHaveBeenCalledOnce());

    try {
      releasePersistence({ ...session(), txSequence: 1 });
      await sending;
      expect(write).toHaveBeenCalledOnce();
    } finally {
      queueMicrotaskSpy.mockRestore();
    }
  });
});
