// ZCode Start Plan 端点常量（T019，R014 §1.3.1 合同）。
// zcode.z.ai 是 ZCode 平台私有网关，不是智谱开放平台公开 API。

/** 端点 origin 覆盖（测试/未来域变更用）。 */
export const ZCODE_ORIGIN_ENV = 'ACCESSMUX_ZCODE_ORIGIN';

export const DEFAULT_ZCODE_ORIGIN = 'https://zcode.z.ai';

export function zcodeOrigin(env: Record<string, string | undefined> = process.env): string {
  const override = env[ZCODE_ORIGIN_ENV]?.trim();
  return override !== undefined && override !== '' ? override : DEFAULT_ZCODE_ORIGIN;
}

/** 模型请求：POST（Anthropic Messages 兼容）。 */
export function zcodeMessagesUrl(env?: Record<string, string | undefined>): string {
  return `${zcodeOrigin(env)}/api/v1/zcode-plan/anthropic/v1/messages`;
}

/** 额度查询：GET（必需 X-Device-Mid，R014 §1.3.1 结论 2）。 */
export function zcodeBalanceUrl(env?: Record<string, string | undefined>): string {
  return `${zcodeOrigin(env)}/api/v1/zcode-plan/billing/balance`;
}
