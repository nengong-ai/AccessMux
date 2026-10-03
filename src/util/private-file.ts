import { randomBytes } from 'node:crypto';
import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, lstatSync,
  mkdirSync, openSync, readlinkSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

function statIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function checkTarget(path: string): void {
  const stat = statIfPresent(path);
  if (stat !== undefined && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error('Private file target must be a regular file, not a symbolic link');
  }
}

/**
 * Sensitive writes: private parent and temporary file, then same-directory rename.
 * Reject symlinks, except verified macOS system aliases /tmp and /var. Never
 * realpath the target or user-created links. Existing ancestors are
 * not chmodded, except the immediate parent owned by this write.
 * This is not an OS sandbox against a hostile process with the same uid.
 */
export function writePrivateFileSync(path: string, data: string | Uint8Array): void {
  let target = resolve(path);
  // Apple system aliases are legitimate configuration/runtime roots. Verify the
  // exact link itself; no blanket realpath that would accept an attacker link.
  if (process.platform === 'darwin') {
    for (const [alias, canonical] of [['/tmp', '/private/tmp'], ['/var', '/private/var']]) {
      if (target.startsWith(`${alias}/`) && lstatSync(alias!).isSymbolicLink() && resolve(dirname(alias!), readlinkSync(alias!)) === canonical) {
        target = `${canonical}${target.slice(alias!.length)}`;
        break;
      }
    }
  }
  const parent = dirname(target);
  const root = parse(parent).root;
  if (parent === root || ['/tmp', '/var', '/private/tmp', '/private/var'].includes(parent)) {
    throw new Error('Private file parent must not be a shared system directory');
  }
  let cursor = root;
  for (const segment of parent.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, segment);
    let stat = statIfPresent(cursor);
    if (stat === undefined) {
      mkdirSync(cursor, { mode: 0o700 });
      stat = lstatSync(cursor);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Private file parent must be a directory, not a symbolic link');
    }
  }
  const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let temporary: string | undefined;
  let fd: number | undefined;
  try {
    fchmodSync(directory, 0o700);
    const originalParent = fstatSync(directory);
    const verifyParent = (): void => {
      const current = lstatSync(parent);
      if (current.isSymbolicLink() || current.dev !== originalParent.dev || current.ino !== originalParent.ino) {
        throw new Error('Private file parent changed during write');
      }
    };
    checkTarget(target);
    temporary = join(parent, `.private-${randomBytes(16).toString('hex')}.tmp`);
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, data);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    verifyParent();
    checkTarget(target);
    renameSync(temporary, target);
    temporary = undefined;
  } catch (error) {
    // Native filesystem errors contain paths, never include caller data/cause text.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== undefined) throw new Error(`Private file write failed (${code})`);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (temporary !== undefined) {
      try { unlinkSync(temporary); } catch { /* best-effort cleanup */ }
    }
    closeSync(directory);
  }
}
