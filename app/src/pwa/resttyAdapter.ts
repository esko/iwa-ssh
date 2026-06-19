import { Terminal } from '@eslzzyl/restty/esm/xterm';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import type { PwaTerminalSettings } from './types';
import { DEFAULT_FONT_ID, bundledFontForSelection, isCustomSelection, customSelectionId } from './terminalFonts';
import { getCustomFontData } from './customFontStore';
import { getThemePalette } from './themes';
import type { TerminalPalette } from './types';

type Rgb = { r: number; g: number; b: number };

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '').trim();
  const v = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return {
    r: parseInt(v.slice(0, 2), 16) || 0,
    g: parseInt(v.slice(2, 4), 16) || 0,
    b: parseInt(v.slice(4, 6), 16) || 0,
  };
}

/** Convert our palette to restty's GhosttyTheme (semantic colors + 256-palette). */
function buildResttyTheme(p: TerminalPalette): unknown {
  const ansi = [
    p.black, p.red, p.green, p.yellow, p.blue, p.magenta, p.cyan, p.white,
    p.brightBlack, p.brightRed, p.brightGreen, p.brightYellow, p.brightBlue, p.brightMagenta, p.brightCyan, p.brightWhite,
  ];
  const palette: Array<Rgb | undefined> = new Array(256).fill(undefined);
  ansi.forEach((hex, i) => { palette[i] = hexToRgb(hex); });
  return {
    name: p.name,
    colors: {
      background: hexToRgb(p.background),
      foreground: hexToRgb(p.foreground),
      cursor: hexToRgb(p.cursor),
      cursorText: hexToRgb(p.background),
      selectionBackground: hexToRgb(p.selectionBackground),
      palette,
    },
    raw: {},
  };
}

/** DECSCUSR sequence for cursor shape + blink. */
function cursorSequence(style: 'block' | 'bar' | 'underline', blink: boolean): string {
  const steady = style === 'block' ? 2 : style === 'underline' ? 4 : 6;
  return `\x1b[${blink ? steady - 1 : steady} q`;
}

/**
 * Same-origin terminal fonts bundled with the app (`app/public/fonts/`).
 *
 * restty's built-in default font list resolves via the Local Font Access API
 * (gated/denied inside an IWA) and a jsdelivr CDN fetch. In the ChromeOS IWA
 * neither is reliable: there is no installed "JetBrains Mono Nerd Font" and the
 * CDN is offline / blocked, so no font buffer ever reaches text-shaper. With no
 * shaped font, `computeCellMetrics()` returns null and `gridState.cellH` stays
 * 0 — which makes restty's wheel handler bail (`!getGridState().cellH`) and
 * trackpad scrollback never moves. Loading our own font over the bundle origin
 * (allowed by the IWA CSP `connect-src 'self'`) guarantees a non-zero cell
 * height, which is what actually restores scrolling. Box-drawing/powerline
 * glyphs are rendered programmatically by restty, so a Nerd Font is not needed.
 */
type ResttyFontSource =
  | { type: 'url'; url: string; label: string }
  | { type: 'buffer'; data: ArrayBuffer; label: string };

/** JetBrains Mono — the default and the always-present fallback. */
const BUNDLED_FALLBACK: ResttyFontSource[] = [
  { type: 'url', url: '/fonts/JetBrainsMono-Regular.ttf', label: 'JetBrains Mono' },
  { type: 'url', url: '/fonts/JetBrainsMono-Bold.ttf', label: 'JetBrains Mono Bold' },
];

/**
 * Resolve a font selection (bundled id or `custom:<id>`) to restty fontSources.
 * The selected font is tried first; JetBrains Mono is always appended so a real
 * font always loads (cellH > 0) even if a custom buffer is missing or a bundled
 * URL fails. Box-drawing/powerline glyphs are drawn programmatically by restty,
 * so a Nerd Font is not required.
 */
