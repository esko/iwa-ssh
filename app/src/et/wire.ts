import sodium from 'libsodium-wrappers';

export const ET_PROTOCOL_VERSION = 6;
export const ET_MAX_MESSAGE = 128 * 1024 * 1024;

export type EtWirePacket = {
  encrypted: boolean;
  type: number;
  payload: Uint8Array;
};

export function frameHandshake(payload: Uint8Array): Uint8Array {
  if (payload.byteLength > ET_MAX_MESSAGE) throw new Error('ET handshake message exceeds 128 MiB');
  const result = new Uint8Array(8 + payload.byteLength);
  new DataView(result.buffer).setBigInt64(0, BigInt(payload.byteLength), true);
  result.set(payload, 8);
  return result;
}

export function framePacket(packet: EtWirePacket): Uint8Array {
  const length = 2 + packet.payload.byteLength;
  if (length > ET_MAX_MESSAGE) throw new Error('ET packet exceeds 128 MiB');
  const result = new Uint8Array(4 + length);
  new DataView(result.buffer).setUint32(0, length, false);
  result[4] = packet.encrypted ? 1 : 0;
  result[5] = packet.type;
  result.set(packet.payload, 6);
  return result;
}

export function serializeCatchupPacket(packet: EtWirePacket): Uint8Array {
  const result = new Uint8Array(2 + packet.payload.byteLength);
  result[0] = packet.encrypted ? 1 : 0;
  result[1] = packet.type;
  result.set(packet.payload, 2);
  return result;
}

export function parseCatchupPacket(bytes: Uint8Array): EtWirePacket {
  if (bytes.byteLength < 2) throw new Error('Truncated ET catch-up packet');
  return { encrypted: bytes[0] !== 0, type: bytes[1], payload: bytes.slice(2) };
}

function nonceFor(sequence: number, direction: 0 | 1): Uint8Array {
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error('Invalid ET nonce sequence');
  const nonce = new Uint8Array(24);
  nonce[23] = direction;
  let value = BigInt(sequence);
  for (let index = 0; value > 0n && index < 23; index += 1) {
    nonce[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  if (value > 0n) throw new Error('ET nonce sequence overflow');
  return nonce;
}

export async function encryptEtPayload(passkey: string, sequence: number, plaintext: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const key = new TextEncoder().encode(passkey);
  if (key.byteLength !== sodium.crypto_secretbox_KEYBYTES) throw new Error('ET passkey must be exactly 32 bytes');
  return sodium.crypto_secretbox_easy(plaintext, nonceFor(sequence, 0), key);
}

export async function decryptEtPayload(passkey: string, sequence: number, ciphertext: Uint8Array): Promise<Uint8Array> {
  await sodium.ready;
  const key = new TextEncoder().encode(passkey);
  if (key.byteLength !== sodium.crypto_secretbox_KEYBYTES) throw new Error('ET passkey must be exactly 32 bytes');
  const result = sodium.crypto_secretbox_open_easy(ciphertext, nonceFor(sequence, 1), key);
  if (!result) throw new Error('ET packet authentication failed');
  return result;
}

export class EtStreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  // Unconsumed socket chunks held by reference; `chunkOffset` tracks how far into
  // the head chunk we've already read. Reassembling into one growing buffer would
  // be O(n^2) on the hot inbound path and on the up-to-128 MiB catch-up handshake;
  // this keeps it to a single copy per byte (only into the exact() result).
  private chunks: Uint8Array[] = [];
  private chunkOffset = 0;
  private available = 0;

  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader();
  }

  async exact(length: number): Promise<Uint8Array> {
    if (length < 0 || length > ET_MAX_MESSAGE) throw new Error(`Invalid ET read length: ${length}`);
    while (this.available < length) {
      const { value, done } = await this.reader.read();
      if (done) throw new Error('ET socket closed');
      if (!value?.byteLength) continue;
      this.chunks.push(value);
      this.available += value.byteLength;
    }
    const result = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const head = this.chunks[0];
      const take = Math.min(head.byteLength - this.chunkOffset, length - written);
      result.set(head.subarray(this.chunkOffset, this.chunkOffset + take), written);
      written += take;
      this.chunkOffset += take;
      this.available -= take;
      if (this.chunkOffset >= head.byteLength) {
        this.chunks.shift();
        this.chunkOffset = 0;
      }
    }
    return result;
  }

  async handshake(): Promise<Uint8Array> {
    const prefix = await this.exact(8);
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getBigInt64(0, true);
    if (length < 0n || length > BigInt(ET_MAX_MESSAGE)) throw new Error(`Invalid ET handshake length: ${length}`);
    return this.exact(Number(length));
  }

  async packet(): Promise<EtWirePacket> {
    const prefix = await this.exact(4);
    const length = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(0, false);
    if (length < 2 || length > ET_MAX_MESSAGE) throw new Error(`Invalid ET packet length: ${length}`);
    const bytes = await this.exact(length);
    return parseCatchupPacket(bytes);
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}
