import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { TerminalAdapter } from './TerminalAdapter';
import type { TerminalAppearance } from '../settings/types';

import '@xterm/xterm/css/xterm.css';

export type Xterm6TerminalAdapterOptions = {
  appearance: TerminalAppearance;
  onBell?: () => void;
};

export class Xterm6TerminalAdapter implements TerminalAdapter {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly searchAddon: SearchAddon;
  private resizeObserver: ResizeObserver | null = null;
  private inputCb: ((data: string) => void) | null = null;
  private resizeCb: ((cols: number, rows: number) => void) | null = null;
  private container: HTMLElement | null = null;

  constructor(options: Xterm6TerminalAdapterOptions) {
    const { appearance } = options;
    this.terminal = new Terminal({
      fontFamily: appearance.fontFamily,
      fontSize: appearance.fontSize,
      lineHeight: appearance.lineHeight,
      letterSpacing: appearance.letterSpacing,
      cursorStyle: appearance.cursorStyle,
      cursorBlink: appearance.cursorBlink,
      scrollback: appearance.scrollbackLines,
      theme: appearance.theme,
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new ClipboardAddon());

    this.terminal.onData((data) => this.inputCb?.(data));
    this.terminal.onResize(({ cols, rows }) => this.resizeCb?.(cols, rows));
    this.terminal.onBell(() => {
      if (options.onBell) {
        options.onBell();
      } else if (appearance.bell === 'visual') {
        this.flashBell();
      }
    });
  }

  open(el: HTMLElement): void {
    this.container = el;
    this.terminal.open(el);
    this.fitAddon.fit();
    this.resizeObserver = new ResizeObserver(() => this.fit());
    this.resizeObserver.observe(el);
    this.terminal.focus();
  }

  write(data: string | Uint8Array): void {
    this.terminal.write(data);
  }

  onInput(cb: (data: string) => void): void {
    this.inputCb = cb;
  }

  onResize(cb: (cols: number, rows: number) => void): void {
    this.resizeCb = cb;
  }

  focus(): void {
    this.terminal.focus();
  }

  fit(): void {
    if (!this.container) return;
    this.fitAddon.fit();
  }

  getSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  dispose(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.terminal.dispose();
    this.container = null;
  }

  getSearchAddon(): SearchAddon {
    return this.searchAddon;
  }

  private flashBell(): void {
    const el = this.container;
    if (!el) return;
    el.classList.add('terminal-bell-flash');
    window.setTimeout(() => el.classList.remove('terminal-bell-flash'), 120);
  }
}
