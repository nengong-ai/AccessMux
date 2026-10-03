// OpenCode 运行时定位（T013）。
// 只定位已安装的二进制并校验版本输出；不做 npm 下载/校验链（本包可写范围不含
// package.json，无法引入 tar 依赖）——安装引导见报错信息，下载链路留后续任务。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { abortable } from '../../util/abort.js';

const exec = promisify(execFile);

/** 显式指定二进制路径的环境变量（最高优先级）。 */
export const OPENCODE_BIN_ENV = 'ACCESSMUX_OPENCODE_BIN';

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export interface RuntimeDeps {
  signal?: AbortSignal;
  env?: Record<string, string | undefined>;
  home?: string;
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  /** 执行 `--version`（测试注入用）。 */
  execFile?: (file: string, args: readonly string[], options?: { signal?: AbortSignal }) => Promise<{ stdout: string }>;
  /** 覆盖候选路径顺序（测试用）；默认 opencodeBinaryCandidates 的推导结果。 */
  candidates?: readonly string[];
}

/** 二进制候选路径（顺序即优先级）：env 覆盖 > ~/.opencode/bin > brew 安装路径。
 * ~/.opencode/bin 是官方安装脚本的目标目录（https://opencode.ai/install
 * `INSTALL_DIR=$HOME/.opencode/bin`；brew 亦为官方文档列出的安装方式）。 */
export function opencodeBinaryCandidates(deps: RuntimeDeps = {}): string[] {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const platform = deps.platform ?? process.platform;
  const override = env[OPENCODE_BIN_ENV];
  const installed = platform === 'win32'
    ? [join(home, '.opencode', 'bin', 'opencode.exe')]
    : [join(home, '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode'];
  return [override, ...installed].filter((p): p is string => typeof p === 'string' && p !== '');
}

export interface ResolvedRuntime {
  path: string;
  version: string;
}

/**
 * 依优先级探测候选路径，返回第一个 `--version` 输出合法 semver 的二进制。
 * 全部落选时抛错并附安装指引。
 */
export async function resolveOpencodeRuntime(deps: RuntimeDeps = {}): Promise<ResolvedRuntime> {
  deps.signal?.throwIfAborted();
  const exists = deps.exists ?? existsSync;
  const run =
    deps.execFile ??
    (async (file: string, args: readonly string[]) => exec(file, [...args], { timeout: 15_000, signal: deps.signal, killSignal: 'SIGKILL' }));
  const candidates = deps.candidates ?? opencodeBinaryCandidates(deps);
  const failures: string[] = [];
  for (const candidate of candidates) {
    deps.signal?.throwIfAborted();
    if (!exists(candidate)) continue;
    let version: string;
    try {
      version = (await abortable(run(candidate, ['--version'], ...(deps.signal ? [{ signal: deps.signal }] : [])), deps.signal)).stdout.trim();
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
    `找不到可用的 opencode 二进制（${
      failures.length > 0 ? failures.join('；') : '候选路径均不存在'
    }）。安装：brew install opencode，或用 ${OPENCODE_BIN_ENV}=<路径> 显式指定`,
  );
}
