import { abortable, abortableDelay } from '../../util/abort.js';
// 隔离 spawn（T013 实现 / T034 换锚官方）：`opencode serve --pure` 的进程级隔离参数。
// 机制锚点 = OpenCode 官方开源仓库 github.com/sst/opencode（MIT）v1.18.31
// （commit 014614d）+ 官方文档 opencode.ai/docs；逐点对照表见回执 R034：
// - `serve` 子命令与 `--pure`（"run without external plugins"）：src/cli/cmd/serve.ts
//   + src/index.ts:61-68（--pure → OPENCODE_PURE=1）；--hostname/--port
//   见 src/cli/network.ts:6-19（默认 127.0.0.1）与 docs/server
// - env 白名单：AccessMux 自有隔离卫生（绝不带其他 provider 的 key 或用户的
//   OPENCODE_* 配置），非上游机制；变量名按 macOS/Windows 最小必需集自定
// - XDG 四目录重定向到独立 root：官方经 xdg-basedir 读 XDG_{CONFIG,DATA,CACHE,
//   STATE}_HOME（packages/core/src/global.ts:3-14），重定向即不读用户登录态
// - 随机 24 字节 hex 作 OPENCODE_SERVER_PASSWORD：官方 HTTP Basic 鉴权
//   （packages/opencode/src/server/auth.ts:17-19，用户名默认 opencode）；
//   仅本机进程间隔离密码，上游零凭据
// - 127.0.0.1 随机端口 + 健康轮询 GET /global/health（healthy+version 字段：
//   routes/instance/httpapi/groups/global.ts:13-14,69；版本必须与二进制一致为自校验）
// - stop：SIGTERM → 等待 → SIGKILL 兜底，保证子进程必回收（无孤儿）——自研

