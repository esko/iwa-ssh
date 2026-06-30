const REMOTE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const DEFAULT_TERM_TYPE = 'xterm-256color';
/** Conservative terminfo-identifier charset — guards against shell injection via TERM. */
const TERM_TYPE_RE = /^[A-Za-z0-9_+.-]{1,40}$/;

/** Build a remote command that works when the SSH account uses fish, zsh, or bash. */
export function buildEtBootstrapCommand(clientId: string, passkey: string, termType?: string): string {
  if (!/^[A-Za-z0-9]{16}$/.test(clientId) || !/^[A-Za-z0-9]{32}$/.test(passkey)) {
    throw new Error('Invalid ET bootstrap credentials');
  }
  const term = termType && TERM_TYPE_RE.test(termType) ? termType : DEFAULT_TERM_TYPE;
  const registration = `${clientId}/${passkey}_${term}`;
  return `env PATH=${REMOTE_PATH} sh -c 'printf "%s\\n" "${registration}" | exec etterminal'`;
}
