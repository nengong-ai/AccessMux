// Trae 桌面 SQLite 缓存（state.vscdb）候选路径（端口 spec §3.2.7）。
//
// state.vscdb 与 storage.json 共享 globalStorage 目录；从 credential candidate
// 推导是正确方式——版本装错的话两边会同时错，保证一致。

import { dirname, join } from 'node:path';
import type { TraeStorageCandidate } from './paths.js';
import { traeStorageCandidates } from './paths.js';

export const TRAE_STATE_DB_FILENAME = 'state.vscdb';

export interface TraeStateDbOptions {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** 显式 credential candidate；提供时锁到该 edition 的目录。 */
  candidate?: TraeStorageCandidate;
  existsSync?: (path: string) => boolean;
}

/**
 * 候选 state.vscdb 路径。candidate 提供时优先 candidate 自己；edition 不同的
 * 直接跳过，避免读到另一账号的 model 列表。
 */
export function traeStateDatabaseCandidates(options: TraeStateDbOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? '';
  const env = options.env ?? process.env;
  const paths: string[] = [];
  const push = (storagePath: string): void => {
    const database = join(dirname(storagePath), TRAE_STATE_DB_FILENAME);
    if (!paths.some((existing) => existing.toLowerCase() === database.toLowerCase())) paths.push(database);
  };
  if (options.candidate !== undefined && options.candidate.source === 'desktop') {
    push(options.candidate.path);
  }
  for (const candidate of traeStorageCandidates(platform, home, env)) {
    if (candidate.source !== 'desktop') continue;
    if (options.candidate !== undefined && candidate.edition !== options.candidate.edition) continue;
    push(candidate.path);
  }
  return paths;
}