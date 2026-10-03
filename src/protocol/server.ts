// 协议暴露层骨架：Fastify 本地服务。
// MVP 端点（D6 + T005 提前）：GET /health、GET /v1/models、
//   POST /v1/chat/completions（OpenAI 兼容；T006 起支持 SSE 流式 passthrough）、
//   POST /v1/messages（Anthropic 兼容，非流式）。
// Phase 2+：/v1/messages 流式 SSE、/v1/responses、/v1/embeddings、MCP server（报告 §3.3）。
// T004：传入 store 后启用 UI 路由（/ui、/api/*）并按 config 过滤 adapter 启停 + 模型 allowlist。

import type { ServerResponse } from 'node:http';
import { writeFile } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { listAdapters } from '../adapters/registry.js';
import { AdapterNotImplementedError, type ProviderSession } from '../adapters/types.js';
import { generateLocalSecret } from '../catalog/index.js';
import { NoProviderAvailable, pickAdapterForModel } from '../router/index.js';
import {
  anthropicMessagesRequestSchema,
  buildAnthropicResponse,
  mapInternalError,
  mapZodError,
  toInternalMessages,
} from './messages.js';
import type { ConfigStore } from '../config/index.js';
import type { ImagePart, TurnUsage } from '../types.js';
import {
  assertAdapterAcceptsImages,
  assertImageCount,
  countRequestImages,
  imagePartFromDataUri,
  imagePartFromUrl,
  ImageInputError,
} from './images.js';
import { estimateTurnUsage } from '../usage.js';
import { makeRouteFilter, mountUiRoutes } from '../ui/index.js';
import { modelDirectoryEntry } from '../ui/model-badges.js';
import { requestDebug, requestLog } from './request-log.js';
import { redactLogText } from '../util/redact.js';
import { adapterEnabled, probeWithBudget } from './control-plane.js';

/** 从 launch 前起绑定生命周期；迟到的 session 也必须释放，绝不开始回合。 */
function requestLifecycle(raw: ServerResponse) {
  const controller = new AbortController();
  let session: ProviderSession | undefined;
  let cancelling: Promise<void> | undefined;
  const cancel = (): Promise<void> => {
    if (!session) return Promise.resolve();
    return cancelling ??= Promise.resolve().then(() => session!.cancel()).catch(() => undefined);
  };
  const close = (): void => {
    if (raw.writableEnded) return;
    controller.abort(new Error('客户端已断开'));
    void cancel();
  };
  const timeoutMs = positiveTimeout(process.env.ACCESSMUX_TURN_TIMEOUT_MS, 300_000);
  const timer = setTimeout(() => {
    controller.abort(new Error('模型请求超时'));
    void cancel();
  }, timeoutMs);
  raw.on('close', close);
  if (raw.destroyed && !raw.writableEnded) close();
  return {
    signal: controller.signal,
    async attach(work: Promise<ProviderSession>): Promise<ProviderSession> {
      void work.then((created) => {
        session = created;
        if (controller.signal.aborted) void cancel();
      }, () => undefined);
      const created = await this.wait(work);
      session = created;
      controller.signal.throwIfAborted();
      return created;
    },
    async wait<T>(work: Promise<T>, watchIdle = false): Promise<T> {
      controller.signal.throwIfAborted();
      let abort: (() => void) | undefined;
      const idleTimer = watchIdle ? setTimeout(() => {
        controller.abort(new Error('模型输出等待超时'));
        void cancel();
      }, positiveTimeout(process.env.ACCESSMUX_IDLE_TIMEOUT_MS, 90_000)) : undefined;
      try {
        return await Promise.race([work, new Promise<never>((_resolve, reject) => {
          abort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', abort, { once: true });
        })]);
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
        if (abort) controller.signal.removeEventListener('abort', abort);
      }
    },
    async finish(): Promise<void> {
      clearTimeout(timer);
      raw.off('close', close);
      await cancel();
    },
  };
}

function positiveTimeout(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= 2_147_483_647 ? number : fallback;
}

type RequestLifecycle = ReturnType<typeof requestLifecycle>;

