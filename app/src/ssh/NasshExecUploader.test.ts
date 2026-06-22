import { describe, expect, it } from 'vitest';
import { buildPortableExecUploadCommand } from './NasshExecUploader';

describe('buildPortableExecUploadCommand', () => {
  it('probes GNU and macOS decoders and protects partial files', () => {
    const command = buildPortableExecUploadCommand('iwa-paste-token.png', '__END__');
    expect(command).toContain('umask 077');
    expect(command).toContain('base64 --decode');
    expect(command).toContain('base64 -D');
    expect(command).toContain("trap 'rm -f \"$p\"'");
    expect(command).toContain('chmod 600 "$p"');
    expect(command).toContain('mv -f "$p" "$f"');
    expect(command).toContain("[ \"$line\" = '__END__' ]");
    expect(command).toContain('IWA_UPLOAD_OK:');
  });
});
