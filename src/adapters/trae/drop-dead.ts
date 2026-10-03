// dropDeadModels：基于 4001 / wire-map 缺席 的死判定（端口 spec §3.2.6）。
//
// 关键不变量：
// 1. `resolved === true` 之前不要 drop（首次启动 wire map 为空时会误清空）
// 2. dead 后不复活；下轮 discoverModels 才会重新进来
// 3. router 在收到 4001 类响应时也用同套机制（markDead），避免 stale 候选
//    反复拖累 latency

export interface WireState {
  /** 列出过的 config_name 集合；live 探测确认可调。 */
  resolved: Set<string>;
  /** 一轮内被 4001 的 config_name；下次 refresh 之前不参与候选。 */
  dead: Set<string>;
}

export function createWireState(): WireState {
  return { resolved: new Set(), dead: new Set() };
}

/**
 * 记录一轮新的可调用 config_name（来自 get_detail_param）。
 * resolved 集合被覆盖式更新；新出现的 id 不再是 dead。
 */
export function noteResolved(state: WireState, ids: readonly string[]): void {
  state.resolved = new Set(ids);
  for (const id of ids) state.dead.delete(id);
}

/**
 * 把不可调用的 config_name 标记为 dead。`resolved=true` 时才生效——
 * 避免首次启动时把整个目录误清空。
 */
export function dropDeadModels<T extends { id: string }>(
  models: readonly T[],
  state: WireState,
): T[] {
  if (!state.resolved.size) return [...models];
  return models.filter((m) => !state.dead.has(m.id));
}

/** 把一个 id 标记 dead（router 收到 4001 时调用）。 */
export function markDead(state: WireState, id: string): void {
  state.dead.add(id);
}