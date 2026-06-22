import { describe, expect, it } from 'vitest';
import { clipboardImageToPng, encodeKittyPng } from './kittyImage';

describe('encodeKittyPng', () => {
  it('uses protocol-compliant base64 chunks and quiet direct transmission', () => {
    const packets = encodeKittyPng(new Uint8Array(3073).fill(7), 42);
    expect(packets).toHaveLength(2);
    expect(packets[0]).toMatch(/^\x1b_Ga=T,t=d,f=100,q=2,c=42,m=1;/);
    expect(packets[0].split(';')[1].slice(0, -2)).toHaveLength(4096);
    expect(packets[1]).toMatch(/^\x1b_Gq=2,m=0;/);
  });

  it('emits one terminating packet for an empty payload', () => {
    expect(encodeKittyPng(new Uint8Array())).toEqual(['\x1b_Ga=T,t=d,f=100,q=2,m=0;\x1b\\']);
  });

  it('honors cancellation before decoding clipboard media', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(clipboardImageToPng(new Blob(['png'], { type: 'image/png' }), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});
