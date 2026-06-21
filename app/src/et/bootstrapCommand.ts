const REMOTE_PATH = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

/** Build a remote command that works when the SSH account uses fish, zsh, or bash. */
export function buildEtBootstrapCommand(clientId: string, passkey: string): string {
  if (!/^[A-Za-z0-9]{16}$/.test(clientId) || !/^[A-Za-z0-9]{32}$/.test(passkey)) {
    throw new Error('Invalid ET bootstrap credentials');
  }
  const registration = `${clientId}/${passkey}_xterm-256color`;
  return `env PATH=${REMOTE_PATH} sh -c 'printf "%s\\n" "${registration}" | exec etterminal'`;
}
