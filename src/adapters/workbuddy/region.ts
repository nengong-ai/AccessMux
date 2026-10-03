// WorkBuddy region / upstream endpoint 解析（端口 spec §2.2.7 + §4.3.2 + §7.1）。
//
// variant 与 endpoint 是 1:1 关系：CN 走 copilot.tencent.com / www.codebuddy.cn，
// Global 走 www.workbuddy.ai。每个 endpoint 都有 catalog / refresh / chat 三套
// base，account 自己选用的 endpoint 优先（D11-7）。
//
// AccessMux MVP 只实装 CN；保留 Global 是为 Phase 2+ 单 variant 切换时不破坏
// 类型契约。

import type { WorkBuddyVariant } from './variant.js';

export interface WorkBuddyRegionGateways {
  /** 模型目录 / refresh / chat 三套 base。 */
  readonly catalog: string;
  readonly refresh: string;
  readonly chat: string;
}

/**
 * 已知 WorkBuddy upstream endpoints（端口 spec §4.3.2 + §7.1）。
 * - CN 优先 copilot.tencent.com（WorkBuddy 5.6+ desktop 行为）；fallback www.codebuddy.cn。
 * - Global 走 www.workbuddy.ai。
 */
export const REGION_GATEWAYS: Readonly<Record<WorkBuddyVariant, WorkBuddyRegionGateways>> = {
  cn: {
    catalog: 'https://copilot.tencent.com',
    refresh: 'https://copilot.tencent.com',
    chat: 'https://copilot.tencent.com',
  },
  global: {
    catalog: 'https://www.workbuddy.ai',
    refresh: 'https://www.workbuddy.ai',
    chat: 'https://www.workbuddy.ai',
  },
};

/**
 * 从凭据 host 后缀读 variant。`.codebuddy.cn` / `.tencent.com` → cn；
 * `.workbuddy.ai` → global；未知时 fallback cn。
 */
export function variantOfHost(host: string | undefined): WorkBuddyVariant {
  if (host === undefined) return 'cn';
  const trimmed = host.trim();
  if (trimmed === '') return 'cn';
  let hostname: string;
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return 'cn';
  }
  if (hostname === 'workbuddy.ai' || hostname.endsWith('.workbuddy.ai')) return 'global';
  if (
    hostname === 'codebuddy.cn'
    || hostname.endsWith('.codebuddy.cn')
    || hostname === 'tencent.com'
    || hostname.endsWith('.tencent.com')
  ) return 'cn';
  return 'cn';
}

/**
 * variant ↔ CN/GLOBAL 区域枚举。本项目只用 CN；保留 Global 是为 Phase 2+。
 */
export type WorkBuddyRegion = 'cn' | 'global';

export function regionOfVariant(variant: WorkBuddyVariant): WorkBuddyRegion {
  return variant;
}