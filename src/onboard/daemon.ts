// daemon 起/复用：onboard 需要守护在跑（拉模型清单 + 冒烟）。
// 生产路径：spawn 的就是本仓 dist/cli/index.js serve（与用户手跑完全同一入口）。

import { spawn } from 'node:child_process';
import { closeSync, constants, existsSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { writePrivateFileSync } from '../util/private-file.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:net';
import { OnboardError } from './errors.js';

export function daemonLogPath(): string {
  // 独立私有目录；不能为收紧日志权限而 chmod 共享临时目录。
  return join(tmpdir(), `accessmux-${process.getuid?.() ?? 'user'}`, 'onboard-daemon.log');
}

export interface DaemonDeps {
  portAvailable?: (port: number) => Promise<boolean>;
  fetchFn?: typeof fetch;
  configPath?: string;
  /** 注入 spawn（测试离线）；默认真实 child_process.spawn */
  spawnFn?: typeof spawn;
  /** 仓库根目录定位（默认从本模块位置向上找 package.json） */
  repoRoot?: string;
  /** spawn 后等待 ready 的时长（毫秒），默认 20000 */
  readyTimeoutMs?: number;
}

export interface DaemonHandle {
  baseURL: string;
  port: number;
  /** true = 本次 onboard 启动的守护；false = 复用已在跑的 */
  started: boolean;
}

/** 从本模块位置向上找到仓库根（含 name=accessmux 的 package.json 的目录） */
export function resolveRepoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string };
        if (pkg.name === 'accessmux') return dir;
      } catch {
        /* 解析失败继续向上 */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new OnboardError(
    '无法定位 AccessMux 仓库根目录（向上未找到 package.json）。' +
      '如果你在移动过的目录里运行，请回到仓库目录重试。',
  );
}

async function fetchHealth(baseURL: string, fetchFn: typeof fetch): Promise<boolean> {
  try {
    const res = await fetchFn(`${baseURL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; service?: string; adapters?: unknown };
    if (body.ok !== true) return false;
    if (body.service === 'accessmux') return true;
    // 旧版尚无 service 标记：只读核对目录形状和 UI 标题，避免重复启动旧服务。
    const known = ['workbuddy', 'trae-cn', 'trae-global', 'opencode', 'qoder', 'zcode'];
    if (body.service === undefined && Array.isArray(body.adapters) && body.adapters.every((id) => known.includes(id))) {
      const ui = await fetchFn(`${baseURL}/ui`, { signal: AbortSignal.timeout(1500) });
      return ui.ok && /<title>\s*AccessMux(?:\s|<)/i.test(await ui.text());
    }
    return false;
  } catch {
    return false;
  }
}

export async function portAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * 确保守护在跑：先探测 health（复用），不通则 spawn 后台守护再等 ready。
 * port 优先级由调用方（CLI）按配置/env/默认值解析好传入。
 */
export async function ensureDaemon(port: number, deps: DaemonDeps = {}): Promise<DaemonHandle> {
  const fetchFn = deps.fetchFn ?? fetch;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new OnboardError('端口必须为 1–65535 的整数');
  let baseURL = '';
  const firstPort = port;
  for (; port < Math.min(firstPort + 20, 65536); port++) {
    baseURL = `http://127.0.0.1:${port}`;
    if (await fetchHealth(baseURL, fetchFn)) return { baseURL, port, started: false };
    if (await (deps.portAvailable ?? portAvailable)(port)) break;
  }
  if (port >= Math.min(firstPort + 20, 65536)) throw new OnboardError('附近端口均被占用，请用 --port 指定空闲端口');
  // spawn 生产入口：仓库根/dist/cli/index.js
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const entry = join(repoRoot, 'dist', 'cli', 'index.js');
  if (!existsSync(entry)) {
    throw new OnboardError(
      `后台服务入口不存在：${entry}。请先在仓库目录执行一次：npm run build`,
      '构建产物是 onboard 启动守护的唯一入口（生产路径）。',
    );
  }
  const spawnFn = deps.spawnFn ?? spawn;
  const logPath = daemonLogPath();
  writePrivateFileSync(logPath, '');
  const logFd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try {
    const args = [entry, 'serve', '--port', String(port)];
    if (deps.configPath !== undefined) args.push('--config', deps.configPath);
    const child = spawnFn(process.execPath, args, {
      detached: true,
      stdio: ['ignore', logFd, logFd],
    });
    child.unref();
  } finally {
    // 子进程已继承 fd，父进程不能一直持有。
    closeSync(logFd);
  }
  const timeout = deps.readyTimeoutMs ?? 20000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await fetchHealth(baseURL, fetchFn)) {
      return { baseURL, port, started: true };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new OnboardError(
    `后台服务启动超时（端口 ${port}，日志：${logPath}）。` +
      '可以手动启动后再跑一次 onboard：accessmux serve',
  );
}
