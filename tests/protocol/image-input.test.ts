// T036 端点级图片输入测试：OpenAI image_url 与 Anthropic image block 双格式
// 归一进 adapter、未点亮源 400 拒绝、未知部件仍明确报错。fixture 用自制
// T036 标记图（点阵字，无版权风险）；adapter 用 FakeAdapter。

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clearRegistry, registerAdapter } from '../../src/adapters/registry.js';
import { buildServer } from '../../src/protocol/server.js';
import { FakeAdapter } from './fake-adapter.js';

afterEach(() => {
  clearRegistry();
});

const markerPngBase64 = readFileSync(join(import.meta.dirname, '../fixtures/image-marker.png')).toString('base64');
const dataUri = `data:image/png;base64,${markerPngBase64}`;

describe('POST /v1/chat/completions 图片输入（T036）', () => {
  it('image_url data URI + 已点亮源 → 归一 ImagePart 进 adapter', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图里写了什么' },
            { type: 'image_url', image_url: { url: dataUri } },
          ],
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fake.turnCalls).toHaveLength(1);
    expect(fake.turnCalls[0].messages).toEqual([
      {
        role: 'user',
        content: '图里写了什么',
        images: [{ type: 'image', mediaType: 'image/png', data: markerPngBase64 }],
      },
    ]);
    await app.close();
  });

  it('未点亮源收到图片 → 400 明确拒绝（不静默丢图）', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUri } }] }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/暂不支持图片输入/);
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });

  it('伪 base64 图片（识别不出格式）→ 400 无法识别格式', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fake:fake-model',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8' } }] }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/无法识别的图片格式/);
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });

  it('单请求图片数超上限 → 400 数量上限', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['ok'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();
    const images = Array.from({ length: 9 }, () => ({ type: 'image_url', image_url: { url: dataUri } }));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: { model: 'fake:fake-model', messages: [{ role: 'user', content: images }] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/最多带/);
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });
});

describe('POST /v1/messages 图片输入（T036）', () => {
  it('Anthropic image block（base64 source）+ 已点亮源 → 归一 ImagePart', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['好的'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '图里写了什么' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: markerPngBase64 } },
          ],
        }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(fake.turnCalls[0].messages).toEqual([
      {
        role: 'user',
        content: '图里写了什么',
        images: [{ type: 'image', mediaType: 'image/png', data: markerPngBase64 }],
      },
    ]);
    await app.close();
  });

  it('未点亮源收到 image block → 400 invalid_request_error', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['好的'] });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: markerPngBase64 } }],
        }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(res.json().error.message).toMatch(/暂不支持图片输入/);
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });

  it('image 之外的部件（tool_result）→ 仍被 schema 明确拒绝', async () => {
    const fake = new FakeAdapter({ id: 'fake', chunks: ['好的'], bridgeImages: true });
    registerAdapter(fake);
    const app = buildServer();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: {
        model: 'fake:fake-model',
        max_tokens: 64,
        messages: [{
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: 'x' }],
        }],
      },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.type).toBe('invalid_request_error');
    expect(fake.turnCalls).toHaveLength(0);
    await app.close();
  });
});
