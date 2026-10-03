// Trae 桌面 / CLI 凭据与缓存的候选路径（D11 + 端口 spec §3.2.7 + D11-3 单一来源）。
//
// 同一份候选表给 identity reader 和 credential scanner 共用：两者读的文件不同
//（product.json vs storage.json）但描述同一个安装，单一来源保证 spelling 一致。

import { homedir } from 'node:os';
import { join } from 'node:path';

export type TraeEdition = 'cn' | 'sg' | 'solo' | 'solo-sg';

/** 凭据的物理来源：Electron desktop storage.json / CLI bare JWT。 */
export type TraeCredentialSource = 'desktop' | 'cli';

export interface TraeStorageCandidate {
  edition: TraeEdition;
  path: string;
  source: TraeCredentialSource;
}

/** Electron app 在 macOS 上的 Application Support 子目录名（与 product.json name 一致）。 */
const APP_NAMES: Readonly<Record<TraeEdition, string>> = {
  cn: 'Trae CN',
  sg: 'Trae',
  solo: 'TRAE SOLO CN',
  'solo-sg': 'TRAE SOLO',
};

/** CLI 的 dotfile home 目录名（CLI 不走 Application Support）。 */
const CLI_HOME_NAMES: readonly string[] = ['.trae-cn', '.trae'];

/** CLI 持久化 JWT 的文件名（裸 JWT，不加密）。 */
export const TRAE_CLI_TOKEN_FILENAME = 'trae-jwt-token';

/**
 * Windows desktop 目录名 spellings（与 win32DirName / applicationName 双取）。
 *   Trae CN       -> win32DirName "Trae CN"        applicationName trae-cn
 *   TRAE SOLO CN  -> win32DirName "TRAE SOLO CN"   applicationName trae-solo-cn
 * 与 dsh-connect-trae/src/paths.ts:71-88 完全一致；AccessMux 直接复用。
 */
const WINDOWS_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['Trae CN', 'trae-cn'],
  sg: ['Trae'],
  solo: ['TRAE SOLO CN', 'trae-solo-cn'],
  'solo-sg': ['TRAE SOLO'],
};

/** Linux desktop 目录名 spellings（Electron on Linux 用小写无空格名）。 */
const LINUX_APP_NAMES: Readonly<Record<TraeEdition, readonly string[]>> = {
  cn: ['trae-cn', 'Trae CN', 'trae', 'Trae'],
  sg: ['trae', 'Trae'],
  solo: ['trae-solo-cn', 'TRAE SOLO CN'],
  'solo-sg': ['trae-solo', 'TRAE SOLO'],
};

/** 给 identity reader 与 credential scanner 共用的 Windows spellings。 */
export function traeWindowsAppNames(edition: TraeEdition): readonly string[] {
  return WINDOWS_APP_NAMES[edition];
}

/**
 * CLI token 候选路径。`.trae-cn` 对应 CN；`.trae` 是国际 CLI home 但带 SG
 * 路径未验证（端口 spec §3.7 注释），store 会按 region 过滤。
 */
export function traeCliCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeStorageCandidate[] {
  const roots: string[] = [];
  if (platform === 'win32') {
    for (const value of [env.USERPROFILE, home]) {
      if (typeof value === 'string' && value !== '' && !roots.includes(value)) roots.push(value);
    }
  } else {
    roots.push(home);
  }
  const result: TraeStorageCandidate[] = [];
  for (const root of roots) {
    for (const name of CLI_HOME_NAMES) {
      const edition: TraeEdition = name === '.trae-cn' ? 'cn' : 'sg';
      result.push({ edition, path: join(root, name, TRAE_CLI_TOKEN_FILENAME), source: 'cli' });
    }
  }
  return result;
}

/**
 * 全部候选路径：4 个 edition × 平台相关 root + Windows/Linux 的多 spelling。
 * 顺序固定，调用方按"第一个能 read 的"策略遍历。
 */
export function traeStorageCandidates(
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
  env: NodeJS.ProcessEnv = process.env,
): TraeStorageCandidate[] {
  const result: TraeStorageCandidate[] = [];
  for (const edition of ['cn', 'sg', 'solo', 'solo-sg'] as const) {
    const app = APP_NAMES[edition];
    let roots: string[];
    let appNames: readonly string[];
    if (platform === 'darwin') {
      roots = [join(home, 'Library', 'Application Support')];
      appNames = [app];
    } else if (platform === 'win32') {
      roots = [env.APPDATA, join(home, 'AppData', 'Roaming')]
        .filter((value): value is string => typeof value === 'string' && value !== '')
        .filter((value, index, all) => all.indexOf(value) === index);
      appNames = WINDOWS_APP_NAMES[edition];
    } else if (platform === 'linux') {
      roots = [env.XDG_CONFIG_HOME || join(home, '.config')];
      appNames = LINUX_APP_NAMES[edition];
    } else {
      roots = [];
      appNames = [app];
    }
    for (const root of roots) {
      for (const appName of appNames) {
        result.push({ edition, path: join(root, appName, 'User', 'globalStorage', 'storage.json'), source: 'desktop' });
      }
    }
  }
  return [...result, ...traeCliCandidates(platform, home, env)];
}