import { execFile as execFileCb, spawn } from 'node:child_process';
import { constants, createWriteStream, openSync } from 'node:fs';
import { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { writePrivateFileSync } from '../../util/private-file.js';
import { redactLogText } from '../../util/redact.js';
import { mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { join } from 'node:path';
import { OpenCodeServeClient } from './client.js';

/**
 * 隔离实例的原生权限（chat-only 铁律：全 ask/deny）。'*' 也是 ask——任何本地
 * 动作都会挂审批，由桥接层拒绝；deny 项连问都不问。
 * 键与取值锚点（官方 permission 配置 schema）：
 * packages/core/src/v1/config/permission.ts:5（Action=ask/allow/deny）、:8
 * （Record<String,Action> 直通，'*' 通配）、:40-41（字符串简写归一 {"*":action}）、
 * :17-36（已知键清单：task/todowrite/question/webfetch/websearch 等）；
 * plan_enter/plan_exit 为官方 action 名（packages/core/src/plugin/agent.ts:112-114）。
 * codesearch 不是 v1.18.31 官方键：schema Record 直通未知键不报错，此处作
 * 防御性 deny，预留其他版本可能引入的同名检索工具。
 */
export const nativePermissions: Readonly<Record<string, 'ask' | 'deny'>> = {
  '*': 'ask',
  question: 'deny',
  websearch: 'deny',
  codesearch: 'deny',
  webfetch: 'deny',
  task: 'deny',
  plan_enter: 'deny',
  plan_exit: 'deny',
  todowrite: 'deny',
};

const CHAT_AGENT_PROMPT =
  'Reply in plain text to the external conversation. No tool use or local actions. Never claim to have executed an action.';

/**
 * 隔离 serve 的内嵌配置（OPENCODE_CONFIG_CONTENT：官方 inline 配置通道，
 * packages/core/src/flag/flag.ts:22 + docs/cli 环境变量表）。chat-only 裁剪：
 * 只保留一个自定义文本 agent（buddy-chat）。agent 配置键锚点：
 * packages/core/src/v1/config/agent.ts:20（prompt）、:26（mode=primary/subagent/all）、
 * :38（permission）；share:'disabled' 与 autoupdate:false 见
 * packages/core/src/v1/config/config.ts:57、:64。
 */
export const isolatedConfig = {
  permission: nativePermissions,
  autoupdate: false,
  share: 'disabled',
  agent: {
    'buddy-chat': {
      mode: 'primary',
      description: 'Text-only external conversation',
      prompt: CHAT_AGENT_PROMPT,
      permission: nativePermissions,
    },
  },
} as const;

/** env 白名单（AccessMux 隔离卫生设计，非上游机制）：OS/网络必需项，其余全部丢弃。 */
const ENV_WHITELIST = [
  'PATH', 'HOME', 'USER', 'LANG', 'TMPDIR', 'SHELL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
  'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PATHEXT', 'COMSPEC',
] as const;

/** 进程间隔离密码：随机 24 字节 hex（48 字符）。 */
export function randomIsolationPassword(): string {
  return randomBytes(24).toString('hex');
}

/** 构造隔离 env：白名单 + XDG 重定向 + OPENCODE_* 隔离变量。纯函数（密码由调用方生成）。 */
export function buildIsolatedEnv(
  source: Record<string, string | undefined>,
  root: string,
  password: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ENV_WHITELIST) {
    const value = source[key];
    if (typeof value === 'string' && value !== '') env[key] = value;
  }
  for (const name of ['config', 'data', 'cache', 'state'] as const) {
    env[`XDG_${name.toUpperCase()}_HOME`] = join(root, name);
  }
  env['OPENCODE_SERVER_PASSWORD'] = password;
  env['OPENCODE_SERVER_USERNAME'] = 'opencode';
  env['OPENCODE_DISABLE_AUTOUPDATE'] = 'true';
  env['OPENCODE_DISABLE_PROJECT_CONFIG'] = 'true';
  env['OPENCODE_DISABLE_CLAUDE_CODE'] = 'true';
  env['OPENCODE_DISABLE_EXTERNAL_SKILLS'] = 'true';
  env['OPENCODE_CONFIG_CONTENT'] = JSON.stringify(isolatedConfig);
  return env;
}

/** 隔离 serve 需要的子进程面（真实 ChildProcess 的最小形状，测试可伪造）。 */
export interface ServeChild {
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  on(event: 'error', listener: (error: Error) => void): void;
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(signal?: NodeJS.Signals | number): boolean;
  stdout: { pipe(destination: { write(chunk: unknown): void }, options?: { end?: boolean }): unknown };
  stderr: { pipe(destination: { write(chunk: unknown): void }, options?: { end?: boolean }): unknown };
}

export type SpawnFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string> },
) => ServeChild;

export type ExecFn = (
  file: string,
  args: readonly string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; signal?: AbortSignal },
) => Promise<{ stdout: string }>;

const realSpawn: SpawnFn = (file, args, options) => {
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (child.stdout === null || child.stderr === null) {
    child.kill('SIGKILL');
    throw new Error('opencode serve: stdio pipe 不可用');
  }
  return child as unknown as ServeChild;
};

const realExec: ExecFn = (file, args, options) =>
  new Promise((resolve, reject) => {
    execFileCb(
      file,
      [...args],
      { cwd: options.cwd, env: options.env, timeout: options.timeoutMs, signal: options.signal, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
      (error: Error | null, stdout: string | Buffer) => {
        if (error !== null) reject(error);
        else resolve({ stdout: stdout.toString() });
      },
    );
  });

/** 取一个空闲的 loopback 端口（先绑后放，窗口期内交给 serve 绑定）。 */
export function getFreeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('无法获取空闲端口'));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

export interface ServeHandle {
  readonly baseUrl: string;
  readonly port: number;
  readonly version: string;
  readonly client: OpenCodeServeClient;
  /** 停止 serve 并保证子进程回收（SIGTERM → grace → SIGKILL）。幂等。 */
  stop(): Promise<void>;
}

