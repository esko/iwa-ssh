import { listIdentities, saveIdentity } from '../storage/indexedDb';
import type { Identity } from '../settings/types';

export type ParsedOpenSshKey = {
  publicKey: string;
  privateKeyBytes: ArrayBuffer;
  keyType: string;
  label: string;
  isEncrypted: boolean;
};

type ParseError = { ok: false; message: string };
type ParseSuccess = { ok: true; value: ParsedOpenSshKey };

// TODO(security): encrypt privateKeyBytes with WebCrypto + user passphrase before persisting.
// Dev-only: raw PEM bytes are stored in Identity.privateKeyPemBytesDevOnly until encryption lands.

function readUint32BE(buf: Uint8Array, offset: number): [number, number] {
  const view = new DataView(buf.buffer, buf.byteOffset + offset, buf.byteLength - offset);
  return [view.getUint32(0, false), offset + 4];
}

function readBytes(buf: Uint8Array, offset: number, length: number): [Uint8Array, number] {
  return [buf.slice(offset, offset + length), offset + length];
}

function readByteString(buf: Uint8Array, offset: number): [Uint8Array, number] {
  const [len, next] = readUint32BE(buf, offset);
  return readBytes(buf, next, len);
}

function readString(buf: Uint8Array, offset: number): [string, number] {
  const [bytes, end] = readByteString(buf, offset);
  return [new TextDecoder().decode(bytes), end];
}

