// Region registration 测试。

import { describe, expect, it } from 'vitest';
import { disableRegion, enableRegion, regionIsEnabled } from '../../../src/adapters/trae/region-registration.js';
import { TraeAdapter } from '../../../src/adapters/trae/index.js';

describe('region-registration', () => {
  it('enable 后 isEnabled → true', () => {
    const m = new Map();
    enableRegion(m, 'cn');
    expect(regionIsEnabled(m, 'cn')).toBe(true);
  });

  it('disable 后 isEnabled → false', () => {
    const m = new Map();
    enableRegion(m, 'cn');
    disableRegion(m, 'cn');
    expect(regionIsEnabled(m, 'cn')).toBe(false);
  });

  it('disable 未注册的 region no-op', () => {
    const m = new Map();
    disableRegion(m, 'ai');
    expect(regionIsEnabled(m, 'ai')).toBe(false);
  });

  it('重复 enable 不破坏 registered 状态', () => {
    const m = new Map();
    enableRegion(m, 'cn');
    enableRegion(m, 'cn');
    expect(m.get('cn')?.registered).toBe(true);
  });
});
describe('TraeAdapter.setEnabled（T021 UI 启停联动）', () => {
  it('setEnabled(false) → isEnabled false；再 enable 恢复（构造离线，无 IO）', () => {
    const adapter = new TraeAdapter('ai');
    expect(adapter.isEnabled()).toBe(true);
    adapter.setEnabled(false);
    expect(adapter.isEnabled()).toBe(false);
    adapter.setEnabled(true);
    expect(adapter.isEnabled()).toBe(true);
  });
});
