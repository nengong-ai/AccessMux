// T013 会话形状测试（验收标准 3/5）：session/message payload 形状、多消息折叠、
// 响应解析（错误/工具拦截/截断/空）、审批看门狗全拒绝、取消与清理。
// 走生产 OpenCodeSession + OpenCodeServeClient，只注入 fetch。

import { describe, expect, it, vi } from 'vitest';
import { OpenCodeServeClient } from '../../../src/adapters/opencode/client.js';
import {
  buildMessagePayload,
  buildSessionCreatePayload,
  foldTurn,
  normalizeModelId,
  OpenCodeSession,
  OpenCodeTurnError,
  parseAssistantText,
} from '../../../src/adapters/opencode/session.js';
import type { ChatMessage } from '../../../src/types.js';
import {
  fakeFetch,
  hangUntilAbort,
  jsonResponse,
  messageResponseFixture,
  pathOf,
  type RecordedCall,
} from './fakes.js';

function msgs(...items: Array<[ChatMessage['role'], string]>): ChatMessage[] {
  return items.map(([role, content]) => ({ role, content }));
}

function clientFor(handler: (call: RecordedCall) => Response | Promise<Response>): {
  client: OpenCodeServeClient;
  calls: RecordedCall[];
} {
  const { fetchImpl, calls } = fakeFetch(handler);
  return { client: new OpenCodeServeClient('http://127.0.0.1:1', 'unit-test-password', fetchImpl), calls };
}

/** 默认假 serve：健康目录 + 会话 + 空审批 + 可配置 message 响应。 */
function standardServe(messageResponse: unknown = messageResponseFixture, permissionQueue: unknown[][] = [[]]): {
  client: OpenCodeServeClient;
  calls: RecordedCall[];
} {
  let permissionIndex = 0;
  return clientFor((call) => {
    const path = pathOf(call.url);
    if (path === '/session' && call.method === 'POST') return jsonResponse({ id: 'ses_1' });
    if (path === '/permission' && call.method === 'GET') {
      const batch = permissionQueue[Math.min(permissionIndex, permissionQueue.length - 1)] ?? [];
      permissionIndex += 1;
      return jsonResponse(batch);
    }
    if (path === '/permission/perm_1/reply' && call.method === 'POST') return jsonResponse({});
    if (path === '/session/ses_1/message' && call.method === 'POST') return jsonResponse(messageResponse);
    if (path === '/session/ses_1/abort' && call.method === 'POST') return jsonResponse({});
    if (path === '/session/ses_1' && call.method === 'DELETE') return jsonResponse({});
    throw new Error(`unexpected request: ${call.method} ${path}`);
  });
}

async function collect(iterable: AsyncIterable<{ delta: string; done: boolean }>): Promise<string> {
  let text = '';
  for await (const chunk of iterable) text += chunk.delta;
  return text;
}

describe('foldTurn', () => {
  it('单条 user 消息原样直发', () => {
    const turn = foldTurn(msgs(['user', 'hi there']));
    expect(turn).toEqual({ system: undefined, text: 'hi there', images: [] });
  });

  it('system 提取为独立 system 参数（多条合并）', () => {
    const turn = foldTurn(msgs(['system', 'be nice'], ['user', 'hi'], ['system', 'and brief']));
    expect(turn.system).toBe('be nice\n\nand brief');
    expect(turn.text).toBe('hi');
  });

  it('多条对话折叠成带角色标签的转录', () => {
    const turn = foldTurn(msgs(['user', 'q1'], ['assistant', 'a1'], ['user', 'q2']));
    expect(turn.text).toBe('user:\nq1\n\nassistant:\na1\n\nuser:\nq2');
  });

  it('tool 角色消息也进转录（宿主侧工具结果由宿主自己消费）', () => {
    const turn = foldTurn(msgs(['user', 'run it'], ['tool', '{"ok":true}'], ['user', 'and?']));
    expect(turn.text).toContain('tool:\n{"ok":true}');
  });
});