function stripPem(pem: string): Uint8Array {
  const lines = pem
    .trim()
    .split(/\r?\n/)
    .filter((line) => !line.startsWith('-----'));
  const b64 = lines.join('');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function publicWireToOpenSsh(wire: Uint8Array): string {
  const [keyType] = readString(wire, 0);
  let binary = '';
  for (let i = 0; i < wire.length; i += 1) {
    binary += String.fromCharCode(wire[i]!);
  }
  return `${keyType} ${btoa(binary)}`;
}

function defaultLabel(keyType: string, comment?: string): string {
  const trimmed = comment?.trim();
  if (trimmed) return trimmed;
  return `${keyType} key`;
}

/**
 * Parse an OpenSSH private key PEM (encrypted or not). Public key is always extracted;
 * private material is returned as raw bytes for later WebCrypto encryption.
 */
export function parseOpenSshPrivateKeyPem(pem: string, labelHint?: string): ParseSuccess | ParseError {
  const trimmed = pem.trim();
  if (!trimmed.includes('BEGIN OPENSSH PRIVATE KEY')) {
    return { ok: false, message: 'Expected an OpenSSH private key (BEGIN OPENSSH PRIVATE KEY).' };
  }

  let bytes: Uint8Array;
  try {
    bytes = stripPem(trimmed);
  } catch {
    return { ok: false, message: 'Invalid base64 in PEM block.' };
  }

  const magic = 'openssh-key-v1\0';
  const header = new TextDecoder().decode(bytes.slice(0, magic.length));
  if (header !== magic) {
    return { ok: false, message: 'Unrecognized OpenSSH key format.' };
  }

  let offset = magic.length;
  const [cipherName, o1] = readString(bytes, offset);
  offset = o1;
  const [kdfName, o2] = readString(bytes, offset);
  offset = o2;
  const [, o3] = readString(bytes, offset);
  offset = o3;
  const [nkeys, o4] = readUint32BE(bytes, offset);
  offset = o4;

  if (nkeys !== 1) {
    return { ok: false, message: 'Only single-key OpenSSH PEM files are supported.' };
  }

  const [publicWire, o5] = readByteString(bytes, offset);
  offset = o5;
  const [keyType] = readString(publicWire, 0);

  const isEncrypted = cipherName !== 'none';
  if (isEncrypted && kdfName !== 'bcrypt') {
    return { ok: false, message: `Unsupported KDF: ${kdfName || '(none)'}.` };
  }

  let comment = labelHint;
  if (!isEncrypted) {
    const [privatePayload] = readByteString(bytes, offset);
    let privateOffset = 0;
    const [, afterCheck1] = readUint32BE(privatePayload, privateOffset);
    privateOffset = afterCheck1;
    const [, afterCheck2] = readUint32BE(privatePayload, privateOffset);
    privateOffset = afterCheck2;
    const [, afterKeyType] = readString(privatePayload, privateOffset);
    privateOffset = afterKeyType;
    const [, afterPub] = readString(privatePayload, privateOffset);
    privateOffset = afterPub;
    const [, afterPriv] = readString(privatePayload, privateOffset);
    privateOffset = afterPriv;
    const [parsedComment] = readString(privatePayload, privateOffset);
    comment = parsedComment || comment;
  }

  const encoder = new TextEncoder();
  const privateKeyBytes = encoder.encode(trimmed).buffer;

  return {
    ok: true,
    value: {
      publicKey: publicWireToOpenSsh(publicWire),
      privateKeyBytes,
      keyType,
      label: defaultLabel(keyType, comment),
      isEncrypted,
    },
  };
}

export async function importIdentityFromPem(pem: string, label?: string): Promise<Identity> {
  const parsed = parseOpenSshPrivateKeyPem(pem, label);
  if (!parsed.ok) {
    throw new Error(parsed.message);
  }

  const identity: Identity = {
    id: crypto.randomUUID(),
    label: label?.trim() || parsed.value.label,
    publicKey: parsed.value.publicKey,
    privateKeyPemBytesDevOnly: parsed.value.privateKeyBytes,
    createdAt: Date.now(),
  };

  await saveIdentity(identity);
  return identity;
}

export function identitySelectMarkup(identities: Identity[], selectedId?: string): string {
  return [
    '<option value="">Default (no key)</option>',
    ...identities.map(
      (identity) =>
        `<option value="${escapeHtml(identity.id)}"${selectedId === identity.id ? ' selected' : ''}>${escapeHtml(identity.label)}</option>`,
    ),
  ].join('');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

export function refreshIdentitySelect(select: HTMLSelectElement, identities: Identity[], selectedId?: string): void {
  const current = selectedId ?? select.value;
  select.innerHTML = identitySelectMarkup(identities, current || undefined);
}

/**
 * Open import modal. Resolves with the saved identity, or null when cancelled.
 */
export function showKeyImportDialog(): Promise<Identity | null> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    backdrop.setAttribute('role', 'presentation');

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog modal-dialog--wide';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', 'key-import-title');

    dialog.innerHTML = `
      <header class="modal-dialog__header">
        <h2 id="key-import-title" class="modal-dialog__title">Import SSH key</h2>
      </header>
      <form id="key-import-form" class="modal-dialog__body form form--compact">
        <p class="muted modal-dialog__intro">
          OpenSSH private key PEM only. Keys are stored as raw PEM bytes locally (not encrypted yet).
          Passphrase-protected keys can be imported; decryption at connect time is not wired yet.
        </p>
        <div class="form-row">
          <label for="key-import-label">Label</label>
          <input id="key-import-label" name="label" type="text" autocomplete="off" spellcheck="false"
            placeholder="Optional display name" />
        </div>
        <div class="form-row">
          <label for="key-import-file">Key file</label>
          <input id="key-import-file" name="file" type="file" accept=".pem,.key,text/plain" />
        </div>
        <div class="form-row">
          <label for="key-import-pem">Or paste PEM</label>
          <textarea id="key-import-pem" name="pem" rows="8" spellcheck="false"
            placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
        </div>
        <p id="key-import-error" class="modal-dialog__error" hidden></p>
      </form>
      <footer class="modal-dialog__footer button-row">
        <button type="submit" form="key-import-form" class="btn primary">Import</button>
        <button type="button" class="btn" data-action="cancel">Cancel</button>
      </footer>
    `;

    backdrop.append(dialog);
    document.body.append(backdrop);

    const form = dialog.querySelector<HTMLFormElement>('#key-import-form')!;
    const fileInput = dialog.querySelector<HTMLInputElement>('#key-import-file')!;
    const pemInput = dialog.querySelector<HTMLTextAreaElement>('#key-import-pem')!;
    const errorEl = dialog.querySelector<HTMLElement>('#key-import-error')!;

    const finish = (identity: Identity | null) => {
      backdrop.remove();
      resolve(identity);
    };

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      pemInput.value = await file.text();
      errorEl.hidden = true;
    });

    dialog.querySelector('[data-action="cancel"]')?.addEventListener('click', () => finish(null));
    backdrop.addEventListener('click', (event) => {
      if (event.target === backdrop) finish(null);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      }
    };
    document.addEventListener('keydown', onKeyDown, { once: true });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorEl.hidden = true;

      const pem = pemInput.value.trim();
      if (!pem) {
        errorEl.textContent = 'Choose a key file or paste PEM contents.';
        errorEl.hidden = false;
        return;
      }

      const label = (dialog.querySelector<HTMLInputElement>('#key-import-label')?.value ?? '').trim();

      try {
        const identity = await importIdentityFromPem(pem, label || undefined);
        finish(identity);
      } catch (error) {
        errorEl.textContent = error instanceof Error ? error.message : 'Import failed.';
        errorEl.hidden = false;
      }
    });

    pemInput.focus();
  });
}

export async function wireIdentityImportButton(
  root: HTMLElement,
  selectSelector: string,
  buttonId: string,
): Promise<void> {
  const select = root.querySelector<HTMLSelectElement>(selectSelector);
  const button = root.querySelector<HTMLButtonElement>(`#${buttonId}`);
  if (!select || !button) return;

  button.addEventListener('click', async () => {
    const identity = await showKeyImportDialog();
    if (!identity) return;
    const identities = await listIdentities();
    refreshIdentitySelect(select, identities, identity.id);
  });
}
