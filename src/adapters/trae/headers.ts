// Trae 上游 header 拼装（D11 + 端口 spec §3.2 + 协议事实）。
//
// Trae 同时接受 CN 与国际网关的同一套 header 形状（端口 spec §3.2.10 验证），
// 所以不再按 edition 分支。x-app-version-code / x-ide-version-code 必须是
// 纯数字；上游若拿到 dotted build version 会回 4001。
//
// x-ide-version-type 固定 'stable'；不模拟其他渠道。

import { randomUUID } from 'node:crypto';
import type { TraeIdentity } from './identity.js';

export type TraeHeaderProfile = 'agent-task' | 'model-detail' | 'raw-chat' | 'native-curl';

/** build version 归一化：上游要纯数字；不是则退回 fallback。 */
export const TRAE_VERSION_CODE_FALLBACK = '20260716';

export function normalizeTraeVersionCode(buildVersion: string | undefined): string {
  if (buildVersion === undefined || buildVersion.trim() === '') return TRAE_VERSION_CODE_FALLBACK;
  const trimmed = buildVersion.trim();
  return /^\d+$/.test(trimmed) ? trimmed : TRAE_VERSION_CODE_FALLBACK;
}

/**
 * 把 identity 转成上游 header。identity 来源是已有官方 storage.json
 * / product.json（见 identity.ts），不会生成随机 id。
 *
 * deviceBrand 仅在 darwin 出现（dsh 一致；TRAE_DEVICE_BRAND 是 macOS only）。
 */
export function identityHeaders(identity: TraeIdentity): Record<string, string> {
  if (!identity.machineId.trim() || !identity.deviceId.trim()) throw new Error('Trae official device identity unavailable');
  const isMac = identity.platform === 'darwin';
  return {
    'x-machine-id': identity.machineId,
    'x-device-id': identity.deviceId,
    'x-device-type': identity.platform === 'darwin' ? 'mac' : identity.platform === 'win32' ? 'windows' : identity.platform,
    ...(isMac && identity.deviceBrand !== undefined ? { 'x-device-brand': identity.deviceBrand } : {}),
    ...(identity.deviceCpu === undefined ? {} : { 'x-device-cpu': identity.deviceCpu }),
    ...(identity.osVersion === undefined ? {} : { 'x-os-version': identity.osVersion }),
    ...(identity.appVersion === undefined ? {} : { 'x-app-version': identity.appVersion, 'x-ide-version': identity.appVersion }),
    ...(identity.buildVersion === undefined ? {} : { 'x-app-version-code': identity.buildVersion, 'x-ide-version-code': identity.buildVersion }),
    'x-ide-version-type': 'stable',
  };
}

export interface TraeCredentialLike {
  accessToken: string;
  userId: string;
}

export interface BuildTraeHeadersOptions {
  appId?: string;
  requestId?: string;
  profile?: TraeHeaderProfile;
}

/**
 * 拼装发给 Trae 上游的 header。`profile` 决定是否带 Authorization / x-app-id
 * 等。`native-curl` 是 Trae 3.3.83 自家 get_skill_detail 诊断 curl 的精确副本。
 */
export function buildTraeHeaders(
  credential: TraeCredentialLike,
  identity: TraeIdentity,
  options: BuildTraeHeadersOptions = {},
): Record<string, string> {
  const requestId = options.requestId ?? randomUUID();
  const traceId = requestId.replaceAll('-', '').slice(0, 32);
  const profile = options.profile ?? 'agent-task';
  const common: Record<string, string> = {
    'Authorization': `Cloud-IDE-JWT ${credential.accessToken}`,
    'X-Ide-Token': credential.accessToken,
    'x-plugin-channel': 'icube-ai',
    'User-Agent': `Trae/${identity.appVersion ?? identity.buildVersion ?? 'unknown'}`,
    'x-app-id': options.appId ?? '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
    ...identityHeaders(identity),
    'x-app-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-ide-version-code': normalizeTraeVersionCode(identity.buildVersion),
    'x-custom-trace-id': traceId,
    'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
    'request-traffic-type': 'prod',
    'Content-Type': 'application/json',
  };
  if (profile === 'native-curl') {
    return {
      'Content-Type': 'application/json',
      'request-traffic-type': 'prod',
      'x-app-id': options.appId ?? '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8',
      ...identityHeaders(identity),
      'x-custom-trace-id': traceId,
      'x-flow-traceparent': `04-${traceId}-${traceId.slice(0, 16)}-01`,
      'X-Ide-Token': credential.accessToken,
    };
  }
  if (profile === 'model-detail') return { ...common, 'Accept': 'application/json' };
  if (profile === 'raw-chat') return { ...common, 'Accept': 'text/event-stream' };
  return {
    ...common,
    'X-Cloudide-Token': credential.accessToken,
    'x-uid': credential.userId,
    'x-request-id': requestId,
    'x-trae-request-id': requestId,
    'Accept': 'text/event-stream',
  };
}