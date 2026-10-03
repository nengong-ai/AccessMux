// INERT_AUTH 基类：把"ambient 凭据通道置空 + 唯一凭据是 shim secret"这层抽象
// 固化下来，方便所有 LockedUsage adapter 共用（D11-3 + 端口 spec §2.2.5）。
//
// 真实凭据只走 shim 的 bearer token（参考 D4 + §10.2）；adapter 在调上游时
// 不能复用环境里的 OPENAI_API_KEY 之类 fallback——这层把那些 fallback 显式
// 关掉，强制走 shim token。

/** 占位 api key：永远不会匹配真实凭据。 */
export const INERT_API_KEY = 'accessmux-inert-no-ambient-credential';

/**
 * 在需要"无 ambient 凭据"语义时返回的对象：典型用法是直接传给上游 SDK 的
 * `apiKey` 参数，确保它不会从 OPENAI_API_KEY / ANTHROPIC_API_KEY 等环境
 * 变量里读到任何真实值。
 */
export function inertApiKey(): string {
  return INERT_API_KEY;
}