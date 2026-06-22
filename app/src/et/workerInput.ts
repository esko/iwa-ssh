type EtInputClient = { sendInput(data: string): Promise<void> };

/** Holds terminal input until the ET worker finishes constructing EtClient. */
export class EtWorkerInputGate {
  private pending: string[] = [];

  deliver(data: string, client: EtInputClient | null, onError: (error: unknown) => void): void {
    if (client) {
      void client.sendInput(data).catch(onError);
      return;
    }
    this.pending.push(data);
  }

  attach(client: EtInputClient, onError: (error: unknown) => void): Promise<void> {
    const queued = this.pending;
    this.pending = [];
    return queued.reduce(
      (pending, chunk) => pending.then(() => client.sendInput(chunk).catch(onError)),
      Promise.resolve(),
    );
  }

  reset(): void {
    this.pending = [];
  }
}
