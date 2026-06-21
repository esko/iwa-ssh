/// <reference lib="webworker" />

import { EtClient } from './client';

type WorkerRequest =
  | { type: 'connect'; sessionId: string }
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'detach' };

const scope = self as DedicatedWorkerGlobalScope;
let client: EtClient | null = null;

function post(type: string, detail: Record<string, unknown> = {}): void {
  scope.postMessage({ type, ...detail });
}

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;
  if (request.type === 'connect') {
    void EtClient.create(request.sessionId, {
      onOutput: (data) => post('output', { data }),
      onStatus: (status, error) => post('status', { status, error }),
      onStale: () => post('stale'),
    }).then(async (created) => {
      client = created;
      await created.connect();
    }).catch((error) => post('error', { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'input') {
    void client?.sendInput(request.data).catch((error) => post('error', { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'resize') {
    void client?.resize(request.cols, request.rows).catch((error) => post('error', { error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'detach') {
    void client?.detach().finally(() => {
      client = null;
      post('detached');
      scope.close();
    });
  }
};
