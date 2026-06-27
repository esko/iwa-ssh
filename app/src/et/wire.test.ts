import { describe, expect, it } from 'vitest';
import sodium from 'libsodium-wrappers';
import { create, toBinary } from '@bufbuild/protobuf';
import { ConnectRequestSchema } from './proto/ET_pb';
import { decryptEtPayload, encryptEtPayload, EtStreamReader, frameHandshake, framePacket, parseCatchupPacket, serializeCatchupPacket } from './wire';

describe('Eternal Terminal wire protocol', () => {
  it('uses little-endian int64 handshake and big-endian packet lengths', () => {
    expect([...frameHandshake(new Uint8Array([1, 2])).slice(0, 8)]).toEqual([2, 0, 0, 0, 0, 0, 0, 0]);
    expect([...framePacket({ encrypted: true, type: 9, payload: new Uint8Array([7]) })]).toEqual([0, 0, 0, 3, 1, 9, 7]);
  });

  it('matches the pinned ET ConnectRequest protobuf golden vector', () => {
    const message = toBinary(ConnectRequestSchema, create(ConnectRequestSchema, { clientId: 'abc', version: 6 }));
    expect([...message]).toEqual([0x0a, 0x03, 0x61, 0x62, 0x63, 0x10, 0x06]);
    expect([...frameHandshake(message).slice(0, 8)]).toEqual([7, 0, 0, 0, 0, 0, 0, 0]);
  });

  it('round-trips catch-up packets without a length prefix', () => {
    const packet = { encrypted: true, type: 1, payload: new Uint8Array([2, 3]) };
    expect(parseCatchupPacket(serializeCatchupPacket(packet))).toEqual(packet);
  });

  it('matches libsodium secretbox with ET client/server nonce directions', async () => {
    await sodium.ready;
    const passkey = '0123456789abcdefghijklmnopqrstuv';
    const plaintext = new TextEncoder().encode('hello');
    const encrypted = await encryptEtPayload(passkey, 1, plaintext);
    const serverNonce = new Uint8Array(24);
    serverNonce[0] = 1;
    serverNonce[23] = 1;
    const serverCipher = sodium.crypto_secretbox_easy(plaintext, serverNonce, new TextEncoder().encode(passkey));
    expect(new TextDecoder().decode(await decryptEtPayload(passkey, 1, serverCipher))).toBe('hello');
    expect(encrypted.byteLength).toBe(plaintext.byteLength + sodium.crypto_secretbox_MACBYTES);
  });

  it('matches the pinned ET client SecretBox golden vector and rejects bad MACs', async () => {
    const key = '12345678901234567890123456789012';
    const plaintext = new Uint8Array([0x0a, 0x03, 0x61, 0x62, 0x63, 0x10, 0x06]);
    const encrypted = await encryptEtPayload(key, 1, plaintext);
    expect([...encrypted].map((byte) => byte.toString(16).padStart(2, '0')).join('')).toBe('11be53cc2bfdc1ddb91e09b21f7f8080d1f652f9ed5e0f');
    const damaged = encrypted.slice();
    damaged[0] ^= 1;
    await expect(decryptEtPayload(key, 1, damaged)).rejects.toThrow();
  });

  it('handles fragmented and coalesced stream reads', async () => {
    const framed = framePacket({ encrypted: false, type: 2, payload: new Uint8Array([8, 9]) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(framed.slice(0, 1));
        controller.enqueue(framed.slice(1, 5));
        controller.enqueue(framed.slice(5));
        controller.close();
      },
    });
    const packet = await new EtStreamReader(stream).packet();
    expect(packet.type).toBe(2);
    expect([...packet.payload]).toEqual([8, 9]);
  });

  it('reads consecutive packets coalesced into a single stream chunk', async () => {
    const first = framePacket({ encrypted: false, type: 2, payload: new Uint8Array([8, 9]) });
    const second = framePacket({ encrypted: true, type: 3, payload: new Uint8Array([4, 5, 6]) });
    const merged = new Uint8Array(first.byteLength + second.byteLength);
    merged.set(first);
    merged.set(second, first.byteLength);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One socket chunk spans both packets; the reader must hand out the first
        // and resume mid-chunk for the second without losing bytes.
        controller.enqueue(merged);
        controller.close();
      },
    });
    const reader = new EtStreamReader(stream);
    const a = await reader.packet();
    const b = await reader.packet();
    expect([a.type, [...a.payload]]).toEqual([2, [8, 9]]);
    expect([b.type, [...b.payload]]).toEqual([3, [4, 5, 6]]);
  });

  it('reassembles a large message fragmented across many small chunks', async () => {
    const payload = new Uint8Array(200_000);
    for (let i = 0; i < payload.byteLength; i += 1) payload[i] = i & 0xff;
    const framed = framePacket({ encrypted: false, type: 7, payload });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let offset = 0; offset < framed.byteLength; offset += 1500) {
          controller.enqueue(framed.subarray(offset, offset + 1500));
        }
        controller.close();
      },
    });
    const packet = await new EtStreamReader(stream).packet();
    expect(packet.type).toBe(7);
    expect(packet.payload.byteLength).toBe(payload.byteLength);
    expect(packet.payload[0]).toBe(0);
    expect(packet.payload[199_999]).toBe(199_999 & 0xff);
  });
});
