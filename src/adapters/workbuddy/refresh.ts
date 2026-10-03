// WorkBuddy token refresh（四轮返工按 dsh-workbuddy-connect 原文重写：
// upstream.ts:647-666 refreshToken + 410-421 refreshHeaders）。
//
// 真实协议：POST `${chatBase}/v2/plugin/auth/token/refresh`，**无 body**，
// refresh JWT 放 `X-Refresh-Token` 头（该头只出现在 refresh 端点，chat
// 请求绝不携带）；响应 `{code, msg, data}` envelope，data 内
// `{accessToken, refreshToken?, expiresIn?, domain?}`。
// 旧实现按 `/api/v1/auth/refresh_token` + JSON body 自造——不在真实协议里。

import { safeCredentialError } from './credential-store.js';
import type { WorkBuddyCredential } from './credential-store.js';
import { buildWorkBuddyRefreshHeaders } from './headers.js';
import { REGION_GATEWAYS } from './region.js';
import type { WorkBuddyVariant } from './variant.js';

export interface RefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
}

/** dsh upstream.ts:534-553 readEnvelope（refresh 复用同一 envelope 语义）。 */
async function readEnvelope(response: Response, credential: Partial<WorkBuddyCredential>): Promise<{ code: number; msg: string; data: Record<string, unknown> }> {
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`WorkBuddy upstream returned non-JSON (http ${response.status}): ${safeCredentialError(text, credential)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`WorkBuddy upstream returned an unexpected document (http ${response.status})`);
  }
  const document = parsed as Record<string, unknown>;
  const data = typeof document['data'] === 'object' && document['data'] !== null
    ? document['data'] as Record<string, unknown>
    : {};
  return {
    code: typeof document['code'] === 'number' ? document['code'] : 0,
    msg: typeof document['msg'] === 'string' ? document['msg'] : '',
    data,
  };
}

/**
 * 把 refresh JWT 换 access JWT。`fetchImpl` 测试可注入；默认 undici fetch。
 * 失败抛错让上层走 graceful 路径（还有余量时保留当前 token）。
 */
export async function refreshWorkBuddyCredential(
  credential: Pick<WorkBuddyCredential, 'refreshToken' | 'variant' | 'enterpriseId' | 'host'>,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<RefreshOutcome> {
  if (credential.refreshToken === undefined || credential.refreshToken === '') {
    throw new Error('WorkBuddy refresh token is missing');
  }
  const variant: WorkBuddyVariant = credential.variant;
  const base = REGION_GATEWAYS[variant].refresh;
  const url = `${base.replace(/\/$/, '')}/v2/plugin/auth/token/refresh`;
  try {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: buildWorkBuddyRefreshHeaders(
      {
        accessToken: '',
        userId: '',
        refreshToken: credential.refreshToken,
        ...(credential.enterpriseId === undefined ? {} : { enterpriseId: credential.enterpriseId }),
        ...(credential.host === undefined ? {} : { domain: credential.host }),
      },
      variant,
    ),
    signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  const envelope = await readEnvelope(response, credential);
  if (!response.ok || envelope.code !== 0) {
    throw new Error(`WorkBuddy token refresh failed (http ${response.status}, code ${envelope.code}): ${envelope.msg}`);
  }
  const accessToken = typeof envelope.data['accessToken'] === 'string' ? envelope.data['accessToken'] : '';
  if (accessToken === '') {
    throw new Error('WorkBuddy token refresh returned no accessToken; sign in again in the WorkBuddy app');
  }
  const refreshToken = typeof envelope.data['refreshToken'] === 'string' && envelope.data['refreshToken'] !== ''
    ? envelope.data['refreshToken']
    : undefined;
  const expiresIn = typeof envelope.data['expiresIn'] === 'number' && envelope.data['expiresIn'] > 0
    ? envelope.data['expiresIn']
    : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAtMs: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : Date.now() + 60 * 60_000,
  };
  } catch (error) { throw new Error(safeCredentialError(error, credential)); }
}
