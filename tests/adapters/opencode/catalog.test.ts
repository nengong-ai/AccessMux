// T013 catalog 过滤测试（验收标准 3）：cost 全 0 过滤、元数据进 ModelInfo、
// 以实时目录为准不硬编码清单。fixture 对照 T012 捕获的真实 /provider 形状。

import { describe, expect, it } from 'vitest';
import {
  freeModelsFromDirectory,
  isFreeModel,
  OpencodeProviderMissingError,
  type OpencodeModelEntry,
} from '../../../src/adapters/opencode/catalog.js';
import { providerDirectoryFixture } from './fakes.js';

/** T012 实测捕获的 mimo-v2.6-flash-free 条目原文形状（字段逐一对齐）。 */
const capturedMimo: OpencodeModelEntry = {
  id: 'mimo-v2.6-flash-free',
  name: 'MiMo-V2.6-Flash Free',
  status: 'active',
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    reasoning: true,
    input: { image: true },
    output: { text: true },
  },
  limit: { context: 200000, output: 32000 },
};

describe('isFreeModel', () => {
  it('cost 四项全 0 + text 输出 + 未 deprecated → 免费', () => {
    expect(isFreeModel(capturedMimo)).toBe(true);
  });

  it('input/output 非 0 排除（glm-5.3-flash 先例）', () => {
    expect(isFreeModel({ ...capturedMimo, cost: { input: 1, output: 0, cache: { read: 0, write: 0 } } })).toBe(false);
    expect(isFreeModel({ ...capturedMimo, cost: { input: 0, output: 2, cache: { read: 0, write: 0 } } })).toBe(false);
  });

  it('cache.read / cache.write 非 0 排除', () => {
    expect(isFreeModel({ ...capturedMimo, cost: { input: 0, output: 0, cache: { read: 0.1, write: 0 } } })).toBe(false);
    expect(isFreeModel({ ...capturedMimo, cost: { input: 0, output: 0, cache: { read: 0, write: 0.2 } } })).toBe(false);
  });

  it('无 cost 字段排除', () => {
    expect(isFreeModel({ capabilities: { output: { text: true } } })).toBe(false);
  });

  it('deprecated 排除；output.text=false 排除', () => {
    expect(isFreeModel({ ...capturedMimo, status: 'deprecated' })).toBe(false);
    expect(isFreeModel({ ...capturedMimo, capabilities: { ...capturedMimo.capabilities, output: { text: false } } })).toBe(false);
  });
});

describe('freeModelsFromDirectory', () => {
  it('只取 opencode provider 的免费条目；id 排序稳定', () => {
    const models = freeModelsFromDirectory(providerDirectoryFixture);
    expect(models.map((m) => m.id)).toEqual(['mimo-v2.6-flash-free', 'space-bunny-free']);
  });

  it('其它 provider 的免费条目不串门（deepinfra 排除）', () => {
    const models = freeModelsFromDirectory(providerDirectoryFixture);
    expect(models.every((m) => m.provider === 'opencode')).toBe(true);
  });

  it('元数据进 ModelInfo：ctx → minCtx，toolcall/image/reasoning → tags', () => {
    const models = freeModelsFromDirectory(providerDirectoryFixture);
    const mimo = models.find((m) => m.id === 'mimo-v2.6-flash-free')!;
    expect(mimo.minCtx).toBe(200000);
    expect(mimo.tags).toEqual(['chat', 'toolcall', 'image', 'reasoning']);
    const bunny = models.find((m) => m.id === 'space-bunny-free')!;
    expect(bunny.minCtx).toBe(1000000);
    expect(bunny.tags).toEqual(['chat', 'toolcall']);
  });

  it('目录里没有 opencode provider → 抛错（probe 收敛为 unavailable）', () => {
    expect(() => freeModelsFromDirectory({ all: [{ id: 'deepinfra', models: {} }] })).toThrow(OpencodeProviderMissingError);
  });

  it('目录变化可跟随：新增免费条目即时出现在结果里（无缓存清单）', () => {
    const before = freeModelsFromDirectory(providerDirectoryFixture);
    const mutated = structuredClone(providerDirectoryFixture);
    mutated.all![1]!.models!['new-free-model'] = {
      cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
      capabilities: { output: { text: true } },
    };
    const after = freeModelsFromDirectory(mutated);
    expect(after.length).toBe(before.length + 1);
    expect(after.map((m) => m.id)).toContain('new-free-model');
  });
});