async function* consumeTurn(session: ProviderSession, input: import('../adapters/types.js').TurnInput, lifecycle: RequestLifecycle) {
  lifecycle.signal.throwIfAborted();
  const iterator = session.runTurn({ ...input, ...{ signal: lifecycle.signal } })[Symbol.asyncIterator]();
  try {
    while (true) {
      const result = await lifecycle.wait(iterator.next(), true);
      if (result.done) return;
      yield result.value;
      if (result.value.done) return;
    }
  } finally {
    // 已挂住的旧 iterator 不得把 HTTP 收尾也挂住；cancel 负责释放底层。
    if (iterator.return) void iterator.return().catch(() => undefined);
  }
}

/** 严格 Host + 实际同源 Origin；无 Origin 的本机 SDK/CLI 保持可用。 */
function mountRequestBoundary(app: FastifyInstance): void {
  app.addHook('onRequest', async (req, reply) => {
    const host = req.headers.host;
    let target: URL;
    try {
      if (!host || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9]\d{0,4})?$/i.test(host)) throw new Error();
      target = new URL(`http://${host}`);
      if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname.toLowerCase())) throw new Error();
      const localPort = req.raw.socket.localPort;
      if (localPort !== undefined && Number(target.port || 80) !== localPort) throw new Error();
    } catch {
      return reply.code(403).send({ error: { message: 'Host 不允许' } });
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== target.origin) {
      return reply.code(403).send({ error: { message: 'Origin 必须与本机服务同源' } });
    }
    if (req.url.split('?')[0]?.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const site = req.headers['sec-fetch-site'];
      const contentType = req.headers['content-type'];
      if ((site !== undefined && site !== 'same-origin' && site !== 'none') ||
          (contentType !== undefined && !/^application\/json(?:\s*;|$)/i.test(contentType))) {
        return reply.code(403).send({ error: { message: '管理写请求必须同源且使用 JSON' } });
      }
    }
  });
}

// OpenAI 协议的 content 允许 string 或 parts 数组；pi-ai（DSH 等宿主的
// 客户端层）对数组 content 恒发数组形态且无折叠开关（T007 实测），schema
// 收两种形态后由 normalizeChatContent 归一（text 折叠 + image_url 收图）再进 adapter。
const chatContentSchema = z.union([
  z.string(),
  z.array(z.object({ type: z.string() }).passthrough()),
]);

const chatRequestSchema = z.object({
  model: z.string().min(1),
  messages: z.array(
    z.object({
      role: z.enum(['system', 'user', 'assistant', 'tool']),
      content: chatContentSchema,
    }),
  ).min(1),
  stream: z.boolean().optional(),
  // T023：OpenAI 惯例——客户端显式要 include_usage 才单独发 usage 帧（[DONE] 前）
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().optional(),
});

/**
 * T010 排障：ACCESSMUX_DEBUG_BODY_DIR 指向一个已存在目录时，把每个 chat 请求的
 * 原始 body 落盘（0600，文件名含模型与时间），供本地复现上游差异。
 * 只写原始请求的 JSON，不含任何凭据（凭据在 adapter/shim 层，不经过这里）。
 * 默认关闭；排完障删掉目录内容。
 */
let bodyDumpSeq = 0;
function dumpRequestBody(model: string, body: unknown): void {
  const dir = process.env['ACCESSMUX_DEBUG_BODY_DIR'];
  if (dir === undefined || dir === '') return;
  bodyDumpSeq += 1;
  const safeModel = model.replace(/[^\w.-]+/g, '_').slice(0, 60);
  const file = join(dir, `body-${Date.now()}-${bodyDumpSeq}-${safeModel}.json`);
  writeFile(file, JSON.stringify(body, null, 1), { mode: 0o600 }, () => undefined);
}

/**
 * T036：把 OpenAI content 的两种形态归一。数组形态折叠 text 部件、收取
 * image_url 部件（base64 data URI 直接解析，http/https 链接代为下载并校验）；
 * 其它部件（audio_url / file 等）仍是明确的请求错误而不是静默丢内容——
 * 丢图会让用户以为模型看到了图。归一与上限校验见 protocol/images.ts。
 */
