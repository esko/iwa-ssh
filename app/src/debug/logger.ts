export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  ts: number;
  level: LogLevel;
  namespace: string;
  message: string;
  data?: unknown;
};

const MAX_ENTRIES = 500;
const entries: LogEntry[] = [];

let verbose = false;

export function setVerboseLogging(enabled: boolean): void {
  verbose = enabled;
}

export function getRecentLogs(limit = 100): LogEntry[] {
  return entries.slice(-limit);
}

function emit(level: LogLevel, namespace: string, message: string, data?: unknown): void {
  const entry: LogEntry = { ts: Date.now(), level, namespace, message, data };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();

  const prefix = `${namespace}:${message}`;
  const args = data === undefined ? [] : [data];

  if (level === 'error') console.error(prefix, ...args);
  else if (level === 'warn') console.warn(prefix, ...args);
  else if (level === 'debug' && verbose) console.debug(prefix, ...args);
  else if (level !== 'debug') console.info(prefix, ...args);
}

function bind(ns: string) {
  return {
    debug: (message: string, data?: unknown) => emit('debug', ns, message, data),
    info: (message: string, data?: unknown) => emit('info', ns, message, data),
    warn: (message: string, data?: unknown) => emit('warn', ns, message, data),
    error: (message: string, data?: unknown) => emit('error', ns, message, data),
  };
}

export const log = {
  socket: bind('socket'),
  ssh: bind('ssh'),
  term: bind('term'),
  session: bind('session'),
  tabs: bind('tabs'),
  storage: bind('storage'),
  knownHosts: bind('known-hosts'),
  app: bind('app'),
};

export type SessionDebugState = {
  lastError?: string;
  lastExitCode?: number;
  activeSessionIds: string[];
};

const sessionDebug: SessionDebugState = {
  activeSessionIds: [],
};

export function getSessionDebugState(): SessionDebugState {
  return { ...sessionDebug, activeSessionIds: [...sessionDebug.activeSessionIds] };
}

export function registerActiveSession(id: string): void {
  if (!sessionDebug.activeSessionIds.includes(id)) {
    sessionDebug.activeSessionIds.push(id);
  }
}

export function unregisterActiveSession(id: string): void {
  sessionDebug.activeSessionIds = sessionDebug.activeSessionIds.filter((x) => x !== id);
}

export function setLastSessionError(error: string | undefined): void {
  sessionDebug.lastError = error;
}
