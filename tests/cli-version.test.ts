import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('--version / -v 输出 package.json 的版本并正常退出', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  for (const flag of ['--version', '-v']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', flag], {
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${version}\n`);
    expect(result.stderr).toBe('');
  }
}, 30000);
