#!/usr/bin/env node
// accessmux CLI 骨架：serve / status / provider list / ui（T004）+ checkin（T027）。
// 绑定 127.0.0.1（D4：不出本机）。

import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { redactLogText } from '../util/redact.js';
import * as readline from 'node:readline';
import type { FastifyInstance } from 'fastify';
import { registerDefaultAdapters } from '../adapters/index.js';
import { listAdapters } from '../adapters/registry.js';
import { buildServer } from '../protocol/server.js';
import {
  ConfigStore,
  ConfigError,
  resolveConfigPath,
  saveConfigToPath,
  loadConfigFromPath,
  buildDefaultConfig,
  type Config,
} from '../config/index.js';
import { runCheckinAll, printCheckinResults } from '../checkin/index.js';
import { readQoderPat, writeQoderPat } from '../checkin/pat-store.js';

const rawArgs = process.argv.slice(2);

/** --config 是全局参数；移除后再分派，支持命令前后的位置。 */
function parseCliArgs(args: string[]): { args: string[]; configOverride?: string } {
  const positional: string[] = [];
  let configOverride: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--config') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new ConfigError('--config 需要文件路径');
      configOverride = value;
    } else if (arg.startsWith('--config=')) {
      configOverride = arg.slice('--config='.length);
      if (!configOverride) throw new ConfigError('--config 需要文件路径');
    } else positional.push(arg);
  }
  return { args: positional, ...(configOverride === undefined ? {} : { configOverride }) };
}

function help(): void {
  console.log(`accessmux —— 统一管理免费/低价 LLM 入口的桥接器

用法:
  accessmux serve [--port <n>]    启动本地服务（默认 8080，仅 127.0.0.1；内置 /ui）
  accessmux ui   [--port <n>]    仅启动本地配置界面（默认 8081，仅 127.0.0.1）
  accessmux onboard --host <id> [--yes]  当前宿主接入、启动/复用服务、打开 UI
                      [--all-hosts] [--dry-run] [--smoke] [--no-open-ui]
  宿主 id: zcode, workbuddy, dsh, claude-code, codex, hermes,
           trae, qoder
  accessmux status                各 adapter 探测状态
  accessmux provider list         已注册 adapter 列表
  accessmux checkin               自动签到：逐源领取每日免费额度（幂等，可挂 cron）
  accessmux checkin --set-pat     写入 Qoder PAT（qoder.com.cn 账号设置生成；0600 存本机）
  accessmux config init           [--config FILE]  生成默认配置文件（缺文件时）
  accessmux config path           打印当前生效的配置文件路径`);
}

function parsePort(args: string[], envName: string, fallback: number): number {
  const idx = args.indexOf('--port');
  if (idx > 0 && args[idx + 1]) {
    const n = Number(args[idx + 1]);
    if (Number.isFinite(n) && n > 0 && n < 65536) return n;
  }
  const env = process.env[envName];
  if (env && Number.isFinite(Number(env))) return Number(env);
  return fallback;
}

/**
 * T021：统一优雅关闭——退出路径遍历已注册 adapter 调 dispose（各 adapter
 * 内部已有的父进程退出联动变双保险）。单家失败不阻塞其余（不抛）。
 */
