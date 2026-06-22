/// <reference lib="webworker" />

import { EtClient } from './client';
import type { EtWorkerEvent, EtWorkerRequest } from './workerMessages';

const scope = self as DedicatedWorkerGlobalScope;
let client: EtClient | null = null;

function post(event: EtWorkerEvent): void {
  scope.postMessage(event);
}

scope.onmessage = (event: MessageEvent<EtWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'connect') {
    void EtClient.create(request.sessionId, {
      onOutput: (data) => post({ type: 'output', data }),
      onStatus: (status, error) => post({ type: 'status', status, error }),
      onStale: () => post({ type: 'stale' }),
    }).then(async (created) => {
      client = created;
      await created.connect();
    }).catch((error) => post({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'input') {
    void client?.sendInput(request.data).catch((error) => post({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'resize') {
    void client?.resize(request.cols, request.rows).catch((error) => post({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'detach') {
    void client?.detach().finally(() => {
      client = null;
      post({ type: 'detached' });
      scope.close();
    });
  }
};
