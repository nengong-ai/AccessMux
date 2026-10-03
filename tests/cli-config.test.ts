import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_ADAPTER_IDS } from '../src/adapters/index.js';

const root = fileURLToPath(new URL('../', import.meta.url));
let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'accessmux-cli-config-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });
function cli(args: string[], extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['--import', 'tsx', join(root, 'src/cli/index.ts'), ...args], {
    cwd: root, encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: `${home}/`, XDG_CONFIG_HOME: home,
      ACCESSMUX_CONFIG: join(home, 'env.yaml'), ACCESSMUX_DISABLE_ADAPTERS: DEFAULT_ADAPTER_IDS.join(','), ...extra },
  });
}
it('config init 不覆写现存配置（包含兼容PAT和关闭签到选择）', () => {
  const path = join(home, 'env.yaml');
  const original = 'version: 1\noutput: {port: 9191}\ncheckin: {sources: {workbuddy: false}}\nqoder: {pat: synthetic-pat}\n';
  writeFileSync(path, original);
  const result = cli(['config', 'init']);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('保持原文件不变');
  expect(result.stdout).not.toContain('synthetic-pat');
  expect(readFileSync(path, 'utf8')).toBe(original);
});
it.each(['after', 'before'])('--config 优先于环境变量且支持命令前/后位置 %s', (position) => {
  const path = join(home, 'chosen.yaml');
  const envPath = join(home, 'env.yaml');
  writeFileSync(envPath, 'keep-existing');
  const args = position === 'before' ? ['--config', path, 'config', 'init'] : ['config', 'init', '--config', path];
  const result = cli(args);
  expect(result.status).toBe(0);
  expect(readFileSync(envPath, 'utf8')).toBe('keep-existing');
  expect(readFileSync(path, 'utf8')).toContain('version: 1');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(cli(['config', 'path', `--config=${path}`]).stdout).toBe(`${path}\n`);
});
it('--config 缺值失败，不静默落到默认配置', () => {
  const result = cli(['config', 'init', '--config']);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('--config 需要文件路径');
});
it('status 对配置禁用源仅返回disabled，不spawn或读取登录态', () => {
  const path = join(home, 'disabled.yaml');
  const adapters = Object.fromEntries(DEFAULT_ADAPTER_IDS.map((id) => [id, { enabled: false }]));
  writeFileSync(path, JSON.stringify({ version: 1, output: { port: 8080 }, adapters, models: { allow: {} } }));
  const result = cli(['status', '--config', path], { ACCESSMUX_DISABLE_ADAPTERS: '' });
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim().split('\n')).toHaveLength(DEFAULT_ADAPTER_IDS.length);
  for (const id of DEFAULT_ADAPTER_IDS) expect(result.stdout).toContain(`${id}\t{"availability":"disabled","models":[]}`);
});
it('checkin 读取 --config 指定开关，全部关闭不访问凭据/网络', () => {
  const path = join(home, 'chosen.yaml');
  writeFileSync(path, 'version: 1\noutput: {port: 9191}\nadapters: {}\nmodels: {allow: {}}\ncheckin: {sources: {workbuddy: false, qoder: false, zcode: false}}\n');
  const result = cli(['checkin', '--config', path]);
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
