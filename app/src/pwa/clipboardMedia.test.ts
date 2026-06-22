import { describe, expect, it } from 'vitest';
import { ClipboardMediaError, MAX_CLIPBOARD_IMAGE_BYTES, readClipboardPaste } from './clipboardMedia';

function item(entries: Record<string, Blob>): ClipboardItem {
  return { types: Object.keys(entries), getType: async (type: string) => entries[type] } as unknown as ClipboardItem;
}

describe('readClipboardPaste', () => {
  it('prefers a supported image over accompanying text', async () => {
    const image = new Blob(['png'], { type: 'image/png' });
    const clipboard = { read: async () => [item({ 'text/plain': new Blob(['caption']), 'image/png': image })], readText: async () => 'fallback' };
    await expect(readClipboardPaste(clipboard)).resolves.toEqual({ kind: 'image', blob: image, type: 'image/png' });
  });

  it('preserves text-only paste behavior', async () => {
    const clipboard = { read: async () => [item({ 'text/plain': new Blob(['hello']) })], readText: async () => '' };
    await expect(readClipboardPaste(clipboard)).resolves.toEqual({ kind: 'text', text: 'hello' });
  });

  it('rejects oversized images', async () => {
    const image = new Blob([new Uint8Array(MAX_CLIPBOARD_IMAGE_BYTES + 1)], { type: 'image/png' });
    const clipboard = { read: async () => [item({ 'image/png': image })], readText: async () => '' };
    await expect(readClipboardPaste(clipboard)).rejects.toMatchObject({ code: 'size' });
  });

  it('reports permission errors', async () => {
    const clipboard = { read: async () => { throw new DOMException('denied', 'NotAllowedError'); }, readText: async () => '' };
    await expect(readClipboardPaste(clipboard)).rejects.toBeInstanceOf(ClipboardMediaError);
  });
});
