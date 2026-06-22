import { DA1_REPLY, deviceAttributeReply } from '../pwa/deviceAttributes';

/** One kitty graphics command ending in ST or BEL. */
const KITTY_COMMAND = /\x1b_G([^\\]*?)(?:;[^\x1b\\]*)?(?:\x1b\\|\x07)/g;
const KITTY_ACK = /\x1b_Gi=\d+;(OK|EINVAL:[^\x1b\\]*)\x1b\\/g;
const DSR_REPLY = /\x1b\[\d+;\d+R/g;
const QUERY_ACTION = /(?:^|,)a=q(?:,|$)/;
const IMAGE_ID = /(?:^|,)i=(\d+)(?:,|$)/;

function kittyQueryReply(id: string): string {
  return id === '1'
    ? `\x1b_Gi=${id};OK\x1b\\`
    : `\x1b_Gi=${id};EINVAL: unsupported medium\x1b\\`;
}

function decodeChunk(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
}

/** Stateful scanner for kitty/DA1 queries split across ET terminal buffers. */
export class TerminalQueryScanner {
  private carry = '';
  private answeredKittyIds = new Set<string>();

  ingest(chunk: Uint8Array | string): { kittyReplies: string[]; sendDa1: boolean } {
    this.carry = (this.carry + decodeChunk(chunk)).slice(-8192);
    const kittyReplies: string[] = [];

    for (const match of this.carry.matchAll(KITTY_COMMAND)) {
      const control = match[1];
      if (!QUERY_ACTION.test(control)) continue;
      const id = IMAGE_ID.exec(control)?.[1];
      if (!id || this.answeredKittyIds.has(id)) continue;
      this.answeredKittyIds.add(id);
      kittyReplies.push(kittyQueryReply(id));
    }

    return { kittyReplies, sendDa1: deviceAttributeReply(this.carry) !== null };
  }

  reset(): void {
    this.carry = '';
    this.answeredKittyIds.clear();
  }
}

/** Build immediate replies for terminal queries embedded in remote PTY output. */
export function terminalQueryReplies(chunk: Uint8Array | string): string[] {
  const scanner = new TerminalQueryScanner();
  const { kittyReplies, sendDa1 } = scanner.ingest(chunk);
  return sendDa1 ? [...kittyReplies, DA1_REPLY] : kittyReplies;
}

/** Remove terminal-generated query replies so duplicate late acks are not sent to ET. */
export function stripTerminalAutoReplies(data: string): string {
  return data
    .replaceAll(KITTY_ACK, '')
    .replaceAll(DA1_REPLY, '')
    .replace(DSR_REPLY, '');
}

/** True when Restty/parser output contains only auto-replies (no user keystrokes). */
export function isTerminalAutoReplyOnly(data: string): boolean {
  return data.length > 0 && stripTerminalAutoReplies(data).length === 0;
}
