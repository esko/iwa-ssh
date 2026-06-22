/**
 * CSP-safe hterm.Terminal + hterm.Terminal.IO shim for nassh CommandInstance.
 * No upstream hterm import — xterm is the only terminal UI.
 */

import { log } from '../debug/logger';
import { isNasshBootstrapOutput } from './nasshBootstrap';
import type { TerminalSink, TerminalSubscription, TerminalViewport } from '../terminal/TerminalAdapter';
import type { HtermStubTerminal, HtermTerminalIo } from './upstreamTypes';

export type NasshIoShimOptions = {
  onOutput?: (data: string | Uint8Array) => void;
};

/** @deprecated Use NasshIoShimOptions */
export type AttachTerminalOptions = NasshIoShimOptions;

function overlayMessageToText(message: unknown): string | null {
  if (typeof message === 'string') return message;
  if (message instanceof Node) return message.textContent?.trim() ?? null;
  return null;
}

function formatOverlayBanner(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return '';
  return `\r\n\x1b[90m── ${lines.join('\r\n── ')}\x1b[0m\r\n`;
}

class NasshTerminalIo implements HtermTerminalIo {
  terminal_: HtermStubTerminal;
  previousIO_: NasshTerminalIo | null = null;
  buffered_ = '';
  private readonly textDecoder_ = new TextDecoder();
  columnCount = 0;
  rowCount = 0;

  sendString: (data: string) => void = (string) => {
    log.term.debug('unhandled sendString', { preview: string.slice(0, 32) });
  };

  onVTKeystroke: (data: string) => void = (string) => {
    log.term.debug('unhandled onVTKeystroke', { preview: string.slice(0, 32) });
  };

  onTerminalResize: (_width: number, _height: number) => void = () => {};

  constructor(terminal: HtermStubTerminal) {
    this.terminal_ = terminal;
    this.columnCount = terminal.screenSize.width;
    this.rowCount = terminal.screenSize.height;
  }

  showOverlay(message: unknown, timeout?: number | null): void {
    this.terminal_.showOverlay(message, timeout);
  }

  hideOverlay(): void {
    this.terminal_.hideOverlay();
  }

  setTerminalProfile(profileName: string): void {
    this.terminal_.setProfile(profileName);
  }

  push(): HtermTerminalIo {
    const io = new NasshTerminalIo(this.terminal_);
    io.columnCount = this.columnCount;
    io.rowCount = this.rowCount;
    io.previousIO_ = this.terminal_.io as NasshTerminalIo;
    this.terminal_.io = io;
    return io;
  }

  pop(): void {
    if (!this.previousIO_) return;
    this.terminal_.io = this.previousIO_;
    this.previousIO_.flush();
  }

  flush(): void {
    if (!this.buffered_) return;
    this.terminal_.interpret(this.buffered_);
    this.buffered_ = '';
  }

  onTerminalResize_(width: number, height: number): void {
    let obj: NasshTerminalIo | null = this;
    while (obj) {
      obj.columnCount = width;
      obj.rowCount = height;
      obj = obj.previousIO_;
    }
    this.onTerminalResize(width, height);
  }

  writeUTF8(buffer: ArrayBuffer | ArrayLike<number>): void {
    const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    // wassh writes are arbitrary byte chunks, not UTF-8 character boundaries.
    // An empty write is an explicit boundary and flushes any incomplete tail.
    const string = u8.byteLength === 0
      ? this.textDecoder_.decode()
      : this.textDecoder_.decode(u8, { stream: true });
    this.print(string);
  }

  writelnUTF8(buffer: ArrayBuffer | ArrayLike<number>): void {
    this.writeUTF8(buffer);
    this.writeUTF8(new Uint8Array());
    this.writeUTF8(new Uint8Array([0x0d, 0x0a]));
  }

  print(string: string): void {
    // Always deliver — xterm is the only UI. When nassh pushes a transient IO layer
    // (username prompt, etc.) that never pops in IWA, the old buffer-until-pop path
    // hid all remote shell output. Bootstrap status is filtered in interpret().
    this.terminal_.interpret(string);
  }