describe('payload 形状（官方 session.prompt 路由：SessionPaths + v1/session.ts 消息输入）', () => {
  it('session 创建：permission 全量 ask/deny + pattern *', () => {
    const payload = buildSessionCreatePayload();
    expect(payload.title).toBe('AccessMux');
    expect(payload.permission).toEqual([
      { permission: '*', pattern: '*', action: 'ask' },
      { permission: 'question', pattern: '*', action: 'deny' },
      { permission: 'websearch', pattern: '*', action: 'deny' },
      { permission: 'codesearch', pattern: '*', action: 'deny' },
      { permission: 'webfetch', pattern: '*', action: 'deny' },
      { permission: 'task', pattern: '*', action: 'deny' },
      { permission: 'plan_enter', pattern: '*', action: 'deny' },
      { permission: 'plan_exit', pattern: '*', action: 'deny' },
      { permission: 'todowrite', pattern: '*', action: 'deny' },
    ]);
  });

  it('message：model 双字段 + agent buddy-chat + 单 text part；system 缺省不出现', () => {
    const withSystem = buildMessagePayload('mimo-v2.6-flash-free', { system: 'be nice', text: 'hi' });
    expect(withSystem).toEqual({
      model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
      agent: 'buddy-chat',
      system: 'be nice',
      parts: [{ type: 'text', text: 'hi' }],
    });
    const noSystem = buildMessagePayload('mimo-v2.6-flash-free', { system: undefined, text: 'hi' });
    expect('system' in noSystem).toBe(false);
  });

  it('T036 带图：parts 追加官方 FilePartInput（mime + data URI url）', () => {
    const payload = buildMessagePayload('mimo-v2.6-flash-free', {
      system: undefined,
      text: '看图',
      images: [
        { type: 'image', mediaType: 'image/png', data: 'QUFB' },
        { type: 'image', mediaType: 'image/jpeg', data: 'Qg==' },
      ],
    });
    expect(payload.parts).toEqual([
      { type: 'text', text: '看图' },
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,QUFB' },
      { type: 'file', mime: 'image/jpeg', url: 'data:image/jpeg;base64,Qg==' },
    ]);
  });

  it('T036 foldTurn 收集 images；无图时为空数组（报文不变）', () => {
    const turn = foldTurn([
      { role: 'user', content: '看图', images: [{ type: 'image', mediaType: 'image/png', data: 'QUFB' }] },
    ]);
    expect(turn).toEqual({ system: undefined, text: '看图', images: [{ type: 'image', mediaType: 'image/png', data: 'QUFB' }] });
  });

  it('宿主塞回上游全名 opencode/<id> 时剥前缀', () => {
    expect(normalizeModelId('opencode/space-bunny-free')).toBe('space-bunny-free');
    expect(normalizeModelId('space-bunny-free')).toBe('space-bunny-free');
  });
});

