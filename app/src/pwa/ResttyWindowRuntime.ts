import type { LaunchConnectionIntent } from '../connections/ConnectionIntent';
import type { TerminalSubscription } from '../terminal/TerminalAdapter';
import type {
  TerminalTabRuntime,
  TerminalTabRuntimeEvents,
  TerminalWindowRuntime,
} from './TerminalWindowController';
import { ResttyTerminalAdapter, type ResttyPaneSink } from './resttyAdapter';
import { recordConnection } from './profileModel';
import { ensureTerminalFontLoaded } from './settings';
import { resolveSettings } from './settingsProfiles';

/** Read-only handle the view layer uses to drive a tab's DOM + renderer. */
export type RuntimeTabView = {
  id: string;
  intent: LaunchConnectionIntent;
  container: HTMLElement;
  terminal: ResttyTerminalAdapter;
};

/**
 * One terminal tab's DOM + renderer, presented to {@link TerminalWindowController}
 * through the {@link TerminalTabRuntime} command surface. The controller owns the
 * session/pane lifecycle and transports; this class only mediates Restty.
 */
class RuntimeTab implements TerminalTabRuntime {
  private appliedFont: string;
  private readonly subs: TerminalSubscription[] = [];

  constructor(
    readonly id: string,
    readonly intent: LaunchConnectionIntent,
    readonly container: HTMLElement,
    readonly terminal: ResttyTerminalAdapter,
    events: TerminalTabRuntimeEvents,
    appliedFont: string,
    private readonly onDispose: () => void,
  ) {
    this.appliedFont = appliedFont;
    this.subs.push(terminal.onPaneClose((paneId) => events.onPaneClose(paneId)));
    this.subs.push(terminal.onTitle((title) => events.onTitle(title)));
    // Registering the open listener last flushes Restty's queued first pane, so
    // the controller binds a transport to it (and to every later split).
    this.subs.push(terminal.onPaneOpen((sink: ResttyPaneSink) => events.onPaneOpen(sink.paneId, sink)));
    terminal.fit?.();
  }

  split(direction: 'vertical' | 'horizontal'): void {
    this.terminal.split(direction);
  }

  closePane(paneId: number): void {
    this.terminal.closePaneById(paneId);
  }

  getActivePaneId(): number {
    return this.terminal.getActivePaneId();
  }

  async refreshSettings(): Promise<void> {
    const settings = resolveSettings(this.intent.settingsProfileId);
    this.terminal.setAppearance(settings);
    this.terminal.fit?.();
    // The font swap is heavier than the theme/cursor reapply, so only run it when
    // the selection actually changed.
    if (settings.fontFamily !== this.appliedFont) {
      this.appliedFont = settings.fontFamily;
      await ensureTerminalFontLoaded(settings);
      await this.terminal.setFont(settings);
    }
  }

  dispose(): void {
    for (const sub of this.subs) sub.dispose();
    this.subs.length = 0;
    this.terminal.dispose();
    this.container.remove();
    this.onDispose();
  }
}

/**
 * Restty/DOM-backed {@link TerminalWindowRuntime}. Each tab gets its own surface
 * element and {@link ResttyTerminalAdapter}; the controller drives them through the
 * returned {@link TerminalTabRuntime}, while {@link getView} / {@link setActive} let
 * the snapshot renderer toggle visibility and reach the active pane for copy/paste.
 */
export class ResttyWindowRuntime implements TerminalWindowRuntime {
  private readonly tabs = new Map<string, RuntimeTab>();

  constructor(private readonly host: HTMLElement) {}

  async createTab(
    id: string,
    intent: LaunchConnectionIntent,
    events: TerminalTabRuntimeEvents,
  ): Promise<TerminalTabRuntime> {
    const settings = resolveSettings(intent.settingsProfileId);
    await ensureTerminalFontLoaded(settings);

    const container = document.createElement('div');
    container.className = 'term-session';
    container.hidden = true; // setActive reveals the focused tab.
    const surface = document.createElement('main');
    surface.className = 'term-surface';
    surface.setAttribute('aria-label', 'Terminal');
    container.append(surface);
    this.host.append(container);

    const terminal = await ResttyTerminalAdapter.create(surface, settings);
    surface.dataset.renderer = 'restty';
    terminal.setAppearance?.(settings);
    await recordConnection(intent);

    const tab = new RuntimeTab(
      id,
      intent,
      container,
      terminal,
      events,
      settings.fontFamily,
      () => this.tabs.delete(id),
    );
    this.tabs.set(id, tab);
    return tab;
  }

  getView(id: string | undefined): RuntimeTabView | undefined {
    if (!id) return undefined;
    const tab = this.tabs.get(id);
    return tab && { id: tab.id, intent: tab.intent, container: tab.container, terminal: tab.terminal };
  }

  /** Show only the active tab's surface; hide and unfocus the rest. */
  setActive(id: string | undefined): void {
    for (const tab of this.tabs.values()) tab.container.hidden = tab.id !== id;
    const tab = id ? this.tabs.get(id) : undefined;
    if (!tab) return;
    tab.terminal.focus();
    tab.terminal.fit?.();
  }
}