  println(string: string): void {
    this.print(`${string}\r\n`);
  }
}

function createIoProxy(io: HtermTerminalIo): HtermTerminalIo {
  if (!import.meta.env.DEV) return io;
  return new Proxy(io, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && !(prop in target)) {
        log.term.warn('missing nassh IO property', { prop });
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export class NasshIoShim {
  readonly io: HtermTerminalIo;
  private readonly stubTerminal: HtermStubTerminal;
  private inputSubscription: TerminalSubscription | null = null;
  private overlayHideTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly adapter: TerminalSink,
    private readonly options: NasshIoShimOptions = {},
  ) {
    const { cols, rows, widthPx, heightPx } = adapter.getSize();

    const showOverlay = (message: unknown, timeout?: number | null): void => {
      const text = overlayMessageToText(message);
      if (text) {
        this.adapter.write(formatOverlayBanner(text));
      }
      if (this.overlayHideTimer) {
        clearTimeout(this.overlayHideTimer);
        this.overlayHideTimer = null;
      }
      if (timeout != null && timeout > 0) {
        this.overlayHideTimer = setTimeout(() => {
          this.overlayHideTimer = null;
        }, timeout);
      }
    };

    const hideOverlay = (): void => {
      if (this.overlayHideTimer) {
        clearTimeout(this.overlayHideTimer);
        this.overlayHideTimer = null;
      }
    };

    this.stubTerminal = {
      interpret: (message) => {
        if (!isNasshBootstrapOutput(message)) {
          this.adapter.write(message);
        }
        this.options.onOutput?.(message);
      },
      clearHome: () => {
        this.adapter.write('\x1b[2J\x1b[H');
      },
      setProfile: () => {},
      screenSize: { width: cols, height: rows, widthPx, heightPx },
      showOverlay,
      hideOverlay,
      focus: () => {
        this.adapter.focus();
      },
      io: null as unknown as HtermTerminalIo,
    };

    const terminalIo = new NasshTerminalIo(this.stubTerminal);
    this.stubTerminal.io = terminalIo;
    this.io = createIoProxy(terminalIo);
  }

  bindInput(): void {
    if (this.inputSubscription) return;
    this.inputSubscription = this.adapter.onInput((data) => {
      // wassh wires sendString on the root IO at Tty init; the active stack top
      // may be a pushed overlay layer with a no-op handler.
      const root = this.io as HtermTerminalIo;
      root.sendString(data);
      if (root.onVTKeystroke !== root.sendString) {
        root.onVTKeystroke(data);
      }
    });
  }

  /** Send to the root nassh IO layer (host-key yes/no, etc.). */
  sendKeystroke(data: string): void {
    const root = this.io as HtermTerminalIo;
    root.sendString(data);
  }

  resize(viewport: TerminalViewport): void {
    const { cols, rows, widthPx, heightPx } = viewport;
    if (
      this.stubTerminal.screenSize.width === cols &&
      this.stubTerminal.screenSize.height === rows &&
      this.stubTerminal.screenSize.widthPx === widthPx &&
      this.stubTerminal.screenSize.heightPx === heightPx
    ) {
      return;
    }
    this.stubTerminal.screenSize.width = cols;
    this.stubTerminal.screenSize.height = rows;
    this.stubTerminal.screenSize.widthPx = widthPx;
    this.stubTerminal.screenSize.heightPx = heightPx;
    log.term.debug('terminal resize', { cols, rows, widthPx, heightPx });
    this.io.onTerminalResize_(cols, rows);
  }

  dispose(): void {
    const io = this.io as HtermTerminalIo;
    io.writeUTF8?.(new Uint8Array());
    if (this.overlayHideTimer) clearTimeout(this.overlayHideTimer);
    this.overlayHideTimer = null;
    this.inputSubscription?.dispose();
    this.inputSubscription = null;
  }
}