// —— 父进程退出联动（T013）——
// `accessmux serve` 骨架尚无优雅关闭钩子（信号一来进程直接死，不走 adapter
// dispose），本 adapter 又是第一个持有外部子进程的源：不挂进程级兜底就会留孤儿
// serve（真机复现过一次）。注册一次全局监听：
// - SIGTERM/SIGINT/SIGHUP：先完整 stop（含 SIGKILL 升级）再原信号自杀（恢复默认处置）
// - exit：同步补一发 SIGTERM（进程已死发不出去等待回收的场景）
// 显式 dispose/stop 后句柄离场，监听成为空转 no-op。

export interface ExitGuardTarget {
  readonly pid: number;
  // eslint 未配置；此处 any[] 是刻意的：兼容 Node Process 的宽松监听器签名
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, listener: (...args: any[]) => void): unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
  kill(pid: number, signal?: NodeJS.Signals): unknown;
}

interface LiveServe {
  stop(): Promise<void>;
  /** 同步路径：只发 SIGTERM，不等回收（exit 钩子必须同步）。 */
  syncKill(): void;
}

const liveServes = new Set<LiveServe>();
const boundTargets = new WeakSet<object>();

export function bindExitGuards(target: ExitGuardTarget = process): void {
  if (boundTargets.has(target)) return;
  boundTargets.add(target);
  target.on('exit', () => {
    for (const serve of liveServes) serve.syncKill();
  });
  const onSignal = (signal: NodeJS.Signals): void => {
    void Promise.allSettled([...liveServes].map((serve) => serve.stop())).then(() => {
      target.removeListener(signal, onSignal);
      // 摘掉自己的监听后原信号重发，交给系统默认处置（退出码语义保持 128+n）
      target.kill(target.pid, signal);
    });
  };
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    target.on(signal, onSignal);
  }
}

export interface StartServeOptions {
  signal?: AbortSignal;
  binary: string;
  /** 二进制 `--version` 输出（resolveOpencodeRuntime 的结果）；健康检查要对照。 */
  version: string;
  /** XDG root：其下建 config/data/cache/state/project 五目录。 */
  root: string;
  /** 环境变量来源（默认 process.env）。 */
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  spawnImpl?: SpawnFn;
  execImpl?: ExecFn;
  /** serve 日志落盘路径；默认 <root>/serve.log。 */
  logPath?: string;
  /** 启动前跑一次 `opencode models opencode --refresh --pure` 刷新目录（默认 true；失败不阻断）。 */
  refreshOnStart?: boolean;
  healthAttempts?: number;
  healthIntervalMs?: number;
  /** stop 的 SIGTERM 宽限（默认 4000ms）。 */
  stopGraceMs?: number;
  /** 退出联动挂载点（测试注入；默认 process）。 */
  exitTarget?: ExitGuardTarget;
}

