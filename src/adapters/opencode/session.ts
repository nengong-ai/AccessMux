import { abortable, abortableDelay } from '../../util/abort.js';
// OpenCode 会话（T013 实现，chat-only MVP）：每轮 runTurn 开一个全新 /session，
// 发一条消息、收完文本、删会话——对话历史由外部宿主持有（宿主每次请求都带
// 全量 messages，桥接侧不攒上下文）。路由锚点（官方 server 源码
// packages/opencode/src/server/routes/instance/httpapi/groups/session.ts:78-105，
// SessionPaths）：POST /session（create）、POST /session/:id/message（prompt）、
// POST /session/:id/abort、DELETE /session/:id（remove）。
// 无工具透传（§3.4 裁剪）：隔离配置里 nativePermissions 全 ask/deny，模型若
// 尝试本地动作会挂审批，看门狗全部拒绝；响应里出现 tool 部件按异常上报。

import type { ChatCompletionChunk, ChatMessage, ImagePart, TurnUsage } from '../../types.js';
import type { ProviderSession, TurnInput } from '../types.js';
import type { OpenCodeServeClient } from './client.js';
import { nativePermissions } from './isolate.js';
import { usageFromTokenBreakdown } from '../../usage.js';
import { redactLogText } from '../../util/redact.js';

/** 上游错误透传（info.error 的 data.statusCode 保留给协议层/日志）。 */
export class OpenCodeTurnError extends Error {
  readonly upstreamStatus: number | undefined;

  constructor(message: string, upstreamStatus?: number) {
    super(message);
    this.name = 'OpenCodeTurnError';
    this.upstreamStatus = upstreamStatus;
  }
}

/** POST /session/<id>/message 的响应形状（T012 实测捕获对照 + T023 usage 实测）。 */
export interface OpencodeMessageResponse {
  info?: {
    role?: string;
    finish?: string;
    /**
     * 上游计量（T023 实测捕获，与 opencode 的 step-finish 部件同值）：
     * input 不含缓存；total = input + output + reasoning + cache.read + cache.write。
     */
    tokens?: {
      total?: number;
      input?: number;
      output?: number;
      reasoning?: number;
      cache?: { read?: number; write?: number };
    };
    cost?: number;
    error?: {
      name?: string;
      message?: string;
      data?: { message?: string; statusCode?: number };
    };
  };
  parts?: Array<{ type?: string; text?: string }>;
}

/** GET /permission 的条目（只需要 id 与归属会话）。 */
interface PermissionEntry {
  id?: string;
  sessionID?: string;
}

/**
 * 把宿主的 OpenAI 形消息折叠成单条消息文本 + system + 图片。
 * 单条 user 消息原样直发（最小损耗路径）；多条消息渲染成带角色标签的转录。
 * T036：各消息 images 汇总为第四个返回值，由 buildMessagePayload 塑形。
 */
export function foldTurn(messages: readonly ChatMessage[]): { system: string | undefined; text: string; images: ImagePart[] } {
  const systemParts = messages.filter((m) => m.role === 'system').map((m) => m.content);
  const system = systemParts.length > 0 ? systemParts.join('\n\n') : undefined;
  const rest = messages.filter((m) => m.role !== 'system');
  let text: string;
  if (rest.length === 1 && rest[0]?.role === 'user') {
    text = rest[0].content;
  } else {
    text = rest.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
  }
  return { system, text, images: rest.flatMap((m) => m.images ?? []) };
}

/** 宿主可能把上游全名 `opencode/<modelId>` 原样塞回来；wire 只收裸 modelID。 */
export function normalizeModelId(modelId: string): string {
  return modelId.startsWith('opencode/') ? modelId.slice('opencode/'.length) : modelId;
}

export function buildSessionCreatePayload(title = 'AccessMux'): { title: string; permission: Array<{ permission: string; pattern: string; action: string }> } {
  return {
    title,
    permission: Object.entries(nativePermissions).map(([permission, action]) => ({
      permission,
      pattern: '*',
      action,
    })),
  };
}