async function resolveFontSources(selection: string): Promise<ResttyFontSource[]> {
  if (isCustomSelection(selection)) {
    const data = await getCustomFontData(customSelectionId(selection)).catch(() => undefined);
    if (data) return [{ type: 'buffer', data, label: 'Custom font' }, ...BUNDLED_FALLBACK];
    return BUNDLED_FALLBACK;
  }
  const font = bundledFontForSelection(selection);
  if (font.id === DEFAULT_FONT_ID) return BUNDLED_FALLBACK;
  const sources: ResttyFontSource[] = [{ type: 'url', url: font.regular, label: font.family }];
  if (font.bold) sources.push({ type: 'url', url: font.bold, label: `${font.family} Bold` });
  return [...sources, ...BUNDLED_FALLBACK];
}

/** Trim the device wheel ring (kept for the debug HUD; no network egress). */
function pushWheelLog(data: Record<string, unknown>): void {
  const win = window as unknown as { __resttyDebugLog?: { location: string; data: Record<string, unknown> }[] };
  const ring = win.__resttyDebugLog ?? [];
  ring.push({ location: 'wheel', data });
  if (ring.length > 60) ring.shift();
  win.__resttyDebugLog = ring;
}

// ---------------------------------------------------------------- pane I/O --

/** restty's per-pane PtyTransport callbacks (see vendor/restty/dist/pty/types.d.ts). */
type PaneCallbacks = {
  onConnect?: () => void;
  onDisconnect?: () => void;
  onData?: (data: string) => void;
  onStatus?: (shell: string) => void;
  onError?: (message: string, errors?: string[]) => void;
  onExit?: (code: number) => void;
};
type PaneConnectOptions = { url?: string; cols?: number; rows?: number; callbacks: PaneCallbacks };

/** The per-pane sink a {@link TerminalTransport} binds to (one per split). */
export type ResttyPaneSink = TerminalAdapter & { readonly paneId: number };

/**
 * Per-pane bridge between restty and a {@link TerminalTransport}.
 *
 * It is two things at once:
 *  - the `PtyTransport` restty drives for one pane — `connect()` stores the
 *    pane's render callbacks, `sendInput()` carries keystrokes + the parser's
 *    DA/DSR auto-replies out, `resize()` carries window-change, and
 *    `isConnected()` gates both (restty only routes a pane's bytes to its
 *    transport while connected);
 *  - the {@link TerminalAdapter} sink the transport binds to — `write()` pushes
 *    server output into the pane (`callbacks.onData`), and `onInput`/`onResize`
 *    deliver the pane's outbound bytes / size to the transport.
 *
 * One bridge per pane gives every split its own independent session, replacing
 * the spike's single shared loopback PTY + `term.write()` path.
 */
class PaneBridge implements TerminalAdapter {
  private callbacks: PaneCallbacks | null = null;
  private connected = false;
  private cols = 80;
  private rows = 24;
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private readonly decoder = new TextDecoder();

  constructor(
    readonly paneId: number,
    private readonly owner: ResttyTerminalAdapter,
  ) {}

  // --- PtyTransport surface (restty -> bridge) ---

  connect(options: PaneConnectOptions): void {
    this.callbacks = options.callbacks;
    if (options.cols) this.cols = options.cols;
    if (options.rows) this.rows = options.rows;
    this.connected = true;
    options.callbacks.onConnect?.();
    this.owner.notifyPaneOpen(this);
  }

  disconnect(): void {
    if (!this.connected) return;
    this.connected = false;
    this.callbacks?.onDisconnect?.();
  }

  sendInput(data: string): boolean {
    if (!data) return true;
    const log = (window as unknown as { __resttyPtyLog?: string[] }).__resttyPtyLog;
    if (log) log.push(data);
    this.inputListeners.forEach((cb) => cb(data));
    return true;
  }

  resize(cols: number, rows: number): boolean {
    this.emitResize(cols, rows);
    return true;
  }

  // Report connected so restty's WASM drainOutput() forwards DA/DSR replies.
  isConnected(): boolean {
    return this.connected;
  }

  destroy(): void {
    this.connected = false;
    this.callbacks = null;
    this.inputListeners.clear();
    this.resizeListeners.clear();
  }

