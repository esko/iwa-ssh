import { DA1_REPLY, deviceAttributeReply } from '../pwa/deviceAttributes';

/** Kitty graphics query: ESC _ G i=N,a=q,... ESC \ */
const KITTY_QUERY = /\x1b_Gi=(\d+),a=q[^\x1b\\]*(?:\x1b\\|\x07)/g;
const KITTY_ACK = /\x1b_Gi=\d+;(OK|EINVAL:[^\x1b\\]*)\x1b\\/g;
const DSR_REPLY = /\x1b\[\d+;\d+R/g;

/** Build immediate replies for terminal queries embedded in remote PTY output. */
export function terminalQueryReplies(chunk: Uint8Array | string): string[] {
  const text = typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk);
  const replies: string[] = [];
  const seenKittyIds = new Set<string>();

  for (const match of text.matchAll(KITTY_QUERY)) {
    const id = match[1];
    if (seenKittyIds.has(id)) continue;
    seenKittyIds.add(id);
    replies.push(
      id === '1'
        ? '\x1b_Gi=1;OK\x1b\\'
        : `\x1b_Gi=${id};EINVAL: unsupported medium\x1b\\`,
    );
  }

  const da1 = deviceAttributeReply(text);
  if (da1) replies.push(da1);

  return replies;
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
