// B09：app-server 兜底硬禁用。HOME/cwd 不是 OS 沙箱，也不能阻止 yolo 工具执行。
// 官方源码证据（既有 <isolated temporary directory>/ZCode 快照）：
// packages/shared/src/zcode-protocol/index.ts:1559-1580 有 toolAllowlist/toolDenylist；
// core/src/tool/handlers/index.ts:201-214、core/src/mcp/index.ts:66-79 可过滤空白名单。
// 但没有将全 deny 语义绑定当前安装 CLI 的可靠证据/离线执行验证；
// core/src/permission/service.ts:135-137 的 yolo 先于普通 deny 直接放行。
// 不猜参数、不静默扩大权限：删除可执行宿主路径，连手动强制与测试注入也不能启动。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ChatCompletionChunk, ChatMessage, TurnUsage } from '../../types.js';
import { usageFromTokenBreakdown } from '../../usage.js';
import { START_PLAN_MODELS, START_PLAN_PROVIDER_ID } from './catalog.js';

export const APP_SERVER_DISABLED_REASON = 'ZCode app-server 兜底已禁用：尚无经验证的官方全拒工具配置；直连失效时此源不可用，不能继续纯文本回复';
export const ZCODE_ELECTRON_ENV = 'ACCESSMUX_ZCODE_ELECTRON';
export const ZCODE_CLI_CJS_ENV = 'ACCESSMUX_ZCODE_CLI_CJS';
export const ZCODE_BUILTIN_CONFIG_ENV = 'ACCESSMUX_ZCODE_BUILTIN_CONFIG';
export interface AppServerPaths { electron: string; cliCjs: string; builtinConfig: string; personalConfig: string }
export function resolveAppServerPaths(deps: { env?: Record<string, string | undefined>; home?: string } = {}): AppServerPaths {
  const env = deps.env ?? process.env;
  const pick = (value: string | undefined, fallback: string) => value?.trim() || fallback;
  return {
    electron: pick(env[ZCODE_ELECTRON_ENV], '/Applications/ZCode.app/Contents/MacOS/ZCode'),
    cliCjs: pick(env[ZCODE_CLI_CJS_ENV], '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs'),
    builtinConfig: pick(env[ZCODE_BUILTIN_CONFIG_ENV], '/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json'),
    personalConfig: join(deps.home ?? homedir(), '.zcode', 'v2', 'provider_config.json'),
  };
}
export function computeBuiltinRevision(path: string): string {
  const revision = (JSON.parse(readFileSync(path, 'utf-8')) as { revision?: unknown }).revision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) throw new Error('zcode builtin 配置缺合法 revision');
  return `zcode-builtin:${revision}:${createHash('sha256').update(resolve(path)).digest('hex')}`;
}
export function buildAccountConfigPayload(builtinRevision: string, hostRevision: string): Record<string, unknown> {
  return { revision: hostRevision, basedOnZCodeBuiltinRevision: builtinRevision,
    providers: { [START_PLAN_PROVIDER_ID]: { builtinModelIds: [...START_PLAN_MODELS], access: { type: 'zhipu-account', entitled: true } } },
    states: { [START_PLAN_PROVIDER_ID]: { availability: 'available', entitled: true, current: true } } };
}
const ENV_WHITELIST = ['PATH', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC'];
export function buildAppServerEnv(source: Record<string, string | undefined>, sandboxHome: string, paths: AppServerPaths): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) if (source[key]) env[key] = source[key]!;
  return { ...env, HOME: sandboxHome, ELECTRON_RUN_AS_NODE: '1', ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: paths.builtinConfig, ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: paths.personalConfig };
}
export interface AppServerChild {
  readonly exitCode: number | null; readonly signalCode: string | null;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  stdin: { write(chunk: string): unknown; end(): void };
  stdout: { on(event: 'data', listener: (chunk: unknown) => void): void };
  stderr: { pipe(destination: { write(chunk: unknown): void }, options?: { end?: boolean }): unknown };
}
export type ZcodeSpawnFn = (file: string, args: readonly string[], options: { cwd: string; env: Record<string, string> }) => AppServerChild;
export interface ExitGuardTarget {
  readonly pid: number;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  kill(pid: number, signal?: NodeJS.Signals): unknown;
}
export interface AppServerHostOptions {
  env?: Record<string, string | undefined>; home?: string; root?: string;
  spawnImpl?: ZcodeSpawnFn; exitTarget?: ExitGuardTarget; paths?: AppServerPaths;
  getJwt: () => string; log?: (line: string) => void;
  stopGraceMs?: number; idleMs?: number; turnTimeoutMs?: number;
}
export interface AppServerTurnInput { model: string; messages: ChatMessage[] }
export function appServerTurnUsage(raw: unknown): TurnUsage | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const pick = (key: string) => typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0 ? record[key] as number : undefined;
  return usageFromTokenBreakdown({ input: pick('inputTokens'), output: pick('outputTokens'), reasoning: pick('reasoningTokens'), cacheRead: pick('cacheReadTokens'), cacheWrite: pick('cacheWriteTokens'), total: pick('totalTokens') });
}
/** 保留 API 供旧调用方收到明确错误；无进程、定时器、RPC waiter 或凭据读取。 */
export class ZcodeAppServerHost {
  constructor(_options: AppServerHostOptions) {}
  get alive(): boolean { return false; }
  async ensureStarted(): Promise<void> { throw new Error(APP_SERVER_DISABLED_REASON); }
  async *runTurn(_input: AppServerTurnInput): AsyncGenerator<ChatCompletionChunk> { throw new Error(APP_SERVER_DISABLED_REASON); }
  async request(_method: string, _params: unknown, _timeoutMs: number): Promise<unknown> { throw new Error(APP_SERVER_DISABLED_REASON); }
  cancelCurrentTurn(): void {}
  async dispose(): Promise<void> {}
}
export function foldForAppServer(messages: readonly ChatMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === 'user') return messages[0].content;
  return messages.map((m) => `${m.role}:\n${m.content}`).join('\n\n');
}
