// Qoder 运行时定位（T020，依附型 LockedUsage）。
// 只驱动真实已装的 `qoderclicn`（~/.qoder-cn/bin/，D22 铁律 3：不拆二进制、
// 不装系统 CA、不伪装客户端）。token 获取/刷新在 qoderclicn 进程内自闭环，
// 本模块连凭据面都不接触——只做二进制定位与版本校验。

import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { abortable } from '../../util/abort.js';

const exec = promisify(execFile);

/** 显式指定二进制路径的环境变量（最高优先级）。 */
export const QODER_BIN_ENV = 'ACCESSMUX_QODER_BIN';

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const BIN_PREFIX = 'qoderclicn-';

export interface QoderRuntimeDeps {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  home?: string;
  exists?: (path: string) => boolean;
  /** 执行 `-v`（测试注入用）。 */
  execFile?: (file: string, args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  /** 覆盖候选路径顺序（测试用）；默认 qoderBinaryCandidates 的推导结果。 */
  candidates?: readonly string[];
}

/** Qoder CLI 安装目录（GUI 自带二进制所在处）。 */
export function qoderBinDir(deps: QoderRuntimeDeps = {}): string {
  const home = deps.home ?? homedir();
  return join(home, '.qoder-cn', 'bin', 'qoderclicn');
}

/**
 * 二进制候选路径（顺序即优先级）：
 * env 覆盖 > version.txt 指定的当前版本 > 目录里 mtime 最新的 qoderclicn-*。
 * version.txt 缺读能力时（测试注入 exists/readFile），只回退 mtime 扫描。
 */
export function qoderBinaryCandidates(deps: QoderRuntimeDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const dir = qoderBinDir(deps);
  const override = env[QODER_BIN_ENV];
  const candidates: string[] = [];
  if (typeof override === 'string' && override !== '') candidates.push(override);
  try {
    const versionFile = join(dir, 'version.txt');
    if ((deps.exists ?? existsSync)(versionFile)) {
      const version = readFileSync(versionFile, 'utf8').trim();
      if (VERSION_RE.test(version)) candidates.push(join(dir, `${BIN_PREFIX}${version}`));
    }
  } catch {
    // version.txt 读不到就走下面的 mtime 扫描
  }
  try {
    const newest = readdirSync(dir)
      .filter((name) => name.startsWith(BIN_PREFIX))
      .map((name) => join(dir, name))
      .filter((path) => (deps.exists ?? existsSync)(path))
      .sort((a, b) => {
        try {
          return statSync(b).mtimeMs - statSync(a).mtimeMs;
        } catch {
          return 0;
        }
      })[0];
    if (newest !== undefined) candidates.push(newest);
  } catch {
    // 目录不存在（未安装 Qoder）→ 无候选
  }
  return [...new Set(candidates)];
}

export interface ResolvedQoderRuntime {
  path: string;
  version: string;
}

/**
 * 依优先级探测候选路径，返回第一个 `-v` 输出合法 semver 的二进制。
 * 全部落选时抛错并附安装指引（需要装有 Qoder 桌面版或 CLI）。
 */
export async function resolveQoderRuntime(deps: QoderRuntimeDeps = {}): Promise<ResolvedQoderRuntime> {
  deps.signal?.throwIfAborted();
  const exists = deps.exists ?? existsSync;
  const run =
    deps.execFile ??
    (async (file: string, args: readonly string[]) => exec(file, [...args], { timeout: 15_000, signal: deps.signal, killSignal: 'SIGKILL' }));
  const candidates = deps.candidates ?? qoderBinaryCandidates(deps);
  const failures: string[] = [];
  for (const candidate of candidates) {
    deps.signal?.throwIfAborted();
    if (!exists(candidate)) continue;
    let version: string;
    try {
      version = (await abortable(run(candidate, ['-v'], ...(deps.signal ? [{ signal: deps.signal }] : [])), deps.signal)).stdout.trim();
    } catch (error) {
      deps.signal?.throwIfAborted();
      failures.push(`${candidate}: ${(error as Error).message}`);
      continue;
    }
    if (!VERSION_RE.test(version)) {
      failures.push(`${candidate}: 无法识别的版本输出 ${version === '' ? '(空)' : version}`);
      continue;
    }
    return { path: candidate, version };
  }
  throw new Error(
    `找不到可用的 qoderclicn 二进制（${
      failures.length > 0 ? failures.join('；') : '未安装 Qoder'
    }）。需要安装 Qoder 桌面版（自带 CLI），或用 ${QODER_BIN_ENV}=<路径> 显式指定`,
  );
}
