// WorkBuddy display suffix 测试（端口 spec §2.2.5）。
//
// 当前 display id == wire id，本文件保留测试以备 Phase 2+ 引入真实装饰逻辑。
import { describe, expect, it } from 'vitest';
import { displaySuffix, withCatalogDisplay } from '../../../src/adapters/workbuddy/display-suffix.js';

describe('displaySuffix', () => {
  it('返回空字符串（display id == wire id）', () => {
    expect(displaySuffix('GLM-5.3')).toBe('');
    expect(displaySuffix('DeepSeek-V4-Pro')).toBe('');
  });
});

describe('withCatalogDisplay', () => {
  it('默认 formatter 返回原 model', () => {
    const model = { id: 'GLM-5.3', name: 'GLM 5.3' };
    expect(withCatalogDisplay(model)).toEqual(model);
  });

  it('自定义 formatter 不改 id（保留接口，未来扩展用）', () => {
    const model = { id: 'm1', name: 'M1' };
    expect(withCatalogDisplay(model, () => ' (preview)')).toEqual(model);
  });
});