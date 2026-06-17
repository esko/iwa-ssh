import { FitAddon, Terminal, init } from 'ghostty-web';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import { getThemePalette } from './themes';
import type { PwaTerminalSettings } from './types';
import { terminalFontFamily } from './settings';

let ghosttyReady: Promise<void> | null = null;

export function ensureGhosttyReady(): Promise<void> {
  ghosttyReady ??= init();
  return ghosttyReady;
}

export class GhosttyTerminalAdapter implements TerminalAdapter {
  private readonly terminal: Terminal;
  private readonly fitAddon = new FitAddon();
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private resizeObserver: ResizeObserver | null = null;
  private cwd: string | null = null;
  private oscBuffer = '';
  private readonly decoder = new TextDecoder();

  constructor(settings: PwaTerminalSettings) {
    this.terminal = new Terminal({
      cols: 100,
      rows: 30,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      fontFamily: terminalFontFamily(settings),
      fontSize: settings.fontSize,
      scrollback: settings.scrollback,
      theme: getThemePalette(settings.theme),
    });
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.onData((data: string) => {
      for (const listener of this.inputListeners) listener(data);
    });
    this.terminal.onResize(({ cols, rows }: { cols: number; rows: number }) => {
      for (const listener of this.resizeListeners) listener(cols, rows);
    });
  }

  open(el: HTMLElement): void {
    this.terminal.open(el);
    this.fit();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(el);
    this.terminal.focus();
  }

  write(data: string | Uint8Array): void {
    this.captureCwd(typeof data === 'string' ? data : this.decoder.decode(data, { stream: true }));
    this.terminal.write(data);
  }

  paste(data: string): void {
    this.terminal.paste(data);
  }

  /** Title set by the remote program via OSC 0/2 (e.g. "user@host: ~"). */
  onTitle(cb: (title: string) => void): TerminalSubscription {
    const sub = this.terminal.onTitleChange((title: string) => cb(title));
    return { dispose: () => sub.dispose() };
  }

  getSelection(): string {
    return this.terminal.getSelection();
  }

  hasSelection(): boolean {
    return this.terminal.hasSelection();
  }

  /** Remote working directory reported via OSC 7, if the shell emits it. */
  getCwd(): string | null {
    return this.cwd;
  }

  // OSC 7: ESC ] 7 ; file://host/path  (BEL | ST). Shells emit this to report
  // cwd; the sequence can straddle writes, so scan a rolling tail and keep the
  // most recent match. (See docs/SHELL_INTEGRATION.md to enable it remotely.)
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

  onInput(cb: (data: string) => void): TerminalSubscription {
    this.inputListeners.add(cb);
    return { dispose: () => this.inputListeners.delete(cb) };
  }

  onResize(cb: (cols: number, rows: number) => void): TerminalSubscription {
    this.resizeListeners.add(cb);
    return { dispose: () => this.resizeListeners.delete(cb) };
  }

  focus(): void {
    this.terminal.focus();
  }

  fit(): void {
    this.fitAddon.fit();
  }

  getSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  updateSettings(settings: PwaTerminalSettings): void {
    this.terminal.options.fontFamily = terminalFontFamily(settings);
    this.terminal.options.fontSize = settings.fontSize;
    this.terminal.options.cursorBlink = settings.cursorBlink;
    this.terminal.options.cursorStyle = settings.cursorStyle;
    this.terminal.options.scrollback = settings.scrollback;
    this.terminal.options.theme = getThemePalette(settings.theme);
    this.fit();
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.inputListeners.clear();
    this.resizeListeners.clear();
    this.terminal.dispose();
  }
}
