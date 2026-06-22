import {
  connectionIntentTitle,
  type LaunchConnectionIntent,
} from '../connections/ConnectionIntent';
import type { TerminalSink } from '../terminal/TerminalAdapter';
import type {
  TerminalTransport,
  TransportStatusHandler,
} from './transport';
import type { TerminalTransportStatus } from './types';

export type TerminalTabRuntimeEvents = {
  onPaneOpen(paneId: number, sink: TerminalSink): void;
  onPaneClose(paneId: number): void;
  onTitle(title: string): void;
  onActivePaneChange(paneId: number): void;
};

export interface TerminalTabRuntime {
  split(direction: 'vertical' | 'horizontal'): void;
  closePane(paneId: number): void;
  getActivePaneId(): number;
  refreshSettings(): void | Promise<void>;
  dispose(): void;
}

export interface TerminalWindowRuntime {
  createTab(
    id: string,
    intent: LaunchConnectionIntent,
    events: TerminalTabRuntimeEvents,
  ): Promise<TerminalTabRuntime>;
}

export type TerminalWindowCommand =
  | { type: 'open-tab'; intent: LaunchConnectionIntent }
  | { type: 'restore-tabs'; intents: LaunchConnectionIntent[]; activeIndex: number }
  | { type: 'activate-tab'; tabId: string }
  | { type: 'close-tab'; tabId?: string }
  | { type: 'reorder-tab'; tabId: string; toIndex: number }
  | { type: 'split-pane'; direction: 'vertical' | 'horizontal' }
  | { type: 'close-pane'; paneId?: number }
  | { type: 'reconnect-active-pane' }
  | { type: 'refresh-settings' };

export type TerminalPaneSnapshot = {
  id: number;
  status: TerminalTransportStatus;
  error?: string;
  resumeEtSessionId?: string;
};

export type TerminalTabSnapshot = {
  id: string;
  title: string;
  paneCount: number;
  activePaneId?: number;
  status: TerminalTransportStatus;
  error?: string;
  panes: TerminalPaneSnapshot[];
};

export type TerminalWindowSnapshot = {
  tabs: TerminalTabSnapshot[];
  activeTabId?: string;
  status: TerminalTransportStatus;
};

type PaneState = {
  id: number;
  sink: TerminalSink;
  transport: TerminalTransport;
  status: TerminalTransportStatus;
  error?: string;
  resumeEtSessionId?: string;
  generation: number;
  closed: boolean;
};

type TabState = {
  id: string;
  intent: LaunchConnectionIntent;
  title: string;
  runtime: TerminalTabRuntime | null;
  panes: Map<number, PaneState>;
  activePaneId?: number;
  primaryResumeId?: string;
  closed: boolean;
};

const STATUS_ORDER: TerminalTransportStatus[] = [
  'error', 'connecting', 'disconnecting', 'connected', 'idle', 'disconnected',
];

function reduceStatus(statuses: TerminalTransportStatus[]): TerminalTransportStatus {
  return STATUS_ORDER.find((status) => statuses.includes(status)) ?? 'idle';
}

export class TerminalWindowController {
  private readonly tabs: TabState[] = [];
  private readonly listeners = new Set<(snapshot: TerminalWindowSnapshot) => void>();
  private readonly pending = new Set<Promise<void>>();
  private activeTabId: string | undefined;
  private sequence = 0;
  private disposed = false;

  constructor(private readonly dependencies: {
    runtime: TerminalWindowRuntime;
    createTransport(intent: LaunchConnectionIntent, status: TransportStatusHandler): TerminalTransport;
    saveLayout?(intents: LaunchConnectionIntent[], activeIndex: number): void;
    closeOnNormalExit?(intent: LaunchConnectionIntent): boolean;
  }) {}

