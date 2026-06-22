import { DA1_REPLY } from '../pwa/deviceAttributes';

/** Minimal port of kitten icat DetectSupport escape handling. */
export function icatDetectAccepts(replies: string[]): boolean {
  let direct = false;
  for (const reply of replies) {
    if (reply.startsWith('\x1b_G')) {
      const id = /^\x1b_Gi=(\d+);OK\x1b\\$/.exec(reply)?.[1];
      if (id === '1') direct = true;
      continue;
    }
    if (/^\x1b\[\?[\d;]*c$/.test(reply)) {
      return direct;
    }
  }
  return direct;
}

export function icatDetectFails(replies: string[]): boolean {
  return !icatDetectAccepts(replies);
}

export { DA1_REPLY };
