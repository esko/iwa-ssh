/**
 * Direct Sockets availability probe and dev-time TCP smoke test.
 *
 * Real SSH traffic uses upstream wassh via nassh CommandInstance
 * (--field-trial-direct-sockets), not this module. Use isDirectSocketsAvailable()
 * and openDirectTcpSocket() only for capability checks (e.g. /debug).
 *
 * @see https://developer.chrome.com/docs/iwa/direct-sockets
 */

export type DirectSocketOptions = {
  host: string;
  port: number;
  signal?: AbortSignal;
};

export type DirectSocketHandle = {
  read(buffer: Uint8Array): Promise<number>;
  write(data: Uint8Array): Promise<void>;
  close(): Promise<void>;
};

declare global {
  interface Window {
    TCPSocket?: new (host: string, port: number) => {
      opened: Promise<{ readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array>; close(): Promise<void> }>;
      close(): Promise<void>;
    };
  }
}

export function isDirectSocketsAvailable(): boolean {
  return typeof window.TCPSocket === 'function';
}

export async function openDirectTcpSocket(
  options: DirectSocketOptions,
): Promise<DirectSocketHandle> {
  const { host, port, signal } = options;

  if (!isDirectSocketsAvailable()) {
    throw new Error(
      'Direct Sockets (TCPSocket) is unavailable. Install as an IWA with Direct Sockets permission on ChromeOS 120+.',
    );
  }

  const socket = new window.TCPSocket!(host, port);
  const abortError = new DOMException('Connection aborted', 'AbortError');

  if (signal?.aborted) {
    await socket.close().catch(() => undefined);
    throw abortError;
  }

  const onAbort = () => {
    void socket.close().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const connection = await socket.opened;
    const reader = connection.readable.getReader();
    const writer = connection.writable.getWriter();

    return {
      async read(buffer: Uint8Array): Promise<number> {
        const { value, done } = await reader.read();
        if (done || !value) return 0;
        const len = Math.min(value.length, buffer.length);
        buffer.set(value.subarray(0, len));
        return len;
      },
      async write(data: Uint8Array): Promise<void> {
        await writer.write(data);
      },
      async close(): Promise<void> {
        signal?.removeEventListener('abort', onAbort);
        await writer.close().catch(() => undefined);
        await reader.cancel().catch(() => undefined);
        await connection.close().catch(() => undefined);
        await socket.close().catch(() => undefined);
      },
    };
  } catch (error) {
    signal?.removeEventListener('abort', onAbort);
    await socket.close().catch(() => undefined);
    throw error;
  }
}
