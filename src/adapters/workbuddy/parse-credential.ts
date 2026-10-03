// WorkBuddy 桌面 `workbuddy-desktop.info` 解析（三轮返工校正，端口 spec §7.1）。
//
// 真机实测 5.6.2 文件结构（dsh-workbuddy-connect 0.6.5 一致）：
//   top-level: { account, auth, accounts, allAccounts }
//   account: 用户档案（uid / nickname encrypted / uin / type / ...）
//   auth: 凭据（accessToken encrypted / refreshToken encrypted / expiresAt / domain / scope / ...）
//
// 之前 T001 误以为 token 在 account.accessToken；实测在 auth.accessToken。
// 解析只校验 envelope + 字段形状，密钥解开放到 credential-store。

import { isEncryptedEnvelope } from './desktop-cred-envelope.js';

export interface RawWorkBuddyCredential {
  account?: {
    uid?: unknown;
    nickname?: unknown;
    uin?: unknown;
    enterpriseId?: unknown;
  };
  auth?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    idToken?: unknown;
    expiresAt?: unknown;
    refreshExpiresAt?: unknown;
    expiresIn?: unknown;
    refreshExpiresIn?: unknown;
    domain?: unknown;
    scope?: unknown;
    tokenType?: unknown;
  };
}

export interface ParsedWorkBuddyCredential {
  uid: string;
  /** nickname 字段也可能是加密 envelope（不参与鉴权，可选） */
  nicknameEnvelope?: unknown;
  /** OAuth bearer 加密字段（必填） */
  accessTokenEnvelope: unknown;
  /** refresh token 加密字段（可选；缺失时 refresh 走错误路径） */
  refreshTokenEnvelope?: unknown;
  /** 兼容老版本（<5.6）：token 写在 account 下 */
  legacyAccount?: {
    accessToken?: unknown;
    refreshToken?: unknown;
    expiresAt?: unknown;
    refreshExpiresAt?: unknown;
  };
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  /** 上游 host（`auth.domain` 或显式 host 字段）；用于推断 region */
  host?: string;
  /** 企业账号标识（dsh auth.ts:243 identity.enterpriseId）；个人账号缺失 */
  enterpriseId?: string;
  /** 至少有一个加密字段（用于状态展示） */
  hasEncryptedFields: boolean;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function timeToMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric > 1e12 ? numeric : numeric * 1000;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * 把 workbuddy-desktop.info 解析为标准形状。文件不存在或解析失败抛错。
 * 加密字段原样保留 envelope（parse 阶段不解密，等拿到 atRest key 后由
 * credential-store 异步解密）。
 */
export function parseWorkBuddyCredentialFile(text: string): ParsedWorkBuddyCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error('workbuddy-desktop.info is not valid JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('workbuddy-desktop.info must be a JSON object');
  }
  const record = parsed as RawWorkBuddyCredential;
  const account = record.account;
  if (typeof account !== 'object' || account === null) {
    throw new Error('workbuddy-desktop.info missing account object');
  }
  const uid = optionalString(account.uid);
  if (uid === undefined) throw new Error('workbuddy-desktop.info missing account.uid');

  // 5.6+ 路径：从 `auth.accessToken` / `auth.refreshToken` 拿
  const auth = record.auth;
  let accessTokenEnvelope: unknown = undefined;
  let refreshTokenEnvelope: unknown = undefined;
  let expiresAtMs = 0;
  let refreshExpiresAtMs: number | undefined;
  let host: string | undefined;
  if (typeof auth === 'object' && auth !== null) {
    accessTokenEnvelope = auth.accessToken;
    refreshTokenEnvelope = auth.refreshToken;
    expiresAtMs = timeToMs(auth.expiresAt) ?? 0;
    refreshExpiresAtMs = timeToMs(auth.refreshExpiresAt);
    host = optionalString(auth.domain);
  }
  // 兼容老版本（<5.6）：token 在 account 下
  const legacyAccount = !accessTokenEnvelope
    ? (account as unknown as {
        accessToken?: unknown;
        refreshToken?: unknown;
        expiresAt?: unknown;
        refreshExpiresAt?: unknown;
      })
    : undefined;

  if (accessTokenEnvelope === undefined) {
    throw new Error('workbuddy-desktop.info missing auth.accessToken');
  }
  const hasEncryptedFields = isEncryptedEnvelope(accessTokenEnvelope)
    || (refreshTokenEnvelope !== undefined && isEncryptedEnvelope(refreshTokenEnvelope))
    || (account.nickname !== undefined && isEncryptedEnvelope(account.nickname));
  const nicknameEnvelope = account.nickname;
  const enterpriseId = optionalString(account.enterpriseId);
  return {
    uid,
    ...(nicknameEnvelope !== undefined ? { nicknameEnvelope } : {}),
    accessTokenEnvelope,
    ...(refreshTokenEnvelope === undefined ? {} : { refreshTokenEnvelope }),
    ...(legacyAccount === undefined ? {} : { legacyAccount }),
    expiresAtMs,
    ...(refreshExpiresAtMs === undefined ? {} : { refreshExpiresAtMs }),
    ...(host === undefined ? {} : { host }),
    ...(enterpriseId === undefined ? {} : { enterpriseId }),
    hasEncryptedFields,
  };
}