async function disposeAllAdapters(): Promise<void> {
  for (const adapter of listAdapters()) {
    try {
      await adapter.dispose();
    } catch (e) {
      console.error(redactLogText(`accessmux: adapter ${adapter.id} dispose 失败: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
}

/** 常驻命令（serve/ui）的信号退出：关 server（等 3s，SSE 长连接可能拖住）→ dispose → exit。 */
function installSignalShutdown(app: FastifyInstance): void {
  let exiting = false;
  const handle = (signal: string): void => {
    if (exiting) return;
    exiting = true;
    console.error(`accessmux: 收到 ${signal}，正在关闭…`);
    void (async () => {
      await Promise.race([
        app.close().catch(() => undefined),
        new Promise((r) => setTimeout(r, 3000).unref?.()),
      ]);
      await disposeAllAdapters();
      process.exit(0);
    })();
  };
  process.once('SIGTERM', () => handle('SIGTERM'));
  process.once('SIGINT', () => handle('SIGINT'));
}

async function loadOrCreateStore(path: string): Promise<{ store: ConfigStore; created: boolean }> {
  try {
    if (existsSync(path)) {
      const cfg = loadConfigFromPath(path);
      return { store: new ConfigStore(cfg), created: false };
    }
    // 首次运行：只把默认配置装入内存，不主动落盘（避免覆盖用户后续通过 /ui 的引导选择）
    const def = buildDefaultConfig();
    return { store: new ConfigStore(def), created: true };
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(redactLogText(`配置错误: ${e.message}`));
      process.exit(2);
    }
    throw e;
  }
}

/**
 * 隐藏输入（PAT/敏感值）：TTY 时关掉回显逐字符读，非 TTY 回退 readline。
 * 不打印、不记录输入内容；Ctrl+C 正常退出。
 */
function promptHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise<string>((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
  }
  return new Promise<string>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    let value = '';
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') { // Ctrl+C
          cleanup();
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (ch >= ' ') value += ch;
      }
    };
    const cleanup = (): void => {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.off('data', onData);
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  const { args, configOverride } = parseCliArgs(rawArgs);
  const [cmd = 'help'] = args;
  const configPath = resolveConfigPath(configOverride);
  if (cmd === '--version' || cmd === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
    console.log(version);
    return;
  }
  registerDefaultAdapters();
  // 常驻命令（serve/ui）由信号处理负责退出清理；一次性命令在 main 收尾统一 dispose
  let longRunning = false;

  switch (cmd) {
    case 'serve': {
      const { store, created } = await loadOrCreateStore(configPath);
      if (created) {
        console.log(`accessmux: 未找到配置文件，已加载内置默认配置（未落盘）: ${configPath}`);
        console.log('accessmux: 打开 http://127.0.0.1:<port>/ui 完成初始配置并保存，或运行 accessmux config init 生成文件');
      } else {
        console.log(`accessmux: 已加载配置 ${configPath}`);
      }
      // T021：端口语义与文档/onboard 对齐——--port > ACCESSMUX_PORT > 配置 > 8080
      const effectivePort = parsePort(args, 'ACCESSMUX_PORT', store.get().output.port);
      // 实际监听地址投影到进程内配置；不持久化、不改用户文件。
      store.set({ ...store.get(), output: { ...store.get().output, port: effectivePort } });
      const app = buildServer({ store, configPath });
      await app.listen({ port: effectivePort, host: '127.0.0.1' });
      console.log(`accessmux listening on http://127.0.0.1:${effectivePort}  (UI: /ui)`);
      installSignalShutdown(app);
      longRunning = true;
      break;
    }

    case 'ui': {
      const { store, created } = await loadOrCreateStore(configPath);
      if (created) {
        console.log(`accessmux ui: 未找到配置文件，已加载内置默认配置（未落盘）: ${configPath}`);
      } else {
        console.log(`accessmux ui: 已加载配置 ${configPath}`);
      }
      const port = parsePort(args, 'ACCESSMUX_UI_PORT', 8081);
      const app = buildServer({ store, configPath, uiOnly: true });
      await app.listen({ port, host: '127.0.0.1' });
      console.log(`accessmux ui on http://127.0.0.1:${port}/ui  (config: ${configPath})`);
      installSignalShutdown(app);
      longRunning = true;
      break;
    }

    case 'status': {
      const cfg = existsSync(configPath) ? loadConfigFromPath(configPath) : undefined;
      for (const adapter of listAdapters()) {
        const probe = cfg?.adapters[adapter.id]?.enabled === false
          ? { availability: 'disabled', models: [] }
          : await adapter.probe().catch((e) => ({ error: String(e) }));
        console.log(`${adapter.id}\t${redactLogText(JSON.stringify(probe), 4000, cfg?.qoder?.pat ? [cfg.qoder.pat] : [])}`);
      }
      break;
    }

    case 'onboard': {
      // T011 一键接入向导。端口解析与 serve 一致（--port > env > 配置 > 8080）。
      const cfgPort = existsSync(configPath)
        ? loadConfigFromPath(configPath).output.port
        : 8080;
      const port = args.includes('--port')
        ? parsePort(args, 'ACCESSMUX_PORT', cfgPort)
        : process.env.ACCESSMUX_PORT && Number.isFinite(Number(process.env.ACCESSMUX_PORT))
          ? Number(process.env.ACCESSMUX_PORT)
          : cfgPort;
      const { runOnboard } = await import('../onboard/onboard.js');
      if (args.includes('--host') && (!args[args.indexOf('--host') + 1] || args[args.indexOf('--host') + 1]?.startsWith('--'))) {
        throw new Error('--host 后需要一个宿主 id（见 help）');
      }
      const code = await runOnboard(
        {
          yes: args.includes('--yes'),
          dryRun: args.includes('--dry-run'),
          smokeAll: args.includes('--smoke'),
          host: args.includes('--host') ? args[args.indexOf('--host') + 1] ?? '' : undefined,
          allHosts: args.includes('--all-hosts'),
          openUi: !args.includes('--no-open-ui'),
        },
        { port, configPath },
      );
      process.exitCode = code;
      break;
    }

    case 'checkin': {
      // T027：自动签到（WorkBuddy + Qoder + ZCode 探测提示）。幂等，重复跑安全。
      const sub = args[1];
      if (sub === '--set-pat') {
        // 写入 Qoder PAT。**不接受命令行参数**：argv 会进 shell 历史与进程表，
        // 只支持交互式隐藏输入或管道 stdin（`pbpaste | accessmux checkin --set-pat`）。
        let pat: string;
        if (process.stdin.isTTY) {
          pat = await promptHidden('粘贴 Qoder PAT（输入不回显；回车确认）：');
        } else {
          pat = await new Promise<string>((resolve) => {
            let buf = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', (chunk) => { buf += chunk; });
            process.stdin.on('end', () => resolve(buf.trim()));
          });
        }
        try {
          const { path } = writeQoderPat(pat);
          console.log(`已写入 ${path}（权限 0600）`);
          console.log('PAT 生成入口：qoder.com.cn → 账号设置 → 个人访问令牌');
        } catch (e) {
          console.error(redactLogText(`写入失败：${e instanceof Error ? e.message : String(e)}`, 300, [pat]));
          process.exitCode = 2;
        }
        break;
      }
      if (sub !== undefined && sub !== '' && !sub.startsWith('-')) {
        help();
        break;
      }
      let cfg: Config | undefined;
      try {
        if (existsSync(configPath)) cfg = loadConfigFromPath(configPath);
      } catch (e) {
        if (e instanceof ConfigError) {
          console.error(redactLogText(`配置错误: ${e.message}`));
          process.exitCode = 2;
          break;
        }
        throw e;
      }
      const qoderPat = readQoderPat() ?? cfg?.qoder?.pat;
      const results = await runCheckinAll({
        sources: cfg?.checkin?.sources,
        ...(qoderPat === undefined ? {} : { qoderPat }),
      });
      process.exitCode = printCheckinResults(results);
      break;
    }

    case 'provider': {
      if (args[1] === 'list') {
        for (const adapter of listAdapters()) {
          console.log(`${adapter.id}\t${adapter.displayName}\tsandbox=${adapter.sandbox}`);
        }
      } else {
        help();
      }
      break;
    }

    case 'config': {
      const sub = args[1];
      if (sub === 'path') {
        console.log(configPath);
      } else if (sub === 'init') {
        const path = configPath;
        // lstat 包含 dangling symlink：init 不能覆盖任何已有目录项。
        let present = false;
        try { lstatSync(path); present = true; } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        if (present) {
          console.log(`配置已存在，保持原文件不变: ${path}`);
        } else {
          saveConfigToPath(path, buildDefaultConfig());
          console.log(`wrote ${path}`);
        }
      } else {
        help();
      }
      break;
    }

    default:
      help();
  }

  // T021：一次性命令收尾统一 dispose（正常退出路径；常驻命令由信号处理负责）
  if (!longRunning) await disposeAllAdapters();
}

main().catch((err) => {
  console.error(redactLogText(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
