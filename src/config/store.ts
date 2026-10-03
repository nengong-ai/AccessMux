// 配置落盘：~/.accessmux/config.yaml，读写走 zod 校验。
// 进程内当前配置存 ConfigStore（单例），set 触发通知，方便 server 热应用。

import { existsSync, readFileSync } from 'node:fs';
import { writePrivateFileSync } from '../util/private-file.js';
import { redactLogText } from '../util/redact.js';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { listAdapters } from '../adapters/registry.js';
import type { ProviderAdapter } from '../adapters/types.js';
import {
  configSchema,
  formatZodError,
  type Config,
  type AdapterEntry,
} from './schema.js';

export const DEFAULT_CONFIG_DIR = join(homedir(), '.accessmux');
export const DEFAULT_CONFIG_PATH = join(DEFAULT_CONFIG_DIR, 'config.yaml');

/** 默认配置：以当前注册表为基础，全部启用、allowlist 全开 */
export function buildDefaultConfig(adapters: ProviderAdapter[] = listAdapters()): Config {
  const adapterEntries: Record<string, AdapterEntry> = {};
  const allow: Record<string, Record<string, boolean>> = {};
  for (const a of adapters) {
    adapterEntries[a.id] = { enabled: true };
    allow[a.id] = {}; // 空 allowlist 表示全部允许
  }
  return {
    version: 1,
    output: {
      port: 8080,
      host: '127.0.0.1',
      protocol: 'openai',
      exposeAnthropic: false,
    },
    adapters: adapterEntries,
    models: { allow },
  };
}

/** 从对象合并未知 adapter 字段：默认启用、新模型默认允许 */
export function reconcileWithRegistry(
  cfg: Config,
  adapters: ProviderAdapter[] = listAdapters(),
): Config {
  const next: Config = {
    ...cfg,
    adapters: { ...cfg.adapters },
    models: { allow: { ...cfg.models.allow } },
  };
  for (const a of adapters) {
    if (!next.adapters[a.id]) {
      next.adapters[a.id] = { enabled: true };
    }
    if (!next.models.allow[a.id]) {
      next.models.allow[a.id] = {};
    }
  }
  return next;
}

export class ConfigError extends Error {
  constructor(message: string, public readonly details?: unknown) {
    super(redactLogText(message));
    this.name = 'ConfigError';
  }
}

export function loadConfigFromPath(path: string): Config {
  if (!existsSync(path)) {
    throw new ConfigError(`配置文件不存在: ${path}`);
  }
  const raw = readFileSync(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    // YAML parser 的错误可能夹带原始配置行（兼容 PAT）；不要投影其上下文。
    throw new ConfigError('配置文件不是合法 YAML');
  }
  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    throw new ConfigError(`配置校验失败: ${formatZodError(result.error)}`, result.error.issues);
  }
  return reconcileWithRegistry(result.data);
}

export function saveConfigToPath(path: string, cfg: Config): void {
  // 落盘前再校验一次，挡住非法状态。
  const result = configSchema.safeParse(cfg);
  if (!result.success) {
    throw new ConfigError(`要保存的配置不合法: ${formatZodError(result.error)}`, result.error.issues);
  }
  writePrivateFileSync(path, stringifyYaml(result.data, { lineWidth: 0 }));
}

/** 解析配置路径：--config > 环境变量 > 默认 */
export function resolveConfigPath(override?: string): string {
  return resolve(
    override ?? process.env.ACCESSMUX_CONFIG ?? DEFAULT_CONFIG_PATH,
  );
}

/**
 * 进程内单例：保存当前生效配置。
 * set 时调用 onChange 通知已挂载的 server，便于热应用 allowlist / adapter 启停。
 */
export class ConfigStore {
  private current: Config;
  private listeners = new Set<(cfg: Config) => void>();

  constructor(initial: Config) {
    this.current = initial;
  }

  get(): Config {
    return this.current;
  }

  set(next: Config): void {
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }

  onChange(fn: (cfg: Config) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 从磁盘重读并 set；缺文件抛 ConfigError */
  reload(path: string): Config {
    const next = loadConfigFromPath(path);
    this.set(next);
    return next;
  }

  /** 首启便利方法：缺文件时写入默认配置；存在则 load */
  loadOrInitialize(path: string): { cfg: Config; created: boolean } {
    if (existsSync(path)) {
      const cfg = loadConfigFromPath(path);
      this.set(cfg);
      return { cfg, created: false };
    }
    const cfg = buildDefaultConfig();
    saveConfigToPath(path, cfg);
    this.set(cfg);
    return { cfg, created: true };
  }
}