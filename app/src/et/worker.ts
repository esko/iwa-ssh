/// <reference lib="webworker" />

import { EtClient } from './client';
import { EtWorkerInputGate } from './workerInput';
import type { EtWorkerEvent, EtWorkerRequest } from './workerMessages';

const scope = self as DedicatedWorkerGlobalScope;
let client: EtClient | null = null;
const inputGate = new EtWorkerInputGate();

function post(event: EtWorkerEvent): void {
  scope.postMessage(event);
}

function reportInputError(error: unknown): void {
  post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
}

scope.onmessage = (event: MessageEvent<EtWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'connect') {
    inputGate.reset();
    void EtClient.create(request.sessionId, {
      onOutput: (data) => post({ type: 'output', data }),
      onStatus: (status, error) => post({ type: 'status', status, error }),
      onStale: () => post({ type: 'stale' }),
    }).then(async (created) => {
      client = created;
      await inputGate.attach(created, reportInputError);
      await created.connect();
    }).catch((error) => post({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    return;
  }
  if (request.type === 'input') {
    inputGate.deliver(request.data, client, reportInputError);
    return;
  }
  if (request.type === 'resize') {
    void client?.resize(request).catch(reportInputError);
    return;
  }
  if (request.type === 'detach') {
    void client?.detach().finally(() => {
      client = null;
      inputGate.reset();
      post({ type: 'detached' });
      scope.close();
    });
  }
};
