import {
  normalizeConnectionSpec,
  type TerminalConnectionSpec,
  type TerminalProtocol,
} from './TerminalConnectionSpec';

const SSH_FLAG_OPTIONS = '46AaCfGgKkMNnqsTtVvXxYy@';

export type ParsedSshCommand = {
  destination: string | null;
  argstr: string;
};

export type ParsedSshDestination = {
  username: string;
  hostname: string;
  port: number | null;
};

function shellTokens(command: string): Array<{ value: string; raw: string; index: number }> {
  return [...command.matchAll(/(?:"[^"]*"|\S+)/g)].map((match) => ({
    value: match[0].replace(/(^"|"$)/g, ''),
    raw: match[0],
    index: match.index ?? 0,
  }));
}

export function parseCommand(command: string): ParsedSshCommand {
  const tokens = shellTokens(command);
  let skipNext = false;

  for (const token of tokens) {
    if (skipNext) {
      skipNext = false;
      continue;
    }

    const arg = token.value;
    if (!arg.startsWith('-')) {
      return {
        destination: arg,
        argstr: (command.slice(0, token.index) + command.slice(token.index + token.raw.length)).trim(),
      };
    }

    for (let index = 1; index < arg.length; index += 1) {
      if (SSH_FLAG_OPTIONS.includes(arg[index])) {
        continue;
      }
      skipNext = index === arg.length - 1;
      break;
    }
  }

  return {
    destination: null,
    argstr: command.trim(),
  };
}

export function parseSSHDestination(destination: string | null): ParsedSshDestination | null {
  if (!destination) {
    return null;
  }

  const sshUrlMatch = destination.match(/^ssh:\/\/(.+)@([^:@]+)(?::(\d+))?$/i);
  if (sshUrlMatch) {
    const [, username, hostname, port] = sshUrlMatch;
    return {
      username,
      hostname,
      port: port ? Number.parseInt(port, 10) : null,
    };
  }

  const match = destination.match(/^(.+)@([^@]+)$/);
  if (!match) {
    return null;
  }

  const [, username, rawHostname] = match;
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname;

  return { username, hostname, port: null };
}

function extractPort(args: string): number | undefined {
  const tokens = shellTokens(args);
  for (let index = 0; index < tokens.length; index += 1) {
    const arg = tokens[index].value;
    if (arg === '-p') {
      const port = Number(tokens[index + 1]?.value);
      return Number.isFinite(port) ? port : undefined;
    }
    if (arg.startsWith('-p') && arg.length > 2) {
      const port = Number(arg.slice(2));
      return Number.isFinite(port) ? port : undefined;
    }
  }
  return undefined;
}

export function parseTerminalConnectionCommand(input: string): TerminalConnectionSpec | null {
  const tokens = shellTokens(input.trim());
  const first = tokens[0]?.value.toLowerCase();
  const protocol: TerminalProtocol = first === 'mosh' ? 'mosh' : first === 'et' ? 'et' : 'ssh';
  const command = first === 'ssh' || first === 'mosh' || first === 'et'
    ? input.slice((tokens[0]?.index ?? 0) + (tokens[0]?.raw.length ?? 0)).trim()
    : input.trim();

  const parsedCommand = parseCommand(command);
  const destination = parseSSHDestination(parsedCommand.destination);
  if (!destination) {
    return null;
  }

  return normalizeConnectionSpec({
    protocol,
    username: destination.username,
    hostname: destination.hostname,
    port: extractPort(parsedCommand.argstr) ?? destination.port ?? undefined,
    args: shellTokens(parsedCommand.argstr).map((token) => token.value),
    argstr: parsedCommand.argstr || undefined,
    rawCommand: input,
  });
}
