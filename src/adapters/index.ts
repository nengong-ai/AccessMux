// 默认 adapter 装配：MVP 两个被桥接源（WorkBuddy、Trae 双区域）+ 免费档
// 三源（OpenCode/Qoder/ZCode，Phase 2）。

import { listAdapters, registerAdapter } from './registry.js';
import { WorkBuddyAdapter } from './workbuddy/index.js';
import type { WorkBuddyKeyProvider } from './workbuddy/key-provider.js';
import { TraeAdapter } from './trae/index.js';
import { OpenCodeAdapter } from './opencode/index.js';
import { QoderAdapter } from './qoder/index.js';
import { ZcodeAdapter } from './zcode/index.js';

/**
 * 默认装配名单（单一事实源）。smoke 测试按它动态断言（T021：不再硬编码
 * 逐家名单），新增 adapter 时断言自动跟随。
 */
export const DEFAULT_ADAPTER_IDS: readonly string[] = [
  'workbuddy',
  'trae-cn',
  'trae-global',
  'opencode',
  'qoder',
  'zcode',
];

/** 禁用开关的 env 名：逗号分隔 adapter id（如 `opencode,qoder`）。 */
export const DISABLE_ADAPTERS_ENV = 'ACCESSMUX_DISABLE_ADAPTERS';

export interface RegisterDefaultAdaptersOptions {
  /**
   * 注入 WorkBuddy key provider；默认走真实 spawn。测试用 fakeKeyProvider 让
   * `npm test` 完全离线（不 spawn Electron、不连真上游）。
   */
  workbuddyKeyProvider?: WorkBuddyKeyProvider;
  /**
   * 禁用的 adapter id 列表；缺省读 env `ACCESSMUX_DISABLE_ADAPTERS`（逗号
   * 分隔）。测试用它解耦真机依赖（T021 取代旧的 VITEST 门控）：注册本身
   * 离线安全（构造不 spawn），但 opencode/qoder/zcode 的 probe 会真起子进
   * 程/读真凭据——离线测试环境按需禁掉，生产行为不变（默认全注册）。
   */
  disable?: string[];
}

function envDisabledIds(): string[] {
  const raw = process.env[DISABLE_ADAPTERS_ENV];
  if (raw === undefined || raw.trim() === '') return [];
  return raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
}

export function registerDefaultAdapters(options: RegisterDefaultAdaptersOptions = {}): void {
  if (listAdapters().length > 0) return;
  const disabled = new Set(options.disable ?? envDisabledIds());
  if (!disabled.has('workbuddy')) registerAdapter(options.workbuddyKeyProvider !== undefined
    ? new WorkBuddyAdapter({ keyProvider: options.workbuddyKeyProvider })
    : new WorkBuddyAdapter());
  if (!disabled.has('trae-cn')) registerAdapter(new TraeAdapter('cn'));
  if (!disabled.has('trae-global')) registerAdapter(new TraeAdapter('ai'));
  // 以下三家构造离线安全；probe/launch 才有真机副作用（隔离由禁用开关承担）。
  if (!disabled.has('opencode')) registerAdapter(new OpenCodeAdapter());
  if (!disabled.has('qoder')) registerAdapter(new QoderAdapter());
  if (!disabled.has('zcode')) registerAdapter(new ZcodeAdapter());
}

export { WorkBuddyAdapter } from './workbuddy/index.js';
export { TraeAdapter } from './trae/index.js';
export { OpenCodeAdapter } from './opencode/index.js';
export { QoderAdapter } from './qoder/index.js';
export { ZcodeAdapter } from './zcode/index.js';
