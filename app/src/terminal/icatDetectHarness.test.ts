import sodium from 'libsodium-wrappers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { create, toBinary } from '@bufbuild/protobuf';
import type { EtSessionRecord } from '../storage/indexedDb';
import { TerminalBufferSchema, TerminalPacketType } from '../et/proto/ETerminal_pb';
import { icatDetectAccepts } from './icatDetectSim';

const mocks = vi.hoisted(() => ({ save: vi.fn(), checkpointOutput: vi.fn() }));

vi.mock('../storage/indexedDb', async (importOriginal) => ({
  ...await importOriginal<typeof import('../storage/indexedDb')>(),
  saveEtOutboundFrame: mocks.save,
}));

vi.mock('../et/sessionStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../et/sessionStore')>(),
  checkpointEtOutput: mocks.checkpointOutput,
}));

import { EtClient } from '../et/client';

const ICAT_DIRECT = '\x1b_Ga=q,t=d,f=24,s=1,v=1,S=3,i=1;MTIz\x1b\\';
const ICAT_FILE = '\x1b_Ga=q,t=t,f=24,s=1,v=1,S=3,i=2;MTIz\x1b\\';
const ICAT_MEMORY = '\x1b_Ga=q,t=s,f=24,s=1,v=1,S=3,i=3;MTIz\x1b\\';
const DA1_QUERY = '\x1b[c';
const PASSKEY = '12345678901234567890123456789012';

const session = (): EtSessionRecord => ({
  id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
  username: 'user', wrappedPasskey: new ArrayBuffer(0), passkeyIv: new Uint8Array(),
  phase: 'active', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
  txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
  journalTruncated: false, cols: 80, rows: 24, createdAt: 1, updatedAt: 1,
});

function rxNonce(sequence: number): Uint8Array {
  const nonce = new Uint8Array(24);
  nonce[0] = sequence;
  nonce[23] = 1;
  return nonce;
}

async function acceptTerminal(
  client: EtClient,
  current: EtSessionRecord,
  sequence: number,
  text: string,
): Promise<EtSessionRecord> {
  await sodium.ready;
  let releaseCheckpoint!: (value: EtSessionRecord) => void;
  mocks.checkpointOutput.mockReturnValueOnce(new Promise<EtSessionRecord>((resolve) => { releaseCheckpoint = resolve; }));
  const buffer = new TextEncoder().encode(text);
  const plaintext = toBinary(TerminalBufferSchema, create(TerminalBufferSchema, { buffer }));
  const encrypted = sodium.crypto_secretbox_easy(plaintext, rxNonce(sequence), new TextEncoder().encode(PASSKEY));
  const task = (client as unknown as {
    acceptEncryptedPacket(packet: { encrypted: boolean; type: number; payload: Uint8Array }): Promise<void>;
  }).acceptEncryptedPacket({ encrypted: true, type: TerminalPacketType.TERMINAL_BUFFER, payload: encrypted });
  const next = { ...current, rxSequence: sequence };
  releaseCheckpoint(next);
  await task;
  return next;
}

describe('kitten icat detect over ET worker path', () => {
  beforeEach(() => {
    mocks.save.mockReset();
    mocks.checkpointOutput.mockReset();
    mocks.save.mockImplementation(async (record: EtSessionRecord) => record);
  });

  it('passes icat detect when probes arrive as separate ET packets', async () => {
    await sodium.ready;
    const writes: string[] = [];
    const client = new (EtClient as unknown as new (
      s: EtSessionRecord,
      passkey: string,
      callbacks: { onOutput(): void; onStatus(): void; onStale(): void },
    ) => EtClient)(session(), PASSKEY, {
      onOutput() {}, onStatus() {}, onStale() {},
    });
    (client as unknown as { sendInputNow(data: string): Promise<void> }).sendInputNow = async (data) => {
      writes.push(data);
    };

    let current = session();
    current = await acceptTerminal(client, current, 1, ICAT_DIRECT);
    current = await acceptTerminal(client, current, 2, ICAT_FILE);
    current = await acceptTerminal(client, current, 3, ICAT_MEMORY);
    await acceptTerminal(client, current, 4, DA1_QUERY);

    expect(icatDetectAccepts(writes)).toBe(true);
    expect(writes.indexOf('\x1b_Gi=1;OK\x1b\\')).toBeLessThan(writes.indexOf('\x1b[?62;22c'));
  });

  it('passes a second icat detect on the same ET session', async () => {
    await sodium.ready;
    const writes: string[] = [];
    const client = new (EtClient as unknown as new (
      s: EtSessionRecord,
      passkey: string,
      callbacks: { onOutput(): void; onStatus(): void; onStale(): void },
    ) => EtClient)(session(), PASSKEY, {
      onOutput() {}, onStatus() {}, onStale() {},
    });
    (client as unknown as { sendInputNow(data: string): Promise<void> }).sendInputNow = async (data) => {
      writes.push(data);
    };

    let current = session();
    current = await acceptTerminal(client, current, 1, ICAT_DIRECT);
    current = await acceptTerminal(client, current, 2, ICAT_FILE);
    current = await acceptTerminal(client, current, 3, ICAT_MEMORY);
    await acceptTerminal(client, current, 4, DA1_QUERY);
    expect(icatDetectAccepts(writes)).toBe(true);

    writes.length = 0;
    current = await acceptTerminal(client, current, 5, ICAT_DIRECT);
    current = await acceptTerminal(client, current, 6, ICAT_FILE);
    current = await acceptTerminal(client, current, 7, ICAT_MEMORY);
    await acceptTerminal(client, current, 8, DA1_QUERY);
    expect(icatDetectAccepts(writes)).toBe(true);
  });

  it('fails icat detect when DA1 is sent before Gi=1;OK', () => {
    expect(icatDetectAccepts(['\x1b[?62;22c', '\x1b_Gi=1;OK\x1b\\'])).toBe(false);
  });
});
