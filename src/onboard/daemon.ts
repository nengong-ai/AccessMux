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
import { ownsLaunchdDaemon, startLaunchdDaemon, stopLaunchdDaemon, type LaunchctlRun, type LaunchdHandle, type LaunchdOptions } from './launchd.js';

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
  platform?: NodeJS.Platform;
  homeDir?: string;
  launchctlRun?: LaunchctlRun;
  /** 仅作启动策略判断，绝不打印或持久化宿主环境。 */
  environment?: NodeJS.ProcessEnv;
  /** 离线测试注入私有日志位置，避免触及真实运行日志。 */
  logPath?: string;
}

export interface DaemonHandle {
  baseURL: string;
  port: number;
  /** true = 本次 onboard 启动的守护；false = 复用已在跑的 */
  started: boolean;
  launcher?: 'launchd' | 'detached';
  /** 明确识别的旧AccessMux UI已坏；迁移宿主只允许针对这个旧本地端点。 */
  recoveredFrom?: number;
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

type Probe = { kind: 'ready' | 'absent' | 'foreign' | 'ui-broken'; failedAsset?: string };

/** health 识别身份；HTML 和真实 JS/CSS 一起确认，不能用 health 200 冒充能开页。 */
export async function probeDaemon(baseURL: string, fetchFn: typeof fetch): Promise<Probe> {
  try {
    const res = await fetchFn(`${baseURL}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return { kind: 'absent' };
    const body = (await res.json()) as { ok?: boolean; service?: string; adapters?: unknown };
    if (body.ok !== true) return { kind: 'foreign' };
    const known = ['workbuddy', 'trae-cn', 'trae-global', 'opencode', 'qoder', 'zcode'];
    const legacy = body.service === undefined && Array.isArray(body.adapters) && body.adapters.every((id) => known.includes(id));
    if (body.service !== 'accessmux' && !legacy) return { kind: 'foreign' };
    for (const [route, contentType] of [['/ui/', 'text/html'], ['/ui/app.js', 'javascript'], ['/ui/style.css', 'text/css']] as const) {
      try {
        const asset = await fetchFn(`${baseURL}${route}`, { signal: AbortSignal.timeout(1500) });
        const text = asset.ok ? await asset.text() : '';
        if (!asset.ok || !asset.headers.get('content-type')?.includes(contentType) || !text.trim()
          || route === '/ui/' && !/<title>\s*AccessMux(?:\s|<)/i.test(text)) {
          return legacy && route === '/ui/' ? { kind: 'foreign' } : { kind: 'ui-broken', failedAsset: route };
        }
      } catch { return { kind: 'ui-broken', failedAsset: route }; }
    }
    return { kind: 'ready' };
  } catch {
    return { kind: 'absent' };
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
  const platform = deps.platform ?? process.platform;
  const environment = deps.environment ?? process.env;
  const repoRoot = deps.repoRoot ?? resolveRepoRoot();
  const launchdOptions = (servicePort: number): LaunchdOptions => ({ repoRoot, port: servicePort, environment, ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }), ...(deps.homeDir === undefined ? {} : { homeDir: deps.homeDir }), ...(deps.launchctlRun === undefined ? {} : { run: deps.launchctlRun }) });
  let recoveredFrom: number | undefined;
  let baseURL = '';
  const firstPort = port;
  for (; port < Math.min(firstPort + 20, 65536); port++) {
    baseURL = `http://127.0.0.1:${port}`;
    const probe = await probeDaemon(baseURL, fetchFn);
    if (probe.kind === 'ready') return { baseURL, port, started: false, ...(recoveredFrom === undefined ? {} : { recoveredFrom }) };
    if (probe.kind === 'ui-broken') {
      recoveredFrom ??= port;
      if (platform === 'darwin' && await ownsLaunchdDaemon(launchdOptions(port))) {
        await stopLaunchdDaemon(launchdOptions(port));
        if (await (deps.portAvailable ?? portAvailable)(port)) break;
      }
      // 旧版或不明进程不强杀：沿原有空闲端口策略创建健康的独立服务。
      continue;
    }
    if (await (deps.portAvailable ?? portAvailable)(port)) break;
  }
  if (port >= Math.min(firstPort + 20, 65536)) throw new OnboardError('附近端口均被占用，请用 --port 指定空闲端口');
  // spawn 生产入口：仓库根/dist/cli/index.js
  const entry = join(repoRoot, 'dist', 'cli', 'index.js');
  if (!existsSync(entry)) {
    throw new OnboardError(
      `后台服务入口不存在：${entry}。请先在仓库目录执行一次：npm run build`,
      '构建产物是 onboard 启动守护的唯一入口（生产路径）。',
    );
  }
  if (platform !== 'darwin' && (environment.CODEBUDDY_BROKERED_FS_HOOK_ENABLED === '1' || environment.CODEBUDDY_SAFE_DELETE_SANDBOX === '1')) {
    throw new OnboardError('当前宿主使用会话绑定的文件访问代理；此系统尚不能自动创建独立后台服务。本次安装未完成，请在系统终端运行同一 onboard 命令，无需重新登录或提供密钥。');
  }
  let managed: LaunchdHandle | undefined;
  if (platform === 'darwin') {
    managed = await startLaunchdDaemon(launchdOptions(port));
  } else {
    const spawnFn = deps.spawnFn ?? spawn;
    const logPath = deps.logPath ?? daemonLogPath();
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
  }
  const timeout = deps.readyTimeoutMs ?? 20000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await probeDaemon(baseURL, fetchFn)).kind === 'ready') {
      return { baseURL, port, started: true, launcher: platform === 'darwin' ? 'launchd' : 'detached', ...(recoveredFrom === undefined ? {} : { recoveredFrom }) };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // 仅清理本次新注册的受控 job，不强杀已有服务或任意端口进程。
  if (managed?.registered) {
    try { await managed.stop(); } catch { throw new OnboardError(`后台服务未完整就绪（端口 ${port}），且系统没有确认停止。本次安装未完成；请用 accessmux service stop --port ${port} 正常停止后重试。`); }
  }
  throw new OnboardError(
    `后台服务启动超时（端口 ${port}）；控制台 HTML、JS 和 CSS 尚未全部就绪。本次安装未完成，不需要重登或提供密钥。`,
  );
}
