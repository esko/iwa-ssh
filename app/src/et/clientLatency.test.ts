import sodium from 'libsodium-wrappers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EtSessionRecord } from '../storage/indexedDb';

const mocks = vi.hoisted(() => ({ save: vi.fn() }));

vi.mock('../storage/indexedDb', async (importOriginal) => ({
  ...await importOriginal<typeof import('../storage/indexedDb')>(),
  saveEtOutboundFrame: mocks.save,
}));

import { EtClient } from './client';

const session = (): EtSessionRecord => ({
  id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
  username: 'user', wrappedPasskey: new ArrayBuffer(0), passkeyIv: new Uint8Array(),
  phase: 'active', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
  txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
  journalTruncated: false, cols: 80, rows: 24, createdAt: 1, updatedAt: 1,
});

describe('EtClient live input latency', () => {
  beforeEach(() => mocks.save.mockReset());

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
});
