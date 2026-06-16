/**
 * Runtime URLs for copied libapps assets under app/upstream/ (not public/ — Vite blocks import from public).
 */

export function getUpstreamBase(): string {
  return typeof __IWA_UPSTREAM_BASE__ !== 'undefined' ? __IWA_UPSTREAM_BASE__ : '/upstream';
}

/** Absolute URL for a file under the upstream tree. */
export function upstreamUrl(relativePath: string): string {
  const base = getUpstreamBase().replace(/\/$/, '');
  const path = relativePath.replace(/^\//, '');
  return `${base}/${path}`;
}

/** Modules loaded at runtime — string literals required for @vite-ignore. */
type UpstreamModuleId =
  | 'nassh/js/nassh_command_instance.js'
  | 'nassh/js/nassh.js'
  | 'nassh/js/nassh_fs.js';

function normalizeModuleId(relativePath: string): UpstreamModuleId {
  const path = relativePath.replace(/^\//, '') as UpstreamModuleId;
  switch (path) {
    case 'nassh/js/nassh_command_instance.js':
    case 'nassh/js/nassh.js':
    case 'nassh/js/nassh_fs.js':
      return path;
    default:
      throw new Error(`Unknown upstream module: ${relativePath}`);
  }
}

/** Dynamic import from /upstream/ without bundling into the Vite app chunk. */
export async function upstreamImport<T = unknown>(relativePath: string): Promise<T> {
  const path = normalizeModuleId(relativePath);
  try {
    switch (path) {
      case 'nassh/js/nassh_command_instance.js':
        return (await import(/* @vite-ignore */ '/upstream/nassh/js/nassh_command_instance.js')) as T;
      case 'nassh/js/nassh.js':
        return (await import(/* @vite-ignore */ '/upstream/nassh/js/nassh.js')) as T;
      case 'nassh/js/nassh_fs.js':
        return (await import(/* @vite-ignore */ '/upstream/nassh/js/nassh_fs.js')) as T;
    }
  } catch (error) {
    const url = new URL(upstreamUrl(path), window.location.href).href;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load upstream module ${path} (${url}): ${detail}`, {
      cause: error,
    });
  }
}