async function normalizeChatContent(
  content: string | Array<{ type: string; text?: unknown; image_url?: { url?: unknown } }>,
): Promise<{ text: string; images: ImagePart[] }> {
  if (typeof content === 'string') return { text: content, images: [] };
  let text = '';
  const images: ImagePart[] = [];
  for (const part of content) {
    if (part.type === 'text' && typeof part.text === 'string') {
      text += part.text;
      continue;
    }
    if (part.type === 'image_url') {
      const url = part.image_url?.url;
      if (typeof url !== 'string' || url === '') {
        throw new ImageInputError('图片部件缺少 image_url.url：请提供图片链接或 base64 data URL');
      }
      images.push(url.startsWith('data:') ? imagePartFromDataUri(url) : await imagePartFromUrl(url));
      continue;
    }
    throw new Error(`content 部件 "${part.type}" 暂不支持：当前支持 text 与 image_url（图片），其余部件明确报错、不会静默丢弃`);
  }
  return { text, images };
}

/** OpenAI 流式 chunk 中 text delta 的形状（仅含最少必要字段）。 */
interface OpenAiDelta {
  role?: 'assistant';
  content?: string;
}

/** OpenAI 流式 chunk 中 choice 的形状。 */
interface OpenAiChoice {
  index: 0;
  delta: OpenAiDelta;
  finish_reason: string | null;
}

/** OpenAI `chat.completion.chunk` 对象的形状（足够客户端解析）。 */
interface OpenAiCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: OpenAiChoice[];
  usage?: Record<string, unknown>;
}

/** 把单个 chunk 序列化为 SSE `data: ...\n\n` 帧。 */
function sseDataFrame(payload: string): string {
  return `data: ${payload}\n\n`;
}

/**
 * TurnUsage → OpenAI 响应体里的 `usage` 对象（T023）。
 * 估算值带非标准扩展字段 `estimated: true`：标准宿主忽略未知字段，
 * 自有 UI/文档可据此区分真数与估算（绝不用估算冒充真数）。
 */
function openAiUsageBody(usage: TurnUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.estimated === true ? { estimated: true } : {}),
    ...(usage.prompt_tokens_details === undefined ? {} : { prompt_tokens_details: usage.prompt_tokens_details }),
    ...(usage.completion_tokens_details === undefined ? {} : { completion_tokens_details: usage.completion_tokens_details }),
  };
}

/**
 * 真数缺位时的兜底估算（带 estimated 标识）。
 * 口径来自任务书铁律："真数缺位才估算，估算必带 estimated"——上游一个数都没给时，
 * 报 0 对宿主毫无信息量，报带标识的估算值更有用，且不会被误当真数。
 */
function fallbackUsage(messages: readonly import('../types.js').ChatMessage[], completion: string): TurnUsage {
  return estimateTurnUsage(messages.map((m) => m.content).join('\n'), completion);
}

/** 请求日志里附带的用量字段（脱敏：只有计数，无内容）。 */
function usageLogFields(usage: TurnUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.estimated === true ? { usage_estimated: true } : {}),
  };
}

/** 流式响应结果（T010：回传请求日志用）。ttft 从流函数起算（≈ launch 完成后）。 */
interface StreamOutcome {
  ok: boolean;
  ttftMs?: number;
  error?: string;
  /** T023：本回合用量（真数或带标识估算），供请求日志与回执核对。 */
  usage?: TurnUsage;
}

