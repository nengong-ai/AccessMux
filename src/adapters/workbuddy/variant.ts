// WorkBuddy variant 决定（D11-4：MVP 只做 CN）。
//
// 立项硬约束：WorkBuddy Global variant 留 Phase 2+，MVP 只实装 CN。
// 这是 router 层路由 `workbuddy:...` 与上游 endpoint 解的入口；本目录不再
// 持有 variant 实例化代码（CN 单 variant），variant 字段保留给未来扩展。

/** WorkBuddy variant：MVP 只实装 CN；Global 占位留给 Phase 2。 */
export type WorkBuddyVariant = 'cn' | 'global';

export const WORKBUDDY_VARIANT_CN: WorkBuddyVariant = 'cn';
export const WORKBUDDY_VARIANT_GLOBAL: WorkBuddyVariant = 'global';

/** MVP 默认 variant；T004 配置 UI 后续可在 YAML 配置中显式切换。 */
export const DEFAULT_WORKBUDDY_VARIANT: WorkBuddyVariant = WORKBUDDY_VARIANT_CN;

/**
 * 解析 variant 字符串；非法值抛错。MVP 仅接受 'cn'。
 * 全套校验也接受 'global'（识别为合法但未实装）。
 */
export function parseWorkBuddyVariant(value: unknown): WorkBuddyVariant {
  if (typeof value !== 'string') {
    throw new Error(`WorkBuddy variant must be a string, got ${typeof value}`);
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'cn') return WORKBUDDY_VARIANT_CN;
  if (normalized === 'global') return WORKBUDDY_VARIANT_GLOBAL;
  throw new Error(`WorkBuddy variant '${value}' is not recognized (supported: cn, global)`);
}