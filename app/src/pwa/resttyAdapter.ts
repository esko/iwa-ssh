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

/** Minimal PtyTransport shape — DA/DSR replies route here, not onData (source=pty). */
type LoopbackPtyTransport = {
  connect: () => void;
  disconnect: () => void;
  sendInput: (data: string) => boolean;
  resize: (cols: number, rows: number) => boolean;
  isConnected: () => boolean;
  destroy: () => void;
};

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

type ResttyDebugEntry = {
  sessionId: string;
  location: string;
  message: string;
  data: Record<string, unknown>;
  timestamp: number;
  hypothesisId: string;
};

function agentLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
): void {
  const entry: ResttyDebugEntry = {
    sessionId: 'b42bad',
    location,
    message,
    data,
    timestamp: Date.now(),
    hypothesisId,
  };
  const win = window as unknown as { __resttyDebugLog?: ResttyDebugEntry[] };
  const ring = win.__resttyDebugLog ?? [];
  ring.push(entry);
  if (ring.length > 120) ring.shift();
  win.__resttyDebugLog = ring;
  // #region agent log
  fetch('http://127.0.0.1:7889/ingest/a7434359-56dc-434f-91db-1acc691680a2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': 'b42bad' },
    body: JSON.stringify(entry),
  }).catch(() => {});
  // #endregion
}

function createLoopbackPtyTransport(
  onDeviceResponse: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
  debugCtx: { markPtyWrite: () => void; clearPtyWrite: () => void; isPtyWritePending: () => boolean },
): LoopbackPtyTransport {
  return {
    connect: () => {},
    disconnect: () => {},
    sendInput: (data) => {
      if (data) {
        const log = (window as unknown as { __resttyPtyLog?: string[] }).__resttyPtyLog;
        if (log) log.push(data);
        agentLog(
          'resttyAdapter.ts:pty-sendInput',
          'loopback pty sendInput',
          { len: data.length, preview: data.slice(0, 24), afterPtyWrite: debugCtx.isPtyWritePending() },
          'H1',
        );
        onDeviceResponse(data);
      }
      return true;
    },
    resize: (cols, rows) => {
      agentLog('resttyAdapter.ts:pty-resize', 'loopback pty resize', { cols, rows }, 'H4');
      onResize(cols, rows);
      return true;
    },
    // Must report connected so WASM drainOutput() forwards replies after PTY writes.
    isConnected: () => true,
    destroy: () => {},
  };
}

