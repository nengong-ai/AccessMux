// Trae 桌面 SQLite 缓存（state.vscdb）读取（端口 spec §3.2.7 + §4.3.3）。
//
// macOS 上 `sqlite3` CLI 是系统组件，可直接 exec；Windows / Linux 通常没有，
// 读取失败时调用方降级到 live catalog 即可。本模块整体 best-effort。
//
// 读出的仅是 cached row 的安全子集：name / prompt / max tokens / multimodal /
// modelType——不包含 endpoint / 凭据。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { traeStateDatabaseCandidates, type TraeStateDbOptions } from './cache-paths.js';

const execFileAsync = promisify(execFile);

export interface TraeCachedModelConfig {
  name: string;
  customConfig?: Record<string, unknown>;
  promptMaxTokens?: number;
  maxTokens?: number;
  maxTurn?: number;
  multimodal?: boolean;
  modelType?: string;
}

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** 安全解析一行缓存的 model 配置；缺关键字段返回 undefined。 */
export function parseTraeCachedModel(value: unknown): TraeCachedModelConfig | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw['name'] !== 'string' || raw['name'] === '') return undefined;
  let customConfig: Record<string, unknown> | undefined;
  if (typeof raw['custom_config'] === 'string' && raw['custom_config'] !== '') {
    try {
      const parsed = JSON.parse(raw['custom_config']) as unknown;
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) customConfig = parsed as Record<string, unknown>;
    } catch {
      // 容忍坏 JSON
    }
  }
  const promptMaxTokens = positive(raw['prompt_max_tokens']);
  const maxTokens = positive(raw['max_tokens']);
  const maxTurn = positive(raw['max_turn']);
  return {
    name: raw['name'],
    ...(customConfig === undefined ? {} : { customConfig }),
    ...(promptMaxTokens === undefined ? {} : { promptMaxTokens }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(maxTurn === undefined ? {} : { maxTurn }),
    ...(typeof raw['multimodal'] === 'boolean' ? { multimodal: raw['multimodal'] } : {}),
    ...(typeof raw['model_type'] === 'string' ? { modelType: raw['model_type'] } : {}),
  };
}

export interface TraeCachedModelReadOptions extends TraeStateDbOptions {
  /** 注入 sqlite3 执行函数（测试用）。 */
  runSqlite?: (database: string, sql: string) => Promise<{ stdout: string }>;
}

/**
 * 从 state.vscdb 读某 user / function 下某 model 的 cached config。
 * 不存在（缺 sqlite3 / 缺 db / 缺 row）一律返回 undefined，让上层保留 live
 * 静态兜底。绝不抛错。
 */
export async function readTraeCachedModel(
  functionName: string,
  modelName: string,
  userId: string,
  options: TraeCachedModelReadOptions = {},
): Promise<TraeCachedModelConfig | undefined> {
  const exists = options.existsSync ?? ((path: string) => {
    try {
      return require('node:fs').existsSync(path) as boolean;
    } catch {
      return false;
    }
  });
  const databases = traeStateDatabaseCandidates(options);
  const fallback = databases[0];
  if (fallback === undefined) return undefined;
  const database = databases.find((candidate) => exists(candidate)) ?? fallback;
  const key = `${userId}_AI.agent.model.model_list_map`;
  const sql = `select value from ItemTable where key=${JSON.stringify(key)} limit 1;`;
  const runSqlite = options.runSqlite
    ?? ((db: string, statement: string) => execFileAsync('sqlite3', [db, statement], { maxBuffer: 8 * 1024 * 1024 }));
  try {
    const { stdout } = await runSqlite(database, sql);
    const document = JSON.parse(stdout) as Record<string, unknown>;
    const list = Array.isArray(document[functionName]) ? document[functionName] as unknown[] : [];
    for (const item of list) {
      if (typeof item !== 'object' || item === null) continue;
      const candidate = (item as { name?: unknown }).name;
      if (candidate === modelName) {
        return parseTraeCachedModel(item);
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}