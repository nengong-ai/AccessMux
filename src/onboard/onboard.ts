// `accessmux onboard` 编排：检测 → 询问 → 起/复用 daemon → 拉模型清单 →
// 逐宿主接入（备份 + 文本级纯增；已接入且支持 refresh 的做清单同步）→ 冒烟自检 →
// 完成清单（含回滚命令）。
//
// 防呆三原则（T008/T009/A010 教训的产品化）：
// 1. 幂等：已接入宿主直接跳过，重复运行不产生重复条目、不重复备份；
// 2. 零破坏：所有配置写入走 json-text 的"单点纯插入"自检，既有字节逐字保留；
// 3. 可回滚：写前必备份，完成清单打印逐宿主回滚命令。

import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { OnboardError } from './errors.js';
import { ensureDaemon, resolveRepoRoot } from './daemon.js';
import { redactLogText } from '../util/redact.js';
import { makeAsk } from './interact.js';
import { openUi } from './open-ui.js';
import { allHosts, type HostContext, type HostDef, type OnboardResult } from './hosts.js';

export interface OnboardOptions {
  /** Agent 从真实会话传入，不能从安装列表推断。 */
  host?: string;
  allHosts?: boolean;
  openUi?: boolean;
  /** 全部默认接入（跳过询问） */
  yes?: boolean;
  /** 只打印将做的改动，不写任何文件 */
  dryRun?: boolean;
  /** 已接入的宿主也重新冒烟 */
  smokeAll?: boolean;
}

export interface OnboardDeps {
  homeDir: string;
  repoRoot: string;
  port: number;
  configPath?: string;
  fetchFn: typeof fetch;
  spawnFn: typeof spawn;
  now: () => Date;
  ask(question: string): Promise<boolean>;
  choose(question: string): Promise<string>;
  openUi(url: string): Promise<boolean>;
  closeAsk(): void;
  log(line?: string): void;
  sleep(ms: number): Promise<void>;
  isTTY: boolean;
  platform: NodeJS.Platform;
}

interface HostState {
  def: HostDef;
  detected: ReturnType<HostDef['detect']>;
  result?: OnboardResult;
  error?: string;
  smokeOk?: boolean;
  smokeDetail?: string;
  /** T024：本次跑过 refresh 且判定"已是最新"（未写盘） */
  refreshCurrent?: boolean;
  endpointMigrated?: boolean;
}

const DEFAULT_PORT = 8080;

export function defaultPortFromEnv(env: { ACCESSMUX_PORT?: string }): number {
  const n = Number(env.ACCESSMUX_PORT);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
}

export async function runOnboard(
  options: OnboardOptions = {},
  depsPartial: Partial<OnboardDeps> = {},
): Promise<number> {
  const defaultAsk = depsPartial.ask || options.dryRun ? undefined : makeAsk();
  const deps: OnboardDeps = {
    homeDir: homedir(),
    repoRoot: resolveRepoRoot(),
    port: defaultPortFromEnv(process.env),
    fetchFn: fetch,
    spawnFn: spawn,
    now: () => new Date(),
    ask: depsPartial.ask ?? defaultAsk?.ask ?? (async () => true),
    choose: depsPartial.choose ?? defaultAsk?.choose ?? (async () => ''),
    openUi,
    closeAsk: depsPartial.closeAsk ?? (() => defaultAsk?.close()),
    log: depsPartial.log ?? ((line?: string) => console.log(line ?? '')),
    sleep: depsPartial.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))),
    isTTY: depsPartial.isTTY ?? Boolean(process.stdin.isTTY),
    platform: process.platform,
    ...depsPartial,
  };
  try {
    return await runFlow(options, deps);
  } finally {
    deps.closeAsk();
  }
}

