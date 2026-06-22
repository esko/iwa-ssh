export const MAX_CLIPBOARD_IMAGE_BYTES = 25 * 1024 * 1024;

export const SUPPORTED_CLIPBOARD_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const;

export type ClipboardPaste =
  | { kind: 'image'; blob: Blob; type: string }
  | { kind: 'text'; text: string }
  | { kind: 'empty' };

export class ClipboardMediaError extends Error {
  constructor(readonly code: 'permission' | 'format' | 'size', message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ClipboardMediaError';
  }
}
type ClipboardReader = Pick<Clipboard, 'read' | 'readText'>;

function isSupportedImage(type: string): boolean {
  return (SUPPORTED_CLIPBOARD_IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

export async function readClipboardPaste(clipboard: ClipboardReader = navigator.clipboard): Promise<ClipboardPaste> {
  try {
    if (typeof clipboard.read === 'function') {
      const items = await clipboard.read();
      for (const item of items) {
        const imageType = item.types.find(isSupportedImage);
        if (!imageType) continue;
        const blob = await item.getType(imageType);
        if (blob.size > MAX_CLIPBOARD_IMAGE_BYTES) {
          throw new ClipboardMediaError('size', 'Clipboard image exceeds the 25 MiB limit.');
        }
        return { kind: 'image', blob, type: imageType.toLowerCase() };
      }
      const hasUnsupportedImage = items.some((item) => item.types.some((type) => type.startsWith('image/')));
      if (hasUnsupportedImage) {
        throw new ClipboardMediaError('format', 'Clipboard image format is not supported. Use PNG, JPEG, WebP, or GIF.');
      }
      for (const item of items) {
        if (!item.types.includes('text/plain')) continue;
        return { kind: 'text', text: await (await item.getType('text/plain')).text() };
      }
      return { kind: 'empty' };
    }
    const text = await clipboard.readText();
    return text ? { kind: 'text', text } : { kind: 'empty' };
  } catch (error) {
    if (error instanceof ClipboardMediaError) throw error;
    throw new ClipboardMediaError('permission', 'Clipboard access was denied.', { cause: error });
  }
}
