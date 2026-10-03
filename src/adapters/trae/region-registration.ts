// Region 注册期同步（端口 spec §3.2.4 + D8 插件化隔离）。
//
// 双 region adapter 同时活跃时：每个 adapter 有自己的 catalog、自己的 shim、
// 自己的凭据 store、自己的 refresh 状态——任何一边 off 都不影响另一边。
// adapter 的 enable toggle 不停 shim 也不停 sweep（端口 spec §3.2.4 行为）。

import type { TraeRegion } from './region.js';

export interface RegionRegistration {
  region: TraeRegion;
  enabled: boolean;
  /** 启动时注册过 false / 上线后关闭：true。关闭时不会再回来（除非重启）。 */
  registered: boolean;
}

/** 把一个 region 注册为启用。重复 enable 是 no-op。 */
export function enableRegion(state: Map<TraeRegion, RegionRegistration>, region: TraeRegion): void {
  const current = state.get(region);
  if (current === undefined) {
    state.set(region, { region, enabled: true, registered: true });
    return;
  }
  state.set(region, { ...current, enabled: true, registered: true });
}

/** 关闭一个 region（adapter 不再贡献模型候选，shim 继续保留）。 */
export function disableRegion(state: Map<TraeRegion, RegionRegistration>, region: TraeRegion): void {
  const current = state.get(region);
  if (current === undefined) return;
  state.set(region, { ...current, enabled: false });
}

/** 是否参与 router 候选。 */
export function regionIsEnabled(state: Map<TraeRegion, RegionRegistration>, region: TraeRegion): boolean {
  return state.get(region)?.enabled === true;
}