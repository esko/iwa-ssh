import { Terminal } from '@eslzzyl/restty/esm/xterm';
import {
  DEFAULT_TERMINAL_VIEWPORT,
  mergeTerminalViewport,
  type TerminalAdapter,
  type TerminalSink,
  type TerminalSubscription,
  type TerminalViewport,
} from '../terminal/TerminalAdapter';
import type { PwaTerminalSettings } from './types';
import { DEFAULT_FONT_ID, bundledFontForSelection, isCustomSelection, customSelectionId, type BundledFont } from './terminalFonts';
import { getCustomFontData } from './customFontStore';
import { getThemePalette } from './themes';
import { DA1_REPLY } from './deviceAttributes';
import { TerminalQueryScanner, stripInboundTerminalProbes } from '../terminal/terminalAutoReplies';
import type { TerminalPalette } from './types';
import { clipboardImageToPng, encodeKittyPng } from './kittyImage';
import { scrollbackBytesForLines } from './scrollback';

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

/**
 * Map the app's font-rendering settings to restty's atlas knobs. These are
 * constructor-time options (no per-pane runtime setters on the surface), so they
 * take effect for newly opened tabs/panes — see the Rendering settings note.
 */
function renderOptions(settings: PwaTerminalSettings): {
  alphaBlending: 'native' | 'linear-corrected';
  fontHinting: boolean;
  fontHintTarget: 'auto' | 'light' | 'normal';
  ligatures: boolean;
  nerdIconScale: number;
} {
  return {
    alphaBlending: settings.fontSmoothing === 'grayscale' ? 'native' : 'linear-corrected',
    fontHinting: settings.fontHinting !== 'off',
    fontHintTarget: settings.fontHinting === 'normal' ? 'normal' : 'light',
    ligatures: settings.ligatures,
    // Symbols Nerd Font is designed around a larger icon em square than the
    // bundled text faces, so the default keeps prompt/file icons subordinate to
    // normal text. User-adjustable via the Rendering settings (0.5–1.5).
    nerdIconScale: settings.nerdFontScale,
  };
}

/**
 * Remove the SGR italic attribute (param 3) and its reset (23) from CSI `m`
 * sequences so italic text renders upright when "use italics" is off. Extended
 * color introducers (38/48/58) consume their own arguments, so a literal `3`
 * appearing as a color value (e.g. `38;5;3`) is preserved, not stripped.
 */
