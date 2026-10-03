// 按需启动的 macOS 用户服务：由 launchd 创建进程，生命周期不依赖安装 Agent。
// plist 不放进 Library/LaunchAgents；退出登录后不会自动启动，也不需要 sudo。
import { execFile } from 'node:child_process';
import { constants, closeSync, existsSync, fchmodSync, lstatSync, openSync, readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { writePrivateFileSync } from '../util/private-file.js';
import { OnboardError } from './errors.js';

export type LaunchctlRun = (args: string[]) => Promise<{ code: number | string; stdout: string }>;
export interface LaunchdOptions {
  repoRoot: string;
  port: number;
  configPath?: string;
  homeDir?: string;
  nodePath?: string;
  uid?: number;
  run?: LaunchctlRun;
  environment?: Partial<Pick<NodeJS.ProcessEnv, 'ACCESSMUX_DISABLE_ADAPTERS'>>;
}
export interface LaunchdHandle {
  label: string;
  /** 本次新注册；已有受管服务不会被盲目强杀。 */
  registered: boolean;
  stop(): Promise<void>;
}

const exec = promisify(execFile);
export const runLaunchctl: LaunchctlRun = async (args) => {
  try {
    const { stdout } = await exec('/bin/launchctl', args, { timeout: 10_000, maxBuffer: 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    // launchctl 输出可含本机路径；对用户只显示退出码，不回显环境或日志。
    const e = error as { code?: number | string };
    return { code: e.code ?? 'unknown', stdout: '' };
  }
};

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function launchdIdentity(options: LaunchdOptions): { label: string; service: string; plist: string; log: string } {
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined || !Number.isInteger(uid) || uid < 0 || !Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new OnboardError('无法确定当前用户的后台服务身份。');
  }
  const label = `ai.nengong.accessmux.onboard.${uid}.${options.port}`;
  const directory = join(options.homeDir ?? homedir(), 'Library', 'Application Support', 'AccessMux', 'runtime', 'launchd');
  return { label, service: `gui/${uid}/${label}`, plist: join(directory, `${label}.plist`), log: join(directory, `${label}.log`) };
}

export function launchdPlist(options: LaunchdOptions): string {
  const { label, log } = launchdIdentity(options);
  const node = options.nodePath ?? process.execPath;
  const home = options.homeDir ?? homedir();
  // Node ESM 会规范化 macOS /var、/tmp 别名；登记和后续 stop 使用同一真实源码目录。
  let repoRoot = resolve(options.repoRoot);
  try { repoRoot = realpathSync(repoRoot); } catch { /* 缺失入口由 daemon 前置检查处理 */ }
  const args = [node, join(repoRoot, 'dist', 'cli', 'index.js'), 'serve', '--port', String(options.port)];
  if (options.configPath !== undefined) args.push('--config', resolve(options.configPath));
  // 不把 Agent 环境（会话 broker、NODE_OPTIONS 或 API Key）写进 plist。
  const path = [dirname(node), join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':');
  const environment = options.environment ?? process.env;
  const knownAdapters = new Set(['workbuddy', 'trae-cn', 'trae-global', 'opencode', 'qoder', 'zcode']);
  const disabled = environment.ACCESSMUX_DISABLE_ADAPTERS?.split(',').map(id => id.trim()).filter(id => knownAdapters.has(id)).join(',') ?? '';
  const disabledEntry = disabled ? `<key>ACCESSMUX_DISABLE_ADAPTERS</key><string>${xml(disabled)}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(repoRoot)}</string>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>${xml(home)}</string><key>PATH</key><string>${xml(path)}</string>${disabledEntry}</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>ExitTimeOut</key><integer>10</integer>
<key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`;
}

function matchingPlist(options: LaunchdOptions): boolean {
  const { plist } = launchdIdentity(options);
  if (!existsSync(plist)) return false;
  const st = lstatSync(plist);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024) throw new OnboardError('后台服务登记文件异常；没有覆盖或停止任何服务。');
  // 停止时用户可能已经取消临时禁用开关；只忽略这一项已知、非秘密控制。
  const withoutDisabled = (text: string): string => text.replace(/<key>ACCESSMUX_DISABLE_ADAPTERS<\/key><string>[a-z0-9,-]*<\/string>/g, '');
  return withoutDisabled(readFileSync(plist, 'utf8')) === withoutDisabled(launchdPlist(options));
}

function registeredPathMatches(stdout: string, path: string): boolean {
  const registered = /^\s*path = (.+)$/m.exec(stdout)?.[1]?.trim().replace(/^"|"$/g, '');
  if (!registered) return false;
  try { return realpathSync(registered) === realpathSync(path); } catch { return false; }
}

function failed(action: string, code: number | string): OnboardError {
  return new OnboardError(`macOS 未允许${action} AccessMux 独立后台服务（launchctl：${code}）。本次接入未完成。请在系统终端运行同一 onboard 命令；不需要重新登录或提供密钥。`);
}

export async function startLaunchdDaemon(options: LaunchdOptions): Promise<LaunchdHandle> {
  const id = launchdIdentity(options);
  const run = options.run ?? runLaunchctl;
  const matches = matchingPlist(options);
  if (existsSync(id.plist) && !matches) throw new OnboardError('此端口已有另一个 AccessMux 安装的登记；没有覆盖或停止它。请使用原安装或选择其它端口。');
  const current = await run(['print', id.service]);
  if (current.code === 0) {
    if (!matches || !registeredPathMatches(current.stdout, id.plist)) throw new OnboardError('同名后台服务不属于当前安装；没有停止它。');
    const kicked = await run(['kickstart', id.service]);
    if (kicked.code !== 0) throw failed('启动', kicked.code);
    return { label: id.label, registered: false, stop: () => stopLaunchdDaemon(options) };
  }
  if (current.code !== 113) throw failed('检查', current.code);
  writePrivateFileSync(id.plist, launchdPlist(options));
  if (!existsSync(id.log)) writePrivateFileSync(id.log, '');
  const st = lstatSync(id.log);
  if (!st.isFile() || st.isSymbolicLink()) throw new OnboardError('后台日志位置异常；没有注册服务。');
  const fd = openSync(id.log, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  const bootstrapped = await run(['bootstrap', id.service.split('/').slice(0, 2).join('/'), id.plist]);
  if (bootstrapped.code !== 0) {
    if (!matches) unlinkSync(id.plist);
    throw failed('注册', bootstrapped.code);
  }
  return { label: id.label, registered: true, stop: () => stopLaunchdDaemon(options) };
}

export async function ownsLaunchdDaemon(options: LaunchdOptions): Promise<boolean> {
  if (!matchingPlist(options)) return false;
  const id = launchdIdentity(options);
  const current = await (options.run ?? runLaunchctl)(['print', id.service]);
  return current.code === 0 && registeredPathMatches(current.stdout, id.plist);
}

export async function stopLaunchdDaemon(options: LaunchdOptions): Promise<void> {
  const id = launchdIdentity(options);
  const run = options.run ?? runLaunchctl;
  if (!matchingPlist(options)) throw new OnboardError('没有找到属于当前安装的后台服务登记；没有停止任何进程。');
  const current = await run(['print', id.service]);
  if (current.code === 0) {
    if (!registeredPathMatches(current.stdout, id.plist)) throw new OnboardError('同名后台服务不属于当前安装；没有停止它。');
    const stopped = await run(['bootout', id.service]);
    if (stopped.code !== 0) throw failed('停止', stopped.code);
    let unloaded = false;
    for (let i = 0; i < 60; i++) {
      const checked = await run(['print', id.service]);
      if (checked.code === 113) { unloaded = true; break; }
      if (checked.code !== 0) throw failed('确认卸载', checked.code);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!unloaded) throw failed('确认卸载', 'still-registered');
  } else if (current.code !== 113) throw failed('检查', current.code);
  unlinkSync(id.plist);
  // 保留已有私有日志，正常停止不删除用户证据或其它配置。
}
