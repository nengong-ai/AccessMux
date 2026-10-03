// WorkBuddy atRestSecretKey provider（端口 spec §7.2 + dsh-workbuddy-connect/
// desktop-credential-protection.ts:608-979 / 1154 HELPER_SCRIPT）。
//
// 5.6+ 凭据解密必须 spawn 桌面应用本体拿 atRestSecretKey —— 这是 WorkBuddy
// 私有 binding `electron_browser_workbuddy_storage.loggerGet()` 的产物。
//
// 路径（端口 spec §7.4 选推荐 = 沿用 dsh）：
//   execFile(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
//     env: { ELECTRON_RUN_AS_NODE: '1' },
//     timeout: 10s,
//   })
//
// AccessMux 的隔离策略：
//   - atRestSecretKey 进程内持有；不进日志/回执
//   - 拿到的 key 派生 AES-256 key 解密 envelope，再把 envelope 里的 accessToken
//     由 daemon 内请求路径使用；缓存只在该 provider 持有，dispose/logout 清引用
//   - helper 单飞 + cache（同进程内多次解密复用同一 atRest key）
//
// 测试/开发可用 fakeKeyProvider() 注入合成 atRest key，无需 spawn。

import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { abortable, SharedWork } from '../../util/abort.js';
import { workBuddyBundleId, workBuddyWindowsAppName } from './paths.js';
import type { WorkBuddyVariant } from './variant.js';

const execFileAsync = promisify(execFile);

export const HELPER_SCRIPT_TIMEOUT_MS = 10_000;
/** `process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()` 的 1 行 JS 输出。 */
export const HELPER_SCRIPT = "process.stdout.write(String(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()))";
/**
 * Node 模式下"执行下一段脚本"参数。`ELECTRON_RUN_AS_NODE=1` 把 Electron 二进制
 * 当 Node 用，Node 没有 `--js`（dsh-workbuddy-connect 用 `--js` 是上游 Electron
 * 内部 flag，新版 Electron / WorkBuddy 私有 fork 都报 `bad option: --js`）。
 * `-e` 是官方支持的 inline-evaluate；execFile 透传不经过 shell，HELPER_SCRIPT
 * 里的单引号 / `$` 不需要额外转义。
 *
 * 真机验证（WorkBuddy 5.6.2 macOS）：`-e "<HELPER_SCRIPT>"` 成功拿到 atRestSecretKey；
 * `--js` 报 `bad option: --js`。
 */
export const HELPER_SCRIPT_ARGUMENT_FLAG = '-e';

/** Only OS/runtime discovery inputs; never inherit provider keys or Node injection flags. */
export function workBuddyHelperEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
    if (env[name] !== undefined) result[name] = env[name];
  }
  return result;
}

/**
 * spawn helper 拿 payload。**payload 到手即 SIGKILL**：真机实测（T001R4）
 * `-e` 模式的 Electron 输出 payload 后可能不退出（私有 binding 初始化会
 * 拉起完整 app 栈：GPU/network/renderer/daemon-app-server），等进程自然
 * 退出会把调用方挂到 10s 超时并留下残余进程树。stdout 增量累计，能
 * `JSON.parse` 即视为完整 payload，立刻杀进程返回。
 */
export function spawnAtRestHelper(
  electronPath: string,
  timeoutMs: number = HELPER_SCRIPT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(electronPath, [HELPER_SCRIPT_ARGUMENT_FLAG, HELPER_SCRIPT], {
      env: workBuddyHelperEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let stdout = '';
    let settled = false;
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try {
        child.kill('SIGKILL');
      } catch {
        // 已退出
      }
      finish();
    };
    const onAbort = () => settle(() => reject(signal?.reason));
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`WorkBuddy key helper (${electronPath}) timed out after ${timeoutMs}ms`)));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const trimmed = stdout.trim();
      if (trimmed === '') return;
      try {
        JSON.parse(trimmed);
      } catch {
        return; // payload 尚未累计完整
      }
      settle(() => resolve(trimmed));
    });
    child.on('error', (error: Error) => {
      settle(() => reject(new Error(`WorkBuddy key helper (${electronPath}) could not be started: ${(error as NodeJS.ErrnoException).code ?? 'spawn failed'}`)));
    });
    child.on('close', () => {
      const trimmed = stdout.trim();
      settle(() => {
        if (trimmed === '') {
          reject(new Error(`WorkBuddy key helper (${electronPath}) produced no payload`));
        } else {
          resolve(trimmed);
        }
      });
    });
  });
}

/**
 * helper 输出格式：`{version: 1, atRestSecretKey: <base64>}`（dsh 假设）。
 * 本类型是 parseAtRestPayload 的解析结果。
 */
export interface AtRestPayload {
  version: number;
  atRestSecretKey: string;
}