  async dispatch(command: TerminalWindowCommand): Promise<void> {
    if (this.disposed) return;
    switch (command.type) {
      case 'open-tab':
        await this.openTab(command.intent);
        break;
      case 'restore-tabs':
        for (const tab of [...this.tabs]) this.closeTab(tab);
        for (const intent of command.intents) await this.openTab(intent, false);
        this.activeTabId = this.tabs[Math.min(command.activeIndex, this.tabs.length - 1)]?.id;
        this.changed();
        break;
      case 'activate-tab':
        if (this.findTab(command.tabId)) this.activeTabId = command.tabId;
        this.changed();
        break;
      case 'close-tab': {
        const tab = command.tabId ? this.findTab(command.tabId) : this.activeTab();
        if (tab) this.closeTab(tab);
        break;
      }
      case 'reorder-tab': {
        const tab = this.findTab(command.tabId);
        if (tab) {
          const from = this.tabs.indexOf(tab);
          this.tabs.splice(from, 1);
          this.tabs.splice(Math.max(0, Math.min(command.toIndex, this.tabs.length)), 0, tab);
          this.changed();
        }
        break;
      }
      case 'split-pane':
        this.activeTab()?.runtime?.split(command.direction);
        await this.drain();
        break;
      case 'close-pane': {
        const tab = this.activeTab();
        const paneId = command.paneId ?? tab?.runtime?.getActivePaneId();
        if (tab && paneId !== undefined) tab.runtime?.closePane(paneId);
        await this.drain();
        break;
      }
      case 'reconnect-active-pane': {
        const tab = this.activeTab();
        const pane = tab?.panes.get(tab.runtime?.getActivePaneId() ?? tab.activePaneId ?? -1);
        if (tab && pane) await this.reconnectPane(tab, pane);
        break;
      }
      case 'refresh-settings':
        await Promise.all(this.tabs.map(async (tab) => tab.runtime?.refreshSettings()));
        this.changed(false);
        break;
    }
  }

  getSnapshot(): TerminalWindowSnapshot {
    const tabs = this.tabs.map((tab): TerminalTabSnapshot => {
      const panes = [...tab.panes.values()].map((pane) => ({
        id: pane.id, status: pane.status, error: pane.error,
        resumeEtSessionId: pane.resumeEtSessionId,
      }));
      const status = reduceStatus(panes.map((pane) => pane.status));
      return {
        id: tab.id, title: tab.title, paneCount: panes.length,
        activePaneId: tab.runtime?.getActivePaneId() ?? tab.activePaneId,
        status, error: panes.find((pane) => pane.status === 'error')?.error, panes,
      };
    });
    const active = tabs.find((tab) => tab.id === this.activeTabId);
    return { tabs, activeTabId: this.activeTabId, status: active?.status ?? 'idle' };
  }