/**
 * POST /session/<id>/message 的 parts 塑形。T036 图片走官方 FilePartInput
 * （packages/schema/src/v1/session.ts:413-421，v1.18.31）：`{type:'file', mime,
 * url}`，url 承载完整 data URI（官方 MCP 资源与 file:// 路径最终都归一到
 * `data:<mime>;base64,…` 形态，见 packages/opencode/src/session/prompt.ts:962-986）。
 * 文本在前、图片追加在后；无图请求与 T013 起的报文逐字节一致。
 */
export function buildMessagePayload(
  modelId: string,
  turn: { system: string | undefined; text: string; images?: readonly ImagePart[] },
): {
  model: { providerID: string; modelID: string };
  agent: string;
  system?: string;
  parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }>;
} {
  const images = turn.images ?? [];
  const parts: Array<{ type: 'text'; text: string } | { type: 'file'; mime: string; url: string }> =
    turn.text === '' ? [] : [{ type: 'text', text: turn.text }];
  for (const image of images) {
    parts.push({ type: 'file', mime: image.mediaType, url: `data:${image.mediaType};base64,${image.data}` });
  }
  return {
    model: { providerID: 'opencode', modelID: normalizeModelId(modelId) },
    agent: 'buddy-chat',
    ...(turn.system === undefined ? {} : { system: turn.system }),
    ...(parts.length === 0 ? { parts: [{ type: 'text', text: '' }] } : { parts }),
  };
}

/**
 * 解析一轮响应为纯文本；info.error / tool 部件 / 截断 / 空回复都按异常抛出。
 * 判定依据官方消息 schema（packages/schema/src/v1/session.ts）：
 * :385-394（error = 按 name 判别的错误联合，含 APIError statusCode）、
 * :452（Assistant.error 可选）、:484（finish 字符串，length=输出截断）、
 * :492-497（WithParts = {info, parts}，parts 含 text/tool 部件判别）。
 */
