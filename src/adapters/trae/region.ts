// Trae 区域（CN vs AI）+ 网关常量（D11 + 端口 spec §3.2）。
//
// 区域决定 chat / remote / pay 三套 base；AccessMux 用 region 路由上游。
// 区域判定优先级：userRegion.region > 凭据 host > edition（每个级别凭据自带）。

import type { TraeEdition } from './paths.js';

/** 内部路由用的区域（CN 服务 vs 国际服务）。
 */
export type TraeRegion = 'cn' | 'ai';

export interface TraeRegionGateways {
  /** chat / agent API base（llm_utils_chat / raw-chat 系列）。 */
  readonly chat: string;
  /** SOLO remote 模型目录 base（`/api/remote/v1`）。 */
  readonly remote: string;
  /** pay / status API base；凭据自己的 host 优先。 */
  readonly pay: string;
}

/**
 * 经验证的网关 base（端口 spec §3.2 + docs/INTL_SG_EVIDENCE.md）。
 * - CN: trae-api-cn.mchost.guru / solo.trae.cn / api.trae.cn
 * - AI: coresg-normal.trae.ai / coresg-normal.trae.ai/api/remote/v1 / growsg-normal.trae.ai
 *
 * AccessMux 不引入 anyTls pinning / 私有证书；上游发版漂移时由
 * fetchQuota / catalog 反查探测并记录到回执"待更新事实"。
 */
export const REGION_GATEWAYS: Readonly<Record<TraeRegion, TraeRegionGateways>> = {
  cn: {
    chat: 'https://trae-api-cn.mchost.guru',
    remote: 'https://solo.trae.cn/api/remote/v1',
    pay: 'https://api.trae.cn',
  },
  ai: {
    chat: 'https://coresg-normal.trae.ai',
    remote: 'https://coresg-normal.trae.ai/api/remote/v1',
    pay: 'https://growsg-normal.trae.ai',
  },
};

/** edition → 区域：国际 edition 归 ai，其余归 cn。 */
export function regionOfEdition(edition: TraeEdition): TraeRegion {
  return edition === 'sg' || edition === 'solo-sg' ? 'ai' : 'cn';
}

/**
 * 从凭据的 `userRegion` 字段读区域。desktop storage 写成 object：
 * `{"region":"CN","_aiRegion":"CN"}`；app log 也可能直接写小写 `"sg"`。两种都接受。
 */
export function regionOfUserRegion(value: unknown): TraeRegion | undefined {
  const raw = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)['region']
    : value;
  if (typeof raw !== 'string') return undefined;
  const lowered = raw.trim().toLowerCase();
  if (lowered === 'cn') return 'cn';
  if (lowered === 'sg' || lowered === 'ai') return 'ai';
  return undefined;
}

/** 从凭据 host 后缀读区域。`.trae.ai` → ai；`.trae.cn` / `.trae.com.cn` → cn。 */
export function regionOfHost(host: string | undefined): TraeRegion | undefined {
  if (host === undefined) return undefined;
  const trimmed = host.trim();
  if (trimmed === '') return undefined;
  let hostname: string;
  try {
    hostname = new URL(trimmed.startsWith('http') ? trimmed : `https://${trimmed}`).hostname;
  } catch {
    return undefined;
  }
  if (hostname === 'trae.ai' || hostname.endsWith('.trae.ai')) return 'ai';
  if (hostname === 'trae.cn' || hostname.endsWith('.trae.cn') || hostname.endsWith('.trae.com.cn')) return 'cn';
  return undefined;
}

/**
 * 凭据自身三层区域判定：userRegion → host → edition。无任何用户配置参与。
 */
export function regionOfCredential(credential: {
  edition: TraeEdition;
  host?: string;
  userRegion?: string;
}): TraeRegion {
  return regionOfUserRegion(credential.userRegion)
    ?? regionOfHost(credential.host)
    ?? regionOfEdition(credential.edition);
}