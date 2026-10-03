// Trae 路径解析测试。

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  traeStorageCandidates,
  traeWindowsAppNames,
  traeCliCandidates,
  TRAE_CLI_TOKEN_FILENAME,
} from '../../../src/adapters/trae/paths.js';

describe('traeWindowsAppNames', () => {
  it('CN 双 spelling', () => {
    expect(traeWindowsAppNames('cn')).toEqual(['Trae CN', 'trae-cn']);
  });
  it('SG 单 spelling', () => {
    expect(traeWindowsAppNames('sg')).toEqual(['Trae']);
  });
  it('solo-sg 单 spelling', () => {
    expect(traeWindowsAppNames('solo-sg')).toEqual(['TRAE SOLO']);
  });
});

describe('traeCliCandidates', () => {
  it('macOS 默认 .trae-cn / .trae 各一次', () => {
    const cands = traeCliCandidates('darwin', '/Users/test');
    expect(cands.map((c) => c.path)).toEqual([
      `/Users/test/.trae-cn/${TRAE_CLI_TOKEN_FILENAME}`,
      `/Users/test/.trae/${TRAE_CLI_TOKEN_FILENAME}`,
    ]);
    expect(cands.every((c) => c.source === 'cli')).toBe(true);
  });

  it('Windows 优先 USERPROFILE 后 home', () => {
    const cands = traeCliCandidates('win32', '/home/x', { USERPROFILE: 'C:\\Users\\X' });
    // 顺序：USERPROFILE × {.trae-cn, .trae}，home × {.trae-cn, .trae}
    expect(cands[0]?.path).toContain('C:\\Users\\X');
    expect(cands[0]?.path.endsWith(`${TRAE_CLI_TOKEN_FILENAME}`)).toBe(true);
    expect(cands[2]?.path.includes('home/x')).toBe(true);
    expect(cands[2]?.path.endsWith(TRAE_CLI_TOKEN_FILENAME)).toBe(true);
  });

  it('edition 标记：.trae-cn → cn / .trae → sg', () => {
    const cands = traeCliCandidates('darwin', '/Users/test');
    expect(cands[0]?.edition).toBe('cn');
    expect(cands[1]?.edition).toBe('sg');
  });
});

describe('traeStorageCandidates', () => {
  it('macOS desktop candidates 在 Library/Application Support 下', () => {
    const cands = traeStorageCandidates('darwin', '/Users/test');
    const desktops = cands.filter((c) => c.source === 'desktop');
    expect(desktops.length).toBeGreaterThan(0);
    expect(desktops[0]?.path).toContain('Library/Application Support');
  });

  it('Linux desktop candidates 用 XDG_CONFIG_HOME', () => {
    const cands = traeStorageCandidates('linux', '/home/test', { XDG_CONFIG_HOME: '/etc/xdg' });
    const desktops = cands.filter((c) => c.source === 'desktop');
    expect(desktops[0]?.path).toContain('/etc/xdg');
  });

  it('Linux 无 XDG_CONFIG_HOME 时回退 ~/.config', () => {
    const cands = traeStorageCandidates('linux', '/home/test', {});
    const desktops = cands.filter((c) => c.source === 'desktop');
    expect(desktops[0]?.path).toContain('/home/test/.config');
  });

  it('unknown platform 给空 desktop', () => {
    const cands = traeStorageCandidates('aix', '/home/test');
    const desktops = cands.filter((c) => c.source === 'desktop');
    expect(desktops).toEqual([]);
  });
});