/** 启动隔离的 `opencode serve --pure`；任何失败路径都会回收子进程。 */
export async function startIsolatedServe(options: StartServeOptions): Promise<ServeHandle> {
  const { binary, version, root } = options;
  options.signal?.throwIfAborted();
  const projectDir = join(root, 'project');
  for (const dir of ['config', 'data', 'cache', 'state', 'project'] as const) {
    options.signal?.throwIfAborted();
    await mkdir(join(root, dir), { recursive: true, mode: 0o700 });
  }
  options.signal?.throwIfAborted();
  const logPath = options.logPath ?? join(root, 'serve.log');
  writePrivateFileSync(logPath, '');
  const logFd = openSync(logPath, constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
  const logStream = createWriteStream(logPath, { fd: logFd, autoClose: true });
  const writeLog = (line: string): void => {
    logStream.write(`${new Date().toISOString()} ${redactLogText(line, 300, [password])}\n`);
  };
  // 每路独立解码/缓冲：鉴权字段或 UTF-8 被拆成多个 chunk 也不能先落原文。
  const logSinks: Writable[] = [];
  const makeLogSink = (): Writable => {
    const decoder = new StringDecoder('utf8');
    let pending = '';
    let discarded = false;
    const consume = (text: string): void => {
      for (const [i, part] of text.split('\n').entries()) {
        if (i > 0) {
          writeLog(discarded ? '[oversized subprocess log omitted]' : pending);
          pending = '';
          discarded = false;
        }
        if (!discarded) {
          pending += part;
          if (pending.length > 65536) { pending = ''; discarded = true; }
        }
      }
    };
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) { consume(decoder.write(chunk)); callback(); },
      final(callback) {
        consume(decoder.end());
        if (pending !== '' || discarded) writeLog(discarded ? '[oversized subprocess log omitted]' : pending);
        callback();
      },
    });
    logSinks.push(sink);
    return sink;
  };

  const password = randomIsolationPassword();
  const env = buildIsolatedEnv(options.env ?? process.env, root, password);
  const execImpl = options.execImpl ?? realExec;
  const spawnImpl = options.spawnImpl ?? realSpawn;

  let port: number;
  try {
  if (options.refreshOnStart !== false) {
    try {
      // 起常驻 serve 前先刷新 provider 目录，避免首个 /provider 是内嵌的过期快照。
      await abortable(execImpl(binary, ['models', 'opencode', '--refresh', '--pure'], {
        cwd: projectDir,
        env,
        timeoutMs: 45_000,
        signal: options.signal,
      }), options.signal);
    } catch (error) {
      options.signal?.throwIfAborted();
      // 刷新失败不阻断：serve 仍可用缓存目录启动，probe 如实反映
      writeLog(`model catalog refresh failed (non-fatal): ${(error as Error).message}`);
    }
  }

  options.signal?.throwIfAborted();
  port = await getFreeLoopbackPort();
  options.signal?.throwIfAborted();
  } catch (error) {
    await new Promise<void>(resolve => logStream.end(resolve));
    throw error;
  }
  const child = spawnImpl(
    binary,
    ['serve', '--pure', '--hostname', '127.0.0.1', '--port', String(port)],
    { cwd: projectDir, env },
  );
  child.stdout.pipe(makeLogSink());
  child.stderr.pipe(makeLogSink());
  let spawnFailure: Error | undefined;
  child.on('error', (error) => {
    spawnFailure = error;
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const client = new OpenCodeServeClient(baseUrl, password, options.fetchImpl);
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    liveServes.delete(serve);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const graceMs = options.stopGraceMs ?? 4000;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, graceMs);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const sink of logSinks) if (!sink.writableEnded) sink.end();
    await new Promise<void>((resolve) => logStream.end(resolve));
  };
  const serve: ServeHandle & LiveServe = {
    baseUrl,
    port,
    version,
    client,
    stop,
    syncKill: () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    },
  };

  try {
    const attempts = options.healthAttempts ?? 120;
    const intervalMs = options.healthIntervalMs ?? 500;
    for (let i = 0; i < attempts; i++) {
      options.signal?.throwIfAborted();
      if (spawnFailure !== undefined) throw spawnFailure;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`opencode serve 提前退出（code=${child.exitCode} signal=${child.signalCode}），详见 serve.log`);
      }
      try {
        const health = await client.request<{ healthy?: boolean; version?: unknown }>('/global/health', 'GET', undefined, { timeoutMs: 1000, signal: options.signal });
        options.signal?.throwIfAborted();
        if (health.healthy === true) {
          if (typeof health.version === 'string' && health.version !== version) {
            throw new Error(`opencode serve 版本不一致：期望 ${version}，实际 ${health.version}`);
          }
          liveServes.add(serve);
          bindExitGuards(options.exitTarget);
          return serve;
        }
      } catch (error) {
        options.signal?.throwIfAborted();
        if (error instanceof Error && error.message.includes('版本不一致')) throw error;
        // 其余（连接拒绝/超时）视为未就绪，继续轮询
      }
      await abortableDelay(intervalMs, options.signal);
    }
    throw new Error(`opencode serve 启动超时（${attempts} 次 × ${intervalMs}ms 健康检查未通过）`);
  } catch (error) {
    await stop();
    throw error;
  }
}