  // --- TerminalAdapter sink (transport -> bridge -> pane) ---

  open(): void {}

  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    this.owner.captureOsc(this, text);
    this.callbacks?.onData?.(text);
  }

  onInput(cb: (data: string) => void): TerminalSubscription {
    this.inputListeners.add(cb);
    return { dispose: () => this.inputListeners.delete(cb) };
  }

  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }

  focus(): void {
    this.owner.focusPane(this.paneId);
  }

  dispose(): void {
    this.destroy();
  }

  getSize(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows };
  }

  emitResize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.resizeListeners.forEach((cb) => cb(cols, rows));
  }

  /** Route context-menu paste to this pane's transport (remote echo draws it). */
  emitInput(data: string): void {
    if (data) this.inputListeners.forEach((cb) => cb(data));
  }
}

type ResttyHandle = {
  getBackend?: () => string;
  updateSize?: (force?: boolean) => void;
  setFontSize?: (px: number) => void;
  applyTheme?: (theme: unknown, name?: string) => void;
  resize?: (cols: number, rows: number) => void;
  focus?: () => void;
};
type ResttyPaneHandleLite = {
  id: number;
  connectPty: (url?: string) => void;
  disconnectPty: () => void;
  sendInput: (text: string, source?: string) => void;
  applyTheme: (theme: unknown, sourceLabel?: string) => void;
  setFontSize: (px: number) => void;
  resize: (cols: number, rows: number) => void;
  focus: () => void;
  updateSize: (force?: boolean) => void;
  getBackend: () => string;
  getMouseStatus?: () => { active: boolean; mode: string } | undefined;
  copySelectionToClipboard: () => Promise<boolean>;
};
type ResttySurface = ResttyHandle & {
  setFontSources?: (sources: ResttyFontSource[]) => Promise<void>;
  splitActivePane?: (dir: 'vertical' | 'horizontal') => unknown;
  closePane?: (id: number) => boolean;
  setActivePane?: (id: number, options?: { focus?: boolean }) => void;
  getActivePane?: () => { id: number } | null;
  pane?: (id: number) => ResttyPaneHandleLite | null;
  activePane?: () => ResttyPaneHandleLite | null;
  panes?: () => ResttyPaneHandleLite[];
};

type PaneState = { bridge: PaneBridge; title: string | null; cwd: string | null; oscBuffer: string };

/**
 * Adapter backed by restty's xterm-compat shim (libghostty-vt → WASM,
 * WebGPU/WebGL2 GPU atlas). restty answers DA1/DSR queries and implements
 * scrollback, which wterm's libghostty build does not.
 *
 * Each restty pane (split) runs an independent session through its own
 * {@link PaneBridge}; the adapter owns layout/appearance/title and exposes
 * `onPaneOpen`/`onPaneClose` so the view layer can bind one transport per pane.
 */
export class ResttyTerminalAdapter implements TerminalAdapter {
  private term: Terminal | null = null;
  private root: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly panes = new Map<number, PaneState>();
  private activePaneId = -1;
  private readonly titleListeners = new Set<(title: string) => void>();
  private readonly paneOpenListeners = new Set<(sink: PaneBridge) => void>();
  private readonly paneCloseListeners = new Set<(paneId: number) => void>();
  private readonly openedPanes = new Set<number>();
  private pendingOpen: PaneBridge[] = [];
  private wheelForwardCleanup: (() => void) | null = null;
  private pointerFocusCleanup: (() => void) | null = null;
  private settings: PwaTerminalSettings | null = null;

  private get surface(): ResttySurface | null {
    return (this.term?.restty as ResttySurface | null) ?? null;
  }