/** 用 SSE 流式响应 chat completions（OpenAI 兼容）。T006 落地。 */
async function streamOpenAiChatCompletion(
  raw: ServerResponse,
  model: string,
  modelId: string,
  messages: import('../types.js').ChatMessage[],
  session: ProviderSession,
  includeUsage: boolean,
  lifecycle: RequestLifecycle,
  safeError: (err: unknown) => string,
): Promise<StreamOutcome> {
  const completionId = `chatcmpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const created = Math.floor(Date.now() / 1000);
  const streamStart = Date.now();
  const encoder = new TextEncoder();
  let firstChunkAt: number | undefined;
  // T023：adapter 上报的用量（真数或带标识估算）；缺位时按 accumulatedText 兜底估算
  let usage: TurnUsage | undefined;
  let accumulatedText = '';
  const ttft = (): { ttftMs?: number } =>
    firstChunkAt === undefined ? {} : { ttftMs: firstChunkAt - streamStart };

  raw.statusCode = 200;
  raw.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  raw.setHeader('Cache-Control', 'no-cache');
  raw.setHeader('Connection', 'keep-alive');
  // 反代/网关不缓冲流式响应
  raw.setHeader('X-Accel-Buffering', 'no');

  // 客户端断开 → 取消 session；防止上游拉满整轮。
  // T021：挂 raw（ServerResponse）的 close，不挂 req 的——IncomingMessage 的
  // close 在 body 读完即触发，真断开反而收不到（T020 实测被掐请求跑完 18.9s
  // 照记 200）。raw 的 close 在连接断开或响应结束时触发，用 writableEnded
  // 区分"正常收尾后的 close"与"客户端中途断开"。
  const aborted = (): boolean => lifecycle.signal.aborted;

  // 第一个 chunk：声明 assistant role（OpenAI 客户端通常依赖此字段）
  const first: OpenAiCompletionChunk = {
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
  };
  raw.write(encoder.encode(sseDataFrame(JSON.stringify(first))));

  try {
    for await (const chunk of consumeTurn(session, { model: modelId, messages, stream: true }, lifecycle)) {
      if (aborted() || raw.writableEnded) break;
      firstChunkAt ??= Date.now();
      if (chunk.usage !== undefined) usage = chunk.usage;
      if (chunk.delta !== '') {
        accumulatedText += chunk.delta;
        const payload: OpenAiCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { content: chunk.delta }, finish_reason: null }],
        };
        raw.write(encoder.encode(sseDataFrame(JSON.stringify(payload))));
      }
      if (chunk.done) break;
    }

    // 收尾：finish_reason=stop 的空 delta + （可选）usage 帧 + [DONE] 哨兵
    //
    // T023 末帧策略（依据见回执"宿主实测"）：
    // - 客户端显式 stream_options.include_usage=true → 按 OpenAI 惯例补一帧
    //   choices:[] + usage，位置在 finish 帧之后、[DONE] 之前（ZCode 宿主实测
    //   恒带该选项，其 AI SDK 客户端正是"取 usage 帧 → 见 choices[0] 为空即收"）。
    // - 未带该选项 → 不额外发帧，把 usage 挂在 finish 帧上（非标准但无害：
    //   OpenAI 客户端忽略未知字段，部分宿主能直接读到，比报 0 更有用）。
    lifecycle.signal.throwIfAborted();
    if (usage === undefined) usage = fallbackUsage(messages, accumulatedText);
    const tail: OpenAiCompletionChunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      ...(includeUsage || usage === undefined ? {} : { usage: openAiUsageBody(usage) }),
    };
    if (!aborted() && !raw.writableEnded) {
      raw.write(encoder.encode(sseDataFrame(JSON.stringify(tail))));
      if (includeUsage && usage !== undefined) {
        const usageFrame: OpenAiCompletionChunk = {
          id: completionId,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage: openAiUsageBody(usage),
        };
        raw.write(encoder.encode(sseDataFrame(JSON.stringify(usageFrame))));
      }
      raw.write(encoder.encode(sseDataFrame('[DONE]')));
    }
    return { ok: true, ...ttft(), usage };
  } catch (err) {
    const message = safeError(err);
    if (!raw.destroyed && !raw.writableEnded) {
      const errorFrame = JSON.stringify({
        error: { message, type: 'api_error' },
      });
      raw.write(encoder.encode(sseDataFrame(errorFrame)));
    }
    // 客户端主动断开不算上游失败
    return { ok: false, error: message, ...ttft() };
  } finally {
    // 先关 shim 再 raw.end：避免"raw close 异步触发 cancel 时，
    // 下一次 launch 已经撞到 shim still occupied"的竞态（T006 调试发现）。
    await lifecycle.finish();
    if (!raw.writableEnded) raw.end();
  }
}

export interface BuildServerOptions {
  /** T004：传入后启用 config 过滤（adapter 启停 + 模型 allowlist）+ UI 路由 */
  store?: ConfigStore;
  /** T004：配置文件路径，仅 UI 首启检测使用；不挂 UI 可省 */
  configPath?: string;
  /** T004：`accessmux ui` 子命令时为 true，跳过 LLM 端点挂载 */
  uiOnly?: boolean;
  /** 控制面单源预算，默认 5 秒；不改变推理回合上限。 */
  controlTimeoutMs?: number;
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const { store, configPath, uiOnly } = opts;
  const app = Fastify({ logger: false });
  mountRequestBoundary(app);
  const safeError = (err: unknown): string => redactLogText(
    err instanceof Error ? err.message : err, 300, [store?.get().qoder?.pat ?? ''],
  );
  app.addHook('onSend', async (_req, reply, payload) => {
    if (reply.statusCode < 400 || typeof payload !== 'string') return payload;
    try {
      const scrub = (value: unknown): unknown => {
        if (typeof value === 'string') return safeError(value);
        if (Array.isArray(value)) return value.map(scrub);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [safeError(key), scrub(v)]));
        return value;
      };
      return JSON.stringify(scrub(JSON.parse(payload)));
    } catch { return safeError(payload); }
  });
  app.setErrorHandler((err, _req, reply) => {
    const code = (err as { statusCode?: number }).statusCode;
    const status = code && code >= 400 && code <= 599 ? code : 500;
    return reply.code(status).send({ error: { message: safeError(err) } });
  });
  const localSecret = generateLocalSecret();
  const routeFilter = store ? makeRouteFilter(store) : null;

  if (store && configPath) {
    mountUiRoutes(app, { store, configPath, controlTimeoutMs: opts.controlTimeoutMs });
  }

  if (uiOnly) {
    return app;
  }

  app.get('/health', async () => ({
    ok: true,
    service: 'accessmux',
    adapters: listAdapters()
      .filter((a) => adapterEnabled(a.id, store?.get()))
      .map((a) => a.id),
  }));

  app.get('/v1/models', async (_req, reply) => {
    const lifecycle = requestLifecycle(reply.raw);
    try {
    const cfg = store?.get();
    const data = (await Promise.all(
      listAdapters().map(async (a) => {
        if (!adapterEnabled(a.id, cfg)) return [];
        const probe = await probeWithBudget(a, opts.controlTimeoutMs, { signal: lifecycle.signal });
        // 安装/接入只消费当前可用目录；离线候选与失败缓存留给 UI 历史展示。
        // auth 未知不等于不可用（匿名源与 Qoder 实时目录无需在此证明登录）。
        if (!probe || probe.availability !== 'available' || probe.auth === 'logged-out'
          || probe.catalogSource === 'fallback' || probe.reasonCode === 'catalog-unavailable') return [];
        const allModels = (probe?.models ?? []).map((m) => modelDirectoryEntry(a.id, m, { bridgeImages: a.bridgeImages }));
        if (!routeFilter) return allModels;
        return allModels.filter((m) => {
          const inner = String(m['id']).slice(a.id.length + 1);
          return routeFilter(a.id, inner);
        });
      }),
    )).flat();
    return { object: 'list', data };
    } finally { await lifecycle.finish(); }
  });

  app.post('/v1/chat/completions', async (req, reply) => {
    // T010 请求日志：每个请求一行 model/status/duration_ms/错误摘要（脱敏）
    const startedAt = Date.now();
    const baseFields: Record<string, unknown> = { path: '/v1/chat/completions' };
    const finish = (status: number, extra: Record<string, unknown> = {}, error?: unknown): void => {
      requestLog({ ...Object.fromEntries(Object.entries(baseFields).map(([key, value]) => [key, typeof value === 'string' ? safeError(value) : value])), ...extra, status, duration_ms: Date.now() - startedAt, ...(error === undefined ? {} : { error: safeError(error) }) });
    };

    const parsed = chatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      finish(400, {}, `请求体不合法（${parsed.error.issues.length} 项）`);
      return reply.code(400).send({ error: { message: '请求体不合法', details: parsed.error.issues } });
    }
    const { model, stream, stream_options } = parsed.data;
    baseFields['model'] = model;
    baseFields['stream'] = Boolean(stream);
    const includeUsage = stream_options?.include_usage === true;
    dumpRequestBody(model, req.body);
    let messages: import('../types.js').ChatMessage[];
    try {
      messages = [];
      for (const m of parsed.data.messages) {
        const normalized = await normalizeChatContent(m.content);
        messages.push({
          role: m.role,
          content: normalized.text,
          ...(normalized.images.length > 0 ? { images: normalized.images } : {}),
        });
      }
      assertImageCount(messages.flatMap((m) => m.images ?? []));
    } catch (err) {
      finish(400, {}, err instanceof Error ? err.message : '请求体不合法');
      return reply.code(400).send({ error: { message: err instanceof Error ? safeError(err) : '请求体不合法' } });
    }
    requestDebug({ ...baseFields, msg_count: messages.length, prompt_chars: messages.reduce((n, m) => n + m.content.length, 0), image_count: countRequestImages(messages) });

    let adapter;
    let modelId: string;
    try {
      ({ adapter, modelId } = pickAdapterForModel(model));
    } catch (err) {
      if (err instanceof NoProviderAvailable) {
        finish(404, {}, err.message);
        return reply.code(404).send({ error: { message: safeError(err) } });
      }
      throw err;
    }
    baseFields['adapter'] = adapter.id;
    baseFields['model_id'] = modelId;

    if (!adapterEnabled(adapter.id, store?.get()) || (routeFilter && !routeFilter(adapter.id, modelId))) {
      finish(404, {}, `模型 ${model} 不在当前 adapter 的 allowlist 中（或 adapter 已停用）`);
      return reply.code(404).send({
        error: { message: `模型 ${model} 不在当前 adapter 的 allowlist 中（或 adapter 已停用）` },
      });
    }

    // T036：未点亮图片的源收到带图请求 → 400 小白文案（宁可报错不静默丢图）。
    try {
      assertAdapterAcceptsImages(adapter, countRequestImages(messages));
    } catch (err) {
      const message = err instanceof Error ? err.message : '图片请求被拒绝';
      finish(400, {}, message);
      return reply.code(400).send({ error: { message } });
    }

    const lifecycle = requestLifecycle(reply.raw);
    if (stream) {
      // 流式：接管 raw response 写 OpenAI SSE；Fastify 不再尝试 JSON 序列化
      let session: ProviderSession;
      try {
        session = await lifecycle.attach(adapter.launch({ localSecret, ...{ signal: lifecycle.signal } }));
      } catch (err) {
        await lifecycle.finish();
        if (err instanceof AdapterNotImplementedError) {
          finish(501, {}, err.message);
          return reply.code(501).send({ error: { message: safeError(err) } });
        }
        finish(500, {}, err);
        throw err;
      }
      reply.hijack();
      const outcome = await streamOpenAiChatCompletion(reply.raw, model, modelId, messages, session, includeUsage, lifecycle, safeError);
      finish(
        outcome.ok ? 200 : 500,
        {
          ...(outcome.ttftMs === undefined ? {} : { ttft_ms: outcome.ttftMs }),
          ...(outcome.usage === undefined ? {} : usageLogFields(outcome.usage)),
        },
        outcome.error,
      );
      // session 由 streamOpenAiChatCompletion 在 close/abort 上统一 cancel；
      // 这里不需要再 await，避免在已 hijack 的连接上重复操作
      return reply;
    }

    try {
      const session = await lifecycle.attach(adapter.launch({ localSecret, ...{ signal: lifecycle.signal } }));
      let content = '';
      let usage: TurnUsage | undefined;
      for await (const chunk of consumeTurn(session, { model: modelId, messages, stream: false }, lifecycle)) {
        content += chunk.delta;
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.done) break;
      }
      await lifecycle.finish();
      // 上游没给数就兜底估算（带 estimated 标识）；绝不无标识地编数
      const resolved = usage ?? fallbackUsage(messages, content);
      finish(200, usageLogFields(resolved));
      return {
        id: `chatcmpl-${Date.now().toString(36)}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: openAiUsageBody(resolved),
      };
    } catch (err) {
      if (err instanceof AdapterNotImplementedError) {
        finish(501, {}, err.message);
        return reply.code(501).send({ error: { message: safeError(err) } });
      }
      finish(500, {}, safeError(err));
      throw err;
    } finally {
      await lifecycle.finish();
    }
  });

  app.post('/v1/messages', async (req, reply) => {
    // T010 请求日志：与 /v1/chat/completions 同款一行式
    const startedAt = Date.now();
    const baseFields: Record<string, unknown> = { path: '/v1/messages' };
    const finish = (status: number, extra: Record<string, unknown> = {}, error?: unknown): void => {
      requestLog({ ...Object.fromEntries(Object.entries(baseFields).map(([key, value]) => [key, typeof value === 'string' ? safeError(value) : value])), ...extra, status, duration_ms: Date.now() - startedAt, ...(error === undefined ? {} : { error: safeError(error) }) });
    };

    // T004 挂账清偿（T021）：exposeAnthropic 勾选实际摘挂本端点（不再只写
    // 配置）。无 store（无配置上下文）时保持 T005 起的挂载行为。
    if (store && !store.get().output.exposeAnthropic) {
      finish(404, {}, 'Anthropic 兼容端点未启用（/ui 输出设置）');
      return reply.code(404).send({
        type: 'error',
        error: {
          type: 'not_found_error',
          message: 'Anthropic 兼容端点未启用：在 /ui 输出设置勾选"暴露 Anthropic 兼容端点"后即时生效',
        },
      });
    }

    const parsed = anthropicMessagesRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const mapped = mapZodError(parsed.error.issues);
      finish(mapped.statusCode, {}, '请求体不合法（Anthropic schema）');
      return reply.code(mapped.statusCode).send(mapped.body);
    }
    const body = parsed.data;
    baseFields['model'] = body.model;
    baseFields['stream'] = false;
    if (body.stream === true) {
      finish(501, {}, '流式 SSE 响应待 Phase 2 实现；当前仅支持非流式');
      return reply.code(501).send({
        type: 'error',
        error: {
          type: 'api_error',
          message: '流式 SSE 响应待 Phase 2 实现；当前仅支持非流式',
        },
      });
    }

    let adapter;
    let modelId: string;
    try {
      ({ adapter, modelId } = pickAdapterForModel(body.model));
    } catch (err) {
      const mapped = mapInternalError(err, [store?.get().qoder?.pat ?? '']);
      mapped.body.error.message = safeError(mapped.body.error.message);
      finish(mapped.statusCode, {}, safeError(err));
      return reply.code(mapped.statusCode).send(mapped.body);
    }
    baseFields['adapter'] = adapter.id;
    baseFields['model_id'] = modelId;

    if (!adapterEnabled(adapter.id, store?.get()) || (routeFilter && !routeFilter(adapter.id, modelId))) {
      finish(404, {}, `模型 ${body.model} 不在当前 adapter 的 allowlist 中（或 adapter 已停用）`);
      return reply.code(404).send({
        type: 'error',
        error: { type: 'not_found_error', message: `模型 ${body.model} 不在当前 adapter 的 allowlist 中（或 adapter 已停用）` },
      });
    }

    // T036：未点亮图片的源收到带图请求 → 400 小白文案（宁可报错不静默丢图）。
    // 只数 image block 个数；归一与逐张校验在 toInternalMessages 里做。
    try {
      assertAdapterAcceptsImages(adapter, body.messages.reduce(
        (n, m) => n + (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'image').length : 0),
        0,
      ));
    } catch (err) {
      const message = err instanceof Error ? err.message : '图片请求被拒绝';
      finish(400, {}, message);
      return reply.code(400).send({ type: 'error', error: { type: 'invalid_request_error', message } });
    }

    let messages: import('../types.js').ChatMessage[];
    try {
      messages = await toInternalMessages(body);
    } catch (err) {
      // 图片归一/上限校验失败：400 invalid_request（小白可读文案在 ImageInputError 里）
      const message = err instanceof Error ? err.message : '请求体不合法';
      finish(400, {}, message);
      return reply.code(400).send({ type: 'error', error: { type: 'invalid_request_error', message } });
    }
    const lifecycle = requestLifecycle(reply.raw);
    requestDebug({ ...baseFields, msg_count: messages.length, prompt_chars: messages.reduce((n, m) => n + m.content.length, 0), image_count: countRequestImages(messages) });
    try {
      const session = await lifecycle.attach(adapter.launch({ localSecret, ...{ signal: lifecycle.signal } }));
      let text = '';
      let usage: TurnUsage | undefined;
      for await (const chunk of consumeTurn(session, { model: modelId, messages, stream: false }, lifecycle)) {
        text += chunk.delta;
        if (chunk.usage !== undefined) usage = chunk.usage;
        if (chunk.done) break;
      }
      await lifecycle.finish();
      const resolved = usage ?? fallbackUsage(messages, text);
      finish(200, usageLogFields(resolved));
      return buildAnthropicResponse({ model: body.model, text, usage: resolved });
    } catch (err) {
      const mapped = mapInternalError(err, [store?.get().qoder?.pat ?? '']);
      mapped.body.error.message = safeError(mapped.body.error.message);
      finish(mapped.statusCode, {}, safeError(err));
      return reply.code(mapped.statusCode).send(mapped.body);
    } finally {
      await lifecycle.finish();
    }
  });

  return app;
}
