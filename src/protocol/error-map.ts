// 上游错误分类 → HTTP 状态码的映射（用于 shim 返回给 adapter 的错误体）。
// 直接移植 dsh-connect-trae/src/shim.ts:27-35 STATUS_BY_KIND。
// 与协议层（src/protocol/server.ts）的错误结构（Anthropic 风格 / OpenAI 风格）正交：
// 这层只决定 shim 出口 HTTP 状态码，外层再包装成最终响应。

export type UpstreamErrorKind =
  | 'authentication'
  | 'hard_credit'
  | 'soft_rate'
  | 'not_found'
  | 'server'
  | 'client'
  | 'unconfigured';

export const STATUS_BY_KIND: Readonly<Record<UpstreamErrorKind, number>> = {
  authentication: 401,
  hard_credit: 402,
  soft_rate: 429,
  not_found: 502,
  server: 502,
  client: 400,
  unconfigured: 503,
};

export interface UpstreamError {
  ok: false;
  status: number;
  kind: UpstreamErrorKind;
  message: string;
}

/** 把分类后的错误打平成 shim 返回体（已含 HTTP 状态码）。 */
export function statusFor(kind: UpstreamErrorKind): number {
  return STATUS_BY_KIND[kind];
}