  static async create(el: HTMLElement, settings: PwaTerminalSettings): Promise<ResttyTerminalAdapter> {
    const adapter = new ResttyTerminalAdapter();
    adapter.root = el;
    adapter.settings = settings;
    // Resolve the selected font (bundled or user-provided) to same-origin URL /
    // buffer sources before opening; restty's default font list (Local Font
    // Access + CDN) is unusable in the IWA. JetBrains Mono is always appended as
    // a fallback so a real font loads (cellH > 0), which keeps scrolling alive.
    const fontSources = await resolveFontSources(settings.fontFamily);

    const term = new Terminal({
      // Per-pane app options: every pane (the first and every split) gets its
      // own PtyTransport bridge keyed by the pane id restty assigns it.
      appOptions: (ctx: { id: number }) => ({
        ptyTransport: adapter.registerPane(ctx.id),
        fontSources,
        autoResize: true,
        attachCanvasEvents: true,
        // restty touch pan is armed on pointerdown only in long-press/drag modes
        // (see bind-pointer-events.ts); "off" disables touch scroll entirely.
        touchSelectionMode: 'long-press',
        maxScrollbackBytes: Math.max(1_000_000, settings.scrollback * 200),
        callbacks: {
          onGridSize: (cols: number, rows: number) => adapter.panes.get(ctx.id)?.bridge.emitResize(cols, rows),
        },
      }),
      // Built-in split keybindings stay off; the app drives splits explicitly so
      // it can bind a transport to each new pane (Ctrl+Shift+D/E in views.ts).
      shortcuts: false,
      onPaneSplit: (_src: { id: number }, created: { id: number }) => adapter.handlePaneCreated(created.id),
      onPaneClosed: (pane: { id: number }) => adapter.handlePaneClosed(pane.id),
      onActivePaneChange: (pane: { id: number } | null) => adapter.handleActivePaneChange(pane?.id ?? -1),
    } as unknown as ConstructorParameters<typeof Terminal>[0]);

    term.open(el);
    adapter.term = term;
    await adapter.waitForBackend();
    // The initial pane was created during open() before term.restty existed, so
    // connect it now; splits connect from onPaneSplit (term.restty is live then).
    const firstId = [...adapter.panes.keys()][0] ?? -1;
    if (firstId >= 0) {
      adapter.activePaneId = firstId;
      adapter.connectPane(firstId);
      await adapter.waitForPaneReady(firstId);
    }
    adapter.syncLayout();
    adapter.installScrollGuard(el);
    adapter.installPointerFocus(el);
    adapter.resizeObserver = new ResizeObserver(() => {
      adapter.syncLayout();
      adapter.installScrollGuard(el);
    });
    adapter.resizeObserver.observe(el);
    adapter.setAppearance(settings);
    term.focus();
    // Expose for the CDP harness / debug HUD.
    const win = window as unknown as {
      __resttyAdapter?: ResttyTerminalAdapter;
      __resttyBackend?: string;
      __resttyPtyLog?: string[];
    };
    win.__resttyAdapter = adapter;
    win.__resttyBackend = adapter.surface?.getBackend?.() ?? '';
    win.__resttyPtyLog = [];
    return adapter;
  }

  /** Factory hook: build (or reuse) the bridge restty drives for a pane. */
  registerPane(id: number): PaneBridge {
    let state = this.panes.get(id);
    if (!state) {
      state = { bridge: new PaneBridge(id, this), title: null, cwd: null, oscBuffer: '' };
      this.panes.set(id, state);
    }
    return state.bridge;
  }

  /** restty signals a pane is connected → let the view bind a transport to it. */
  notifyPaneOpen(bridge: PaneBridge): void {
    if (this.openedPanes.has(bridge.paneId)) return;
    this.openedPanes.add(bridge.paneId);
    if (this.paneOpenListeners.size === 0) {
      this.pendingOpen.push(bridge);
      return;
    }
    this.paneOpenListeners.forEach((cb) => cb(bridge));
  }

  onPaneOpen(cb: (sink: ResttyPaneSink) => void): TerminalSubscription {
    this.paneOpenListeners.add(cb);
    const queued = this.pendingOpen;
    this.pendingOpen = [];
    queued.forEach((bridge) => cb(bridge));
    return { dispose: () => this.paneOpenListeners.delete(cb) };
  }

