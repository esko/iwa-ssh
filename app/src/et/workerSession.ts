import type { EtWorkerInputGate } from './workerInput';

type EtSessionClient = {
  connect(): Promise<void>;
  sendInput(data: string): Promise<void>;
};

/**
 * Open the ET session, then flush input buffered while EtClient was being
 * constructed. Order matters: input gating makes sendInput() block until
 * connect() marks user traffic ready, so flushing the gate *before* connect()
 * deadlocks — the buffered sends wait on a gate only connect() opens, while
 * connect() itself waits behind the flush. On resume the journal replay makes
 * Restty emit query replies that buffer here, so the wrong order left resume
 * stuck on "connecting" forever (the connect timeout lives inside connect(),
 * which never ran). Connect first; flush after.
 */
export async function startEtClientSession(
  client: EtSessionClient,
  gate: EtWorkerInputGate,
  onError: (error: unknown) => void,
): Promise<void> {
  await client.connect();
  await gate.attach(client, onError);
}