/**
 * 解析 helper stdout。抛出说明 stdout 不是预期 JSON，或字段缺失。
 *
 * key 形状校验对齐 dsh（desktop-credential-protection.ts:286-308）：
 * canonical base64 的 32 字节、非全零。提前拦住"helper 输出异常形状"，
 * 免得错 key 流到解密层才以 GCM auth failed 收场。
 */
export function parseAtRestPayload(raw: string): AtRestPayload {
  const trimmed = raw.trim();
  if (trimmed === '') throw new Error('WorkBuddy helper returned empty stdout');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error: unknown) {
    throw new Error('WorkBuddy helper output is not JSON');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('WorkBuddy helper output must be a JSON object');
  }
  const record = parsed as Record<string, unknown>;
  const version = record['version'];
  const key = record['atRestSecretKey'];
  if (version !== 1) throw new Error('WorkBuddy atRest payload version not supported');
  if (typeof key !== 'string' || key === '') {
    throw new Error('WorkBuddy atRest payload missing atRestSecretKey');
  }
  const decoded = Buffer.from(key, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== key) {
    throw new Error('WorkBuddy atRest payload atRestSecretKey is not a canonical base64 32-byte secret');
  }
  if (decoded.every((byte) => byte === 0)) {
    throw new Error('WorkBuddy atRest payload atRestSecretKey is all-zero');
  }
  return { version: 1, atRestSecretKey: key };
}

export interface WorkBuddyAppDiscovery {
  /** Electron 二进制绝对路径（macOS 上是 *.app/Contents/MacOS/...）。 */
  electronPath: string;
  variant: WorkBuddyVariant;
}

export interface WorkBuddyKeyProvider {
  /**
   * 单飞 + 缓存：进程内第一次 spawn 拿 atRest key；之后直接复用。
   * 同一个 provider 实例的所有解析共用一份 atRest key。
   */
  resolveAtRestSecretKey(signal?: AbortSignal): Promise<AtRestPayload>;
  /** 测试钩子：清掉缓存与 inflight；下一次 resolveAtRestSecretKey 重新 spawn。 */
  resetCache(): void;
}

/**
 * 合成 provider：测试 / dry-run 用，注入一段假 atRest key 直接派生解密。
 * 不 spawn 任何子进程；可信环境的开发与单测都可以用。
 */
export function fakeKeyProvider(atRestSecretKey: string): WorkBuddyKeyProvider {
  return {
    resolveAtRestSecretKey: async () => ({ version: 1, atRestSecretKey }),
    resetCache: () => undefined,
  };
}

/**
 * 实际 spawn provider（生产用）。需要：
 * 1. discoveryWorkBuddyApp() 找到 Electron 二进制绝对路径
 * 2. spawnAtRestHelper() spawn helper（payload 到手即 kill）
 * 3. parseAtRestPayload() 解 stdout
 */
export interface SpawnKeyProviderOptions {
  /** Electron 二进制发现策略（默认 mdfind / reg query + 默认平台路径）。 */
  discovery?: (variant: WorkBuddyVariant, signal?: AbortSignal) => Promise<WorkBuddyAppDiscovery | undefined>;
  /** helper spawn 顶层函数（对齐 dsh 的 spawnHelper 注入缝）；测试注入用。 */
  spawnHelper?: (electronPath: string, signal?: AbortSignal) => Promise<string>;
}

export function createSpawnKeyProvider(
  variant: WorkBuddyVariant,
  options: SpawnKeyProviderOptions = {},
): WorkBuddyKeyProvider {
  let cached: AtRestPayload | undefined;
  let keyWork = new SharedWork<AtRestPayload>();
  let generation = 0;
  const spawnHelper = options.spawnHelper ?? ((path: string, signal?: AbortSignal) => spawnAtRestHelper(path, HELPER_SCRIPT_TIMEOUT_MS, signal));
  const discovery = options.discovery ?? defaultWorkBuddyDiscovery;
  return {
    async resolveAtRestSecretKey(signal?: AbortSignal): Promise<AtRestPayload> {
      signal?.throwIfAborted();
      if (cached !== undefined) return cached;
      const startedGeneration = generation;
      return keyWork.run(async ownedSignal => {
        const app = await abortable(discovery(variant, ownedSignal), ownedSignal);
        ownedSignal.throwIfAborted();
        if (app === undefined) throw new Error(`WorkBuddy desktop app (variant ${variant}) was not found; cannot spawn helper`);
        const stdout = await abortable(spawnHelper(app.electronPath, ownedSignal), ownedSignal);
        ownedSignal.throwIfAborted();
        const payload = parseAtRestPayload(stdout);
        if (generation !== startedGeneration) throw new Error('WorkBuddy key resolution was reset');
        cached = payload;
        return payload;
      }, signal);
    },
    resetCache(): void {
      generation++;
      cached = undefined;
      keyWork.cancel(new Error('WorkBuddy key resolution was reset'));
      keyWork = new SharedWork<AtRestPayload>();
    },
  };
}

