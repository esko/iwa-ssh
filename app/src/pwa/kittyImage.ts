const KITTY_PAYLOAD_BYTES = 3072; // 3072 raw bytes become exactly 4096 base64 bytes.

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function encodeKittyPng(bytes: Uint8Array, columns?: number): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length || offset === 0; offset += KITTY_PAYLOAD_BYTES) {
    const payload = base64(bytes.subarray(offset, Math.min(bytes.length, offset + KITTY_PAYLOAD_BYTES)));
    const more = offset + KITTY_PAYLOAD_BYTES < bytes.length ? 1 : 0;
    const params = offset === 0
      ? `a=T,t=d,f=100,q=2${columns ? `,c=${columns}` : ''},m=${more}`
      : `q=2,m=${more}`;
    chunks.push(`\x1b_G${params};${payload}\x1b\\`);
  }
  return chunks;
}

export async function clipboardImageToPng(blob: Blob, signal?: AbortSignal): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  signal?.throwIfAborted();
  const bitmap = await createImageBitmap(blob);
  try {
    signal?.throwIfAborted();
    if (blob.type.toLowerCase() === 'image/png') {
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: bitmap.width, height: bitmap.height };
    }
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas image conversion is unavailable.');
    context.drawImage(bitmap, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error('PNG conversion failed.')), 'image/png'));
    signal?.throwIfAborted();
    return { bytes: new Uint8Array(await png.arrayBuffer()), width: bitmap.width, height: bitmap.height };
  } finally {
    bitmap.close();
  }
}
