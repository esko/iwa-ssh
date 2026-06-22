export type EtWorkerRequest =
  | { type: 'connect'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'detach' };

export type EtWorkerEvent =
  | { type: 'output'; data: Uint8Array }
  | { type: 'status'; status: 'idle' | 'connecting' | 'connected' | 'disconnecting' | 'disconnected' | 'error'; error?: string }
  | { type: 'stale' }
  | { type: 'error'; error: string }
  | { type: 'detached' };
