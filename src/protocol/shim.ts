// 通用 LoopbackShim 工厂：accessmux 的 LockedUsage adapter 在自己进程内起一个
// 127.0.0.1 随机端口 + 进程内随机 secret 的 HTTP 服务，作为 adapter 调上游的
// 调用渠道。shim 与 adapter 都在 daemon 进程内，secret 不提供内存隔离。
//
// 设计要点（D4 + 报告 §10.2 金标准 + 端口 spec §1.3 #1/#3）：
// - 永远 127.0.0.1（不放外部网卡）
// - server.listen(0) 由 OS 选空闲端口
// - 32B random secret 进程内生成，退出即丢
// - bearer 校验用 timingSafeEqual 防 timing attack
// - host/origin loopback 校验防意外外部访问
// - body 上限 64 MB（与 dsh 一致）
// - AbortSignal 串联（客户端断 → adapter abort → shim abort → upstream fetch abort）
// - sockets 在 close() 时被强杀，防 keep-alive 残留
//
// 这是 D11-3 决定的 LoopbackShim 通用工厂：T001 WorkBuddy 与 T002 Trae 都复用。
// 两个 LockedUsage 源的 shim 完全等价，差别只在注入的 catalog + 上游 client。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { redactLogText } from '../util/redact.js';
import { Readable } from 'node:stream';

export interface ShimLogger {
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** 上游 chat 调用结果。失败时由 kind 决定 HTTP 状态。 */
export interface ShimUpstreamResult {
  ok: boolean;
  status: number;
  kind: 'authentication' | 'hard_credit' | 'soft_rate' | 'not_found' | 'server' | 'client' | 'unconfigured';
  message: string;
  /** 成功时：上游 SSE 响应体，供 shim 透传给 adapter。 */
  response?: Response;
}

/** catalog 模型那一段的 快照（供 /v1/models 返回）。 */
export interface ShimCatalogEntry {
  id: string;
  object?: 'model';
  owned_by?: string;
  created?: number;
}

export interface ShimCatalogSource {
  current(): readonly ShimCatalogEntry[];
}

/** 一个 chat 请求的真正上游调用。AbortSignal 必须串联。 */
export type ShimChatHandler = (
  bodyJson: string,
  signal: AbortSignal,
) => Promise<ShimUpstreamResult>;

export interface LoopbackShimOptions {
  /** catalog 快照；GET /v1/models 直接返回。 */
  catalog: ShimCatalogSource;
  /** POST /v1/chat/completions 的真实上游调用。 */
  chat: ShimChatHandler;
  /** 路由前缀，默认 '/v1'。T002 用上注册的 shim 区分。 */
  routePrefix?: string;
  /** 上游在响应里暴露的 owned_by 字段（默认 'shim'）。 */
  ownedBy?: string;
  /** 日志：warn 收业务警告、error 收未预期异常。凭据相关字段调用方负责红化。 */
  logger?: ShimLogger;
}

export interface LoopbackShim {
  /** 等到 server.listening 触发后 resolve；listen 失败则 reject。 */
  ready: Promise<void>;
  /** 'http://127.0.0.1:<port>'。shim 必须先 ready。 */
  baseUrl(): string;
  /** 进程内随机 secret；adapter 用作 Authorization: Bearer。 */
  token(): string;
  /** 强杀 keep-alive、关 listening。多次调用幂等。 */
  close(): Promise<void>;
}

const BODY_LIMIT = 64 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase();
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']');
    return end === -1 ? hostname : hostname.slice(0, end + 1);
  }
  const colon = hostname.lastIndexOf(':');
  if (colon !== -1 && /^\d+$/.test(hostname.slice(colon + 1))) hostname = hostname.slice(0, colon);
  return hostname;
}

function hostIsLoopback(host: string | undefined): boolean {
  return host !== undefined && host.trim() !== '' && LOOPBACK_HOSTS.has(hostnameOfHost(host));
}

