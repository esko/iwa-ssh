import { WTerm } from '@wterm/dom';
import { GhosttyCore } from '@wterm/ghostty';
import '@wterm/dom/src/terminal.css';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import { getThemePalette } from './themes';
import { terminalFontFamily } from './settings';
import type { PwaTerminalSettings } from './types';

/**
 * Terminal adapter backed by wterm's DOM renderer over libghostty (compiled
 * from upstream Ghostty). Text is real DOM, so it's crisp at any DPR and gets
 * native selection / copy / find for free. Implements the same TerminalAdapter
 * surface the transports and views expect.
 */
export class WtermTerminalAdapter implements TerminalAdapter {
  private term: WTerm | null = null;
  private el: HTMLElement | null = null;
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private readonly titleListeners = new Set<(title: string) => void>();
  private cwd: string | null = null;
  private oscBuffer = '';
  private readonly decoder = new TextDecoder();

  static async create(el: HTMLElement, settings: PwaTerminalSettings): Promise<WtermTerminalAdapter> {
    const adapter = new WtermTerminalAdapter();
    adapter.el = el;
    applyWtermTheme(el, settings);
    // Served from our origin root (app/public/) — the package doesn't export its
    // wasm/ subpath, so the default import.meta.url resolution 404s under Vite/IWA.
    const core = await GhosttyCore.load({ wasmPath: '/ghostty-vt.wasm' });
    const term = new WTerm(el, {
      core,
      autoResize: true,
      cursorBlink: settings.cursorBlink,
      onData: (data) => adapter.inputListeners.forEach((cb) => cb(data)),
      onResize: (cols, rows) => adapter.resizeListeners.forEach((cb) => cb(cols, rows)),
      onTitle: (title) => adapter.titleListeners.forEach((cb) => cb(title)),
    });
    await term.init();
    adapter.term = term;
    term.focus();
    return adapter;
  }

  // create() does the real work; open() exists to satisfy the interface.
  open(): void {}

  write(data: string | Uint8Array): void {
    this.captureCwd(typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }));
    this.term?.write(data);
  }

  onInput(cb: (data: string) => void): TerminalSubscription {
    this.inputListeners.add(cb);
    return { dispose: () => this.inputListeners.delete(cb) };
  }

  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }

  /** Title set by the remote program via OSC 0/2. */
  onTitle(cb: (title: string) => void): TerminalSubscription {
    this.titleListeners.add(cb);
    return { dispose: () => this.titleListeners.delete(cb) };
  }

  focus(): void {
    this.term?.focus();
  }

  // wterm auto-resizes via its own ResizeObserver; nothing to do here.
  fit(): void {}

  getSize(): { cols: number; rows: number } {
    return { cols: this.term?.cols ?? 80, rows: this.term?.rows ?? 24 };
  }

  getSelection(): string {
    return window.getSelection?.()?.toString() ?? '';
  }

  hasSelection(): boolean {
    return this.getSelection().length > 0;
  }

  /** Context-menu paste: send clipboard text to the remote as input. */
  paste(data: string): void {
    this.inputListeners.forEach((cb) => cb(data));
  }

  /** Remote working directory reported via OSC 7, if the shell emits it. */
  getCwd(): string | null {
    return this.cwd;
  }

  updateAppearance(): void {
    if (this.el) applyWtermTheme(this.el, undefined);
  }

  /** Reapply the terminal font live; wterm reads it from the CSS custom property. */
  setFont(settings: PwaTerminalSettings): void {
    if (this.el) this.el.style.setProperty('--term-font-family', terminalFontFamily(settings));
  }

  /** Apply theme colors and font size live (wterm is CSS-custom-property driven). */
  setAppearance(settings: PwaTerminalSettings): void {
    if (this.el) applyWtermTheme(this.el, settings);
  }

  dispose(): void {
    this.term?.destroy();
    this.term = null;
    this.inputListeners.clear();
    this.resizeListeners.clear();
    this.titleListeners.clear();
  }

  // OSC 7: ESC ] 7 ; file://host/path (BEL | ST). Scanned across writes; keep
  // the most recent. See docs/SHELL_INTEGRATION.md to enable it remotely.
  private captureCwd(data: string): void {
    this.oscBuffer = (this.oscBuffer + data).slice(-1024);
    const re = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let match: RegExpExecArray | null;
    let last: RegExpExecArray | null = null;
    while ((match = re.exec(this.oscBuffer))) last = match;
    if (!last) return;
    try {
      this.cwd = decodeURIComponent(last[1]);
    } catch {
      this.cwd = last[1];
    }
    this.oscBuffer = this.oscBuffer.slice(re.lastIndex);
  }
}

/** Drive wterm's CSS custom properties from an iwa-ssh terminal settings object. */
export function applyWtermTheme(el: HTMLElement, settings: PwaTerminalSettings | undefined): void {
  if (!settings) return;
  const palette = getThemePalette(settings.theme);
  const style = el.style;
  style.setProperty('--term-bg', palette.background);
  style.setProperty('--term-fg', palette.foreground);
  style.setProperty('--term-cursor', palette.cursor);
  const ansi = [
    palette.black, palette.red, palette.green, palette.yellow,
    palette.blue, palette.magenta, palette.cyan, palette.white,
    palette.brightBlack, palette.brightRed, palette.brightGreen, palette.brightYellow,
    palette.brightBlue, palette.brightMagenta, palette.brightCyan, palette.brightWhite,
  ];
  ansi.forEach((color, i) => style.setProperty(`--term-color-${i}`, color));
  style.setProperty('--term-font-family', terminalFontFamily(settings));
  style.setProperty('--term-font-size', `${settings.fontSize}px`);
}