export function parseAssistantText(response: OpencodeMessageResponse): string {
  const error = response.info?.error;
  if (error !== undefined) {
    throw new OpenCodeTurnError(
      error.data?.message ?? error.message ?? error.name ?? 'opencode 模型请求失败',
      error.data?.statusCode,
    );
  }
  if (response.parts?.some((part) => part.type === 'tool')) {
    throw new OpenCodeTurnError('chat-only 模型尝试调用本地工具，已被隔离权限拦截', 502);
  }
  if (response.info?.finish === 'length') {
    throw new OpenCodeTurnError('模型输出被截断（finish=length）', 502);
  }
  const text = (response.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('');
  if (text.trim() === '') {
    throw new OpenCodeTurnError('模型没有返回文本', 502);
  }
  return text;
}

/** 上游 info.tokens → 回合用量（真数透传；拿不到返回 undefined，不伪造 0）。 */
export function opencodeTurnUsage(response: OpencodeMessageResponse): TurnUsage | undefined {
  const tokens = response.info?.tokens;
  if (tokens === undefined) return undefined;
  return usageFromTokenBreakdown({
    input: tokens.input,
    output: tokens.output,
    reasoning: tokens.reasoning,
    cacheRead: tokens.cache?.read,
    cacheWrite: tokens.cache?.write,
    total: tokens.total,
  });
}

export interface OpenCodeSessionOptions {
  /** 诊断日志行（serve 侧异常链路用）。 */
  log?: (line: string) => void;
  turnTimeoutMs?: number;
}

export class OpenCodeSession implements ProviderSession {
  private turnController: AbortController | undefined;
  private sessionId: string | undefined;
  private turnDone = true;
  private cancelled = false;

  constructor(
    private readonly client: OpenCodeServeClient,
    private readonly options: OpenCodeSessionOptions = {},
  ) {}

  async *runTurn(input: TurnInput): AsyncIterable<ChatCompletionChunk> {
    input.signal?.throwIfAborted();
    if (this.cancelled) throw new Error('opencode session cancelled');
    this.turnDone = false;
    const controller = new AbortController();
    this.turnController = controller;
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error('opencode turn timed out')), this.options.turnTimeoutMs ?? 300_000);
    let route: string | undefined;
    let watchdog: Promise<void> = Promise.resolve();
    try {
      const turn = foldTurn(input.messages);
      const payload = buildMessagePayload(input.model, turn);
      const creating = this.client.request<{ id?: unknown }>('/session', 'POST', buildSessionCreatePayload(), { timeoutMs: 10_000, signal, retainLateResult: true });
      void creating.then(async created => {
        if (!signal.aborted || typeof created.id !== 'string' || !created.id) return;
        const lateRoute = `/session/${encodeURIComponent(created.id)}`;
        await this.client.request(`${lateRoute}/abort`, 'POST', undefined, { timeoutMs: 5_000 }).catch(() => undefined);
        await this.client.request(lateRoute, 'DELETE', undefined, { timeoutMs: 5_000 }).catch(() => undefined);
      }, () => undefined);
      const session = await abortable(creating, signal);
      if (typeof session.id !== 'string' || session.id === '') throw new Error('opencode: /session 未返回会话 id');
      this.sessionId = session.id;
      route = `/session/${encodeURIComponent(session.id)}`;
      signal.throwIfAborted();
      watchdog = this.runPermissionWatchdog(session.id, signal);
      const response = await this.client.request<OpencodeMessageResponse>(`${route}/message`, 'POST', payload, {
        signal,
      });
      // 收尾扫尾：响应落地前一瞬挂起的审批也要拒掉，否则它会一直挂着
      await this.rejectPendingPermissions(session.id, signal);
      const text = parseAssistantText(response);
      const usage = opencodeTurnUsage(response);
      // MVP 非流式：整段文本作为单个 chunk 吐出（真流式见 §3.4 后补项）
      yield { delta: text, done: false };
      yield { delta: '', done: true, ...(usage === undefined ? {} : { usage }) };
    } catch (error) {
      // 失败/取消都要停掉后端推理，防止孤儿会话在隔离 serve 里继续烧
      if (route) await this.client
        .request(`${route}/abort`, 'POST', undefined, { timeoutMs: 5_000 })
        .catch(() => undefined);
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
      await watchdog;
      this.turnController = undefined;
      if (route) await this.cleanupSession(route);
      this.turnDone = true;
    }
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
    this.turnController?.abort();
    if (!this.turnDone && this.sessionId !== undefined) {
      const route = `/session/${encodeURIComponent(this.sessionId)}`;
      await this.client
        .request(`${route}/abort`, 'POST', undefined, { timeoutMs: 5_000 })
        .catch(() => undefined);
      await this.cleanupSession(route);
    }
  }

  /** 审批看门狗：推理期间轮询 pending 权限并全部拒绝（chat-only 不放行任何本地动作）。 */
  private runPermissionWatchdog(sessionId: string, signal: AbortSignal): Promise<void> {
    return (async () => {
      while (!signal.aborted) {
        await this.rejectPendingPermissions(sessionId, signal);
        await abortableDelay(250, signal);
      }
    })().catch(() => undefined);
  }

  private async rejectPendingPermissions(sessionId: string, signal: AbortSignal): Promise<void> {
    let pending: unknown;
    try {
      pending = await this.client.request('/permission', 'GET', undefined, { timeoutMs: 5_000, signal });
    } catch {
      // 轮询失败 ≠ 放行：权限仍挂 ask；下一轮再看
      return;
    }
    if (!Array.isArray(pending)) return;
    for (const entry of pending as PermissionEntry[]) {
      signal.throwIfAborted();
      if (entry.sessionID !== sessionId || typeof entry.id !== 'string' || entry.id === '') continue;
      await this.client
        .request(`/permission/${encodeURIComponent(entry.id)}/reply`, 'POST', {
          reply: 'reject',
          message: 'AccessMux chat-only bridge: native actions are not available.',
        }, { timeoutMs: 5_000, signal })
        .catch(() => undefined);
    }
  }

  private async cleanupSession(route: string): Promise<void> {
    if (this.sessionId === undefined) return;
    this.sessionId = undefined;
    await this.client
      .request(route, 'DELETE', undefined, { timeoutMs: 5_000 })
      .catch((error: unknown) => {
        this.options.log?.(redactLogText(`session cleanup failed: ${error instanceof Error ? error.message : String(error)}`));
      });
  }
}
