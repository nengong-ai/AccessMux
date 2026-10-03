import { abortable } from '../../util/abort.js';
// WorkBuddy 桌面版本解析（端口 spec §7.1 + dsh-workbuddy-connect/
// client-identity.ts:42/209-211 + app-version.ts:38-42）。
//
// 版本号进 chat UA（`WorkBuddy/<v> WorkBuddy/<v>`）和 `X-IDE-Version`。
// dsh 实测：网关按 UA 的 product 段分流，不按版本数值分支——所以解析
// 失败一律降级到编译期 fallback（CN 5.5.6 / Global 5.5.2），绝不阻塞请求。
//
// 解析链（对齐 dsh resolveChatIdentity：installed → fallback）：
//   macOS: /Applications/WorkBuddy.app 与 ~/Applications/WorkBuddy.app 的
//          Info.plist CFBundleShortVersionString（plutil）
//   其他平台 / 读不到: fallback 常量
// 进程内按 variant 缓存（一次消息不重读安装树）。

import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { WorkBuddyVariant } from './variant.js';

const execFileAsync = promisify(execFile);

/** dsh client-identity.ts:42 FALLBACK_CN_APP_VERSION。 */
export const FALLBACK_CN_APP_VERSION = '5.5.6';
/** dsh app-version.ts:38 FALLBACK_APP_VERSION（Global）。 */
export const FALLBACK_APP_VERSION = '5.5.2';

/** dsh app-version.ts:60 validAppVersion：可进 HTTP header 的版本形状（N.N[.N[.N]]）。 */
export function validAppVersion(value: unknown): value is string {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value);
}

/** bundle 读取器；测试注入用。 */
export type WorkBuddyBundleVersionReader = (signal?: AbortSignal) => Promise<string | undefined>;

function macAppRoots(): string[] {
  return ['/Applications', join(homedir(), 'Applications')];
}

/** 默认 bundle 版本读取：遍历 macOS 安装位置读 CFBundleShortVersionString。 */
async function readInstalledBundleVersion(signal?: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  for (const root of macAppRoots()) {
    signal?.throwIfAborted();
    const plist = join(root, 'WorkBuddy.app', 'Contents', 'Info.plist');
    try {
      const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', plist], { signal, timeout: 10_000, killSignal: 'SIGKILL' });
      const value = stdout.trim();
      if (validAppVersion(value)) return value;
    } catch {
      signal?.throwIfAborted();
      // 读不到就试下一个位置
    }
  }
  return undefined;
}

const cache = new Map<WorkBuddyVariant, string>();

/**
 * 解析 chat identity 用的 clientVersion。永不抛错——任何读取失败都
 * 降级到 fallback（对齐 dsh：resolution never blocks a message）。
 */
export async function resolveWorkBuddyClientVersion(
  variant: WorkBuddyVariant,
  options: { bundleVersionReader?: WorkBuddyBundleVersionReader; signal?: AbortSignal } = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  if (options.bundleVersionReader !== undefined) {
    // 注入路径不进缓存，测试之间互不可见（对齐 dsh injectable 语义）
    try {
      const version = await abortable(options.bundleVersionReader(options.signal), options.signal);
      if (validAppVersion(version)) return version;
    } catch {
      options.signal?.throwIfAborted();
      // fall through to fallback
    }
    return fallbackFor(variant);
  }
  const cached = cache.get(variant);
  if (cached !== undefined) return cached;
  let resolved: string;
  try {
    resolved = (await abortable(readInstalledBundleVersion(options.signal), options.signal)) ?? fallbackFor(variant);
  } catch {
    options.signal?.throwIfAborted();
    resolved = fallbackFor(variant);
  }
  options.signal?.throwIfAborted();
  cache.set(variant, resolved);
  return resolved;
}

/** 测试钩子：清缓存。 */
export function resetClientVersionCache(): void {
  cache.clear();
}

function fallbackFor(variant: WorkBuddyVariant): string {
  return variant === 'global' ? FALLBACK_APP_VERSION : FALLBACK_CN_APP_VERSION;
}
