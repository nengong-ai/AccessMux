// Trae token refresh（端口 spec §3.3 + 协议事实）。
//
// per-edition 合同（实测 2026-09-15）：
// - cn / sg / solo：/cloudide/api/v3/trae/oauth/ExchangeToken + 共享 ClientID
//   `ono9krqynydwx5`，无 DeviceInfo body
// - solo-sg：/trae/api/v3/oauth/ExchangeToken + ClientID `en1oxy7wnw8j9n`
//   + DeviceInfo（deviceId + machineId + PlatformCode=SOLO_PC/DeviceType=PC/
//   DeviceName=hostname()）
//
// 请求挂在 credential.host 上（自带 host claim），绝不写死 base。

import { hostname } from 'node:os';
import { safeCredentialError } from './credential-store.js';
import type { TraeCredential } from './credential-store.js';
import type { TraeEdition } from './paths.js';

interface RefreshContract {
  readonly path: string;
  readonly clientId: string;
  readonly deviceInfo: boolean;
}

const REFRESH_CONTRACT: Readonly<Record<TraeEdition, RefreshContract>> = {
  cn: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  sg: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  solo: { path: '/cloudide/api/v3/trae/oauth/ExchangeToken', clientId: 'ono9krqynydwx5', deviceInfo: false },
  'solo-sg': { path: '/trae/api/v3/oauth/ExchangeToken', clientId: 'en1oxy7wnw8j9n', deviceInfo: true },
};

export interface RefreshDevice {
  deviceId: string;
  machineId: string;
}

export interface RefreshOutcome {
  accessToken: string;
  refreshToken?: string;
  expiresAtMs: number;
  refreshExpiresAtMs?: number;
  host?: string;
}

function normalizeHost(host: string): string {
  const value = host.trim();
  if (value === '') throw new Error('Trae refresh host is missing');
  return value.replace(/\/$/, '');
}

/**
 * 用 refresh token 换 access token。`device` 只在合同要求时用；
 * 解析不出时省略字段（不发空对象）。
 */
export async function refreshTraeCredential(
  credential: TraeCredential,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
  device?: RefreshDevice,
): Promise<RefreshOutcome> {
  const contract = REFRESH_CONTRACT[credential.edition];
  if (contract === undefined) {
    throw new Error(`Trae ${credential.edition} refresh contract is not verified`);
  }
  if (credential.refreshToken === undefined) {
    throw new Error('Trae refresh token is missing');
  }
  const body: Record<string, unknown> = {
    ClientID: contract.clientId,
    ClientSecret: '-',
    RefreshToken: credential.refreshToken,
    UserID: credential.userId,
  };
  if (contract.deviceInfo && device !== undefined) {
    body['DeviceInfo'] = {
      DeviceID: device.deviceId,
      MachineID: device.machineId,
      PlatformCode: credential.edition === 'solo-sg' ? 'SOLO_PC' : 'TRAE',
      DeviceType: 'PC',
      DeviceName: hostname(),
    };
  }
  try {
  const response = await fetchImpl(`${normalizeHost(credential.host)}${contract.path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal === undefined ? AbortSignal.timeout(30_000) : AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok) {
    throw new Error(`Trae token refresh failed (http ${response.status})`);
  }
  const payload = await response.json() as { Result?: Record<string, unknown> };
  const result = payload.Result;
  const accessToken = typeof result?.['Token'] === 'string' ? result['Token'] : '';
  if (accessToken === '') throw new Error('Trae token refresh returned no token');
  const expiry = result?.['TokenExpireAt'];
  const expiresAtMs = typeof expiry === 'number'
    ? expiry
    : typeof expiry === 'string'
      ? Date.parse(expiry)
      : Number.NaN;
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('Trae token refresh returned an invalid expiry');
  }
  const refreshToken = typeof result?.['RefreshToken'] === 'string' && result['RefreshToken'] !== ''
    ? result['RefreshToken']
    : undefined;
  return {
    accessToken,
    ...(refreshToken === undefined ? {} : { refreshToken }),
    expiresAtMs,
    ...(typeof result?.['RefreshExpiredAt'] === 'number' || typeof result?.['RefreshExpiredAt'] === 'string'
      ? { refreshExpiresAtMs: typeof result['RefreshExpiredAt'] === 'number'
          ? result['RefreshExpiredAt']
          : Date.parse(result['RefreshExpiredAt'] as string) }
      : {}),
    ...(typeof result?.['Host'] === 'string' ? { host: result['Host'] } : {}),
  };
  } catch (error) { throw new Error(safeCredentialError(error, credential)); }
}