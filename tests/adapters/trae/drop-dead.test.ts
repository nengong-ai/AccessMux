// dropDeadModels 测试：覆盖首启不误清、resolved 后才生效、markDead 后才过滤。

import { describe, expect, it } from 'vitest';
import { createWireState, dropDeadModels, markDead, noteResolved } from '../../../src/adapters/trae/drop-dead.js';

describe('dropDeadModels', () => {
  it('首启（resolved 为空）保留所有 model——避免初次启动 wire map 为空时误清空', () => {
    const state = createWireState();
    const models = [{ id: 'a' }, { id: 'b' }];
    expect(dropDeadModels(models, state)).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('resolved 之后，dead 列表里的模型被过滤', () => {
    const state = createWireState();
    noteResolved(state, ['a', 'b']);
    markDead(state, 'a');
    expect(dropDeadModels([{ id: 'a' }, { id: 'b' }], state)).toEqual([{ id: 'b' }]);
  });

  it('noteResolved 自动清理已解析 id 的 dead 标记', () => {
    const state = createWireState();
    noteResolved(state, ['a']);
    markDead(state, 'a');
    noteResolved(state, ['a']);
    expect(state.dead.has('a')).toBe(false);
  });

  it('markDead 多次幂等', () => {
    const state = createWireState();
    markDead(state, 'a');
    markDead(state, 'a');
    expect(state.dead.size).toBe(1);
  });

  it('resolved 后整个 catalog 都被 drop 时返回空', () => {
    const state = createWireState();
    noteResolved(state, ['a']);
    markDead(state, 'a');
    expect(dropDeadModels([{ id: 'a' }], state)).toEqual([]);
  });
});