// WorkBuddy 上游 header 拼装（端口 spec §4.3.2 + dsh-workbuddy-connect/
// upstream.ts:179 CLIENT_UA + 373-421 三套 headers + client-identity.ts:122-133 chatUserAgent）。
//
// 四轮返工按 dsh 原文重写：之前的自造头（x-accessmux-* / x-app-version /
// `CodeBuddyIDE/<v> (accessmux-bridge)` UA）不在真实协议里，chat/catalog/
// refresh 三条链路分别对齐：
//   - chat:   chatUserAgent + X-User-Id/X-Enterprise-Id/X-Domain（含 X-No-* 变体）
//             + X-IDE-Type/Name/Version + X-Product + Authorization
//   - catalog: CLIENT_UA + Origin/Referer + Authorization（CN 不带 X-Requested-With/X-Product）
//   - refresh: CLIENT_UA + Origin/Referer + X-Refresh-Token + X-Auth-Refresh-Source
//   - Origin/Referer: CN 用 www.codebuddy.cn（dsh originReferer 走 BILLING base）

import { validAppVersion } from './app-version.js';
import type { WorkBuddyVariant } from './variant.js';

/** dsh upstream.ts:179：refresh / CN catalog 用的 CLI UA 原值。 */
export const CLIENT_UA = 'CLI/2.63.2 CodeBuddy/2.63.2';

export interface WorkBuddyCredentialLike {
  accessToken: string;
  /** uid；空/缺失时 chat 头走 `X-No-User-Id: 1`。 */
  userId?: string;
  enterpriseId?: string;
  /** 登录域（auth.domain）；空/缺失时走 `X-No-Department-Info: 1`。 */
  domain?: string;
}

/** chat identity：clientVersion 必备（X-IDE-Version + UA），cliVersion 可选。 */
export interface WorkBuddyIdentityLike {
  clientVersion: string;
  cliVersion?: string;
}

/** dsh upstream.ts:369-371 originReferer：CN 走 BILLING base，Global 走主站。 */
function originReferer(variant: WorkBuddyVariant): string {
  return variant === 'global' ? 'https://www.workbuddy.ai' : 'https://www.codebuddy.cn';
}

/** dsh upstream.ts:373-382 commonHeaders（不含 Authorization——由各调用点补）。 */
function commonHeaders(variant: WorkBuddyVariant): Record<string, string> {
  const origin = originReferer(variant);
  return {
    'Accept': 'application/json, text/plain, */*',
    'X-Requested-With': 'XMLHttpRequest',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

/**
 * dsh client-identity.ts:122-133 chatUserAgent：`WorkBuddy/<v> <product>/<v> [CLI/<v>]`。
 * CN product 段是 `WorkBuddy`（不是 CodeBuddyIDE）。版本形状不合法直接抛
 * （值会进 header，宁可早失败）。
 */
export function chatUserAgent(identity: WorkBuddyIdentityLike, variant: WorkBuddyVariant): string {
  if (!validAppVersion(identity.clientVersion)) {
    throw new Error(`invalid client version for chat User-Agent: ${JSON.stringify(identity.clientVersion)}`);
  }
  const product = variant === 'global' ? 'WorkBuddy AI' : 'WorkBuddy';
  const parts = [`WorkBuddy/${identity.clientVersion}`, `${product}/${identity.clientVersion}`];
  if (identity.cliVersion !== undefined) parts.push(`CLI/${identity.cliVersion}`);
  return parts.join(' ');
}

/**
 * dsh upstream.ts:391-408 chatHeaders + 628-630 的 Authorization 注入。
 * X-No-* 约定对齐官方 CLI：缺身份字段时显式声明"没有"，而非省略头。
 */
export function buildWorkBuddyChatHeaders(
  credential: WorkBuddyCredentialLike,
  identity: WorkBuddyIdentityLike,
  variant: WorkBuddyVariant,
): Record<string, string> {
  return {
    ...commonHeaders(variant),
    'User-Agent': chatUserAgent(identity, variant),
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${credential.accessToken}`,
    ...(credential.userId === undefined || credential.userId === ''
      ? { 'X-No-User-Id': '1' }
      : { 'X-User-Id': credential.userId }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ''
      ? { 'X-No-Enterprise-Id': '1' }
      : { 'X-Enterprise-Id': credential.enterpriseId }),
    ...(credential.domain === undefined || credential.domain === ''
      ? { 'X-No-Department-Info': '1' }
      : { 'X-Domain': credential.domain }),
    'X-IDE-Type': 'WorkBuddy',
    'X-IDE-Name': 'WorkBuddy',
    'X-IDE-Version': identity.clientVersion,
    'X-Product': 'SaaS',
  };
}

/**
 * dsh upstream.ts:700-715 fetchModels 的 CN 段：Authorization + Accept +
 * Origin/Referer + CLIENT_UA。X-Requested-With/X-Product 是 international
 * 专属，CN 不带。
 */
export function buildWorkBuddyCatalogHeaders(
  credential: WorkBuddyCredentialLike,
  variant: WorkBuddyVariant,
): Record<string, string> {
  const origin = originReferer(variant);
  return {
    'Authorization': `Bearer ${credential.accessToken}`,
    'Accept': 'application/json',
    'Origin': origin,
    'Referer': `${origin}/`,
    'User-Agent': CLIENT_UA,
  };
}

/**
 * dsh upstream.ts:410-421 refreshHeaders：X-Refresh-Token 只在这里出现，
 * chat 请求绝不携带 refresh token（安全红线）。
 */
export function buildWorkBuddyRefreshHeaders(
  credential: WorkBuddyCredentialLike & { refreshToken: string },
  variant: WorkBuddyVariant,
): Record<string, string> {
  const headers: Record<string, string> = {
    ...commonHeaders(variant),
    'X-Refresh-Token': credential.refreshToken,
    'X-Auth-Refresh-Source': 'workbuddy',
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== '') {
    headers['X-Enterprise-Id'] = credential.enterpriseId;
  }
  return headers;
}