  subscribe(listener: (snapshot: TerminalWindowSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.getSnapshot());
    return () => this.listeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const tab of [...this.tabs]) this.teardownTab(tab);
    this.tabs.length = 0;
    this.activeTabId = undefined;
    this.emit();
    this.listeners.clear();
  }

  private async openTab(intent: LaunchConnectionIntent, activate = true): Promise<void> {
    const id = `tab${++this.sequence}`;
    const tab: TabState = {
      id, intent: { ...intent, etSessionId: undefined }, title: connectionIntentTitle(intent),
      runtime: null, panes: new Map(), primaryResumeId: intent.etSessionId, closed: false,
    };
    this.tabs.push(tab);
    if (activate) this.activeTabId = id;
    this.changed();
    const events: TerminalTabRuntimeEvents = {
      onPaneOpen: (paneId, sink) => this.track(this.openPane(tab, paneId, sink)),
      onPaneClose: (paneId) => this.closePane(tab, paneId),
      onTitle: (title) => { if (!tab.closed) { tab.title = title.trim() || connectionIntentTitle(tab.intent); this.changed(false); } },
      onActivePaneChange: (paneId) => { if (!tab.closed) { tab.activePaneId = paneId; this.changed(false); } },
    };
    tab.runtime = await this.dependencies.runtime.createTab(id, tab.intent, events);
    await this.drain();
    this.changed();
  }

  private async openPane(tab: TabState, paneId: number, sink: TerminalSink): Promise<void> {
    if (this.disposed || tab.closed || tab.panes.has(paneId)) return;
    const resume = tab.panes.size === 0 ? tab.primaryResumeId : undefined;
    tab.primaryResumeId = undefined;
    let pane!: PaneState;
    const generation = 1;
    const status: TransportStatusHandler = (state, error, meta) => {
      if (pane?.closed || pane?.generation !== generation || tab.closed || this.disposed) return;
      pane.status = state === 'disconnected' && meta?.disconnectReason === 'transport' ? 'error' : state;
      pane.error = error;
      if (state === 'connected') pane.resumeEtSessionId = pane.transport.getPersistentSessionId?.() ?? pane.resumeEtSessionId;
      this.changed();
      if (
        state === 'disconnected' &&
        meta?.disconnectReason === 'normal-exit' &&
        (this.dependencies.closeOnNormalExit?.(tab.intent) ?? true)
      ) this.closePane(tab, paneId);
    };
    const transport = this.dependencies.createTransport({ ...tab.intent, etSessionId: resume }, status);
    pane = { id: paneId, sink, transport, status: 'connecting', resumeEtSessionId: resume, generation, closed: false };
    tab.panes.set(paneId, pane);
    tab.activePaneId ??= paneId;
    this.changed();
    try {
      await transport.connect(sink);
      if (!pane.closed) pane.resumeEtSessionId = transport.getPersistentSessionId?.() ?? pane.resumeEtSessionId;
    } catch (error) {
      status('error', error instanceof Error ? error.message : String(error));
    }
    this.changed();
  }

  private async reconnectPane(tab: TabState, pane: PaneState): Promise<void> {
    const resume = pane.resumeEtSessionId;
    this.teardownPane(pane);
    tab.panes.delete(pane.id);
    tab.primaryResumeId = resume;
    await this.openPane(tab, pane.id, pane.sink);
  }

  private closePane(tab: TabState, paneId: number): void {
    const pane = tab.panes.get(paneId);
    if (!pane) return;
    this.teardownPane(pane);
    tab.panes.delete(paneId);
    if (tab.panes.size === 0) this.closeTab(tab);
    else this.changed();
  }

  private closeTab(tab: TabState): void {
    const index = this.tabs.indexOf(tab);
    if (index < 0) return;
    this.teardownTab(tab);
    this.tabs.splice(index, 1);
    if (this.activeTabId === tab.id) this.activeTabId = this.tabs[Math.min(index, this.tabs.length - 1)]?.id;
    this.changed();
  }

  private teardownPane(pane: PaneState): void {
    if (pane.closed) return;
    pane.closed = true;
    pane.generation += 1;
    void pane.transport.disconnect().catch(() => undefined);
    pane.transport.dispose();
  }

  private teardownTab(tab: TabState): void {
    if (tab.closed) return;
    tab.closed = true;
    for (const pane of tab.panes.values()) this.teardownPane(pane);
    tab.panes.clear();
    tab.runtime?.dispose();
  }

  private activeTab(): TabState | undefined { return this.tabs.find((tab) => tab.id === this.activeTabId); }
  private findTab(id: string): TabState | undefined { return this.tabs.find((tab) => tab.id === id); }

  private changed(persist = true): void {
    if (persist) {
      const activeIndex = Math.max(0, this.tabs.findIndex((tab) => tab.id === this.activeTabId));
      this.dependencies.saveLayout?.(this.tabs.map((tab) => ({ ...tab.intent, etSessionId: [...tab.panes.values()][0]?.resumeEtSessionId })), activeIndex);
    }
    this.emit();
  }

  private emit(): void {
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) listener(snapshot);
  }

  private track(promise: Promise<void>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise));
  }

  private async drain(): Promise<void> {
    while (this.pending.size) await Promise.all([...this.pending]);
  }
}
