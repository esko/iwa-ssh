import { DA1_QUERY, DA1_REPLY, deviceAttributeReply } from '../pwa/deviceAttributes';

/** One kitty graphics command ending in ST or BEL. */
const KITTY_COMMAND = /\x1b_G([^\\]*?)(?:;[^\x1b\\]*)?(?:\x1b\\|\x07)/g;
const KITTY_ACK = /\x1b_Gi=\d+;(OK|EINVAL:[^\x1b\\]*)\x1b\\/g;
const DSR_REPLY = /\x1b\[\d+;\d+R/g;
/** kitten serializes query action as `a=q`; some builds use the enum value `a=2`. */
const QUERY_ACTION = /(?:^|,)a=(?:q|2)(?:,|;|$)/;
const IMAGE_ID = /(?:^|,)i=(\d+)(?:,|;|$)/;

function kittyQueryReply(id: string): string {
  return id === '1'
    ? `\x1b_Gi=${id};OK\x1b\\`
    : `\x1b_Gi=${id};EINVAL: unsupported medium\x1b\\`;
}

const textDecoder = new TextDecoder();
/** Streaming decoder for ET output chunks that may split multibyte UTF-8. */
const probeStripDecoder = new TextDecoder();

function hasEscapeByte(chunk: Uint8Array | string): boolean {
  if (typeof chunk === 'string') return chunk.includes('\x1b');
  for (let i = 0; i < chunk.length; i += 1) {
    if (chunk[i] === 0x1b) return true;
  }
  return false;
}

function decodeChunk(chunk: Uint8Array | string): string {
  return typeof chunk === 'string' ? chunk : textDecoder.decode(chunk, { stream: true });
}

function stripProbesFromText(text: string): string {
  return text
    .replace(KITTY_COMMAND, (match, control: string) => (QUERY_ACTION.test(control) ? '' : match))
    .replaceAll(KITTY_ACK, '')
    .replace(DA1_QUERY, '')
    .replaceAll(DA1_REPLY, '')
    .replaceAll(DSR_REPLY, '');
}

/** Stateful scanner for kitty/DA1 queries split across ET terminal buffers. */
export class TerminalQueryScanner {
  private carry = '';
  private answeredKittyIds = new Set<string>();
  private sawKittyProbe = false;

  ingest(chunk: Uint8Array | string): { kittyReplies: string[]; sendDa1: boolean } {
    const chunkText = decodeChunk(chunk);
    this.carry = (this.carry + chunkText).slice(-8192);
    const kittyReplies: string[] = [];

    for (const match of this.carry.matchAll(KITTY_COMMAND)) {
      const control = match[1];
      if (!QUERY_ACTION.test(control)) continue;
      this.sawKittyProbe = true;
      const id = IMAGE_ID.exec(control)?.[1];
      if (!id || this.answeredKittyIds.has(id)) continue;
      this.answeredKittyIds.add(id);
      kittyReplies.push(kittyQueryReply(id));
    }

    const sendDa1 = deviceAttributeReply(chunkText) !== null
      && (this.answeredKittyIds.has('1') || !this.sawKittyProbe);

    if (sendDa1) {
      this.answeredKittyIds.clear();
      this.sawKittyProbe = false;
      this.carry = '';
    }

    return { kittyReplies, sendDa1 };
  }

  reset(): void {
    this.carry = '';
    this.answeredKittyIds.clear();
    this.sawKittyProbe = false;
  }
}

/** Build immediate replies for terminal queries embedded in remote PTY output. */
export function terminalQueryReplies(chunk: Uint8Array | string): string[] {
  const scanner = new TerminalQueryScanner();
  const { kittyReplies, sendDa1 } = scanner.ingest(chunk);
  return sendDa1 ? [...kittyReplies, DA1_REPLY] : kittyReplies;
}

/**
 * Remove remote kitty/DA1 probes before Restty renders ET output. Probes are
 * answered in the ET worker; forwarding them causes visible control-character
 * garbage and races Restty's delayed DA1 shim against icat detect.
 */
export function stripInboundTerminalProbes(chunk: Uint8Array | string): string {
  if (typeof chunk === 'string') {
    return hasEscapeByte(chunk) ? stripProbesFromText(chunk) : chunk;
  }
  if (!hasEscapeByte(chunk)) return probeStripDecoder.decode(chunk, { stream: true });
  return stripProbesFromText(probeStripDecoder.decode(chunk, { stream: true }));
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
