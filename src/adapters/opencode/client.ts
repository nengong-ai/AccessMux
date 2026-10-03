import { abortable } from '../../util/abort.js';
// 隔离 serve 的 HTTP 客户端。HTTP Basic 里的密码只是本机进程间隔离密码
//（随机生成、只活在本进程与 serve 子进程之间），上游零凭据（§3.1）。

export class OpenCodeServeError extends Error {
  /** HTTP 状态码；传输失败为 0。 */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'OpenCodeServeError';
    this.status = status;
  }
}

export interface ServeRequestOptions {
  /** Resource create only: keep late body/id observable to its owner for cleanup. */
  retainLateResult?: boolean;
  /** 单请求超时；不设则不限时（长推理的 message 请求用）。 */
  timeoutMs?: number;
  /** 外部取消（runTurn cancel 链路）。 */
  signal?: AbortSignal;
}

export class OpenCodeServeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly password: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString('base64')}`,
    };
  }

  async request<T>(
    route: string,
    method: 'GET' | 'POST' | 'DELETE',
    body?: unknown,
    options: ServeRequestOptions = {},
  ): Promise<T> {
    const signals: AbortSignal[] = [];
    if (options.timeoutMs !== undefined) signals.push(AbortSignal.timeout(options.timeoutMs));
    if (options.signal !== undefined) signals.push(options.signal);
    const signal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    signal?.throwIfAborted();
    let response: Response;
    try {
      const fetching = this.fetchImpl(this.baseUrl + route, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
      response = options.retainLateResult ? await fetching : await abortable(fetching, signal);
    } catch (error) {
      // 主动取消让原始 AbortError 往上冒（runTurn 的取消语义依赖它）
      if (options.signal?.aborted === true) throw error;
      throw new OpenCodeServeError(`opencode serve 请求失败: ${(error as Error).message}`, 0);
    }
    if (!response.ok) {
      const text = await abortable(response.text(), signal).catch(() => '');
      throw new OpenCodeServeError(
        `opencode serve HTTP ${response.status}: ${text.slice(0, 600)}`,
        response.status,
      );
    }
    const text = await abortable(response.text(), options.retainLateResult ? AbortSignal.timeout(5_000) : signal);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new OpenCodeServeError('opencode serve 返回了非 JSON 响应', 0);
    }
  }
}
