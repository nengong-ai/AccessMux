// prepareSoloBody 测试：developer → system、tool_calls.function → function_call、
// tools.function.parameters JSON.stringify。

import { describe, expect, it } from 'vitest';
import { prepareSoloBody } from '../../../src/adapters/trae/request-shaper.js';

describe('prepareSoloBody', () => {
  it('基本 messages 透传', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
    }))) as { model: string; function: string; stream: boolean };
    expect(body.model).toBe('glm-5.2');
    expect(body.config_name).toBe('glm-5.2');
    expect(body.function).toBe('solo_work_lite');
    expect(body.stream).toBe(true);
  });

  it('developer role 改为 system', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'developer', content: 'rule' }],
    }))) as { messages: Array<{ role: string }> };
    expect(body.messages[0]?.role).toBe('system');
  });

  it('string content 改为数组形式', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'plain' }],
    }))) as { messages: Array<{ content: Array<{ type: string; text: string }> }> };
    expect(body.messages[0]?.content).toEqual([{ type: 'text', text: 'plain' }]);
  });

  it('tool_calls[].function 改名为 function_call', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{
        role: 'assistant',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{}' } }],
      }],
    }))) as { messages: Array<{ tool_calls: Array<{ function_call: { name: string } }> }> };
    expect(body.messages[0]?.tool_calls[0]?.function_call?.name).toBe('f');
  });

  it('tools[].function.parameters 必须 JSON 字符串化', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f', parameters: { type: 'object', properties: {} } } }],
    }))) as { tools: Array<{ function: { parameters: string } }> };
    expect(typeof body.tools[0]?.function.parameters).toBe('string');
    expect(JSON.parse(body.tools[0]?.function.parameters ?? '{}')).toEqual({ type: 'object', properties: {} });
  });

  it('tool 消息缺 tool_call_id 抛错', () => {
    expect(() => prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'tool', content: 'result' }],
    }))).toThrow(/tool_call_id/);
  });

  it('指定 functionName 覆盖默认 solo_work_lite', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.3',
      messages: [{ role: 'user', content: 'hi' }],
    }), { functionName: 'solo_work_remote' })) as { function: string };
    expect(body.function).toBe('solo_work_remote');
  });

  it('reasoning_effort 透传', () => {
    const body = JSON.parse(prepareSoloBody(JSON.stringify({
      model: 'glm-5.2',
      messages: [{ role: 'user', content: 'hi' }],
      reasoning_effort: 'medium',
    }))) as { reasoning_effort?: string };
    expect(body.reasoning_effort).toBe('medium');
  });
});