async function runFlow(options: OnboardOptions, deps: OnboardDeps): Promise<number> {
  const log = deps.log;
  log('AccessMux 一键接入向导');
  log('把桌面 IDE 锁定的额度，开放给本机任意可配 Base URL 的宿主。');
  log('');

  // ---------- 第 1 步：检测 ----------
  log('第 1 步 · 检测本机已装的宿主…');
  const preCtx: HostContext = {
    homeDir: deps.homeDir,
    repoRoot: deps.repoRoot,
    baseURL: `http://127.0.0.1:${deps.port}`,
    port: deps.port,
    modelIds: [],
    fetchFn: deps.fetchFn,
    now: deps.now,
  };
  let hostId = options.host;
  if (hostId && options.allHosts) throw new OnboardError('--host 与 --all-hosts 不能同时使用');
  const definitions = allHosts();
  if (!hostId && !options.allHosts && !options.dryRun) {
    if (!deps.isTTY) throw new OnboardError('请从当前 Agent 会话传入 --host <id>；明确要求全部接入时用 --all-hosts --yes。');
    log(`  宿主选项：${definitions.map((d) => `${d.id}（${d.name}）`).join('、')}`);
    hostId = await deps.choose('当前要接入哪个宿主？请输入一个 id：');
  }
  if (hostId && !definitions.some((d) => d.id === hostId)) throw new OnboardError(`不支持的宿主：${hostId}；请使用 help 列出的宿主 id。`);
  const states: HostState[] = definitions.filter((def) => !hostId || def.id === hostId).map((def) => {
    try {
      return { def, detected: def.detect(preCtx) };
    } catch (e) {
      return {
        def,
        detected: { installed: true, canAuto: false, detail: `检测出错：${errText(e)}` },
        error: errText(e),
      };
    }
  });
  const installed = states.filter((s) => s.detected.installed);
  const missingCurrentHost = !!hostId && installed.length === 0;
  if (installed.length === 0) {
    log(
      '  没有检测到支持的宿主（ZCode / WorkBuddy / DSH / Claude Code / Codex CLI / Hermes）。',
    );
    log('  稍后仍会启动服务、打开 UI；请先完成宿主安装或按官方方式接入。');
  }
  for (const s of installed) {
    const flag = s.detected.onboarded ? '✓ 已接入' : s.detected.canAuto === false ? '△ 需手动' : '○ 可接入';
    log(`  ${flag}  ${s.def.name} —— ${s.detected.detail}`);
    if (s.detected.warning) log(`         ⚠ ${s.detected.warning}`);
  }
  log('');

  const candidates = installed.filter(
    (s) => s.def.kind === 'auto' && s.detected.canAuto !== false && !s.detected.onboarded,
  );

  // 纯本地计划提前结束：即使 daemon 已在线，/v1/models 也可能触发凭据读取/探源。
  if (options.dryRun) {
    log('预览（--dry-run）：不启动服务、不访问网络、不改写文件。');
    log('  模型数量未知；正式接入时才探测桥接源。');
    for (const s of candidates) log(`  [预览] ${s.def.name}：将写入 ${dryRunPlan(s)}`);
    for (const s of installed.filter((s) => s.detected.onboarded)) {
      log(`  [预览] ${s.def.name}：已接入（本次不刷新、不自检）`);
    }
    printGuides(installed, preCtx, log);
    log('╔═ 预览完成（未执行接入）═╗');
    return installed.some((s) => s.error) ? 1 : 0;
  }

  // T024：已接入且支持"模型清单同步"的 auto 宿主（目前仅 ZCode）。
  const refreshTargets = options.dryRun
    ? []
    : installed.filter(
        (s) => s.def.kind === 'auto' && s.detected.onboarded && s.def.refresh !== undefined,
      );

  // ---------- 第 2 步：询问 ----------
  const selected: HostState[] = [];
  if (candidates.length > 0 && !options.dryRun) {
    log('第 2 步 · 确认要接入哪些（回车 = 接入，输 n 跳过）…');
    if (options.yes) {
      for (const s of candidates) {
        log(`  ${s.def.name}：接入（--yes 默认）`);
        selected.push(s);
      }
    } else if (!deps.isTTY) {
      throw new OnboardError(
        '当前不是交互终端，无法逐个确认。全自动接入请加 --yes（预览改动请加 --dry-run）。',
      );
    } else {
      for (const s of candidates) {
        if (await deps.ask(`  接入 ${s.def.name}？(Y/n) `)) {
          selected.push(s);
        } else {
          log(`  跳过 ${s.def.name}`);
        }
      }
    }
    log('');
  } else if (candidates.length > 0) {
    for (const s of candidates) selected.push(s);
  }

  if (selected.length === 0 && !options.smokeAll && refreshTargets.length === 0) {
    log(candidates.length === 0
      ? '本次无需自动注册；仍会启动/复用服务并打开 UI。'
      : '本次没有选择接入任何宿主。');
    for (const s of installed) {
      if (s.detected.onboarded) log(`  ✓ ${s.def.name}：已接入（本次未重复注册）`);
    }
    // 指引里的示例模型名：daemon 恰好在跑就拉真实清单（不起 daemon）；
    // 探针未就绪时最多等 1s，仍拿不到就显示 [探测中]（T024，不再打裸占位名）
  }

  // ---------- 第 3 步：后台服务 + 模型清单 ----------
  log('第 3 步 · 准备后台服务…');
  const daemon = await ensureDaemon(deps.port, {
    fetchFn: deps.fetchFn,
    spawnFn: deps.spawnFn,
    repoRoot: deps.repoRoot,
    homeDir: deps.homeDir,
    platform: deps.platform,
    ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
  });
  log(
    daemon.started
      ? daemon.launcher === 'launchd'
        ? `  已由 macOS 启动独立后台服务（${daemon.baseURL}）；退出当前 Agent 后仍可打开，不会设置开机自启。`
        : `  已在后台启动服务（${daemon.baseURL}）`
      : `  复用已在跑的后台服务（${daemon.baseURL}）`,
  );
  const uiURL = `${daemon.baseURL}/ui`;
  if (daemon.recoveredFrom !== undefined) log(`  旧控制台不可用，已自动准备健康控制台：${uiURL}`);
  let uiReady = false;
  // 首屏 bootstrap 读取宿主配置；成功注册/刷新后再开页，失败和无源也给诊断入口。
  async function showUi(): Promise<void> {
    log(`  ACCESSMUX_UI_URL=${uiURL}`);
    try {
      const ready = await deps.fetchFn(uiURL, { signal: AbortSignal.timeout(5_000) });
      if (!ready.ok || !ready.headers.get('content-type')?.includes('text/html')) throw new Error('UI 未就绪');
      uiReady = true;
      if (options.openUi !== false) {
        log(await deps.openUi(uiURL) ? '  已打开本地 UI。' : `  浏览器未能自动打开，请点击：${uiURL}`);
      } else log(`  请由当前 Agent 的浏览器工具打开：${uiURL}（避免重复开页）。`);
    } catch {
      log(`  UI 尚未确认就绪，请稍后打开：${uiURL}`);
    }
  }
  const directory = await fetchModelDescriptions(daemon.baseURL, deps.fetchFn);
  const modelIds = directory.map((model) => model.id);
  if (modelIds.length === 0) {
    if (selected.length > 0 || options.smokeAll) {
      log('  ✗ 没有任何模型：桥接源（WorkBuddy / Trae）还没被守护识别。');
      log('    请在 UI 查看源状态；宿主配置未改动。登录或修复源后重跑 onboard。');
      await showUi();
      return 1;
    }
    // 纯同步路径（T024）：源离线不构成失败——跳过同步，保留"已接入"结论与指引
    log('  ✗ 桥接源当前没有在线模型（先打开对应桌面 IDE 登录一次，等 1-2 分钟后重跑）。');
    log('    本次跳过模型清单同步；已接入状态不受影响。');
    refreshTargets.length = 0; // 防御：绝不用空清单覆盖已注册的模型
  } else {
    const byAdapter = new Map<string, number>();
    for (const id of modelIds) {
      const a = id.slice(0, id.indexOf(':')) || id;
      byAdapter.set(a, (byAdapter.get(a) ?? 0) + 1);
    }
    const sourceSummary = [...byAdapter.entries()].map(([a, n]) => `${a} ${n}`).join(' + ');
    log(`  桥接源在线，共 ${modelIds.length} 个模型（${sourceSummary}）。`);
  }
  log('');
  const modelDescriptions = Object.fromEntries(directory.filter((model) => model.name).map((model) => [model.id, { name: model.name! }]));
  const ctx: HostContext = { ...preCtx, baseURL: daemon.baseURL, port: daemon.port, modelIds, modelDescriptions };
  {
    for (const s of installed.filter((s) => s.detected.onboarded)) {
      let matches: boolean | undefined;
      try { matches = s.def.endpointMatches?.(ctx); } catch { matches = false; }
      if (matches === true || matches === undefined && daemon.port === deps.port) continue;
      if (daemon.recoveredFrom !== undefined && s.def.migrateEndpoint) {
        try {
          const migrated = await s.def.migrateEndpoint(ctx, `http://127.0.0.1:${daemon.recoveredFrom}`);
          if (migrated && s.def.endpointMatches?.(ctx) === true) {
            s.result = migrated; s.endpointMigrated = true;
            log(`  ↻ ${s.def.name}：${migrated.summary}`);
            continue;
          }
        } catch { /* 不覆盖不认识的登记，保留下面的明确未完成说明。 */ }
      }
      s.error = '既有宿主配置的地址尚未确认匹配当前服务；本次不覆盖配置。请核对原端口后重跑，或按官方接法核对地址。';
      log(`  △ ${s.def.name}：${s.error}`);
    }
    // 不把旧端口的登记当成新端口已接入，也不自动覆盖既有清单。
    for (let i = refreshTargets.length - 1; i >= 0; i--) if (refreshTargets[i]?.error || refreshTargets[i]?.endpointMigrated) refreshTargets.splice(i, 1);
  }
  if (daemon.port !== 8080) {
    for (const s of installed.filter((s) => s.def.id === 'dsh')) {
      s.error = `DSH 插件默认指向 8080；请在插件设置将 baseURL 设为 ${daemon.baseURL}/v1。本次未自动改插件配置，接入尚待确认。`;
      log(`  △ ${s.def.name}：${s.error}`);
    }
  }

  // ---------- 第 4 步：接入（新宿主）与清单同步（已接入宿主） ----------
  if (selected.length > 0 || refreshTargets.length > 0) {
    if (options.dryRun) {
      log('第 4 步 · 预览（--dry-run，不写任何文件）…');
    } else {
      log(`第 4 步 · ${selected.length > 0 ? '接入' : '同步模型清单'}…`);
    }
  }
  for (const s of selected) {
    if (options.dryRun) {
      log(`  [预览] ${s.def.name}：将写入 ${dryRunPlan(s)}`);
      continue;
    }
    try {
      s.result = await s.def.onboard?.(ctx);
      if (!s.result) throw new OnboardError('该宿主不支持自动接入');
      log(`  ✓ ${s.def.name}：${s.result.summary}`);
      for (const f of s.result.files) {
        log(`    ${f.created ? '新建' : '写入'} ${f.path}${f.backup ? `（改前备份：${f.backup}）` : ''}`);
      }
    } catch (e) {
      s.error = errText(e);
      log(`  ✗ ${s.def.name}：${errText(e)}`);
      const hint = e instanceof OnboardError ? e.hint : undefined;
      if (hint) log(`    怎么办：${hint}`);
      log('    手动接法（照做也能接上）：');
      for (const line of s.def.guideLines(ctx)) log(`    ${line}`);
    }
  }
  // T024：已接入宿主的模型清单同步（受控替换，幂等：已最新则不写盘不备份）
  for (const s of refreshTargets) {
    try {
      const r = await s.def.refresh?.(ctx);
      if (r) {
        s.result = r;
        log(`  ↻ ${s.def.name}：${r.summary}`);
        for (const f of r.files) {
          log(`    ${f.created ? '新建' : '写入'} ${f.path}${f.backup ? `（改前备份：${f.backup}）` : ''}`);
        }
      } else {
        s.refreshCurrent = true;
        log(`  ✓ ${s.def.name}：模型清单已是最新（${ctx.modelIds.length} 个，未改动文件）`);
      }
    } catch (e) {
      s.error = errText(e);
      log(`  ✗ ${s.def.name}：模型清单同步失败：${errText(e)}`);
      const hint = e instanceof OnboardError ? e.hint : undefined;
      if (hint) log(`    怎么办：${hint}`);
    }
  }
  if (selected.length > 0 || refreshTargets.length > 0) log('');
  await showUi();

  // ---------- 第 5 步：自检 ----------
  if (!options.dryRun) {
    const smokeTargets = options.smokeAll ? selected.filter((s) => s.result) : [];
    const extra =
      options.smokeAll
        ? installed.filter((s) => s.detected.onboarded && s.def.smoke && !selected.includes(s))
        : [];
    const targets = [...smokeTargets, ...extra];
    if (targets.length > 0) {
      log('第 5 步 · 自检：每个接入的宿主发一条真实消息（消耗极少量额度）…');
      for (const [i, s] of targets.entries()) {
        if (i > 0) await deps.sleep(1500); // shim 单会话约束：串行 + 间隔（T009 教训）
        if (!s.def.smoke) continue;
        try {
          const r = await s.def.smoke(ctx);
          s.smokeOk = r.ok;
          s.smokeDetail = redactLogText(r.detail);
        } catch (error) {
          s.smokeOk = false;
          s.smokeDetail = errText(error);
        }
        log(`  ${s.smokeOk ? '✓' : '✗'} ${s.def.name}：${s.smokeDetail}`);
      }
      log('');
    }
  }

  // ---------- 完成清单 ----------
  const failures = installed.filter((s) => s.error || s.smokeOk === false);
  const manualOnly = installed.length > 0 && installed.every((s) => s.def.kind === 'guide' || s.detected.canAuto === false);
  log(failures.length > 0 || !uiReady || missingCurrentHost ? '╔═ 部分完成（有失败项，见上）═╗' : manualOnly ? '╔═ 向导完成（需按下方指引完成宿主配置）═╗' : '╔═ 接入完成 ═╗');
  for (const s of installed) {
    if (s.error) {
      log(`  ✗ ${s.def.name}：失败（上面有手动接法）`);
      continue;
    }
    if (s.smokeOk === false) {
      log(`  ✗ ${s.def.name}：已接入但自检失败（${s.smokeDetail}）；配置保留，未自动回滚`);
    }
    if (s.result) {
      log(`  ${s.smokeOk === false ? '△' : '✓'} ${s.def.name}：${s.result.summary}`);
      const rb = s.def.rollbackLines?.(s.result) ?? [];
      for (const line of rb) log(`      回滚：${line}`);
      continue;
    }
    if (s.detected.onboarded && s.smokeOk !== false) {
      log(
        `  ✓ ${s.def.name}：${
          s.refreshCurrent ? '已接入，模型清单已是最新' : '已接入（本次未重复注册）'
        }`,
      );
    }
  }
  printGuides(installed, ctx, log);
  printNextStep(log);
  log(`  重新打开/启动服务：accessmux onboard ${hostId ? `--host ${hostId}` : '--all-hosts'} --yes --port ${daemon.port}`);
  if (!options.smokeAll) log('  本次只检查目录和配置；未发送模型消息，调用效果尚未验证。');
  log('  排错：docs/onboard.md「常见问题」与 docs/host-integration.md「排错速查」。');
  return failures.length > 0 || !uiReady || missingCurrentHost ? 1 : 0;
}

