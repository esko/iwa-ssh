import type { TerminalViewport } from '../terminal/TerminalAdapter';

export type EtWorkerRequest =
  | { type: 'connect'; sessionId: string }
  | { type: 'input'; data: string }
  | ({ type: 'resize' } & TerminalViewport)
  | { type: 'detach' };

export type EtWorkerEvent =
  | { type: 'output'; data: Uint8Array }
  | { type: 'status'; status: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'; error?: string }
  | { type: 'stale' }
  | { type: 'error'; error: string }
  | { type: 'detached' };
