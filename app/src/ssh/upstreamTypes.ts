/**
 * Minimal upstream libapps types for Phase 1 nassh/hterm bridge (not full Closure typings).
 */

export type HtermStubTerminal = {
  interpret: (message: string) => void;
  clearHome: () => void;
  setProfile: (profileId: string) => void;
  screenSize: { width: number; height: number; widthPx: number; heightPx: number };
  showOverlay: (message: unknown, timeout?: number | null) => void;
  hideOverlay: () => void;
  focus: () => void;
  io: HtermTerminalIo;
};

export type HtermTerminalIo = {
  terminal_: HtermStubTerminal;
  columnCount?: number;
  rowCount?: number;
  sendString: (data: string) => void;
  onVTKeystroke: (data: string) => void;
  onTerminalResize_: (width: number, height: number) => void;
  onTerminalResize: (width: number, height: number) => void;
  print: (data: string) => void;
  println: (data: string) => void;
  writeUTF8?: (buffer: ArrayBuffer | ArrayLike<number>) => void;
  writelnUTF8?: (buffer: ArrayBuffer | ArrayLike<number>) => void;
  setTerminalProfile?: (profileName: string) => void;
  push: () => HtermTerminalIo;
  pop: () => void;
  showOverlay: (message: unknown, timeout?: number | null) => void;
  hideOverlay: () => void;
  flush?: () => void;
};

export type HtermNamespace = {
  initPromise?: Promise<void>;
  VERSION?: string;
  Terminal: {
    IO: new (terminal: HtermStubTerminal) => HtermTerminalIo;
    DEFAULT_PROFILE_ID: string;
  };
};

export type NasshConnectParams = {
  hostname: string;
  port?: number;
  username: string;
  command?: string;
  argstr?: string;
  nasshOptions?: string;
  /** Basename under /.ssh/identity/ (not a full path). */
  identity?: string;
};

export type NasshCommandInstance = {
  connectTo: (params: NasshConnectParams) => Promise<void>;
  secureInput: (prompt: string, bufLen: number, echo: boolean) => Promise<string>;
  onPluginExit: (code: number) => Promise<void>;
  terminateProgram_: () => void;
  exit: (code: number, noReconnect: boolean) => void;
  onSftpInitialised?: () => void;
  sftpClient?: NasshSftpClient | null;
};

export type NasshSftpEntry = {
  filename: string;
  lastModified?: number;
  isDirectory?: boolean;
};

export type NasshSftpClient = {
  isInitialised: boolean;
  writeChunkSize: number;
  realPath(path: string): Promise<{ files: NasshSftpEntry[] }>;
  makeDirectory(path: string): Promise<unknown>;
  fileStatus(path: string): Promise<unknown>;
  openDirectory(path: string): Promise<string>;
  scanDirectory(handle: string): Promise<NasshSftpEntry[]>;
  openFile(path: string, flags: number): Promise<string>;
  writeChunk(handle: string, offset: number, data: Uint8Array): Promise<unknown>;
  closeFile(handle: string): Promise<unknown>;
  setFileStatus(path: string, attrs: { permissions: number }): Promise<unknown>;
  renameFile(from: string, to: string): Promise<unknown>;
  removeFile(path: string): Promise<unknown>;
};

export type NasshCommandInstanceCtor = new (argv: {
  io: HtermTerminalIo;
  syncStorage: unknown;
  environment?: Record<string, string>;
  onExit?: (code: number) => void;
  terminalLocation?: { href: string; hash: string; replace: (url: string) => void };
  isSftp?: boolean;
  sftpStartupCallback?: (success: boolean, message: string | null) => void;
}) => NasshCommandInstance;

export type NasshJsModule = {
  getSyncStorage: () => unknown;
  setupForWebApp: () => Promise<void>;
};

export type NasshCommandModule = {
  CommandInstance: NasshCommandInstanceCtor;
};
