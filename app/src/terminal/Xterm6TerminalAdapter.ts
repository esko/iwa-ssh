import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import type { TerminalAdapter, TerminalSubscription } from './TerminalAdapter';
import { applyKeyboardBindings, type KeyboardBindingsHandle } from './keyboardBindings';
import { createXtermConstructorOptions } from './xtermOptions';
import type { KeyboardSettings, TerminalAppearance, TerminalPerformance } from '../settings/types';

import '@xterm/xterm/css/xterm.css';

export type Xterm6TerminalAdapterOptions = {
  appearance: TerminalAppearance;
  keyboard?: KeyboardSettings;
  performance?: TerminalPerformance;
  onBell?: () => void;
};

export class Xterm6TerminalAdapter implements TerminalAdapter {
  private readonly terminal: Terminal;
  private readonly fitAddon: FitAddon;
  private readonly searchAddon: SearchAddon;
  private resizeObserver: ResizeObserver | null = null;
  private fitDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly fitDebounceMs: number;
  private readonly inputListeners = new Set<(data: string) => void>();
  private readonly resizeListeners = new Set<(cols: number, rows: number) => void>();
  private container: HTMLElement | null = null;
  private keyboardBindings: KeyboardBindingsHandle | null = null;
  private readonly keyboard: KeyboardSettings | undefined;

  constructor(options: Xterm6TerminalAdapterOptions) {
    const { appearance } = options;
    this.keyboard = options.keyboard;
    this.fitDebounceMs = options.performance?.resizeDebounceMs ?? 100;
    this.terminal = new Terminal(createXtermConstructorOptions(appearance, this.keyboard));

    this.fitAddon = new FitAddon();
    this.searchAddon = new SearchAddon();
    this.terminal.loadAddon(this.fitAddon);
    this.terminal.loadAddon(new WebLinksAddon());
    this.terminal.loadAddon(this.searchAddon);
    this.terminal.loadAddon(new ClipboardAddon());

    this.terminal.onData((data) => {
      for (const listener of this.inputListeners) {
        listener(data);
      }
    });
    this.terminal.onResize(({ cols, rows }) => {
      for (const listener of this.resizeListeners) {
        listener(cols, rows);
      }
    });
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
    if (this.keyboard) {
      this.keyboardBindings = applyKeyboardBindings(this.terminal, el, this.keyboard);
    }
    this.fitAddon.fit();
    this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
    this.resizeObserver.observe(el);
    this.terminal.focus();
  }

  write(data: string | Uint8Array): void {
    this.terminal.write(data);
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
    if (!this.container) return;
    this.fitAddon.fit();
  }

  /** Debounce rapid ResizeObserver events before propagating SIGWINCH via onResize. */
  scheduleFit(): void {
    if (this.fitDebounceTimer) clearTimeout(this.fitDebounceTimer);
    this.fitDebounceTimer = setTimeout(() => {
      this.fitDebounceTimer = null;
      this.fit();
    }, this.fitDebounceMs);
  }

  getSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows };
  }

  updateAppearance(appearance: TerminalAppearance): void {
    this.terminal.options.fontFamily = appearance.fontFamily;
    this.terminal.options.fontSize = appearance.fontSize;
    this.terminal.options.lineHeight = appearance.lineHeight;
    this.terminal.options.letterSpacing = appearance.letterSpacing;
    this.terminal.options.cursorStyle = appearance.cursorStyle;
    this.terminal.options.cursorBlink = appearance.cursorBlink;
    this.terminal.options.fontWeight = 'normal';
    this.terminal.options.fontWeightBold = appearance.boldTextEnabled ? 'bold' : 'normal';
    this.terminal.options.scrollback = appearance.scrollbackLines;
    this.terminal.options.theme = appearance.theme;
    this.scheduleFit();
  }

  dispose(): void {
    if (this.fitDebounceTimer) clearTimeout(this.fitDebounceTimer);
    this.fitDebounceTimer = null;
    this.keyboardBindings?.dispose();
    this.keyboardBindings = null;
    this.inputListeners.clear();
    this.resizeListeners.clear();
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
