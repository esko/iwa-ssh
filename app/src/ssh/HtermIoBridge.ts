/**
 * Stub hterm.Terminal + hterm.Terminal.IO wired to TerminalAdapter.
 *
 * Pattern from upstream nassh_external_api.js (mount connection) — CommandInstance
 * talks to hterm.IO; we render via xterm instead of hterm UI.
 */

import { log } from '../debug/logger';
import type { TerminalAdapter, TerminalSubscription } from '../terminal/TerminalAdapter';
import type { HtermNamespace, HtermStubTerminal, HtermTerminalIo } from './upstreamTypes';
import { upstreamImport } from './upstreamUrls';

let htermModulePromise: Promise<HtermNamespace> | null = null;

/** Load hterm.Terminal.IO from copied upstream assets (shared module singleton). */
export async function loadHtermTerminalIo(): Promise<HtermNamespace> {
  if (!htermModulePromise) {
    htermModulePromise = (async () => {
      const { hterm } = await upstreamImport<{ hterm: HtermNamespace }>('hterm/js/hterm.js');
      await upstreamImport('hterm/js/hterm_terminal_io.js');
      hterm.Terminal ??= { DEFAULT_PROFILE_ID: 'default' } as HtermNamespace['Terminal'];
      hterm.Terminal.DEFAULT_PROFILE_ID ??= 'default';
      await hterm.initPromise;
      return hterm;
    })();
  }
  return htermModulePromise;
}

export type HtermIoBridgeOptions = {
  onOutput?: (data: string | Uint8Array) => void;
};

/** @deprecated Use HtermIoBridgeOptions — kept for NasshSession.attachTerminal. */
export type AttachTerminalOptions = HtermIoBridgeOptions;

export class HtermIoBridge {
  readonly io: HtermTerminalIo;
  private readonly stubTerminal: HtermStubTerminal;
  private inputSubscription: TerminalSubscription | null = null;

  constructor(
    private readonly adapter: TerminalAdapter,
    hterm: HtermNamespace,
    private readonly options: HtermIoBridgeOptions = {},
  ) {
    const { cols, rows } = adapter.getSize();
    this.stubTerminal = {
      interpret: (message) => {
        this.adapter.write(message);
        this.options.onOutput?.(message);
      },
      clearHome: () => {
        this.adapter.write('\x1b[2J\x1b[H');
      },
      setProfile: () => {},
      screenSize: { width: cols, height: rows },
      showOverlay: () => {},
      hideOverlay: () => {},
      io: null as unknown as HtermTerminalIo,
    };

    const IoCtor = hterm.Terminal.IO;
    this.io = new IoCtor(this.stubTerminal);
    this.stubTerminal.io = this.io;
  }

  /** Forward xterm keystrokes into the active nassh/wassh session. */
  bindInput(): void {
    if (this.inputSubscription) return;
    this.inputSubscription = this.adapter.onInput((data) => {
      this.io.sendString(data);
    });
  }

  resize(cols: number, rows: number): void {
    if (
      this.stubTerminal.screenSize.width === cols &&
      this.stubTerminal.screenSize.height === rows
    ) {
      return;
    }
    this.stubTerminal.screenSize.width = cols;
    this.stubTerminal.screenSize.height = rows;
    log.term.debug('terminal resize', { cols, rows });
    this.io.onTerminalResize_(cols, rows);
  }

  dispose(): void {
    this.inputSubscription?.dispose();
    this.inputSubscription = null;
  }
}