function dryRunPlan(s: HostState): string {
  if (s.def.id === 'zcode') {
    return `~/.zcode/v2/provider_config.json（备份后纯增供应商条目 + providerOrder，模型数量待正式探测）`;
  }
  if (s.def.id === 'workbuddy') {
    return '~/.workbuddy/models.json（备份后追加模型条目，数量待正式探测）';
  }
  if (s.def.id === 'dsh') {
    return `~/.dsh/profiles/desktop/package.json（备份后纯增 bundles + dependencies）+ node_modules 软链`;
  }
  return s.detected.detail;
}

async function fetchModelDescriptions(
  baseURL: string,
  fetchFn: typeof fetch,
  timeoutMs = 10000,
): Promise<Array<{ id: string; name?: string }>> {
  try {
    const res = await fetchFn(`${baseURL}/v1/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const json = (await res.json()) as { data?: Array<{ id?: unknown; name?: unknown; display_name?: unknown }> };
    return (json.data ?? []).flatMap((model) => {
      if (typeof model.id !== 'string') return [];
      const rawName = typeof model.display_name === 'string' ? model.display_name : model.name;
      const name = typeof rawName === 'string' ? rawName.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180) : '';
      return [{ id: model.id, ...(name ? { name } : {}) }];
    });
  } catch {
    return [];
  }
}

function printGuides(installed: HostState[], ctx: HostContext, log: OnboardDeps['log']): void {
  const guides = installed.filter(
    (s) =>
      s.def.kind === 'guide' ||
      (s.def.kind === 'auto' && s.detected.canAuto === false),
  );
  if (guides.length === 0) return;
  log('  ── 其它检测到的宿主（手动接入，两三行配置）──');
  for (const s of guides) {
    for (const line of s.def.guideLines(ctx)) log(`  ${line}`);
  }
}

function printNextStep(log: OnboardDeps['log']): void {
  log('  ── 下一步 ──');
  log('  打开宿主 → 模型选择器里选 "AccessMux" 组（或 AccessMux · 开头的模型）→ 发消息。');
  // T027：签到能力指引（只加不改；不阻塞接入流程）
  log('  想每日自动领免费额度：跑 `accessmux checkin`。Qoder 需先生成一次 PAT');
  log('  （qoder.com.cn → 账号设置 → 个人访问令牌），再 `accessmux checkin --set-pat`。');
  log('  详见 docs/host-integration.md 第 12 节。');
}

function errText(e: unknown): string {
  return redactLogText(e instanceof Error ? e.message : String(e));
}
