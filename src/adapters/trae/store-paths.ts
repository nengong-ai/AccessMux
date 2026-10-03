// plugin-owned 凭据副本路径：每 region 一个文件，避免双区域相互覆盖。
//
// AccessMux 默认配置目录 = `$XDG_CONFIG_HOME/accessmux/` 或 `~/.accessmux/`。
// 与 dsh 的 `$DSH_HOME` 不同（端口 spec §2.2.5），保留 accessmux 自有目录。

import { join } from 'node:path';
import { accessmuxConfigHome } from '../../config/paths.js';
import type { TraeRegion } from './region.js';

const OWN_PREFIX = '.trae-auth';

/** 单 region 的 own copy path。两 region 同时刷新不会互相覆盖。 */
export function traeOwnAuthPath(region: TraeRegion): string {
  return join(accessmuxConfigHome(), `${OWN_PREFIX}.${region}.json`);
}

/** 旧版单文件副本 path：保留为迁移读取源，logout 时一起清。 */
export function legacyTraeOwnAuthPath(): string {
  return join(accessmuxConfigHome(), `${OWN_PREFIX}.json`);
}

/** 当前 own copy 版本号；写盘格式变更时 +1。 */
export const TRAE_AUTH_OWN_VERSION = 1 as const;