  onPaneClose(cb: (paneId: number) => void): TerminalSubscription {
    this.paneCloseListeners.add(cb);
    return { dispose: () => this.paneCloseListeners.delete(cb) };
  }

  /** Split the focused pane; the new pane connects via onPaneSplit. */
  split(direction: 'vertical' | 'horizontal'): void {
    this.surface?.splitActivePane?.(direction);
  }

  /** Close the focused pane (its transport is torn down via onPaneClosed). */
  closeActivePane(): boolean {
    return this.closePaneById(this.activePaneId);
  }

  /** Close a pane by id; refuses to close the last remaining pane. */
  closePaneById(id: number): boolean {
    if (id < 0 || this.panes.size <= 1) return false;
    return this.surface?.closePane?.(id) ?? false;
  }

  paneCount(): number {
    return this.panes.size;
  }

  getActivePaneId(): number {
    return this.activePaneId;
  }

  private handlePaneCreated(id: number): void {
    this.registerPane(id);
    this.connectPane(id);
    this.syncLayout();
    if (this.root) this.installScrollGuard(this.root);
    if (this.settings) this.applyAppearanceToPane(id, this.settings);
  }

  private handlePaneClosed(id: number): void {
    this.panes.delete(id);
    this.openedPanes.delete(id);
    this.paneCloseListeners.forEach((cb) => cb(id));
    this.syncLayout();
  }

  private handleActivePaneChange(id: number): void {
    if (id >= 0) this.activePaneId = id;
  }

  private connectPane(id: number): void {
    const handle = this.surface?.pane?.(id);
    handle?.connectPty();
  }

  private activeHandle(): ResttyPaneHandleLite | null {
    const surface = this.surface;
    if (!surface) return null;
    return surface.pane?.(this.activePaneId) ?? surface.activePane?.() ?? null;
  }

  focusPane(id: number): void {
    this.activePaneId = id;
    this.surface?.setActivePane?.(id, { focus: true });
  }

  // create() does the real work; open() exists to satisfy the interface.
  open(): void {}

