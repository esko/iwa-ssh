/** Direct Sockets availability probe. Live SSH uses upstream wassh. */

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
