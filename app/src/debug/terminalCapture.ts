import { getDebugFlags } from './flags';
import { log } from './logger';

type CaptureChunk = {
  ts: number;
  direction: 'out' | 'in';
  data: string;
};

const captures = new Map<string, CaptureChunk[]>();

function getKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function recordTerminalOutput(sessionId: string, data: string | Uint8Array, direction: 'out' | 'in'): void {
  if (!getDebugFlags().termTrace && !getDebugFlags().debug) return;

  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const key = getKey(sessionId);
  const list = captures.get(key) ?? [];
  list.push({ ts: Date.now(), direction, data: text });
  if (list.length > 50_000) list.splice(0, list.length - 50_000);
  captures.set(key, list);
}

function getTerminalCapture(sessionId: string): CaptureChunk[] {
  return [...(captures.get(getKey(sessionId)) ?? [])];
}

export function downloadTerminalCapture(sessionId: string): void {
  const chunks = getTerminalCapture(sessionId);
  const body = chunks
    .map((c) => `[${new Date(c.ts).toISOString()}] ${c.direction}\n${c.data}`)
    .join('\n---\n');
  const blob = new Blob([body], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `iwa-ssh-${sessionId.slice(0, 8)}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
  log.term.info('capture-download', { sessionId, chunks: chunks.length });
}