function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true;
  try {
    const hostname = new URL(origin).hostname;
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1';
  } catch {
    return false;
  }
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(String(payload)) });
  res.end(payload);
}

function writeError(res: ServerResponse, status: number, kind: string, message: string): void {
  writeJson(res, status, { error: { message: redactLogText(message), type: kind, code: kind } });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        reject(new Error('request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 起一个 LoopbackShim。返回的 instance 在 process 内单次使用；
 * 进程退出时由调用方显式 close()，否则 Node 进程不会自动释放监听端口。
 */
export function createLoopbackShim(options: LoopbackShimOptions): LoopbackShim {
  let secret = randomBytes(32).toString('base64url');
  const sockets = new Set<Socket>();
  const prefix = options.routePrefix ?? '/v1';
  const ownedBy = options.ownedBy ?? 'shim';
  const server: Server = createServer((req, res) => {
    void handle(req, res);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const ready = new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', (err) => reject(err));
  });
  server.listen(0, '127.0.0.1');

  function bearerOk(req: IncomingMessage): boolean {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const actual = Buffer.from(match[1] ?? '');
    const expected = Buffer.from(secret);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        return writeError(res, 403, 'host_not_allowed', 'Host must be loopback');
      }
      if (!originIsLoopback(req.headers.origin)) {
        return writeError(res, 403, 'origin_not_allowed', 'Origin must be loopback');
      }
      if (!bearerOk(req)) {
        return writeError(res, 401, 'unauthorized', 'Missing or invalid bearer');
      }
      const url = req.url ?? '/';
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        return writeJson(res, 200, { ok: true });
      }
      const modelsPath = `${prefix}/models`;
      if (req.method === 'GET' && (url === modelsPath || url === `${modelsPath}/`)) {
        return writeJson(res, 200, {
          object: 'list',
          data: options.catalog.current().map((m) => ({
            id: m.id,
            object: m.object ?? 'model',
            owned_by: m.owned_by ?? ownedBy,
            created: m.created ?? 0,
          })),
        });
      }
      const chatPath = `${prefix}/chat/completions`;
      if (req.method === 'POST' && (url === chatPath || url === `${chatPath}/`)) {
        const ct = req.headers['content-type'];
        if (typeof ct !== 'string' || !ct.toLowerCase().startsWith('application/json')) {
          return writeError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json');
        }
        const raw = (await readBody(req)).toString('utf8');
        try {
          JSON.parse(raw);
        } catch {
          return writeError(res, 400, 'invalid_json', 'Request body must be valid JSON');
        }
        const controller = new AbortController();
        const abort = (): void => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        const result = await options.chat(raw, controller.signal);
        if (!result.ok) {
          return writeError(res, result.status >= 400 && result.status <= 599 ? result.status : 502, result.kind, result.message);
        }
        if (result.response === undefined) {
          return writeError(res, 502, 'server', 'shim chat handler returned no upstream response');
        }
        const upstream = result.response;
        if (upstream.body === null) {
          return writeError(res, 502, 'server', 'upstream returned no body');
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const body = Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0]);
        res.once('close', () => { body.destroy(); req.off('aborted', abort); });
        body.on('error', () => {
          options.logger?.warn('LoopbackShim: upstream stream transport failed');
          controller.abort();
          if (!res.destroyed) res.destroy();
        });
        body.pipe(res);
        return;
      }
      writeError(res, 404, 'not_found', `No such route: ${req.method ?? ''} ${url}`);
    } catch (error: unknown) {
      options.logger?.error('LoopbackShim: handler error');
      if (!res.headersSent) writeError(res, 500, 'internal', 'Internal shim error');
      else if (!res.destroyed) res.destroy();
    }
  }

  let closed = false;
  return {
    ready,
    baseUrl(): string {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('LoopbackShim is not listening');
      }
      return `http://127.0.0.1:${address.port}`;
    },
    token: () => secret,
    close: () => new Promise<void>((resolve, reject) => {
      if (closed) return resolve();
      closed = true;
      secret = '';
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    }),
  };
}