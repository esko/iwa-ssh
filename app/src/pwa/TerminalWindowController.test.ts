import { describe, expect, it, vi } from 'vitest';
import type { LaunchConnectionIntent } from '../connections/ConnectionIntent';
import type { TerminalSink } from '../terminal/TerminalAdapter';
import type { TerminalTransport, TransportStatusHandler } from './transport';
import {
  TerminalWindowController,
  type TerminalTabRuntime,
  type TerminalTabRuntimeEvents,
  type TerminalWindowRuntime,
} from './TerminalWindowController';

const intent = (hostname: string, protocol: 'ssh' | 'et' = 'ssh'): LaunchConnectionIntent => ({
  protocol, hostname, args: [], ...(protocol === 'et' ? { etPort: 2022 } : {}),
});

const sink: TerminalSink = {
  write: vi.fn(), onInput: () => ({ dispose: vi.fn() }), onResize: () => ({ dispose: vi.fn() }),
  focus: vi.fn(), getSize: () => ({ cols: 80, rows: 24 }),
};

class FakeTab implements TerminalTabRuntime {
  activePaneId = 1;
  disposed = 0;
  refreshed = 0;
  constructor(readonly events: TerminalTabRuntimeEvents) {}
  split(): void { this.activePaneId += 1; this.events.onPaneOpen(this.activePaneId, sink); }
  closePane(id: number): void { this.events.onPaneClose(id); }
  getActivePaneId(): number { return this.activePaneId; }
  refreshSettings(): void { this.refreshed += 1; }
  dispose(): void { this.disposed += 1; }
}

class FakeRuntime implements TerminalWindowRuntime {
  tabs = new Map<string, FakeTab>();
  async createTab(id: string, _intent: LaunchConnectionIntent, events: TerminalTabRuntimeEvents): Promise<TerminalTabRuntime> {
    const tab = new FakeTab(events);
    this.tabs.set(id, tab);
    events.onPaneOpen(1, sink);
    return tab;
  }
}

class FakeTransport implements TerminalTransport {
  disconnects = 0;
  disposals = 0;
  constructor(readonly status: TransportStatusHandler, readonly resumeId?: string) {}
  async connect(): Promise<void> { this.status('connected'); }
  async disconnect(): Promise<void> { this.disconnects += 1; this.status('disconnected'); }
  dispose(): void { this.disposals += 1; }
  getPersistentSessionId(): string | undefined { return this.resumeId; }
}

function setup() {
  const runtime = new FakeRuntime();
  const transports: FakeTransport[] = [];
  const controller = new TerminalWindowController({
    runtime,
    createTransport: (connection, status) => {
      const transport = new FakeTransport(status, connection.protocol === 'et' ? `resume-${transports.length + 1}` : undefined);
      transports.push(transport);
      return transport;
    },
  });
  return { controller, runtime, transports };
}

describe('TerminalWindowController', () => {
  it('opens tabs and gives every Restty split an independent pane transport', async () => {
    const { controller, transports } = setup();
    await controller.dispatch({ type: 'open-tab', intent: intent('one') });
    await controller.dispatch({ type: 'split-pane', direction: 'vertical' });
    expect(transports).toHaveLength(2);
    expect(controller.getSnapshot().tabs[0]).toMatchObject({ paneCount: 2, status: 'connected' });
  });

  it('owns ET resume identity per pane and creates a fresh identity for a split', async () => {
    const { controller } = setup();
    await controller.dispatch({ type: 'open-tab', intent: { ...intent('et', 'et'), etSessionId: 'existing' } });
    await controller.dispatch({ type: 'split-pane', direction: 'horizontal' });
    const panes = controller.getSnapshot().tabs[0].panes;
    expect(panes.map((pane) => pane.resumeEtSessionId)).toEqual(['resume-1', 'resume-2']);
  });

  it('restores primary intents, reorders tabs, and refreshes settings', async () => {
    const { controller, runtime } = setup();
    await controller.dispatch({ type: 'restore-tabs', intents: [intent('one'), intent('two')], activeIndex: 1 });
    await controller.dispatch({ type: 'reorder-tab', tabId: controller.getSnapshot().tabs[1].id, toIndex: 0 });
    await controller.dispatch({ type: 'refresh-settings' });
    expect(controller.getSnapshot().tabs.map((tab) => tab.title)).toEqual(['two', 'one']);
    expect([...runtime.tabs.values()].every((tab) => tab.refreshed === 1)).toBe(true);
  });

  it('reconnects the active pane and tears down every generation exactly once', async () => {
    const { controller, runtime, transports } = setup();
    await controller.dispatch({ type: 'open-tab', intent: intent('one') });
    await controller.dispatch({ type: 'reconnect-active-pane' });
    expect(transports).toHaveLength(2);
    expect(transports[0]).toMatchObject({ disconnects: 1, disposals: 1 });
    await controller.dispose();
    await controller.dispose();
    expect(transports[1]).toMatchObject({ disconnects: 1, disposals: 1 });
    expect([...runtime.tabs.values()][0].disposed).toBe(1);
    transports[1].status('error', 'late');
    expect(controller.getSnapshot().tabs).toHaveLength(0);
  });

  it('notifies subscribers with reduced status and closes on normal exit', async () => {
    const { controller, transports } = setup();
    const listener = vi.fn();
    controller.subscribe(listener);
    await controller.dispatch({ type: 'open-tab', intent: intent('one') });
    transports[0].status('error', 'boom');
    expect(controller.getSnapshot().status).toBe('error');
    transports[0].status('disconnected', undefined, { disconnectReason: 'normal-exit' });
    await Promise.resolve();
    expect(controller.getSnapshot().tabs).toHaveLength(0);
    expect(listener).toHaveBeenCalled();
  });
});
