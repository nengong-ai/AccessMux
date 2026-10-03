// T019 噪音剥离（D21 处置第二层）：只剥末尾已知插件尾巴。

import { describe, expect, it } from 'vitest';
import { stripKnownNoise } from '../../../src/adapters/zcode/noise.js';

describe('stripKnownNoise', () => {
  it('剥掉末尾 tokline 遥测尾巴及其前空行（R016 §5.2 实测形态）', () => {
    expect(
      stripKnownNoise('E7R2\n\n> ⏱ tokline · 首字 37.5s · 本轮 0.5 tok/s'),
    ).toBe('E7R2');
  });

  it('多行尾巴全剥；正文中间的同款行不动', () => {
    expect(
      stripKnownNoise('正文\n\n> ⏱ tokline · A\n> ⏱ tokline · B'),
    ).toBe('正文');
    expect(
      stripKnownNoise('> ⏱ tokline · 中间\n正文'),
    ).toBe('> ⏱ tokline · 中间\n正文');
  });

  it('干净文本原样返回；全尾部场景剥到空串', () => {
    expect(stripKnownNoise('hello')).toBe('hello');
    expect(stripKnownNoise('\n\n> ⏱ tokline · x')).toBe('');
  });

  it('非 tokline 的引用块不剥（保守：只处理已知插件）', () => {
    const text = '正文\n\n> 普通引用';
    expect(stripKnownNoise(text)).toBe(text);
  });
});
