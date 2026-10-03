// WorkBuddy 桌面凭据与缓存的候选路径（端口 spec §2.2.7 + §4.3.2 + §7.1）。
//
// 路径策略（与 dsh-workbuddy-connect/src/auth.ts:148-172 + dsh/src/probe.ts:26
// 一致；唯一差异是用 accessmux 自己的命名空间）：
// - macOS：`~/Library/Application Support/CodeBuddyExtension/Data/Public/auth/<file>`
// - Windows：`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\<file>`
// - Linux：`$XDG_CONFIG_HOME/CodeBuddyExtension/Data/Public/auth/<file>`
//
// CodeBuddyExtension 是 Electron 主目录（跨 CN/Global 都用），凭据/缓存/可见性
// 等都放其下；accessmux 自己的 own-copy 走独立目录避免污染。

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WorkBuddyVariant } from './variant.js';
import { WORKBUDDY_VARIANT_GLOBAL } from './variant.js';

export const WORKBUDDY_AUTH_FILENAME = 'workbuddy-desktop.info';
export const WORKBUDDY_PRODUCT_FILENAME = 'product.json';
export const WORKBUDDY_BUNDLE_ID_CN = 'com.tencent.workbuddy.mac';
export const WORKBUDDY_BUNDLE_ID_GLOBAL = 'com.workbuddy.workbuddy';
export const WORKBUDDY_WINDOWS_APP_NAME_CN = 'WorkBuddy';
export const WORKBUDDY_WINDOWS_APP_NAME_GLOBAL = 'WorkBuddy AI';

/** 单个凭据/缓存文件的物理位置。 */
export interface WorkBuddyFileCandidate {
  variant: WorkBuddyVariant;
  path: string;
  kind: 'auth' | 'product';
}

function authRoot(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
  }
  if (platform === 'win32') {
    const candidates = [env['LOCALAPPDATA'], env['APPDATA'], join(home, 'AppData', 'Local'), join(home, 'AppData', 'Roaming')]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .filter((value, index, all) => all.indexOf(value) === index);
    return candidates.map((root) => join(root, 'CodeBuddyExtension', 'Data', 'Public', 'auth'));
  }
  const linuxRoot = typeof env['XDG_DATA_HOME'] === 'string' && env['XDG_DATA_HOME'].trim() !== ''
    ? env['XDG_DATA_HOME']
    : join(home, '.local', 'share');
  return [join(linuxRoot, 'CodeBuddyExtension', 'Data', 'Public', 'auth')];
}

function productRoot(platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  if (platform === 'darwin') {
    return [join(home, 'Library', 'Application Support', 'CodeBuddyExtension')];
  }
  if (platform === 'win32') {
    const candidates = [env['LOCALAPPDATA'], env['APPDATA'], join(home, 'AppData', 'Local'), join(home, 'AppData', 'Roaming')]
      .filter((value): value is string => typeof value === 'string' && value.trim() !== '')
      .filter((value, index, all) => all.indexOf(value) === index);
    return candidates.map((root) => join(root, 'CodeBuddyExtension'));
  }
  const linuxRoot = typeof env['XDG_DATA_HOME'] === 'string' && env['XDG_DATA_HOME'].trim() !== ''
    ? env['XDG_DATA_HOME']
    : join(home, '.local', 'share');
  return [join(linuxRoot, 'CodeBuddyExtension')];
}

/**
 * 全部凭据文件候选路径（多平台 + 多 spelling）。顺序：CN 优先（与 MVP 范围一致），
 * 调用方按 "第一个能 read 的" 策略遍历。
 */
export function workBuddyAuthCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): WorkBuddyFileCandidate[] {
  const result: WorkBuddyFileCandidate[] = [];
  for (const variant of ['cn', 'global'] as const) {
    for (const root of authRoot(platform, home, env)) {
      result.push({ variant, path: join(root, WORKBUDDY_AUTH_FILENAME), kind: 'auth' });
    }
  }
  return result;
}

/** product.json 候选（用于读取 appVersion 等）。 */
export function workBuddyProductCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): WorkBuddyFileCandidate[] {
  const result: WorkBuddyFileCandidate[] = [];
  for (const variant of ['cn', 'global'] as const) {
    for (const root of productRoot(platform, home, env)) {
      result.push({ variant, path: join(root, WORKBUDDY_PRODUCT_FILENAME), kind: 'product' });
    }
  }
  return result;
}

/** variant → Electron bundle id（macOS mdfind 探测用）。 */
export function workBuddyBundleId(variant: WorkBuddyVariant): string {
  return variant === WORKBUDDY_VARIANT_GLOBAL ? WORKBUDDY_BUNDLE_ID_GLOBAL : WORKBUDDY_BUNDLE_ID_CN;
}

/** variant → Windows DisplayName（reg query 探测用）。 */
export function workBuddyWindowsAppName(variant: WorkBuddyVariant): string {
  return variant === WORKBUDDY_VARIANT_GLOBAL ? WORKBUDDY_WINDOWS_APP_NAME_GLOBAL : WORKBUDDY_WINDOWS_APP_NAME_CN;
}