describe('parseAssistantText', () => {
  it('text 部件按序拼接（step-start/step-finish 忽略）', () => {
    expect(parseAssistantText(messageResponseFixture)).toBe('OCFREE_OK');
    expect(
      parseAssistantText({ info: { finish: 'stop' }, parts: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }),
    ).toBe('ab');
  });

  it('info.error 透传：message 与 statusCode（big-pickle 403 先例）', () => {
    expect(() =>
      parseAssistantText({
        info: { error: { name: 'APIError', data: { message: 'Model access is disabled', statusCode: 403 } } },
        parts: [],
      }),
    ).toThrowError(new OpenCodeTurnError('Model access is disabled', 403));
    try {
      parseAssistantText({ info: { error: { data: { statusCode: 429 } } }, parts: [] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(OpenCodeTurnError);
      expect((error as OpenCodeTurnError).upstreamStatus).toBe(429);
    }
  });

  it('tool 部件出现 → chat-only 隔离拦截异常', () => {
    expect(() =>
      parseAssistantText({ info: {}, parts: [{ type: 'tool', tool: 'bash' }] }),
    ).toThrow(/隔离权限拦截/);
  });

  it('finish=length 截断与空回复分别报错', () => {
    expect(() => parseAssistantText({ info: { finish: 'length' }, parts: [] })).toThrow(/截断/);
    expect(() => parseAssistantText({ info: { finish: 'stop' }, parts: [{ type: 'text', text: '  ' }] })).toThrow(/没有返回文本/);
  });
});

describe('OpenCodeSession.runTurn（生产 session + client，注入 fetch）', () => {
  it('全链路：建会话 → 发消息 → 单 chunk 吐全文 → 删会话；成功不打 abort', async () => {
    const { client, calls } = standardServe();
    const session = new OpenCodeSession(client);
    const text = await collect(
      session.runTurn({ model: 'mimo-v2.6-flash-free', messages: msgs(['user', 'Reply with exactly: OCFREE_OK']), stream: true }),
    );
    expect(text).toBe('OCFREE_OK');
    const create = calls.find((c) => pathOf(c.url) === '/session' && c.method === 'POST');
    expect(create?.body).toEqual(buildSessionCreatePayload());
    const message = calls.find((c) => pathOf(c.url) === '/session/ses_1/message');
    expect(message?.body).toEqual({
      model: { providerID: 'opencode', modelID: 'mimo-v2.6-flash-free' },
      agent: 'buddy-chat',
      parts: [{ type: 'text', text: 'Reply with exactly: OCFREE_OK' }],
    });
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1/abort')).toBe(false);
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1' && c.method === 'DELETE')).toBe(true);
    await session.cancel();
    const deletes = calls.filter((c) => pathOf(c.url) === '/session/ses_1' && c.method === 'DELETE');
    expect(deletes.length).toBe(1); // cancel 幂等：完成后不再重复清理
  });

  // T023：上游 info.tokens 真数透传（input 不含 cache → prompt 含；reasoning 计入 completion）
  it('usage：info.tokens 分桶归一后挂在终帧（真数，无 estimated）', async () => {
    const { client } = standardServe({
      info: {
        role: 'assistant',
        finish: 'stop',
        tokens: { total: 3798, input: 2, output: 2, reasoning: 0, cache: { read: 3794, write: 0 } },
      },
      parts: [{ type: 'text', text: 'OCFREE_OK' }],
    });
    const session = new OpenCodeSession(client);
    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];
    for await (const chunk of session.runTurn({
      model: 'space-bunny-free',
      messages: msgs(['user', 'QPROBE']),
      stream: true,
    })) {
      chunks.push(chunk);
    }
    const done = chunks.find((c) => c.done);
    expect(done?.usage).toEqual({
      prompt_tokens: 3796, // 2 + 3794（缓存读计入 prompt，OpenAI 口径）
      completion_tokens: 2,
      total_tokens: 3798, // == 上游 total
      prompt_tokens_details: { cached_tokens: 3794, cache_write_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    });
    await session.cancel();
  });

  it('usage：上游不给 tokens → 终帧不带 usage（不编数）', async () => {
    const { client } = standardServe({
      info: { role: 'assistant', finish: 'stop' },
      parts: [{ type: 'text', text: 'OCFREE_OK' }],
    });
    const session = new OpenCodeSession(client);
    const chunks: Array<{ delta: string; done: boolean; usage?: unknown }> = [];
    for await (const chunk of session.runTurn({
      model: 'space-bunny-free',
      messages: msgs(['user', 'QPROBE']),
      stream: true,
    })) {
      chunks.push(chunk);
    }
    expect(chunks.find((c) => c.done)?.usage).toBeUndefined();
    await session.cancel();
  });

  it('cleanup 失败日志不回显短鉴权原值', async () => {
    const logs: string[] = [];
    const { client } = clientFor((call) => {
      if (call.method === 'DELETE') throw new Error('Authorization: Bearer short-cleanup-secret');
      if (pathOf(call.url) === '/session') return jsonResponse({ id: 'ses_1' });
      if (pathOf(call.url) === '/permission') return jsonResponse([]);
      return jsonResponse(messageResponseFixture);
    });
    const session = new OpenCodeSession(client, { log: (line) => logs.push(line) });
    expect(await collect(session.runTurn({ model: 'big-pickle', messages: msgs(['user', 'hi']), stream: false }))).toBe('OCFREE_OK');
    expect(logs.join('\n')).toContain('session cleanup failed');
    expect(logs.join('\n')).not.toContain('short-cleanup-secret');
  });

  it('上游 403：abort + 清理照走，异常带 upstreamStatus', async () => {
    const { client, calls } = standardServe({
      info: { error: { name: 'APIError', data: { message: 'Model access is disabled', statusCode: 403 } } },
      parts: [],
    });
    const session = new OpenCodeSession(client);
    await expect(
      collect(session.runTurn({ model: 'big-pickle', messages: msgs(['user', 'hi']), stream: false })),
    ).rejects.toThrow(/Model access is disabled/);
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1/abort')).toBe(true);
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1' && c.method === 'DELETE')).toBe(true);
  });

  it('审批看门狗：本会话 pending 全部 reject，别家会话不动', async () => {
    const { client, calls } = standardServe(messageResponseFixture, [
      [{ id: 'perm_1', sessionID: 'ses_1' }, { id: 'perm_2', sessionID: 'ses_other' }],
      [],
    ]);
    const session = new OpenCodeSession(client);
    const text = await collect(session.runTurn({ model: 'mimo-v2.6-flash-free', messages: msgs(['user', 'hi']), stream: false }));
    expect(text).toBe('OCFREE_OK');
    const reply = calls.find((c) => pathOf(c.url) === '/permission/perm_1/reply');
    expect(reply?.body).toMatchObject({ reply: 'reject' });
    expect(calls.some((c) => c.url.includes('perm_2'))).toBe(false);
  });

  it('取消：进行中的 message 中断 → abort + 删会话', async () => {
    const { client, calls } = clientFor((call) => {
      const path = pathOf(call.url);
      if (path === '/session' && call.method === 'POST') return jsonResponse({ id: 'ses_1' });
      if (path === '/permission' && call.method === 'GET') return jsonResponse([]);
      if (path === '/session/ses_1/message' && call.method === 'POST') return hangUntilAbort(call);
      if (path === '/session/ses_1/abort' && call.method === 'POST') return jsonResponse({});
      if (path === '/session/ses_1' && call.method === 'DELETE') return jsonResponse({});
      throw new Error(`unexpected request: ${call.method} ${path}`);
    });
    const session = new OpenCodeSession(client);
    const iterator = session.runTurn({ model: 'mimo-v2.6-flash-free', messages: msgs(['user', 'long ask']), stream: true });
    const next = iterator.next();
    await vi.waitFor(() => {
      expect(calls.some((c) => pathOf(c.url) === '/session/ses_1/message')).toBe(true);
    });
    await session.cancel();
    await expect(next).rejects.toThrow();
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1/abort')).toBe(true);
    expect(calls.some((c) => pathOf(c.url) === '/session/ses_1' && c.method === 'DELETE')).toBe(true);
  });
});
