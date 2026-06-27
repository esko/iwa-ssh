export const REMOTE_PASTE_DIRECTORY = '.cache/gosh/pastes';
export const REMOTE_PASTE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type RemoteUploadProgress = { uploaded: number; total: number };

export interface RemoteFileChannel {
  readonly writeChunkSize: number;
  home(): Promise<string>;
  ensureDirectory(path: string): Promise<void>;
  list(path: string): Promise<Array<{ name: string; modified?: number }>>;
  remove(path: string): Promise<void>;
  open(path: string): Promise<string>;
  write(handle: string, offset: number, data: Uint8Array): Promise<void>;
  close(handle: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  dispose(): void;
}

export type RemoteImageUploaderOptions = {
  connect: (signal?: AbortSignal) => Promise<RemoteFileChannel>;
  fallback?: (blob: Blob, signal?: AbortSignal, onProgress?: (progress: RemoteUploadProgress) => void) => Promise<string>;
  isSubsystemUnavailable?: (error: unknown) => boolean;
  now?: () => number;
  randomName?: () => string;
};

function extension(type: string): string {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[type] ?? 'bin';
}

export function shellQuotePath(path: string): string {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

export class RemoteImageUploader {
  private channelPromise: Promise<RemoteFileChannel> | null = null;

  constructor(private readonly options: RemoteImageUploaderOptions) {}

  async uploadFile(blob: Blob, signal?: AbortSignal, onProgress?: (progress: RemoteUploadProgress) => void): Promise<string> {
    signal?.throwIfAborted();
    let channel: RemoteFileChannel;
    try {
      channel = await (this.channelPromise ??= this.options.connect(signal));
    } catch (error) {
      this.channelPromise = null;
      if (this.options.fallback && this.options.isSubsystemUnavailable?.(error)) {
        return this.options.fallback(blob, signal, onProgress);
      }
      throw error;
    }
    signal?.throwIfAborted();
    const home = (await channel.home()).replace(/\/$/, '');
    const directory = `${home}/${REMOTE_PASTE_DIRECTORY}`;
    for (const path of [`${home}/.cache`, `${home}/.cache/gosh`, directory]) {
      await channel.ensureDirectory(path);
    }
    await this.cleanup(channel, directory);

    const token = this.options.randomName?.() ?? crypto.randomUUID().replaceAll('-', '');
    const finalPath = `${directory}/iwa-paste-${token}.${extension(blob.type)}`;
    const temporaryPath = `${finalPath}.part`;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let handle: string | null = null;
    try {
      handle = await channel.open(temporaryPath);
      const size = channel.writeChunkSize > 0 ? channel.writeChunkSize : 64 * 1024;
      for (let offset = 0; offset < bytes.length; offset += size) {
        signal?.throwIfAborted();
        const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + size));
        await channel.write(handle, offset, chunk);
        onProgress?.({ uploaded: offset + chunk.length, total: bytes.length });
        signal?.throwIfAborted();
      }
      await channel.close(handle);
      handle = null;
      await channel.chmod(temporaryPath, 0o600);
      await channel.rename(temporaryPath, finalPath);
      return finalPath;
    } catch (error) {
      if (handle) await channel.close(handle).catch(() => undefined);
      await channel.remove(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  private async cleanup(channel: RemoteFileChannel, directory: string): Promise<void> {
    try {
      const cutoff = (this.options.now?.() ?? Date.now()) - REMOTE_PASTE_RETENTION_MS;
      const files = await channel.list(directory);
      await Promise.all(files.filter((file) => /^iwa-paste-[a-zA-Z0-9_-]+\.(?:png|jpg|webp|gif|bin)(?:\.part)?$/.test(file.name) && (file.modified ?? Infinity) < cutoff)
        .map((file) => channel.remove(`${directory}/${file.name}`).catch(() => undefined)));
    } catch {
      // Retention is best-effort and must never prevent a paste.
    }
  }

  dispose(): void {
    void this.channelPromise?.then((channel) => channel.dispose()).catch(() => undefined);
    this.channelPromise = null;
  }
}