  /** Inject output into the active pane (used by reconnect's clear-screen). */
  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.activeHandle()?.sendInput(text, 'pty');
  }

  onInput(): TerminalSubscription {
    // Input is bound per-pane via PaneBridge; the adapter itself has no stream.
    return { dispose: () => undefined };
  }

  onResize(): TerminalSubscription {
    return { dispose: () => undefined };
  }

  onTitle(cb: (title: string) => void): TerminalSubscription {
    this.titleListeners.add(cb);
    return { dispose: () => this.titleListeners.delete(cb) };
  }

  focus(): void {
    this.term?.focus();
  }

  fit(): void {
    this.syncLayout();
  }

  getSize(): { cols: number; rows: number } {
    return this.panes.get(this.activePaneId)?.bridge.getSize() ?? { cols: 80, rows: 24 };
  }

  getSelection(): string {
    return '';
  }

  hasSelection(): boolean {
    return false;
  }

  /** Copy the focused pane's canvas selection to the clipboard (no-op if empty). */
  async copySelectionToClipboard(): Promise<boolean> {
    return (await this.activeHandle()?.copySelectionToClipboard?.().catch(() => false)) ?? false;
  }

  paste(data: string): void {
    if (!data) return;
    // Context-menu paste: send to the focused pane's transport (remote echo
    // draws it). Do not also route through restty keyboard handling.
    this.panes.get(this.activePaneId)?.bridge.emitInput(data);
  }

  getCwd(): string | null {
    return this.panes.get(this.activePaneId)?.cwd ?? null;
  }

  updateAppearance(): void {}

  /** Apply theme colors, cursor shape/blink, and font size to every pane. */
  setAppearance(settings: PwaTerminalSettings): void {
    this.settings = settings;
    for (const id of this.panes.keys()) this.applyAppearanceToPane(id, settings);
  }

  private applyAppearanceToPane(id: number, settings: PwaTerminalSettings): void {
    const handle = this.surface?.pane?.(id);
    if (!handle) return;
    const palette = getThemePalette(settings.theme);
    handle.applyTheme(buildResttyTheme(palette), palette.name);
    if (Number.isFinite(settings.fontSize)) handle.setFontSize(settings.fontSize);
    handle.sendInput(cursorSequence(settings.cursorStyle, settings.cursorBlink), 'pty');
  }

  /** Reapply the terminal font live (every pane) without reopening. */
  async setFont(settings: PwaTerminalSettings): Promise<void> {
    this.settings = settings;
    const sources = await resolveFontSources(settings.fontFamily);
    await this.surface?.setFontSources?.(sources);
    this.syncLayout();
  }

  /** SPIKE debug: mouse mode + grid/canvas snapshot for the focused pane. */
  getDebugSummary(): Record<string, unknown> {
    const handle = this.activeHandle();
    const mouse = handle?.getMouseStatus?.();
    const canvas = this.root?.querySelector('canvas');
    const size = this.getSize();
    return {
      mouse,
      panes: this.panes.size,
      grid: { cols: size.cols, rows: size.rows },
      canvas: canvas
        ? { px: `${canvas.width}×${canvas.height}`, client: `${canvas.clientWidth}×${canvas.clientHeight}` }
        : null,
    };
  }

  /** SPIKE debug: per-pane grid + backend (cols/rows > 0 ⇒ cellH > 0 ⇒ scrollable). */
  paneMetrics(): Array<{ id: number; cols: number; rows: number; backend: string }> {
    return [...this.panes.entries()].map(([id, state]) => {
      const size = state.bridge.getSize();
      return { id, cols: size.cols, rows: size.rows, backend: this.surface?.pane?.(id)?.getBackend() ?? '' };
    });
  }

  /** SPIKE debug: fill scrollback then dispatch trackpad-like wheel ticks. */
  probeScrollWheel(): void {
    let block = '';
    for (let i = 1; i <= 80; i += 1) block += `scroll-probe ${i}\r\n`;
    this.write(block);
    const canvas = this.root?.querySelector('canvas');
    if (!canvas) return;
    for (let i = 0; i < 5; i += 1) {
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, deltaMode: 0, bubbles: true, cancelable: true }));
    }
  }

  dispose(): void {
    this.wheelForwardCleanup?.();
    this.wheelForwardCleanup = null;
    this.pointerFocusCleanup?.();
    this.pointerFocusCleanup = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.term?.dispose();
    this.term = null;
    this.panes.clear();
    this.openedPanes.clear();
    this.pendingOpen = [];
    this.titleListeners.clear();
    this.paneOpenListeners.clear();
    this.paneCloseListeners.clear();
  }

  private async waitForBackend(timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const backend = this.surface?.getBackend?.();
      if (backend === 'webgpu' || backend === 'webgl2' || backend === 'webgl') return;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error('restty backend not ready');
  }

  // getBackend() resolves before wasmPromise finishes in restty init(); probe DA
  // so keyboard IME handlers (which require wasm) are actually live.
  private async waitForPaneReady(id: number, timeoutMs = 20_000): Promise<void> {
    const bridge = this.panes.get(id)?.bridge;
    const handle = this.surface?.pane?.(id);
    if (!bridge || !handle) return;
    const deadline = Date.now() + timeoutMs;
    let daReply = false;
    const sub = bridge.onInput(() => { daReply = true; });
    handle.sendInput('\x1b[c', 'pty');
    while (!daReply && Date.now() < deadline) {
      handle.updateSize(true);
      await new Promise((r) => setTimeout(r, 50));
    }
    sub.dispose();
    if (!daReply) throw new Error('restty wasm input path not ready (DA probe failed)');
  }

  private syncLayout(): void {
    this.surface?.updateSize?.(true);
  }

  /**
   * Trackpad scroll is wheel on a restty canvas (bubble listener). Forward
   * parent-target wheels to the canvas under the pointer and bypass the
   * mouse-reporting hijack with Shift. Re-scans canvases so splits are covered.
   */
  private installScrollGuard(root: HTMLElement): void {
    this.wheelForwardCleanup?.();
    const canvases = Array.from(root.querySelectorAll('canvas'));
    if (canvases.length === 0) {
      this.wheelForwardCleanup = null;
      return;
    }

    const canvasUnder = (x: number, y: number): HTMLCanvasElement | null => {
      for (const canvas of canvases) {
        const rect = canvas.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return canvas;
      }
      return null;
    };
    const dispatchCanvasWheel = (canvas: HTMLElement, source: WheelEvent, shiftKey: boolean): void => {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: source.deltaX,
          deltaY: source.deltaY,
          deltaZ: source.deltaZ,
          deltaMode: source.deltaMode,
          clientX: source.clientX,
          clientY: source.clientY,
          ctrlKey: source.ctrlKey,
          shiftKey,
          altKey: source.altKey,
          metaKey: source.metaKey,
          bubbles: true,
          cancelable: true,
        }),
      );
    };

    const onCanvasWheelCapture = (event: WheelEvent): void => {
      const mouse = this.activeHandle()?.getMouseStatus?.();
      if (!event.shiftKey && mouse?.active) {
        event.stopImmediatePropagation();
        event.preventDefault();
        dispatchCanvasWheel(event.currentTarget as HTMLElement, event, true);
      }
    };

    const onRootWheelCapture = (event: WheelEvent): void => {
      if (event.target instanceof HTMLCanvasElement) return;
      const canvas = canvasUnder(event.clientX, event.clientY);
      if (!canvas || !root.contains(event.target as Node)) return;
      const mouse = this.activeHandle()?.getMouseStatus?.();
      pushWheelLog({ deltaY: event.deltaY, forwarded: true });
      event.stopImmediatePropagation();
      event.preventDefault();
      dispatchCanvasWheel(canvas, event, event.shiftKey || !!mouse?.active);
    };

    canvases.forEach((canvas) =>
      canvas.addEventListener('wheel', onCanvasWheelCapture, { capture: true, passive: false }),
    );
    root.addEventListener('wheel', onRootWheelCapture, { capture: true, passive: false });
    this.wheelForwardCleanup = () => {
      canvases.forEach((canvas) =>
        canvas.removeEventListener('wheel', onCanvasWheelCapture, { capture: true }),
      );
      root.removeEventListener('wheel', onRootWheelCapture, { capture: true });
    };
  }

  private installPointerFocus(root: HTMLElement): void {
    this.pointerFocusCleanup?.();
    const onPointerDown = () => this.term?.focus();
    root.addEventListener('pointerdown', onPointerDown, { passive: true });
    this.pointerFocusCleanup = () => root.removeEventListener('pointerdown', onPointerDown);
  }

  // OSC 0/2 (window title) and OSC 7 (cwd). ESC ] N ; payload (BEL | ST).
  // Scanned per pane across writes; the buffer is bounded so old matches age out.
  captureOsc(bridge: PaneBridge, data: string): void {
    const state = this.panes.get(bridge.paneId);
    if (!state) return;
    state.oscBuffer = (state.oscBuffer + data).slice(-2048);
    let consumed = 0;

    const titleRe = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    let lastTitle: RegExpExecArray | null = null;
    while ((m = titleRe.exec(state.oscBuffer))) lastTitle = m;
    if (lastTitle) {
      consumed = Math.max(consumed, lastTitle.index + lastTitle[0].length);
      const title = lastTitle[2];
      if (title !== state.title) {
        state.title = title;
        if (bridge.paneId === this.activePaneId) this.titleListeners.forEach((cb) => cb(title));
      }
    }

    const cwdRe = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let c: RegExpExecArray | null;
    let lastCwd: RegExpExecArray | null = null;
    while ((c = cwdRe.exec(state.oscBuffer))) lastCwd = c;
    if (lastCwd) {
      consumed = Math.max(consumed, lastCwd.index + lastCwd[0].length);
      try {
        state.cwd = decodeURIComponent(lastCwd[1]);
      } catch {
        state.cwd = lastCwd[1];
      }
    }

    if (consumed) state.oscBuffer = state.oscBuffer.slice(consumed);
  }
}
