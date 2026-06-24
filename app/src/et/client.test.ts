import 'fake-indexeddb/auto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import sodium from 'libsodium-wrappers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConnectResponseSchema, ConnectStatus, EtPacketType } from './proto/ET_pb';
import { InitialResponseSchema, TerminalInfoSchema } from './proto/ETerminal_pb';
import { EtClient, ET_SESSION_ENVIRONMENT, serializeEtTerminalInfo } from './client';
import { frameHandshake, framePacket } from './wire';
import { resetIndexedDbConnection, saveEtSession, getEtSession, type EtSessionRecord } from '../storage/indexedDb';
import { resetSessionCheckpointFlushes, wrapEtPasskey } from './sessionStore';

async function resetDb(): Promise<void> {
  resetSessionCheckpointFlushes();
  await resetIndexedDbConnection();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase('iwa-ssh');
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
}

beforeEach(resetDb);
afterEach(async () => {
  delete (globalThis as { window?: unknown }).window;
  await resetDb();
});

describe('EtClient over Direct Sockets', () => {
  it('serializes terminal backing-canvas dimensions', () => {
    const info = fromBinary(TerminalInfoSchema, serializeEtTerminalInfo('client', {
      cols: 100, rows: 32, widthPx: 1280, heightPx: 768,
    }));
    expect(info).toMatchObject({ id: 'client', column: 100, row: 32, width: 1280, height: 768 });
  });

  it('performs a fresh v6 handshake and checkpoints both nonce sequences', async () => {
    await sodium.ready;
    const passkey = '12345678901234567890123456789012';
    const wrapped = await wrapEtPasskey(passkey);
    const now = Date.now();
    const session: EtSessionRecord = {
      id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
      username: 'user', wrappedPasskey: wrapped.ciphertext, passkeyIv: wrapped.iv,
      phase: 'detached', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
      txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
      journalTruncated: false, cols: 80, rows: 24, createdAt: now, updatedAt: now,
    };
    await saveEtSession(session);

    const response = frameHandshake(toBinary(ConnectResponseSchema, create(ConnectResponseSchema, { status: ConnectStatus.NEW_CLIENT })));
    const initialPlaintext = toBinary(InitialResponseSchema, create(InitialResponseSchema));
    const nonce = new Uint8Array(24); nonce[0] = 1; nonce[23] = 1;
    const initialCiphertext = sodium.crypto_secretbox_easy(initialPlaintext, nonce, new TextEncoder().encode(passkey));
    const initial = framePacket({ encrypted: true, type: EtPacketType.INITIAL_RESPONSE, payload: initialCiphertext });
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const readable = new ReadableStream<Uint8Array>({ start(value) { controller = value; value.enqueue(concat(response, initial)); } });
    const writes: Uint8Array[] = [];
    const writable = new WritableStream<Uint8Array>({ write(value) { writes.push(value.slice()); } });
    const opened = { readable, writable, close: async () => controller.close() };
    class FakeSocket { opened = Promise.resolve(opened); async close(): Promise<void> {} }
    (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
    window.TCPSocket = FakeSocket as unknown as typeof window.TCPSocket;

    const statuses: string[] = [];
    const client = await EtClient.create('local', {
      onOutput() {},
      onStatus(status) { statuses.push(status); },
      onStale() {},
    });
    await client.connect();
    expect(statuses).toContain('connected');
    expect(writes.length).toBeGreaterThanOrEqual(2);
    expect(await getEtSession('local')).toMatchObject({ rxSequence: 1, txSequence: 1, phase: 'active' });
    await client.detach();
    expect((await getEtSession('local'))?.phase).toBe('detached');
  });

  it('advertises truecolor to the remote shell via the InitialPayload env', () => {
    // TERM rides the etterminal registration; COLORTERM must come through the
    // ET environment channel so truecolor apps match the SSH/Mosh transports.
    expect(ET_SESSION_ENVIRONMENT).toMatchObject({ COLORTERM: 'truecolor' });
  });

  it('rejects the first connect attempt instead of entering the reconnect loop', async () => {
    await sodium.ready;
    const passkey = '12345678901234567890123456789012';
    const wrapped = await wrapEtPasskey(passkey);
    const now = Date.now();
    await saveEtSession({
      id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
      username: 'user', wrappedPasskey: wrapped.ciphertext, passkeyIv: wrapped.iv,
      phase: 'detached', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
      txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
      journalTruncated: false, cols: 80, rows: 24, createdAt: now, updatedAt: now,
    });
    class FailingSocket {
      opened = Promise.reject(new Error('network unreachable'));
      constructor() { this.opened.catch(() => undefined); }
      async close(): Promise<void> {}
    }
    (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
    window.TCPSocket = FailingSocket as unknown as typeof window.TCPSocket;

    const statuses: string[] = [];
    const client = await EtClient.create('local', {
      onOutput() {},
      onStatus(status, error) { statuses.push(`${status}:${error ?? ''}`); },
      onStale() {},
    });
    await expect(client.connect()).rejects.toThrow('network unreachable');
    expect(statuses).toContain('connecting:');
    expect(statuses).toContain('error:network unreachable');
  });

  it('detach does not resurrect a stale (server-ended) session', async () => {
    await sodium.ready;
    const passkey = '12345678901234567890123456789012';
    const wrapped = await wrapEtPasskey(passkey);
    const now = Date.now();
    await saveEtSession({
      id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
      username: 'user', wrappedPasskey: wrapped.ciphertext, passkeyIv: wrapped.iv,
      phase: 'stale', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
      txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
      journalTruncated: false, cols: 80, rows: 24, createdAt: now, updatedAt: now,
    });
    const client = await EtClient.create('local', { onOutput() {}, onStatus() {}, onStale() {} });
    await client.detach();
    expect((await getEtSession('local'))?.phase).toBe('stale');
  });

  it('reconnects after the live connection drops instead of stranding', async () => {
    await sodium.ready;
    const passkey = '12345678901234567890123456789012';
    const wrapped = await wrapEtPasskey(passkey);
    const now = Date.now();
    await saveEtSession({
      id: 'local', clientId: '1234567890123456', host: 'host', sshPort: 22, etPort: 2022,
      username: 'user', wrappedPasskey: wrapped.ciphertext, passkeyIv: wrapped.iv,
      phase: 'detached', protocolVersion: 6, storageFormatVersion: 1, rxSequence: 0,
      txSequence: 0, txAcknowledged: 0, outboundBytes: 0, journalBytes: 0,
      journalTruncated: false, cols: 80, rows: 24, createdAt: now, updatedAt: now,
    });

    const response = frameHandshake(toBinary(ConnectResponseSchema, create(ConnectResponseSchema, { status: ConnectStatus.NEW_CLIENT })));
    const initialPlaintext = toBinary(InitialResponseSchema, create(InitialResponseSchema));
    const nonce = new Uint8Array(24); nonce[0] = 1; nonce[23] = 1;
    const initialCiphertext = sodium.crypto_secretbox_easy(initialPlaintext, nonce, new TextEncoder().encode(passkey));
    const initial = framePacket({ encrypted: true, type: EtPacketType.INITIAL_RESPONSE, payload: initialCiphertext });

    let socketCount = 0;
    let firstController: ReadableStreamDefaultController<Uint8Array> | null = null;
    class FakeSocket {
      opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close: () => Promise<void> }>;
      constructor() {
        socketCount += 1;
        if (socketCount === 1) {
          const readable = new ReadableStream<Uint8Array>({ start(c) { firstController = c; c.enqueue(concat(response, initial)); } });
          const writable = new WritableStream<Uint8Array>({ write() {}, abort() {} });
          this.opened = Promise.resolve({ readable, writable, close: async () => {} });
        } else {
          // Reconnect attempt: still "offline" — reject so the loop backs off.
          this.opened = Promise.reject(new Error('still offline'));
          this.opened.catch(() => undefined);
        }
      }
      async close(): Promise<void> {}
    }
    (globalThis as unknown as { window: Window }).window = globalThis as unknown as Window;
    window.TCPSocket = FakeSocket as unknown as typeof window.TCPSocket;

    const statuses: string[] = [];
    const client = await EtClient.create('local', { onOutput() {}, onStatus(status) { statuses.push(status); }, onStale() {} });
    await client.connect();
    expect(statuses).toContain('connected');
    expect(socketCount).toBe(1);

    // Drop the live connection mid-session; closeSocket must not throw and the
    // reconnect loop must open a fresh socket rather than stranding.
    firstController!.error(new Error('network dropped'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(socketCount).toBeGreaterThanOrEqual(2);

    await client.detach();
  });
});