export function stripItalicSgr(text: string): string {
  if (!text.includes('\x1b[')) return text;
  return text.replace(/\x1b\[([0-9;]*)m/g, (full, params: string) => {
    if (params === '') return full; // CSI m == reset-all; leave untouched
    const parts = params.split(';');
    const out: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      if (p === '38' || p === '48' || p === '58') {
        const mode = parts[i + 1];
        const span = mode === '2' ? 5 : mode === '5' ? 3 : 1; // introducer + its args
        for (let k = 0; k < span && i < parts.length; k += 1, i += 1) out.push(parts[i]);
        i -= 1; // the for-loop's increment lands on the next param
        continue;
      }
      if (p === '3' || p === '23') continue; // italic set / reset → drop
      out.push(p);
    }
    return out.length ? `\x1b[${out.join(';')}m` : '';
  });
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
 * glyphs are drawn programmatically by restty, but icon glyphs (the wider Nerd
 * Font range used by prompts like starship/powerlevel10k) are not — so a
 * Symbols Nerd Font is bundled and appended as the final fallback below, making
 * icons render regardless of which text font the user selects.
 */
type ResttyFontSource =
  | { type: 'url'; url: string; label: string }
  | { type: 'buffer'; data: ArrayBuffer; label: string };

/** JetBrains Mono — the default and the always-present text fallback. */
const BUNDLED_FALLBACK: ResttyFontSource[] = [
  { type: 'url', url: '/fonts/JetBrainsMono-Regular.ttf', label: 'JetBrains Mono' },
  { type: 'url', url: '/fonts/JetBrainsMono-Bold.ttf', label: 'JetBrains Mono Bold' },
];

/**
 * Symbols-only Nerd Font (monospaced) appended last so icon glyphs the text
 * fonts lack fall through to it. Same-origin, so the IWA CSP allows it.
 *
 * `label` is load-bearing: restty's font picker classifies a source as a
 * Nerd-symbol font by matching the label against its NERD_SYMBOL_FONT_HINTS
 * regexes (`/symbols nerd font/i`, `/nerd fonts symbols/i`), then routes Nerd
 * codepoints to it. "Symbols Nerd Font" matches; do not rename it to something
 * that fails those patterns or icons will silently render from the text font.
 * (cf. wiedymi/restty#22, which adds space-less fallbacks for URL-derived labels.)
 */
const NERD_SYMBOLS_FALLBACK: ResttyFontSource = {
  type: 'url',
  url: '/fonts/SymbolsNerdFontMono-Regular.ttf',
  label: 'Symbols Nerd Font',
};

/**
 * Resolve a font selection (bundled id or `custom:<id>`) to restty fontSources.
 * The selected font is tried first; JetBrains Mono is always appended so a real
 * text font always loads (cellH > 0) even if a custom buffer is missing or a
 * bundled URL fails, and (when `nerdFallback`) the Symbols Nerd Font is the last
 * fallback so icon glyphs render with any selected font.
 */
/**
 * Ordered face list for a bundled font: the base weight (regular, or medium when
 * selected and shipped) plus its italic, then bold and bold-italic. Restty maps
 * SGR bold/italic to the matching cut by each file's embedded weight/italic, so
 * providing the real faces yields real bold/italic instead of synthetic ones.
 */
function bundledFontFaces(font: BundledFont, fontWeight: 'regular' | 'medium'): ResttyFontSource[] {
  const useMedium = fontWeight === 'medium' && Boolean(font.medium);
  const normal = useMedium ? font.medium! : font.regular;
  const normalItalic = useMedium ? font.mediumItalic : font.italic;
  const faces: ResttyFontSource[] = [{ type: 'url', url: normal, label: font.family }];
  if (normalItalic) faces.push({ type: 'url', url: normalItalic, label: `${font.family} Italic` });
  if (font.bold) faces.push({ type: 'url', url: font.bold, label: `${font.family} Bold` });
  if (font.boldItalic) faces.push({ type: 'url', url: font.boldItalic, label: `${font.family} Bold Italic` });
  return faces;
}

async function resolveFontSources(
  selection: string,
  nerdFallback: boolean,
  fontWeight: 'regular' | 'medium',
): Promise<ResttyFontSource[]> {
  const withFallbacks = (sources: ResttyFontSource[]): ResttyFontSource[] =>
    nerdFallback ? [...sources, NERD_SYMBOLS_FALLBACK] : sources;
  if (isCustomSelection(selection)) {
    const data = await getCustomFontData(customSelectionId(selection)).catch(() => undefined);
    if (data) return withFallbacks([{ type: 'buffer', data, label: 'Custom font' }, ...BUNDLED_FALLBACK]);
    return withFallbacks(BUNDLED_FALLBACK);
  }
  const font = bundledFontForSelection(selection);
  const faces = bundledFontFaces(font, fontWeight);
  // JetBrains Mono (regular+bold) is the guaranteed text fallback so a real font
  // always loads (cellH > 0); skip it when it IS the selection to avoid dupes.
  const guaranteed = font.id === DEFAULT_FONT_ID ? [] : BUNDLED_FALLBACK;
  return withFallbacks([...faces, ...guaranteed]);
}

/** Trim the device wheel ring (kept for the debug HUD; no network egress). */
function pushWheelLog(data: Record<string, unknown>): void {
  const win = window as unknown as { __resttyDebugLog?: { location: string; data: Record<string, unknown> }[] };
  const ring = win.__resttyDebugLog ?? [];
  ring.push({ location: 'wheel', data });
  if (ring.length > 60) ring.shift();
  win.__resttyDebugLog = ring;
}

const PTY_LOG_LIMIT = 60;
const sharedTextDecoder = new TextDecoder();

/** Trim the PTY input ring (kept for the debug HUD; no network egress). */
function pushPtyLog(data: string): void {
  const win = window as unknown as { __resttyPtyLog?: string[] };
  const log = win.__resttyPtyLog;
  if (!log) return;
  log.push(data);
  if (log.length > PTY_LOG_LIMIT) log.shift();
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
export type ResttyPaneSink = TerminalSink & { readonly paneId: number; insertText(data: string): void };

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
/** @internal Exported for transport-ordering regression coverage. */
export class PaneBridge implements TerminalSink {
  private callbacks: PaneCallbacks | null = null;
  private connected = false;
  private viewport: TerminalViewport = { ...DEFAULT_TERMINAL_VIEWPORT };
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(viewport: TerminalViewport) => void>();
  // Per-pane scanner that answers DA1 + Kitty graphics capability queries on the
  // raw SSH/Mosh output stream (the ET worker answers them upstream instead).
  private readonly queryScanner = new TerminalQueryScanner();
  private readonly decoder = new TextDecoder();

  constructor(
    readonly paneId: number,
    private readonly owner: ResttyTerminalAdapter,
  ) {}

  // --- PtyTransport surface (restty -> bridge) ---

  connect(options: PaneConnectOptions): void {
    this.queryScanner.reset();
    this.callbacks = options.callbacks;
    this.updateViewport({ cols: options.cols, rows: options.rows });
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
    pushPtyLog(data);
    this.inputListeners.forEach((cb) => cb(data));
    return true;
  }

  resize(cols: number, rows: number): boolean {
    this.updateViewport({ cols, rows });
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
    this.queryScanner.reset();
  }

  // --- TerminalAdapter sink (transport -> bridge -> pane) ---

  open(): void {}

  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : this.decoder.decode(data, { stream: true });
    this.owner.captureOsc(this, text);
    if (!this.connected) {
      this.callbacks?.onData?.(text);
      return;
    }
    // Restty/ghostty-vt does not reliably emit DA1 or Kitty graphics query
    // replies back through the PtyTransport — fish stalls ~10s waiting for DA1,
    // and image previewers (Yazi, kitten icat) never detect Kitty support. So
    // answer both at the boundary and strip the probes from what Restty renders.
    // This mirrors the ET worker, which answers + strips probes upstream, so the
    // scanner no-ops on ET output. Kitty image transmit packets (a=T) and the
    // DSR cursor query are left intact for Restty to render / answer.
    const { kittyReplies, sendDa1 } = this.queryScanner.ingest(text);
    for (const reply of kittyReplies) this.emitInput(reply);
    if (sendDa1) this.emitInput(DA1_REPLY);
    const rendered = stripInboundTerminalProbes(text);
    this.callbacks?.onData?.(this.owner.italicsEnabled ? rendered : stripItalicSgr(rendered));
  }

  /** Render trusted local output without OSC capture, DA replies, or remote input. */
  renderLocal(data: string): void {
    this.callbacks?.onData?.(data);
  }

  onInput(cb: (data: string) => void): TerminalSubscription {
    this.inputListeners.add(cb);
    return { dispose: () => this.inputListeners.delete(cb) };
  }

  onResize(cb: (viewport: TerminalViewport) => void): TerminalSubscription {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }

  focus(): void {
    this.owner.focusPane(this.paneId);
  }

  dispose(): void {
    this.destroy();
  }

  getSize(): TerminalViewport {
    return { ...this.viewport };
  }

  updateViewport(update: Partial<TerminalViewport>): void {
    const next = mergeTerminalViewport(this.viewport, update);
    if (next === this.viewport) return;
    this.viewport = next;
    const snapshot = { ...next };
    this.resizeListeners.forEach((cb) => cb(snapshot));
  }

  /** Route context-menu paste to this pane's transport (remote echo draws it). */
  emitInput(data: string): void {
    if (data) this.inputListeners.forEach((cb) => cb(data));
  }

  insertText(data: string): void {
    this.emitInput(data);
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
  requestLayoutSync?: () => void;
};

/** Direction for keyboard pane focus and resize. */
export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export type TerminalPreviewOptions = {
  width: number;
  height: number;
};

type PreviewCaptureRequest = {
  afterGeneration: number;
  promise: Promise<HTMLCanvasElement | null>;
  resolve: (canvas: HTMLCanvasElement | null) => void;
  timeout: ReturnType<typeof setTimeout>;
};

type PreviewGpuTexture = object;
type PreviewGpuCommandBuffer = object;
type PreviewGpuBuffer = {
  readonly mapState: string;
  mapAsync(mode: number): Promise<void>;
  getMappedRange(): ArrayBuffer;
  unmap(): void;
  destroy(): void;
};
type PreviewGpuCommandEncoder = {
  copyTextureToBuffer(
    source: { texture: PreviewGpuTexture },
    destination: { buffer: PreviewGpuBuffer; bytesPerRow: number; rowsPerImage: number },
    size: { width: number; height: number },
  ): void;
  finish(): PreviewGpuCommandBuffer;
};
type PreviewGpuQueue = {
  submit(commandBuffers: Iterable<PreviewGpuCommandBuffer>): void;
};
type PreviewGpuDevice = {
  queue: PreviewGpuQueue;
  createBuffer(options: { size: number; usage: number }): PreviewGpuBuffer;
  createCommandEncoder(): PreviewGpuCommandEncoder;
};
type PreviewGpuCanvasConfiguration = {
  device: PreviewGpuDevice;
  format: string;
  usage?: number;
  [key: string]: unknown;
};
type PreviewGpuCanvasContext = {
  configure(configuration: PreviewGpuCanvasConfiguration): void;
  getCurrentTexture(): PreviewGpuTexture;
};

const GPU_TEXTURE_COPY_SRC = 0x01;
const GPU_TEXTURE_RENDER_ATTACHMENT = 0x10;
const GPU_BUFFER_MAP_READ = 0x01;
const GPU_BUFFER_COPY_DST = 0x08;
const GPU_MAP_READ = 0x01;

type WebGpuPreviewState = {
  canvas: HTMLCanvasElement;
  context: PreviewGpuCanvasContext | null;
  device: PreviewGpuDevice | null;
  format: string | null;
  queue: PreviewGpuQueue | null;
  generation: number;
  latestTexture: PreviewGpuTexture | null;
  request: PreviewCaptureRequest | null;
  restoreGetContext: () => void;
};

type PreviewQueueRegistration = {
  queue: PreviewGpuQueue;
  originalSubmit: PreviewGpuQueue['submit'];
  states: Set<WebGpuPreviewState>;
  pendingStates: Set<WebGpuPreviewState>;
};

const previewQueueRegistrations = new WeakMap<PreviewGpuQueue, PreviewQueueRegistration>();

function finishPreviewRequest(request: PreviewCaptureRequest, canvas: HTMLCanvasElement | null): void {
  clearTimeout(request.timeout);
  request.resolve(canvas);
}

function unregisterPreviewQueue(state: WebGpuPreviewState): void {
  const queue = state.queue;
  if (!queue) return;
  const registration = previewQueueRegistrations.get(queue);
  registration?.states.delete(state);
  registration?.pendingStates.delete(state);
  if (registration && registration.states.size === 0) {
    Object.defineProperty(queue, 'submit', {
      configurable: true,
      value: registration.originalSubmit,
    });
    previewQueueRegistrations.delete(queue);
  }
  state.queue = null;
}

function mapPreviewBuffer(
  request: PreviewCaptureRequest,
  buffer: PreviewGpuBuffer,
  bytesPerRow: number,
  width: number,
  height: number,
  format: string,
): void {
  void buffer.mapAsync(GPU_MAP_READ).then(() => {
    const source = new Uint8Array(buffer.getMappedRange());
    const pixels = new Uint8ClampedArray(width * height * 4);
    const isBgra = format.startsWith('bgra');
    for (let y = 0; y < height; y += 1) {
      const sourceRow = y * bytesPerRow;
      const targetRow = y * width * 4;
      for (let x = 0; x < width; x += 1) {
        const sourceOffset = sourceRow + x * 4;
        const targetOffset = targetRow + x * 4;
        pixels[targetOffset] = source[sourceOffset + (isBgra ? 2 : 0)];
        pixels[targetOffset + 1] = source[sourceOffset + 1];
        pixels[targetOffset + 2] = source[sourceOffset + (isBgra ? 0 : 2)];
        pixels[targetOffset + 3] = source[sourceOffset + 3];
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      finishPreviewRequest(request, null);
      return;
    }
    context.putImageData(new ImageData(pixels, width, height), 0, 0);
    finishPreviewRequest(request, canvas);
  }).catch(() => finishPreviewRequest(request, null)).finally(() => {
    if (buffer.mapState === 'mapped') buffer.unmap();
    buffer.destroy();
  });
}

function flushPreviewCopies(registration: PreviewQueueRegistration): void {
  if (registration.pendingStates.size === 0) return;
  const pendingStates = [...registration.pendingStates].filter((state) => (
    state.request
    && state.latestTexture
    && state.generation > state.request.afterGeneration
    && state.device
    && state.format
  ));
  if (pendingStates.length === 0) return;

  const captures: Array<{
    request: PreviewCaptureRequest;
    buffer: PreviewGpuBuffer;
    bytesPerRow: number;
    width: number;
    height: number;
    format: string;
  }> = [];
  const encoder = pendingStates[0]?.device?.createCommandEncoder();
  if (!encoder) return;

  for (const state of pendingStates) {
    const request = state.request;
    const texture = state.latestTexture;
    if (!request || !texture || state.generation <= request.afterGeneration || !state.device || !state.format) continue;
    state.request = null;
    registration.pendingStates.delete(state);
    clearTimeout(request.timeout);
    const width = state.canvas.width;
    const height = state.canvas.height;
    const bytesPerRow = Math.ceil((width * 4) / 256) * 256;
    try {
      const buffer = state.device.createBuffer({
        size: bytesPerRow * height,
        usage: GPU_BUFFER_COPY_DST | GPU_BUFFER_MAP_READ,
      });
      encoder.copyTextureToBuffer(
        { texture },
        { buffer, bytesPerRow, rowsPerImage: height },
        { width, height },
      );
      captures.push({ request, buffer, bytesPerRow, width, height, format: state.format });
    } catch {
      finishPreviewRequest(request, null);
    }
  }
  if (captures.length === 0) return;

  try {
    registration.originalSubmit.call(registration.queue, [encoder.finish()]);
    for (const capture of captures) {
      mapPreviewBuffer(
        capture.request,
        capture.buffer,
        capture.bytesPerRow,
        capture.width,
        capture.height,
        capture.format,
      );
    }
  } catch {
    for (const capture of captures) {
      capture.buffer.destroy();
      finishPreviewRequest(capture.request, null);
    }
  }
}

function registerPreviewQueue(state: WebGpuPreviewState, queue: PreviewGpuQueue): void {
  if (state.queue === queue) return;
  unregisterPreviewQueue(state);
  let registration = previewQueueRegistrations.get(queue);
  if (!registration) {
    const originalSubmit = queue.submit;
    registration = { queue, originalSubmit, states: new Set(), pendingStates: new Set() };
    previewQueueRegistrations.set(queue, registration);
    Object.defineProperty(queue, 'submit', {
      configurable: true,
      value(commandBuffers: Iterable<PreviewGpuCommandBuffer>): void {
        originalSubmit.call(queue, commandBuffers);
        flushPreviewCopies(registration!);
      },
    });
  }
  registration.states.add(state);
  state.queue = queue;
}

function instrumentPreviewCanvas(canvas: HTMLCanvasElement): WebGpuPreviewState {
  const originalGetContext = canvas.getContext.bind(canvas);
  const state: WebGpuPreviewState = {
    canvas,
    context: null,
    device: null,
    format: null,
    queue: null,
    generation: 0,
    latestTexture: null,
    request: null,
    restoreGetContext: () => undefined,
  };

  const patchedGetContext = ((contextId: string, options?: unknown): unknown => {
    const context = originalGetContext(contextId, options);
    if (
      contextId !== 'webgpu'
      || !context
      || state.context === (context as unknown as PreviewGpuCanvasContext)
    ) return context;
    const gpuContext = context as unknown as PreviewGpuCanvasContext;
    const originalConfigure = gpuContext.configure.bind(gpuContext);
    const originalGetCurrentTexture = gpuContext.getCurrentTexture.bind(gpuContext);
    Object.defineProperty(gpuContext, 'configure', {
      configurable: true,
      value(configuration: PreviewGpuCanvasConfiguration): void {
        state.context = gpuContext;
        state.device = configuration.device;
        state.format = configuration.format;
        registerPreviewQueue(state, configuration.device.queue);
        originalConfigure({
          ...configuration,
          usage: (configuration.usage ?? GPU_TEXTURE_RENDER_ATTACHMENT) | GPU_TEXTURE_COPY_SRC,
        });
      },
    });
    Object.defineProperty(gpuContext, 'getCurrentTexture', {
      configurable: true,
      value(): PreviewGpuTexture {
        const texture = originalGetCurrentTexture();
        state.latestTexture = texture;
        state.generation += 1;
        return texture;
      },
    });
    state.context = gpuContext;
    return context;
  }) as typeof canvas.getContext;

  Object.defineProperty(canvas, 'getContext', {
    configurable: true,
    value: patchedGetContext,
  });
  state.restoreGetContext = () => {
    Object.defineProperty(canvas, 'getContext', {
      configurable: true,
      value: originalGetContext,
    });
  };
  return state;
}

type PaneState = { bridge: PaneBridge; title: string | null; cwd: string | null; oscBuffer: string };

/**
 * Adapter backed by restty's xterm-compat shim (libghostty-vt → WASM,
 * WebGPU/WebGL2 GPU atlas). restty answers DA1/DSR queries and implements
 * scrollback through the vendored renderer backend.
 *
 * Each restty pane (split) runs an independent session through its own
 * {@link PaneBridge}; the adapter owns layout/appearance/title and exposes
 * `onPaneOpen`/`onPaneClose` so the view layer can bind one transport per pane.
 */
export class ResttyTerminalAdapter implements TerminalAdapter {
  private term: Terminal | null = null;
  private root: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private layoutFrame = 0;
  private scrollGuardCanvasCount = 0;
  private readonly panes = new Map<number, PaneState>();
  private activePaneId = -1;
  private readonly titleListeners = new Set<(title: string) => void>();
  private readonly paneOpenListeners = new Set<(sink: PaneBridge) => void>();
  private readonly paneCloseListeners = new Set<(paneId: number) => void>();
  private readonly openedPanes = new Set<number>();
  private pendingOpen: PaneBridge[] = [];
  private wheelForwardCleanup: (() => void) | null = null;
  private redispatchingWheel = false;
  private pointerFocusCleanup: (() => void) | null = null;
  private settings: PwaTerminalSettings | null = null;
  private readonly previewCanvases = new Map<number, WebGpuPreviewState>();
  /** Pane currently maximized over the split layout, or null when none. */
  private zoomedPaneId: number | null = null;
  /** Saved inline `position` of the root while a pane is zoomed (for restore). */
  private prevRootPosition: string | null = null;

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
    const fontSources = await resolveFontSources(settings.fontFamily, settings.nerdFontFallback, settings.fontWeight);

    const term = new Terminal({
      // Per-pane app options: every pane (the first and every split) gets its
      // own PtyTransport bridge keyed by the pane id restty assigns it.
      appOptions: (ctx: { id: number; canvas: HTMLCanvasElement }) => {
        adapter.previewCanvases.set(ctx.id, instrumentPreviewCanvas(ctx.canvas));
        // Restty consumes this limit only when a pane core is created. Use the
        // latest settings so splits opened after a settings change get the new
        // capacity; existing panes keep their history and current limit.
        const paneSettings = adapter.settings ?? settings;
        return {
          ptyTransport: adapter.registerPane(ctx.id),
          fontSources,
          ...renderOptions(paneSettings),
          autoResize: true,
          attachCanvasEvents: true,
          // restty touch pan is armed on pointerdown only in long-press/drag modes
          // (see bind-pointer-events.ts); "off" disables touch scroll entirely.
          touchSelectionMode: 'long-press',
          maxScrollbackBytes: scrollbackBytesForLines(paneSettings.scrollback),
          callbacks: {
            onGridSize: (cols: number, rows: number) => adapter.panes.get(ctx.id)?.bridge.updateViewport({ cols, rows }),
            onCanvasSize: (widthPx: number, heightPx: number) =>
              adapter.panes.get(ctx.id)?.bridge.updateViewport({ widthPx, heightPx }),
          },
        };
      },
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
    adapter.installScrollGuardIfNeeded(el);
    adapter.installPointerFocus(el);
    adapter.resizeObserver = new ResizeObserver(() => adapter.scheduleLayoutSync());
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
    // A new split invalidates a maximized layout; restore before adding.
    if (this.zoomedPaneId !== null) this.unzoomPane();
    this.registerPane(id);
    this.connectPane(id);
    this.syncLayout();
    if (this.root) this.installScrollGuardIfNeeded(this.root);
    if (this.settings) this.applyAppearanceToPane(id, this.settings);
  }

  private handlePaneClosed(id: number): void {
    if (this.zoomedPaneId === id) this.unzoomPane();
    this.releasePreviewCanvas(id);
    this.panes.delete(id);
    this.openedPanes.delete(id);
    this.paneCloseListeners.forEach((cb) => cb(id));
    this.syncLayout();
    if (this.root) this.installScrollGuardIfNeeded(this.root);
  }

  private handleActivePaneChange(id: number): void {
    if (id < 0) return;
    this.activePaneId = id;
    // Surface the newly-focused pane's title so the tab follows the active split
    // (empty falls back to the connection target in the view layer).
    const title = this.panes.get(id)?.title ?? '';
    this.titleListeners.forEach((cb) => cb(title));
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

  /** The DOM container restty assigns to a pane (`.pane[data-pane-id]`). */
  private paneContainer(id: number): HTMLElement | null {
    return this.root?.querySelector<HTMLElement>(`.pane[data-pane-id="${id}"]`) ?? null;
  }

  /**
   * Move focus to the nearest pane in a direction (spatial, like tmux/vim).
   * Prefers a neighbor that overlaps the active pane on the cross axis, falling
   * back to the closest pane otherwise. No-op with a single pane.
   */
  focusPaneInDirection(dir: PaneDirection): boolean {
    if (this.panes.size <= 1) return false;
    if (this.zoomedPaneId !== null) this.unzoomPane();
    const active = this.paneContainer(this.activePaneId);
    if (!active) return false;
    const a = active.getBoundingClientRect();
    const acx = a.left + a.width / 2;
    const acy = a.top + a.height / 2;
    let best: { id: number; dist: number; overlap: boolean } | null = null;
    for (const id of this.panes.keys()) {
      if (id === this.activePaneId) continue;
      const el = this.paneContainer(id);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const inDir =
        dir === 'left' ? cx < acx : dir === 'right' ? cx > acx : dir === 'up' ? cy < acy : cy > acy;
      if (!inDir) continue;
      const overlap =
        dir === 'left' || dir === 'right'
          ? r.top < a.bottom && r.bottom > a.top
          : r.left < a.right && r.right > a.left;
      const dist = Math.hypot(cx - acx, cy - acy);
      // Prefer cross-axis-overlapping neighbors; among equals, the closest center.
      if (!best || (overlap && !best.overlap) || (overlap === best.overlap && dist < best.dist)) {
        best = { id, dist, overlap };
      }
    }
    if (!best) return false;
    this.focusPane(best.id);
    return true;
  }

  /** Cycle focus through panes in id order; `delta` is +1 (next) or -1 (prev). */
  cyclePane(delta: number): boolean {
    if (this.panes.size <= 1) return false;
    if (this.zoomedPaneId !== null) this.unzoomPane();
    const ids = [...this.panes.keys()].sort((x, y) => x - y);
    const idx = ids.indexOf(this.activePaneId);
    const next = ids[(idx + (delta >= 0 ? 1 : -1) + ids.length) % ids.length];
    if (next === undefined || next === this.activePaneId) return false;
    this.focusPane(next);
    return true;
  }

  /** Read the `<pct>` from an element's inline `flex: 0 0 <pct>%`, else null. */
  private flexPct(el: HTMLElement): number | null {
    const match = /(\d+(?:\.\d+)?)%/.exec(el.style.flex);
    return match ? Number(match[1]) : null;
  }

  /**
   * Grow/shrink the active pane toward a direction by nudging the divider of the
   * nearest split ancestor whose orientation matches that axis. Walks up the
   * split tree so a pane on the far side of its immediate split still resizes
   * against the correct boundary. No-op when no matching split exists.
   */
  resizeActivePane(dir: PaneDirection, stepPct = 6): boolean {
    if (this.panes.size <= 1) return false;
    const active = this.paneContainer(this.activePaneId);
    if (!active) return false;
    // Horizontal moves (left/right) act on side-by-side (vertical) splits.
    const wantClass = dir === 'left' || dir === 'right' ? 'is-vertical' : 'is-horizontal';
    // Right/Down extend the active pane's high-side edge: it must be the FIRST
    // child of the split. Left/Up extend the low-side edge: the SECOND child.
    const wantFirst = dir === 'right' || dir === 'down';
    let node: HTMLElement = active;
    while (node.parentElement) {
      const parent: HTMLElement = node.parentElement;
      if (parent.classList.contains('pane-split') && parent.classList.contains(wantClass)) {
        const branches = Array.from(parent.children).filter(
          (c): c is HTMLElement => c instanceof HTMLElement && !c.classList.contains('pane-divider'),
        );
        if (branches.length === 2) {
          const isFirst = branches[0] === node;
          if (isFirst === wantFirst) {
            const grow = wantFirst ? branches[0] : branches[1];
            const other = wantFirst ? branches[1] : branches[0];
            const gPct = this.flexPct(grow) ?? 50;
            const oPct = this.flexPct(other) ?? 50;
            const total = gPct + oPct;
            const next = Math.min(total - 10, Math.max(10, gPct + stepPct));
            grow.style.flex = `0 0 ${next.toFixed(5)}%`;
            other.style.flex = `0 0 ${(total - next).toFixed(5)}%`;
            this.surface?.requestLayoutSync?.();
            this.syncLayout();
            return true;
          }
        }
      }
      node = parent;
    }
    return false;
  }

  /** Toggle maximize for the active pane (overlay over the split layout). */
  toggleZoomActivePane(): boolean {
    if (this.zoomedPaneId !== null) {
      this.unzoomPane();
      return true;
    }
    if (this.panes.size <= 1) return false;
    const el = this.paneContainer(this.activePaneId);
    const root = this.root;
    if (!el || !root) return false;
    // Anchor the absolute overlay to the root rather than an intermediate split.
    if (!root.style.position) {
      this.prevRootPosition = root.style.position;
      root.style.position = 'relative';
    }
    el.style.position = 'absolute';
    el.style.inset = '0';
    el.style.zIndex = '6';
    this.zoomedPaneId = this.activePaneId;
    this.surface?.requestLayoutSync?.();
    this.syncLayout();
    return true;
  }

  isPaneZoomed(): boolean {
    return this.zoomedPaneId !== null;
  }

  private releasePreviewCanvas(id: number): void {
    const state = this.previewCanvases.get(id);
    if (!state) return;
    if (state.request) {
      finishPreviewRequest(state.request, null);
      state.request = null;
    }
    unregisterPreviewQueue(state);
    state.restoreGetContext();
    this.previewCanvases.delete(id);
  }

  private captureWebGpuPane(id: number, handle: ResttyPaneHandleLite): Promise<HTMLCanvasElement | null> {
    const state = this.previewCanvases.get(id);
    if (!state?.context || !state.device || !state.format) return Promise.resolve(null);
    if (state.request) return state.request.promise;

    let resolveRequest!: (canvas: HTMLCanvasElement | null) => void;
    const promise = new Promise<HTMLCanvasElement | null>((resolve) => {
      resolveRequest = resolve;
    });
    const request: PreviewCaptureRequest = {
      afterGeneration: state.generation,
      promise,
      resolve: resolveRequest,
      timeout: setTimeout(() => {
        if (state.request === request) {
          state.request = null;
          if (state.queue) previewQueueRegistrations.get(state.queue)?.pendingStates.delete(state);
        }
        finishPreviewRequest(request, null);
      }, 1500),
    };
    state.request = request;
    if (state.queue) previewQueueRegistrations.get(state.queue)?.pendingStates.add(state);

    const settings = this.settings;
    if (settings) {
      const palette = getThemePalette(settings.theme);
      handle.applyTheme(buildResttyTheme(palette), palette.name);
    }
    handle.updateSize(true);
    return promise;
  }

  async capturePreview(options: TerminalPreviewOptions): Promise<Blob | null> {
    const root = this.root;
    if (!root) return null;
    const width = Math.max(1, Math.floor(options.width));
    const height = Math.max(1, Math.floor(options.height));
    const rootRect = root.getBoundingClientRect();
    if (rootRect.width <= 0 || rootRect.height <= 0) return null;

    const target = document.createElement('canvas');
    target.width = width;
    target.height = height;
    const ctx = target.getContext('2d');
    if (!ctx) return null;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    const scale = Math.min(width / rootRect.width, height / rootRect.height);
    const drawWidth = rootRect.width * scale;
    const drawHeight = rootRect.height * scale;
    const offsetX = (width - drawWidth) / 2;
    const offsetY = (height - drawHeight) / 2;

    const canvases = [...root.querySelectorAll<HTMLCanvasElement>('canvas.pane-canvas, .pane canvas')];
    const snapshots = await Promise.all(canvases.map(async (canvas) => {
      const pane = canvas.closest<HTMLElement>('.pane[data-pane-id]');
      const paneId = Number(pane?.dataset.paneId);
      const handle = Number.isFinite(paneId) ? this.surface?.pane?.(paneId) : null;
      const source = handle?.getBackend() === 'webgpu'
        ? await this.captureWebGpuPane(paneId, handle)
        : canvas;
      return { canvas, source };
    }));
    let drawn = 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(offsetX, offsetY, drawWidth, drawHeight);
    ctx.clip();
    for (const { canvas, source } of snapshots) {
      if (!source) continue;
      if (canvas.width <= 0 || canvas.height <= 0) continue;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const dx = offsetX + (rect.left - rootRect.left) * scale;
      const dy = offsetY + (rect.top - rootRect.top) * scale;
      const dw = rect.width * scale;
      const dh = rect.height * scale;
      if (dx + dw < 0 || dy + dh < 0 || dx > width || dy > height) continue;
      try {
        ctx.drawImage(source, dx, dy, dw, dh);
        drawn += 1;
      } catch {
        // Canvas readback can fail for a backend-specific surface; keep this
        // preview path best-effort and leave the caller's cached image intact.
      }
    }
    ctx.restore();
    if (drawn === 0) return null;
    return await new Promise<Blob | null>((resolve) => target.toBlob(resolve, 'image/png'));
  }

  private unzoomPane(): void {
    if (this.zoomedPaneId === null) return;
    const el = this.paneContainer(this.zoomedPaneId);
    if (el) {
      el.style.position = '';
      el.style.inset = '';
      el.style.zIndex = '';
    }
    if (this.prevRootPosition !== null && this.root) {
      this.root.style.position = this.prevRootPosition;
      this.prevRootPosition = null;
    }
    this.zoomedPaneId = null;
    this.surface?.requestLayoutSync?.();
    this.syncLayout();
  }

  // create() does the real work; open() exists to satisfy the interface.
  open(): void {}

  /** Inject output into the active pane (used by reconnect's clear-screen). */
  write(data: string | Uint8Array): void {
    const text = typeof data === 'string' ? data : sharedTextDecoder.decode(data);
    const bridge = this.panes.get(this.activePaneId)?.bridge;
    if (bridge) this.captureOsc(bridge, text); // keep title/cwd in sync with injected output
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

  getSize(): TerminalViewport {
    return this.panes.get(this.activePaneId)?.bridge.getSize() ?? { ...DEFAULT_TERMINAL_VIEWPORT };
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

  /** Convert clipboard media and inject direct Kitty packets into only the focused pane. */
  async displayImage(blob: Blob, signal?: AbortSignal, paneId = this.activePaneId): Promise<void> {
    const state = this.panes.get(paneId);
    if (!state) throw new Error('No focused terminal pane.');
    const image = await clipboardImageToPng(blob, signal);
    signal?.throwIfAborted();
    // A terminal cell is approximately twice as tall as it is wide. Choosing
    // only `c` lets Kitty preserve the source aspect ratio while bounding tall
    // images to the visible pane as well as wide images to its columns.
    const size = state.bridge.getSize();
    const aspect = image.width / Math.max(1, image.height);
    const columns = Math.max(1, Math.min(size.cols, Math.floor(size.rows * 2 * aspect)));
    for (const packet of encodeKittyPng(image.bytes, columns)) {
      signal?.throwIfAborted();
      // Do not call paste()/sendInput(): these bytes are renderer-local and
      // must never reach SSH, Mosh, or ET.
      state.bridge.renderLocal(packet);
      await Promise.resolve();
    }
  }

  getCwd(): string | null {
    return this.panes.get(this.activePaneId)?.cwd ?? null;
  }

  /** Apply theme colors, cursor shape/blink, and font size to every pane. */
  setAppearance(settings: PwaTerminalSettings): void {
    this.settings = settings;
    for (const id of this.panes.keys()) this.applyAppearanceToPane(id, settings);
  }

  /** Whether SGR italic should render; false makes PaneBridge strip it (upright). */
  get italicsEnabled(): boolean {
    return this.settings?.useItalics !== false;
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
    const sources = await resolveFontSources(settings.fontFamily, settings.nerdFontFallback, settings.fontWeight);
    await this.surface?.setFontSources?.(sources);
    // restty's setFontSources updates cell metrics + schedules a paint but omits
    // the WASM renderUpdate() that setFontSize performs, so already-painted cells
    // keep stale glyphs (spacing changes, glyph shapes don't). Nudge each pane's
    // font size to force a full re-render with the new font; the intermediate
    // size never paints because both calls land before the next animation frame.
    const px = settings.fontSize;
    if (Number.isFinite(px)) {
      for (const id of this.panes.keys()) {
        const handle = this.surface?.pane?.(id);
        if (!handle) continue;
        handle.setFontSize(px + 1);
        handle.setFontSize(px);
      }
    }
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
    if (this.layoutFrame) window.cancelAnimationFrame(this.layoutFrame);
    this.layoutFrame = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const id of [...this.previewCanvases.keys()]) this.releasePreviewCanvas(id);
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
  // so keyboard IME handlers (which require wasm) are actually live. This is a
  // best-effort readiness nudge: if the reply is slow (cold GPU / software
  // rendering) we warn and proceed rather than failing startup — the wasm path
  // settles a beat later and the terminal is otherwise fully usable.
  private async waitForPaneReady(id: number, timeoutMs = 8_000): Promise<void> {
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
    if (!daReply) console.warn('[restty] DA probe did not reply in time; proceeding (input path should settle shortly)');
  }

  private syncLayout(): void {
    this.surface?.updateSize?.(true);
  }

  /** Coalesce burst ResizeObserver callbacks into one layout sync per frame. */
  private scheduleLayoutSync(): void {
    if (this.layoutFrame) return;
    this.layoutFrame = window.requestAnimationFrame(() => {
      this.layoutFrame = 0;
      this.syncLayout();
    });
  }

  /** Rebuild scroll guard only when the canvas set changes (splits), not on resize. */
  private installScrollGuardIfNeeded(root: HTMLElement): void {
    const count = root.querySelectorAll('canvas').length;
    if (count === this.scrollGuardCanvasCount && this.wheelForwardCleanup) return;
    this.scrollGuardCanvasCount = count;
    this.installScrollGuard(root);
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
    const dispatchCanvasWheel = (canvas: HTMLElement, source: WheelEvent, shiftKey: boolean, scale = 1): void => {
      this.redispatchingWheel = true;
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaX: source.deltaX * scale,
          deltaY: source.deltaY * scale,
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
      this.redispatchingWheel = false;
    };

    const sensitivity = (): number => {
      const s = this.settings?.scrollSensitivity ?? 1;
      return Number.isFinite(s) && s > 0 ? s : 1;
    };

    const onCanvasWheelCapture = (event: WheelEvent): void => {
      if (this.redispatchingWheel) return; // our own re-dispatched event
      const mouse = this.activeHandle()?.getMouseStatus?.();
      const unhijack = !event.shiftKey && !!mouse?.active;
      const sens = sensitivity();
      // Default path (no mouse-reporting, sensitivity 1) is left entirely alone.
      if (!unhijack && sens === 1) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      dispatchCanvasWheel(event.currentTarget as HTMLElement, event, unhijack ? true : event.shiftKey, sens);
    };

    const onRootWheelCapture = (event: WheelEvent): void => {
      if (event.target instanceof HTMLCanvasElement) return;
      const canvas = canvasUnder(event.clientX, event.clientY);
      if (!canvas || !root.contains(event.target as Node)) return;
      const mouse = this.activeHandle()?.getMouseStatus?.();
      pushWheelLog({ deltaY: event.deltaY, forwarded: true });
      event.stopImmediatePropagation();
      event.preventDefault();
      dispatchCanvasWheel(canvas, event, event.shiftKey || !!mouse?.active, sensitivity());
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
    if (!state.oscBuffer && !data.includes('\x1b]')) return;
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
    // No ESC left means no partial OSC to complete on a later write — drop the
    // tail so subsequent plain output hits the early-out instead of re-scanning.
    if (state.oscBuffer && !state.oscBuffer.includes('\x1b')) state.oscBuffer = '';
  }
}