/**
 * 默认的 WorkBuddy Electron 二进制发现策略（端口 spec §7.1）：
 * - macOS: mdfind kMDItemCFBundleIdentifier == '<bundleId>' + plutil 拿 Contents/MacOS/<exe>
 * - Windows: reg query DisplayName + exe basename 校验（仅占位，详细策略见 dsh 882-939）
 * - Linux: ~/.local/share/workbuddy-prefix 之类（占位；Linux WorkBuddy 不在 MVP 必须范围）
 */
export async function defaultWorkBuddyDiscovery(
  variant: WorkBuddyVariant,
  signal?: AbortSignal,
): Promise<WorkBuddyAppDiscovery | undefined> {
  signal?.throwIfAborted();
  if (process.platform === 'darwin') {
    return discoverMacosApp(variant, signal);
  }
  if (process.platform === 'win32') {
    return discoverWindowsApp(variant, signal);
  }
  return discoverLinuxApp(variant);
}

async function discoverMacosApp(variant: WorkBuddyVariant, signal?: AbortSignal): Promise<WorkBuddyAppDiscovery | undefined> {
  const bundleId = workBuddyBundleId(variant);
  const { stdout } = await execFileAsync('mdfind', [`kMDItemCFBundleIdentifier == '${bundleId}'`], { env: workBuddyHelperEnv(), signal, timeout: HELPER_SCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' });
  const first = stdout.split('\n').map((line) => line.trim()).find((line) => line.endsWith('.app'));
  if (first === undefined) return undefined;
  const macOSDir = join(first, 'Contents', 'MacOS');
  // 优先用 Info.plist 的 CFBundleExecutable（WorkBuddy 5.6.2 真机实测是 'Electron'，
  // 不是 productName）。plutil 拿不到时再走兜底名单（同样包含 Electron）。
  const executableName = await readMacosBundleExecutable(first, signal).catch(() => undefined);
  signal?.throwIfAborted();
  const candidates = executableName !== undefined
    ? [executableName, ...FALLBACK_MACOS_EXECUTABLES]
    : FALLBACK_MACOS_EXECUTABLES;
  for (const name of candidates) {
    const candidate = join(macOSDir, name);
    if (existsSync(candidate)) return { electronPath: candidate, variant };
  }
  return undefined;
}

const FALLBACK_MACOS_EXECUTABLES: readonly string[] = ['Electron', 'WorkBuddy', 'workbuddy', 'WorkBuddy AI'];

/**
 * 读 macOS bundle 的 `CFBundleExecutable` 字段（plutil / defaults read）。
 * plutil 优先——更稳；defaults read 兜底（plist 不存在 key 时 plutil 返回
 * 非零退出码，所以这里 catch 不抛）。
 */
async function readMacosBundleExecutable(appBundle: string, signal?: AbortSignal): Promise<string | undefined> {
  const plist = join(appBundle, 'Contents', 'Info.plist');
  try {
    const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleExecutable', 'raw', plist], { env: workBuddyHelperEnv(), signal, timeout: HELPER_SCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const value = stdout.trim();
    if (value === '' || value === '<null>') return undefined;
    return value;
  } catch {
    signal?.throwIfAborted();
    // fallback 到 defaults read
  }
  try {
    const { stdout } = await execFileAsync('defaults', ['read', plist, 'CFBundleExecutable'], { env: workBuddyHelperEnv(), signal, timeout: HELPER_SCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const value = stdout.trim();
    if (value === '' || value === '<null>') return undefined;
    return value;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function discoverWindowsApp(variant: WorkBuddyVariant, signal?: AbortSignal): Promise<WorkBuddyAppDiscovery | undefined> {
  const displayName = workBuddyWindowsAppName(variant);
  try {
    const { stdout } = await execFileAsync('reg', ['query', 'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall', '/s', '/f', displayName, '/d'], { env: workBuddyHelperEnv(), signal, timeout: HELPER_SCRIPT_TIMEOUT_MS, killSignal: 'SIGKILL' });
    const match = /InstallLocation\s+REG_SZ\s+(.+)/i.exec(stdout);
    if (match === null) return undefined;
    const installLocation = (match[1] ?? '').trim();
    if (installLocation === '') return undefined;
    const candidate = join(installLocation, 'WorkBuddy.exe');
    if (existsSync(candidate)) return { electronPath: candidate, variant };
    return undefined;
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

async function discoverLinuxApp(_variant: WorkBuddyVariant): Promise<WorkBuddyAppDiscovery | undefined> {
  // WorkBuddy Linux 桌面不在 MVP 必须范围；保留占位避免 throw
  return undefined;
}