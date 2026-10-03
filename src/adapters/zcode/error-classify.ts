// ZCode 上游错误分类（T019，验收标准 3）。
// - 401 → relogin：JWT 失效且无 refresh（R014 §1.3.1 结论 1），整源降级"需重新登录"
// - 429 → rateLimited：限流，可重试（R014 §4.5；balance 端点间歇 429）
// - 405（code 3012）→ prefixGate：system 前缀门失配（R017 §1.3.2）。
//   直连形态撞到 = 上游前缀已变（我方常量未跟上），明确报不可用（兜底硬禁用），
//   不猜、不硬闯、不改写前缀
// - 其余 → upstream：透传状态码与上游信息

export type ZcodeErrorKind = 'relogin' | 'rateLimited' | 'prefixGate' | 'upstream';

export class ZcodeUpstreamError extends Error {
  readonly kind: ZcodeErrorKind;
  readonly status: number | undefined;
  readonly upstreamCode: number | string | undefined;

  constructor(
    kind: ZcodeErrorKind,
    message: string,
    details: { status?: number; upstreamCode?: number | string } = {},
  ) {
    super(message);
    this.name = 'ZcodeUpstreamError';
    this.kind = kind;
    this.status = details.status;
    this.upstreamCode = details.upstreamCode;
  }
}

export interface UpstreamResponseLike {
  status: number;
  /** 尽力解析的 JSON body（非 JSON 时 undefined） */
  body: unknown;
}

/** 从响应体提取上游 code 字段（3012/3001 等）。 */
function extractUpstreamCode(body: unknown): number | string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const code = (body as { code?: unknown; error?: { code?: unknown } }).code
    ?? (body as { error?: { code?: unknown } }).error?.code;
  if (typeof code === 'number' || typeof code === 'string') return code;
  return undefined;
}

function extractUpstreamMessage(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const holder = body as { msg?: unknown; message?: unknown; error?: { message?: unknown; msg?: unknown } };
  const text = holder.msg ?? holder.message ?? holder.error?.message ?? holder.error?.msg;
  return typeof text === 'string' && text !== '' ? text : undefined;
}

export function classifyUpstreamResponse(response: UpstreamResponseLike): ZcodeUpstreamError {
  const code = extractUpstreamCode(response.body);
  const upstreamMessage = extractUpstreamMessage(response.body);
  const statusText = `HTTP ${response.status}${code !== undefined ? ` code ${code}` : ''}`;

  if (response.status === 401) {
    return new ZcodeUpstreamError(
      'relogin',
      `ZCode 登录态已失效（${statusText}）：JWT 无 refresh 流程，请在 ZCode 客户端重新登录后重试`,
      { status: response.status, upstreamCode: code },
    );
  }
  if (response.status === 429) {
    return new ZcodeUpstreamError(
      'rateLimited',
      `ZCode 上游限流（HTTP 429）：稍后重试即可，不代表源不可用`,
      { status: response.status },
    );
  }
  if (response.status === 405) {
    // 3012 = 前缀门（R017 定性）；405 无 body 也按同族处理（同一边缘）
    return new ZcodeUpstreamError(
      'prefixGate',
      `ZCode 前缀门拦截（${statusText}${upstreamMessage !== undefined ? `：${upstreamMessage}` : ''}）：官方 harness 前缀与上游预期失配`,
      { status: response.status, upstreamCode: code },
    );
  }
  return new ZcodeUpstreamError(
    'upstream',
    `ZCode 上游错误（${statusText}${upstreamMessage !== undefined ? `：${upstreamMessage}` : ''}）${
      code === 3006 ? '——该模型不在当前 Start Plan 权益内（权益以 GET /v1/models 实时清单为准）' : ''
    }`,
    { status: response.status, upstreamCode: code },
  );
}
