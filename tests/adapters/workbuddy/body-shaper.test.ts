// WorkBuddy chat body 准备（端口 spec §2.2.6 + §4.3.2）。
import { describe, expect, it } from 'vitest';
import { prepareWorkBuddyChatBody } from '../../../src/adapters/workbuddy/body-shaper.js';

describe('prepareWorkBuddyChatBody (CN)', () => {
  it('model / messages / stream: true 必填', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'hi' }] }),
      { reasoningSupported: [] },
    ));
    expect(out.model).toBe('glm-5.3');
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
    expect(out.stream).toBe(true);
  });

  it('model 缺失时透传（不造默认值；dsh 不做 default）', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
      { reasoningSupported: [] },
    ));
    expect(out.model).toBeUndefined();
  });

  it('messages 缺失时不写 messages 字段', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm' }),
      { reasoningSupported: [] },
    ));
    expect(out.messages).toBeUndefined();
  });

  it('role: developer 先归一为 system，再随指纹门剥离（T010：developer 本质也是宿主提示词）', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [
        { role: 'developer', content: 'sys prompt' },
        { role: 'user', content: 'hi' },
      ] }),
      { reasoningSupported: [] },
    ));
    expect(out.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('T010 指纹门适配：宿主 system 提示词剥离，user/assistant 原样保留', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [
        { role: 'system', content: 'Main branch (you will usually use this for PRs): main' },
        { role: 'system', content: 'You are ZCode, an interactive coding agent' },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好！' },
        { role: 'user', content: '<system-reminder>宿主上下文块走 user 角色</system-reminder>' },
      ] }),
      { reasoningSupported: [] },
    ));
    expect(out.messages).toEqual([
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '<system-reminder>宿主上下文块走 user 角色</system-reminder>' },
    ]);
  });

  it('T010 指纹门适配：只有 system 消息时抛错（不替用户编造提示词）', () => {
    expect(() => prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [{ role: 'system', content: 'only system' }] }),
      { reasoningSupported: [] },
    )).toThrow(/strips host system prompts/);
  });

  it('tool_choice 对象形式扁平化为字符串（dsh normalizeToolChoice）', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'auto' } }),
      { reasoningSupported: [] },
    ));
    expect(out.tool_choice).toBe('auto');
    const fn = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], tool_choice: { type: 'function', function: { name: 'get_weather' } } }),
      { reasoningSupported: [] },
    ));
    expect(fn.tool_choice).toBe('get_weather');
  });

  it('tool_choice: none 删字段并连坐 tools/functions', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], tool_choice: 'none', tools: [{ type: 'function' }] }),
      { reasoningSupported: [] },
    ));
    expect(out.tool_choice).toBeUndefined();
    expect(out.tools).toBeUndefined();
  });

  it('其他字段透传（桥接层不吃宿主参数）', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], stop: ['\n'], presence_penalty: 0.5 }),
      { reasoningSupported: [] },
    ));
    expect(out.stop).toEqual(['\n']);
    expect(out.presence_penalty).toBe(0.5);
  });

  it('reasoning_effort 在能力表内时写入', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'low' }),
      { reasoningSupported: ['low', 'high'] },
    ));
    expect(out.reasoning_effort).toBe('low');
  });

  it('reasoning_effort 不在能力表内时抛错', () => {
    expect(() => prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'xhigh' }),
      { reasoningSupported: ['low', 'high'] },
    )).toThrow(/does not advertise/);
  });

  it('CN 端 off 在 supported 含 off 时保留', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }),
      { reasoningSupported: ['off', 'low', 'high'] },
    ));
    expect(out.reasoning_effort).toBe('off');
  });

  it('CN 端 off 在 supported 不含 off 时抛错', () => {
    expect(() => prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }),
      { reasoningSupported: ['low', 'high'] },
    )).toThrow(/does not advertise/);
  });

  it('temperature / top_p / max_tokens 透传（含 0；上游自己拒非法值）', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], temperature: 0.7, top_p: 0.9, max_tokens: 1024 }),
      { reasoningSupported: [] },
    ));
    expect(out.temperature).toBe(0.7);
    expect(out.top_p).toBe(0.9);
    expect(out.max_tokens).toBe(1024);
  });

  it('reasoningSupported 空 + 没传 effort → 不写字段', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [] }),
      { reasoningSupported: [] },
    ));
    expect(out.reasoning_effort).toBeUndefined();
  });
});

describe('prepareWorkBuddyChatBody (Global)', () => {
  it('Global 端 off 在 supported 不含 off 时被删除', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }),
      { variant: 'global', reasoningSupported: ['low', 'high'] },
    ));
    expect(out.reasoning_effort).toBeUndefined();
  });

  it('Global 端 off 在 supported 含 off 时保留', () => {
    const out = JSON.parse(prepareWorkBuddyChatBody(
      JSON.stringify({ model: 'm', messages: [], reasoning_effort: 'off' }),
      { variant: 'global', reasoningSupported: ['off', 'low', 'high'] },
    ));
    expect(out.reasoning_effort).toBe('off');
  });
});