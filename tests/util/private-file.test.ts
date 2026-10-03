import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivateFileSync } from '../../src/util/private-file.js';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

const roots: string[] = [];
function root(): string {
  const path = fs.mkdtempSync(join(fs.realpathSync(tmpdir()), 'accessmux-private-'));
  roots.push(path);
  return path;
}
afterEach(() => { vi.restoreAllMocks(); for (const path of roots.splice(0)) fs.rmSync(path, { recursive: true, force: true }); });
const mode = (path: string): number => fs.statSync(path).mode & 0o777;

describe('B05 real filesystem private writes', () => {
  it('never chmods a shared system directory for a direct file override', () => {
    const before = mode(fs.realpathSync('/tmp'));
    expect(() => writePrivateFileSync('/tmp/accessmux-shared-parent-rejected', 'synthetic')).toThrow(/shared system directory/);
    expect(mode(fs.realpathSync('/tmp'))).toBe(before);
  });
  it('creates all missing directories 0700 and file 0600 despite umask 022', () => {
    const old = process.umask(0o022);
    try {
      const base = root(); const path = join(base, 'nested', 'private', 'auth');
      writePrivateFileSync(path, 'synthetic-secret');
      expect(mode(join(base, 'nested'))).toBe(0o700);
      expect(mode(join(base, 'nested', 'private'))).toBe(0o700);
      expect(mode(path)).toBe(0o600);
    } finally { process.umask(old); }
  });
  it('atomically replaces 0644 file, tightens 0755 directory without altering hardlink alias', () => {
    const base = root(); const path = join(base, 'auth'); const alias = join(base, 'alias');
    fs.chmodSync(base, 0o755); fs.writeFileSync(path, 'old', { mode: 0o644 }); fs.linkSync(path, alias);
    const inode = fs.statSync(path).ino;
    writePrivateFileSync(path, Buffer.from('new-synthetic-secret'));
    expect(mode(base)).toBe(0o700); expect(mode(path)).toBe(0o600);
    expect(fs.statSync(path).ino).not.toBe(inode); expect(fs.readFileSync(alias, 'utf8')).toBe('old');
    expect(fs.readdirSync(base).sort()).toEqual(['alias', 'auth']);
  });
  it.each(['target', 'dangling', 'parent', 'ancestor'])('rejects %s symlink without touching outside target', (kind) => {
    const base = root(); const outside = root(); const victim = join(outside, 'auth');
    fs.writeFileSync(victim, 'untouched');
    let path = join(base, 'auth');
    if (kind === 'target') fs.symlinkSync(victim, path);
    if (kind === 'dangling') fs.symlinkSync(join(outside, 'absent'), path);
    if (kind === 'parent' || kind === 'ancestor') {
      fs.symlinkSync(outside, join(base, 'link')); path = join(base, 'link', ...(kind === 'ancestor' ? ['nested'] : []), 'auth');
    }
    expect(() => writePrivateFileSync(path, 'synthetic-secret')).toThrow(/symbolic link/);
    expect(fs.readFileSync(victim, 'utf8')).toBe('untouched'); expect(fs.readdirSync(outside)).toEqual(['auth']);
  });
  it('rejects nonregular overwrite and preserves it with no temporary remnants', () => {
    const base = root(); const path = join(base, 'auth'); fs.mkdirSync(path);
    expect(() => writePrivateFileSync(path, 'synthetic-secret')).toThrow(/regular file/);
    expect(fs.statSync(path).isDirectory()).toBe(true); expect(fs.readdirSync(base)).toEqual(['auth']);
  });
});


it('B05 rename failure leaves old bytes unchanged and cleans private temporary file', () => {
  const base = root(); const path = join(base, 'auth');
  fs.writeFileSync(path, 'old');
  vi.mocked(fs.renameSync).mockImplementationOnce(() => { throw Object.assign(new Error('synthetic OS failure'), { code: 'EACCES' }); });
  expect(() => writePrivateFileSync(path, 'new-synthetic-secret')).toThrow('Private file write failed (EACCES)');
  expect(fs.readFileSync(path, 'utf8')).toBe('old'); expect(fs.readdirSync(base)).toEqual(['auth']);
});


it.runIf(process.platform === 'darwin')('verified macOS /tmp system alias allows new/existing private files, not child symlinks', () => {
  const base = fs.mkdtempSync('/tmp/accessmux-private-alias-'); roots.push(base);
  const path = join(base, 'auth'); writePrivateFileSync(path, 'first');
  expect(mode(path)).toBe(0o600); fs.chmodSync(base, 0o755); fs.chmodSync(path, 0o644);
  writePrivateFileSync(path, 'second'); expect(mode(path)).toBe(0o600); expect(mode(base)).toBe(0o700);
  const outside = root(); const victim = join(outside, 'auth'); fs.writeFileSync(victim, 'untouched');
  fs.symlinkSync(outside, join(base, 'evil')); expect(() => writePrivateFileSync(join(base, 'evil', 'auth'), 'secret')).toThrow(/symbolic link/);
  fs.symlinkSync(victim, join(base, 'evil-target')); expect(() => writePrivateFileSync(join(base, 'evil-target'), 'secret')).toThrow(/symbolic link/);
  expect(fs.readFileSync(victim, 'utf8')).toBe('untouched');
});

it.runIf(process.platform === 'darwin')('verified /var alias remains usable without following user-created links', () => {
  const canonical = root();
  if (!canonical.startsWith('/private/var/')) return;
  const path = join(canonical.replace('/private/var/', '/var/'), 'auth');
  writePrivateFileSync(path, 'synthetic'); expect(mode(path)).toBe(0o600);
});