async function waitForResttyReady(
  term: Terminal,
  probeInput: (cb: (data: string) => void) => TerminalSubscription,
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let backend = '';
  while (Date.now() < deadline) {
    const next = term.restty?.getBackend?.();
    if (next === 'webgpu' || next === 'webgl2' || next === 'webgl') {
      backend = next;
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!backend) throw new Error('restty backend not ready');

  // getBackend() is set before wasmPromise finishes in restty init(); probe DA so
  // keyboard IME handlers (which require wasm) are actually live.
  let daReply = false;
  const sub = probeInput(() => {
    daReply = true;
  });
  term.write('\x1b[c');
  while (!daReply && Date.now() < deadline) {
    term.restty?.updateSize(true);
    await new Promise((r) => setTimeout(r, 50));
  }
  sub.dispose();
  if (!daReply) throw new Error('restty wasm input path not ready (DA probe failed)');
  agentLog('resttyAdapter.ts:ready', 'restty ready', { backend }, 'H-delay');
  return backend;
}

/**
 * SPIKE adapter backed by restty's xterm-compat shim (libghostty-vt → WASM,
 * WebGPU/WebGL2 GPU atlas). The reason for the migration: restty answers DA1/DSR
 * queries and implements scrollback, which wterm's libghostty build does not.
 *
 * This is the minimal surface needed to prove render + DA replies + scrollback
 * behind a temporary renderer flag in views.ts (restty default on spike branch;
 * ?renderer=wterm opts back). The full adapter (byte-write path, theme/font
 * mapping, real selection/title) is Phase 1.
 */
export class ResttyTerminalAdapter implements TerminalAdapter {
  private term: Terminal | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();
  private gridCols = 80;
  private gridRows = 24;
  private wheelForwardCleanup: (() => void) | null = null;
  private pointerFocusCleanup: (() => void) | null = null;
  private cwd: string | null = null;
  private lastTitle: string | null = null;
  private oscBuffer = '';
  private readonly decoder = new TextDecoder();

  private emitResize(cols: number, rows: number): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols <= 0 || rows <= 0) return;
    if (cols === this.gridCols && rows === this.gridRows) return;
    this.gridCols = cols;
    this.gridRows = rows;
    if (this.term) {
      this.term.cols = cols;
      this.term.rows = rows;
    }
    this.resizeListeners.forEach((cb) => cb(cols, rows));
  }

  static async create(el: HTMLElement, settings: PwaTerminalSettings): Promise<ResttyTerminalAdapter> {
    const adapter = new ResttyTerminalAdapter();
    let ptyWriteDepth = 0;
    const debugCtx = {
      markPtyWrite: () => { ptyWriteDepth += 1; },
      clearPtyWrite: () => { ptyWriteDepth = Math.max(0, ptyWriteDepth - 1); },
      isPtyWritePending: () => ptyWriteDepth > 0,
    };
    const emitInput = (data: string) => {
      agentLog(
        'resttyAdapter.ts:emitInput',
        'adapter inputListeners emit',
        { len: data.length, preview: data.slice(0, 24), listenerCount: adapter.inputListeners.size },
        'H2',
      );
      adapter.inputListeners.forEach((cb) => cb(data));
    };
    // Resolve the selected font (bundled or user-provided) to same-origin URL /
    // buffer sources before opening; restty's default font list (Local Font
    // Access + CDN) is unusable in the IWA. JetBrains Mono is always appended as
    // a fallback so a real font loads (cellH > 0), which keeps scrolling alive.
    const fontSources = await resolveFontSources(settings.fontFamily);
    const term = new Terminal({
      appOptions: {
        ptyTransport: createLoopbackPtyTransport(emitInput, (cols, rows) => adapter.emitResize(cols, rows), debugCtx),
        fontSources,
        autoResize: true,
        attachCanvasEvents: true,
        // restty touch pan is armed on pointerdown only in long-press/drag modes (see
        // bind-pointer-events.ts); "off" disables touch scroll entirely on touchscreens.
        touchSelectionMode: 'long-press',
        maxScrollbackBytes: Math.max(1_000_000, settings.scrollback * 200),
        callbacks: {
          onGridSize: (cols, rows) => {
            adapter.emitResize(cols, rows);
            agentLog(
              'resttyAdapter.ts:onGridSize',
              'restty onGridSize',
              { cols, rows, xtermCols: term.cols, xtermRows: term.rows },
              'H4',
            );
          },
          onCanvasSize: (width, height) => {
            const canvas = el.querySelector('canvas');
            agentLog(
              'resttyAdapter.ts:onCanvasSize',
              'restty onCanvasSize',
              { width, height, clientW: canvas?.clientWidth, clientH: canvas?.clientHeight },
              'H5',
            );
          },
        },
      },
    });
    term.open(el);
    const backend = await waitForResttyReady(term, (cb) => adapter.onInput(cb));
    adapter.syncLayout();
    adapter.installScrollGuard(el);
    adapter.installPointerFocus(el);
    adapter.resizeObserver = new ResizeObserver(() => {
      adapter.syncLayout();
      adapter.installScrollGuard(el);
    });
    adapter.resizeObserver.observe(el);
    // Outbound bytes (keys, paste, DA/DSR replies) must use the loopback PTY only.
    // term.onData would duplicate keyboard when isConnected() is true.
    term.onResize(({ cols, rows }) => adapter.resizeListeners.forEach((cb) => cb(cols, rows)));
    adapter.term = term;
    adapter.setAppearance(settings);
    term.focus();
    // SPIKE-ONLY: expose the adapter so the CDP harness can probe DA/DSR replies
    // and the render backend. Removed in Phase 1.
    (window as unknown as { __resttyAdapter?: ResttyTerminalAdapter; __resttyBackend?: string; __resttyPtyLog?: string[]; __resttyDebugCtx?: typeof debugCtx }).__resttyAdapter = adapter;
    (window as unknown as { __resttyBackend?: string }).__resttyBackend = backend;
    (window as unknown as { __resttyPtyLog?: string[] }).__resttyPtyLog = [];
    (window as unknown as { __resttyDebugCtx?: typeof debugCtx }).__resttyDebugCtx = debugCtx;
    return adapter;
  }

  // create() does the real work; open() exists to satisfy the interface.
  open(): void {}

  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    this.captureOsc(text);
    const ctx = (window as unknown as { __resttyDebugCtx?: { markPtyWrite: () => void; clearPtyWrite: () => void } }).__resttyDebugCtx;
    ctx?.markPtyWrite();
    this.term?.write(text);
    queueMicrotask(() => ctx?.clearPtyWrite());
    agentLog('resttyAdapter.ts:write', 'adapter write to term', { len: text.length, preview: text.slice(0, 24) }, 'H1');
  }

  onInput(cb: (data: string) => void): TerminalSubscription {
    this.inputListeners.add(cb);
    return { dispose: () => this.inputListeners.delete(cb) };
  }

  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }

  onTitle(cb: (title: string) => void): TerminalSubscription {
    this.titleListeners.add(cb);
    return { dispose: () => this.titleListeners.delete(cb) };
  }

  focus(): void {
    this.term?.focus();
  }

  // restty owns its own resize; nothing to do here.
  fit(): void {
    this.syncLayout();
  }

  getSize(): { cols: number; rows: number } {
    return { cols: this.gridCols, rows: this.gridRows };
  }

  // restty owns selection on the GPU canvas and doesn't expose the text, but it
  // can copy the active selection straight to the clipboard.
  getSelection(): string {
    return '';
  }

  hasSelection(): boolean {
    return false;
  }

  /** Copy restty's current canvas selection to the clipboard (no-op if empty). */
  async copySelectionToClipboard(): Promise<boolean> {
    const restty = this.term?.restty as { copySelectionToClipboard?: () => Promise<boolean> } | undefined;
    return (await restty?.copySelectionToClipboard?.().catch(() => false)) ?? false;
  }

  paste(data: string): void {
    if (!data) return;
    agentLog('resttyAdapter.ts:paste', 'context-menu paste', { len: data.length, preview: data.slice(0, 24) }, 'H3');
    // Context-menu paste: send to transport only (remote echo draws). Do not also
    // route through restty keyboard handling — that duplicates with Ctrl+V paste.
    this.inputListeners.forEach((cb) => cb(data));
  }

  getCwd(): string | null {
    return this.cwd;
  }

  updateAppearance(): void {}

  /** Apply theme colors, cursor shape/blink, and font size to the live terminal. */
  setAppearance(settings: PwaTerminalSettings): void {
    const restty = this.term?.restty as
      | { applyTheme?: (theme: unknown, name?: string) => void; setFontSize?: (px: number) => void }
      | undefined;
    if (!restty) return;
    const palette = getThemePalette(settings.theme);
    restty.applyTheme?.(buildResttyTheme(palette), palette.name);
    if (Number.isFinite(settings.fontSize)) restty.setFontSize?.(settings.fontSize);
    this.term?.write(cursorSequence(settings.cursorStyle, settings.cursorBlink));
  }

  /** Reapply the terminal font live (e.g. after a settings change) without reopening. */
  async setFont(settings: PwaTerminalSettings): Promise<void> {
    const restty = this.term?.restty as
      | { setFontSources?: (sources: ResttyFontSource[]) => Promise<void> }
      | undefined;
    if (!restty?.setFontSources) return;
    const sources = await resolveFontSources(settings.fontFamily);
    await restty.setFontSources(sources);
    this.syncLayout();
  }

  /** SPIKE debug: mouse mode + recent wheel/scroll logs (device ring buffer). */
  getDebugSummary(): Record<string, unknown> {
    const mouse = this.term?.restty?.getMouseStatus?.();
    const canvas = this.term?.element?.querySelector('canvas');
    const logs = (window as unknown as { __resttyDebugLog?: ResttyDebugEntry[] }).__resttyDebugLog ?? [];
    const wheelLogs = logs.filter((e) => e.location.includes('wheel'));
    return {
      mouse,
      grid: { cols: this.gridCols, rows: this.gridRows },
      canvas: canvas
        ? { px: `${canvas.width}×${canvas.height}`, client: `${canvas.clientWidth}×${canvas.clientHeight}` }
        : null,
      wheelEvents: wheelLogs.length,
      lastWheel: wheelLogs.at(-1)?.data ?? null,
    };
  }

  /** SPIKE debug: fill scrollback then dispatch trackpad-like wheel ticks on the canvas. */
  probeScrollWheel(): void {
    let block = '';
    for (let i = 1; i <= 80; i += 1) block += `scroll-probe ${i}\r\n`;
    this.write(block);
    const canvas = this.term?.element?.querySelector('canvas');
    if (!canvas) {
      agentLog('resttyAdapter.ts:scroll-probe', 'scroll probe: no canvas', {}, 'H-wheel');
      return;
    }
    for (let i = 0; i < 5; i += 1) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: -120,
          deltaMode: 0,
          bubbles: true,
          cancelable: true,
        }),
      );
    }
    agentLog(
      'resttyAdapter.ts:scroll-probe',
      'scroll probe dispatched 5 wheel events',
      { deltaY: -120, canvasClient: `${canvas.clientWidth}×${canvas.clientHeight}` },
      'H-wheel',
    );
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
    this.inputListeners.clear();
    this.resizeListeners.clear();
    this.titleListeners.clear();
  }

  private syncLayout(): void {
    this.term?.restty?.updateSize(true);
  }

  /**
   * Trackpad scroll is wheel on the restty canvas (bubble listener). Do not call
   * updateSize during wheel — it retriggers grid resize and resets viewport offset.
   * Forward parent-target wheels; bypass mouse-reporting hijack with Shift.
   */
  private installScrollGuard(root: HTMLElement): void {
    this.wheelForwardCleanup?.();
    const canvas = root.querySelector('canvas');
    if (!canvas) {
      this.wheelForwardCleanup = null;
      return;
    }

    const dispatchCanvasWheel = (source: WheelEvent, shiftKey: boolean): void => {
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
      const mouse = this.term?.restty?.getMouseStatus?.();
      if (!event.shiftKey && mouse?.active) {
        event.stopImmediatePropagation();
        event.preventDefault();
        agentLog(
          'resttyAdapter.ts:wheel-unhijack',
          'mouse reporting stole wheel; re-dispatch with shift',
          { deltaY: event.deltaY, mouseMode: mouse.mode },
          'H-wheel',
        );
        dispatchCanvasWheel(event, true);
      }
    };

    const onRootWheelCapture = (event: WheelEvent): void => {
      if (event.target === canvas) return;
      const rect = canvas.getBoundingClientRect();
      const overCanvas =
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom;
      if (!overCanvas || !root.contains(event.target as Node)) return;
      const mouse = this.term?.restty?.getMouseStatus?.();
      agentLog(
        'resttyAdapter.ts:wheel-forward',
        'forward parent-target wheel to canvas',
        {
          deltaY: event.deltaY,
          target: event.target instanceof Element ? event.target.className || event.target.tagName : '?',
          mouseActive: mouse?.active ?? false,
        },
        'H-wheel',
      );
      event.stopImmediatePropagation();
      event.preventDefault();
      dispatchCanvasWheel(event, event.shiftKey || !!mouse?.active);
    };

    const onCanvasWheelBubble = (event: WheelEvent): void => {
      agentLog(
        'resttyAdapter.ts:canvas-wheel',
        'wheel bubbled on canvas',
        {
          deltaY: event.deltaY,
          deltaMode: event.deltaMode,
          defaultPrevented: event.defaultPrevented,
        },
        'H-wheel',
      );
    };

    canvas.addEventListener('wheel', onCanvasWheelCapture, { capture: true, passive: false });
    canvas.addEventListener('wheel', onCanvasWheelBubble, { passive: true });
    root.addEventListener('wheel', onRootWheelCapture, { capture: true, passive: false });
    this.wheelForwardCleanup = () => {
      canvas.removeEventListener('wheel', onCanvasWheelCapture, { capture: true });
      canvas.removeEventListener('wheel', onCanvasWheelBubble);
      root.removeEventListener('wheel', onRootWheelCapture, { capture: true });
    };
  }

  private installPointerFocus(root: HTMLElement): void {
    this.pointerFocusCleanup?.();
    const onPointerDown = () => {
      this.term?.focus();
    };
    root.addEventListener('pointerdown', onPointerDown, { passive: true });
    this.pointerFocusCleanup = () => root.removeEventListener('pointerdown', onPointerDown);
  }

  // OSC 0/2 (window title) and OSC 7 (cwd). ESC ] N ; payload (BEL | ST).
  // Scanned across writes; the buffer is bounded so old matches age out.
  private captureOsc(data: string): void {
    this.oscBuffer = (this.oscBuffer + data).slice(-2048);
    let consumed = 0;

    const titleRe = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    let lastTitle: RegExpExecArray | null = null;
    while ((m = titleRe.exec(this.oscBuffer))) lastTitle = m;
    if (lastTitle) {
      consumed = Math.max(consumed, lastTitle.index + lastTitle[0].length);
      const title = lastTitle[2];
      if (title !== this.lastTitle) {
        this.lastTitle = title;
        this.titleListeners.forEach((cb) => cb(title));
      }
    }

    const cwdRe = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let c: RegExpExecArray | null;
    let lastCwd: RegExpExecArray | null = null;
    while ((c = cwdRe.exec(this.oscBuffer))) lastCwd = c;
    if (lastCwd) {
      consumed = Math.max(consumed, lastCwd.index + lastCwd[0].length);
      try {
        this.cwd = decodeURIComponent(lastCwd[1]);
      } catch {
        this.cwd = lastCwd[1];
      }
    }

    if (consumed) this.oscBuffer = this.oscBuffer.slice(consumed);
  }
}
