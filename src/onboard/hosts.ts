// 宿主定义：每个宿主一段"检测 → 接入（备份 + 文本级纯增）→ [已接入后可选：模型清单同步]
// → 冒烟 → 指引/回滚"。
// 注册面依据 docs/host-integration.md 各段实测结论：
// - ZCode ~/.zcode/v2/provider_config.json：providerOrder + providerRules 两处纯增（键序敏感，禁重排）；
//   已接入后 refresh 用"受控替换"同步 personalModelIds/modelOrder 数组内容，数组外字节逐字不动（T024）
// - WorkBuddy ~/.workbuddy/models.json：数组（或 {models:[]}）追加条目，1s 热重载
// - DSH ~/.dsh/profiles/desktop：package.json bundles+dependencies 两处纯增 + node_modules symlink
//   （复刻 dshmarket GUI"本地目录路径"安装的文件形态；lockfile 不动）
// - Trae / Qoder：guide 型，检测特征 ~/.trae*、~/.qoder* 数据目录（T037；接入面已核，
//   连通性待真机复核，见文件末尾两段注释）

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { OnboardError } from './errors.js';
import {
  appendToArray,
  appendToObject,
  atomicWrite,
  getByPointer,
  locateValue,
  parseJson,
  replaceArrayContents,
  type Pointer,
} from './json-text.js';
import { backupFile } from './backup.js';

export interface HostContext {
  homeDir: string;
  repoRoot: string;
  /** http://127.0.0.1:<port>（不带 /v1） */
  baseURL: string;
  port: number;
  /** daemon /v1/models 报告的全格式模型 id（<adapterId>:<modelId>），daemon 未就绪时为空 */
  modelIds: string[];
  /** /v1/models 的公开显示描述，只用于接入模型标签，键仍为完整原始 ID。 */
  modelDescriptions?: Record<string, { name: string }>;
  fetchFn: typeof fetch;
  now?: () => Date;
}

export interface DetectResult {
  installed: boolean;
  /** 小白可读的检测依据 */
  detail: string;
  onboarded?: boolean;
  /** false = 装了但当前无法自动接入（如关键配置文件缺失），降级为指引 */
  canAuto?: boolean;
  warning?: string;
}

export interface OnboardResult {
  /** 本次写过的文件与对应备份（备份 null = 新建文件） */
  files: { path: string; backup: string | null; created?: boolean }[];
  /** 一句话成果 */
  summary: string;
}

export interface SmokeResult {
  ok: boolean;
  model?: string;
  detail: string;
}

export interface HostDef {
  id: string;
  name: string;
  kind: 'auto' | 'guide';
  detect(ctx: HostContext): DetectResult;
  /** 只读核对已登记端点，不能把配置存在当成当前地址已接入。 */
  endpointMatches?(ctx: HostContext): boolean;
  /** 仅恢复明确识别的本产品旧本地端点，不改模型ID、Key或其它provider。 */
  migrateEndpoint?(ctx: HostContext, previousBaseURL: string): Promise<OnboardResult | null>;
  onboard?(ctx: HostContext): Promise<OnboardResult>;
  /**
   * 已接入后的"模型清单同步"（可选；目前仅 ZCode）：
   * 返回 OnboardResult = 本次改写了文件；返回 null = 已是最新（不写盘、不备份）。
   * 只允许改写既有注册面里的模型数组，文件其余字节严禁触碰（json-text 受控替换）。
   */
  refresh?(ctx: HostContext): Promise<OnboardResult | null>;
  smoke?(ctx: HostContext): Promise<SmokeResult>;
  /** 接法指引（guide 型宿主；auto 型用于失败降级说明） */
  guideLines(ctx: HostContext): string[];
  /** 回滚命令（auto 型；result 为本次接入结果，无则给手动步骤） */
  rollbackLines?(result?: OnboardResult): string[];
}

const ADAPTER_DISPLAY: Record<string, string> = {
  workbuddy: 'WorkBuddy',
  'trae-cn': 'Trae CN',
  'trae-global': 'Trae Global',
  // T013 遗留顺手项（R013 §5-4）+ T020
  opencode: 'OpenCode',
  qoder: 'Qoder',
  // T019
  zcode: 'ZCode',
};

/** `trae-cn:glm-5.2` → `Trae CN glm-5.2`（选择器显示名，T009 同款） */
export function modelDisplayName(id: string): string {
  const i = id.indexOf(':');
  if (i < 0) return id;
  const adapter = id.slice(0, i);
  const model = id.slice(i + 1);
  return `${ADAPTER_DISPLAY[adapter] ?? adapter} ${model}`;
}

function readTextOrThrow(path: string, what: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    throw new OnboardError(`读不到 ${what}（${path}）：${String(e)}`);
  }
}

function fileMode(path: string, fallback: number): number {
  try {
    return lstatSync(path).mode & 0o777;
  } catch {
    return fallback;
  }
}

/** 统一冒烟：走宿主接入件同款端点发一条非流式请求（生产路径，消费一次桥接额度） */
async function chatSmoke(ctx: HostContext, model: string): Promise<SmokeResult> {
  try {
    const res = await ctx.fetchFn(`${ctx.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: '连接自检：请只回复 pong' }],
        stream: false,
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const short = body.slice(0, 200);
      if (res.status === 404) {
        return {
          ok: false,
          model,
          detail: `模型 ${model} 不存在（404）。用 curl ${ctx.baseURL}/v1/models 查可用 id`,
        };
      }
      if (res.status === 500 && body.includes('shim is already running')) {
        return {
          ok: false,
          model,
          detail: '撞上单会话限制（500 shim is already running）：等几秒再试一次即可',
        };
      }
      return { ok: false, model, detail: `HTTP ${res.status} ${short}` };
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: unknown } }[];
    };
    const content = json.choices?.[0]?.message?.content;
    const text =
      typeof content === 'string' ? content : content != null ? JSON.stringify(content) : '';
    if (!text) {
      return { ok: false, model, detail: '返回为空（无 choices 内容）' };
    }
    return { ok: true, model, detail: `收到回复（${text.slice(0, 40)}…）` };
  } catch (e) {
    return {
      ok: false,
      model,
      detail: `请求失败：${String(e)}。常见原因：后台服务没在跑（accessmux serve）`,
    };
  }
}

// ---------------------------------------------------------------- ZCode

const ZCODE_FILE_PARTS = ['.zcode', 'v2', 'provider_config.json'];

function zcodeFilePath(ctx: HostContext): string {
  return join(ctx.homeDir, ...ZCODE_FILE_PARTS);
}

function zcodeAccessMuxIndex(parsed: unknown): number {
  const rules = zcodeProviderRules(parsed);
  if (!rules) return -1;
  return rules.findIndex(
    (r) => (r as { providerName?: unknown })?.providerName === 'AccessMux',
  );
}

function zcodeRuleHasAccessMux(parsed: unknown): boolean {
  return zcodeAccessMuxIndex(parsed) >= 0;
}

function zcodeProviderRules(parsed: unknown): unknown[] | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const config = (parsed as { config?: unknown }).config;
  if (config === null || typeof config !== 'object') return null;
  const rulesWrap = (config as { providerConfigRules?: unknown }).providerConfigRules;
  if (rulesWrap === null || typeof rulesWrap !== 'object') return null;
  const rules = (rulesWrap as { providerRules?: unknown }).providerRules;
  return Array.isArray(rules) ? rules : null;
}

export async function migrateAccessMuxEndpoint(ctx: HostContext, host: 'workbuddy' | 'zcode', previousBaseURL: string): Promise<OnboardResult | null> {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(previousBaseURL) || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(ctx.baseURL) || previousBaseURL === ctx.baseURL) return null;
  const file = host === 'workbuddy' ? workbuddyFilePath(ctx) : zcodeFilePath(ctx);
  const text = readTextOrThrow(file, '宿主接入配置');
  const parsed = parseJson(text);
  const replacements: Array<{ range: { start: number; end: number }; value: string }> = [];
  const canonical = (id: unknown): boolean => typeof id === 'string' && /^(workbuddy|trae-cn|trae-global|opencode|qoder|zcode):.+$/.test(id);
  if (host === 'workbuddy') {
    const shape = workbuddyArrayPointer(parsed);
    if (!shape) return null;
    shape.entries.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const row = raw as { id?: unknown; name?: unknown; url?: unknown };
      if (!canonical(row.id) || typeof row.name !== 'string' || !row.name.startsWith('AccessMux ·') || row.url !== `${previousBaseURL}/v1/chat/completions`) return;
      const pointer = shape.pointer.length ? [...shape.pointer, index, 'url'] : [index, 'url'];
      replacements.push({ range: locateValue(text, pointer), value: JSON.stringify(`${ctx.baseURL}/v1/chat/completions`) });
    });
  } else {
    const rules = zcodeProviderRules(parsed);
    if (!rules || rules.filter(raw => raw && typeof raw === 'object' && (raw as { providerName?: unknown }).providerName === 'AccessMux').length !== 1) return null;
    const index = zcodeAccessMuxIndex(parsed);
    if (index < 0) return null;
    const api: Pointer = ['config', 'providerConfigRules', 'providerRules', index, 'config', 'api'];
    const models = getByPointer(parsed, ['config', 'providerConfigRules', 'providerRules', index, 'config', 'personalModelIds']);
    if (!Array.isArray(models) || !models.length || !models.every(canonical) || getByPointer(parsed, [...api, 'baseUrl']) !== `${previousBaseURL}/v1` || getByPointer(parsed, [...api, 'type']) !== 'openai-chat-completions') return null;
    replacements.push({ range: locateValue(text, [...api, 'baseUrl']), value: JSON.stringify(`${ctx.baseURL}/v1`) });
  }
  if (!replacements.length) return null;
  let edited = text;
  for (const item of replacements.sort((a, b) => b.range.start - a.range.start)) edited = edited.slice(0, item.range.start) + item.value + edited.slice(item.range.end);
  parseJson(edited);
  const backup = backupFile(file, { now: ctx.now });
  atomicWrite(file, edited, fileMode(file, host === 'zcode' ? 0o600 : 0o644));
  return { files: [{ path: file, backup }], summary: `已备份并将 ${replacements.length} 个 AccessMux 接入地址迁移到恢复后的服务（只改本产品 URL）` };
}

const zcodeHost: HostDef = {
  id: 'zcode',
  name: 'ZCode',
  kind: 'auto',
  migrateEndpoint: (ctx, previousBaseURL) => migrateAccessMuxEndpoint(ctx, 'zcode', previousBaseURL),
  endpointMatches(ctx) {
    const parsed = parseJson(readTextOrThrow(zcodeFilePath(ctx), 'ZCode provider 配置'));
    const index = zcodeAccessMuxIndex(parsed);
    return index >= 0 && getByPointer(parsed, ['config', 'providerConfigRules', 'providerRules', index, 'config', 'api', 'baseUrl']) === `${ctx.baseURL}/v1`;
  },
  detect(ctx) {
    if (!existsSync(join(ctx.homeDir, '.zcode'))) {
      return { installed: false, detail: '' };
    }
    const file = zcodeFilePath(ctx);
    if (!existsSync(file)) {
      return {
        installed: true,
        canAuto: false,
        detail: '已安装 ZCode，但 ~/.zcode/v2/provider_config.json 不存在（还没配置过自定义供应商）',
      };
    }
    const parsed = parseJson(readTextOrThrow(file, 'ZCode provider 配置'));
    return {
      installed: true,
      canAuto: true,
      onboarded: zcodeRuleHasAccessMux(parsed),
      detail: `已安装 ZCode，找到 ${file}`,
    };
  },
  async onboard(ctx) {
    const file = zcodeFilePath(ctx);
    const text = readTextOrThrow(file, 'ZCode provider 配置');
    parseJson(text); // 编辑前先确认原文件合法
    if (ctx.modelIds.length === 0) {
      throw new OnboardError('后台服务没有报告任何模型，无法注册');
    }
    const uuid = randomUUID();
    const entry = {
      providerId: uuid,
      providerName: 'AccessMux',
      config: {
        group: 'standard-personal',
        access: { type: 'api-key', apiKey: 'local' },
        api: {
          type: 'openai-chat-completions',
          baseUrl: `${ctx.baseURL}/v1`,
        },
        personalModelIds: [...ctx.modelIds],
        modelOrder: [...ctx.modelIds],
      },
    };
    let edited = appendToArray(text, ['config', 'providerOrder'], uuid);
    edited = appendToArray(edited, ['config', 'providerConfigRules', 'providerRules'], entry);
    const backup = backupFile(file, { now: ctx.now });
    atomicWrite(file, edited, fileMode(file, 0o600));
    return {
      files: [{ path: file, backup }],
      summary: `注册供应商「AccessMux」（${ctx.modelIds.length} 个模型，GUI 热识别无需重启）`,
    };
  },
  async refresh(ctx) {
    // T024：已接入后的模型清单同步。只做"数组内容替换"：personalModelIds / modelOrder
    // 两个数组整段改为当前清单，文件其余字节（含键序）逐字保留（受控替换自检强制）。
    const file = zcodeFilePath(ctx);
    const text = readTextOrThrow(file, 'ZCode provider 配置');
    const parsed = parseJson(text);
    const idx = zcodeAccessMuxIndex(parsed);
    if (idx < 0) {
      throw new OnboardError(
        'ZCode 配置里找不到 AccessMux 供应商条目，无法同步模型清单',
        '在 ZCode 里删掉旧的 AccessMux 入口后重跑 onboard，会重新注册一个完整的。',
      );
    }
    if (ctx.modelIds.length === 0) {
      // 防御：空清单多半是桥接源离线，绝不用它覆盖已注册的模型
      throw new OnboardError('后台服务没有报告任何模型，拒绝用空清单覆盖 ZCode 里已注册的模型');
    }
    const ptr = (key: 'personalModelIds' | 'modelOrder'): Pointer => [
      'config',
      'providerConfigRules',
      'providerRules',
      idx,
      'config',
      key,
    ];
    const currentIds = getByPointer(parsed, ptr('personalModelIds'));
    const currentOrder = getByPointer(parsed, ptr('modelOrder'));
    if (!Array.isArray(currentIds) || !Array.isArray(currentOrder)) {
      throw new OnboardError(
        'AccessMux 条目缺 personalModelIds / modelOrder 数组，结构与预期不符，拒绝写入',
        '在 ZCode 里删掉旧的 AccessMux 入口后重跑 onboard 重新注册。',
      );
    }
    const want = [...ctx.modelIds];
    const same = (a: unknown[]): boolean => JSON.stringify(a) === JSON.stringify(want);
    if (same(currentIds) && same(currentOrder)) return null; // 幂等：已最新，不写盘、不备份
    let edited = text;
    if (!same(currentIds)) edited = replaceArrayContents(edited, ptr('personalModelIds'), want);
    if (!same(currentOrder)) edited = replaceArrayContents(edited, ptr('modelOrder'), want);
    const backup = backupFile(file, { now: ctx.now });
    atomicWrite(file, edited, fileMode(file, 0o600));
    return {
      files: [{ path: file, backup }],
      summary: `同步模型清单（${currentIds.length} → ${want.length} 个模型；数组外逐字节未动）`,
    };
  },
  async smoke(ctx) {
    const model = ctx.modelIds[0];
    if (!model) return { ok: false, detail: '无可用模型' };
    return chatSmoke(ctx, model);
  },
  guideLines() {
    return [
      'ZCode 接法（详见 docs/host-integration.md 第 6 节）：',
      '  在 ~/.zcode/v2/provider_config.json 纯增一个自定义 provider（schema 照文件里既有',
      '  自定义条目），并把它追加进 config.providerOrder —— 两处都要写。',
      '  ⚠ 该文件对键序敏感：严禁 jq -S 等会重排键序的工具，改坏会静默 fallback。',
    ];
  },
  rollbackLines(result) {
    const file = result?.files[0];
    if (file?.backup) {
      return [
        `cp "${file.backup}" "${file.path}" && chmod 600 "${file.path}"`,
        '（或手动删 providerOrder 里的 AccessMux UUID + providerRules 末尾的 AccessMux 条目）',
      ];
    }
    return ['从 provider_config.json 删掉 providerOrder 里的 AccessMux UUID 和 providerRules 末尾的 AccessMux 条目，其余一字不动'];
  },
};

// ---------------------------------------------------------------- WorkBuddy

const WORKBUDDY_MODELS_PARTS = ['.workbuddy', 'models.json'];

function workbuddyFilePath(ctx: HostContext): string {
  return join(ctx.homeDir, ...WORKBUDDY_MODELS_PARTS);
}

interface WorkbuddyEntryLike {
  name?: unknown;
}

/** 解析 models.json 形态：数组 → pointer []；{models:[…]} → pointer ['models'] */
function workbuddyArrayPointer(parsed: unknown): { pointer: [] | ['models']; entries: unknown[] } | null {
  if (Array.isArray(parsed)) return { pointer: [], entries: parsed };
  if (parsed !== null && typeof parsed === 'object') {
    const models = (parsed as { models?: unknown }).models;
    if (Array.isArray(models)) return { pointer: ['models'], entries: models };
  }
  return null;
}

function workbuddyHasAccessMux(entries: unknown[]): boolean {
  return entries.some(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      typeof (e as WorkbuddyEntryLike).name === 'string' &&
      ((e as WorkbuddyEntryLike).name as string).startsWith('AccessMux ·'),
  );
}

const workbuddyHost: HostDef = {
  id: 'workbuddy',
  name: 'WorkBuddy',
  kind: 'auto',
  migrateEndpoint: (ctx, previousBaseURL) => migrateAccessMuxEndpoint(ctx, 'workbuddy', previousBaseURL),
  endpointMatches(ctx) {
    const parsed = parseJson(readTextOrThrow(workbuddyFilePath(ctx), 'WorkBuddy 自定义模型配置'));
    const entries = workbuddyArrayPointer(parsed)?.entries ?? [];
    const ours = entries.filter((raw) => {
      const name = (raw as WorkbuddyEntryLike).name;
      return typeof name === 'string' && name.startsWith('AccessMux ·');
    });
    return ours.length > 0 && ours.every((raw) => (raw as {url?: unknown}).url === `${ctx.baseURL}/v1/chat/completions`);
  },
  detect(ctx) {
    if (!existsSync(join(ctx.homeDir, '.workbuddy'))) {
      return { installed: false, detail: '' };
    }
    const file = workbuddyFilePath(ctx);
    if (!existsSync(file)) {
      return {
        installed: true,
        canAuto: true,
        onboarded: false,
        detail: `已安装 WorkBuddy（${file} 尚不存在，接入时会新建）`,
      };
    }
    const parsed = parseJson(readTextOrThrow(file, 'WorkBuddy 自定义模型配置'));
    const shape = workbuddyArrayPointer(parsed);
    if (!shape) {
      return {
        installed: true,
        canAuto: false,
        detail: `${file} 既不是数组也不是 {models:[…]} 形态，为安全起见不自动改`,
        warning: 'models.json 结构不认识：请按 docs/host-integration.md 第 7 节手动追加',
      };
    }
    return {
      installed: true,
      canAuto: true,
      onboarded: workbuddyHasAccessMux(shape.entries),
      detail: `已安装 WorkBuddy，找到 ${file}（现有 ${shape.entries.length} 条模型）`,
    };
  },
  async onboard(ctx) {
    // 自环排除：WorkBuddy 上不注册 workbuddy:*（请求会绕 AccessMux 一圈回到自己）
    const modelIds = ctx.modelIds.filter((m) => !m.startsWith('workbuddy:'));
    if (modelIds.length === 0) {
      throw new OnboardError(
        '没有可注册的模型（workbuddy 自身源的模型在 WorkBuddy 上属自环，已排除）。',
        '先确认桥接源（Trae 等）在 daemon 里在线：curl http://127.0.0.1:8080/v1/models',
      );
    }
    const entries = modelIds.map((id) => ({
      id,
      name: `AccessMux · ${ctx.modelDescriptions?.[id]?.name ?? modelDisplayName(id)}`,
      vendor: 'Custom',
      url: `${ctx.baseURL}/v1/chat/completions`,
      apiKey: 'local',
      supportsToolCall: false,
      supportsImages: false,
      supportsReasoning: false,
      useCustomProtocol: true,
      onlyReasoning: false,
    }));
    const file = workbuddyFilePath(ctx);
    let text: string;
    let pointer: [] | ['models'];
    let created = false;
    let backup: string | null = null;
    if (existsSync(file)) {
      text = readTextOrThrow(file, 'WorkBuddy 自定义模型配置');
      const parsed = parseJson(text);
      const shape = workbuddyArrayPointer(parsed);
      if (!shape) {
        throw new OnboardError(
          `${file} 形态不认识（既非数组也非 {models:[…]}），拒绝写入。文件未做任何修改。`,
        );
      }
      pointer = shape.pointer;
      backup = backupFile(file, { now: ctx.now });
    } else {
      text = '[]';
      pointer = [];
      created = true;
    }
    let edited = text;
    for (const entry of entries) {
      edited = appendToArray(edited, pointer, entry);
    }
    atomicWrite(file, edited, created ? 0o644 : fileMode(file, 0o644));
    return {
      files: [{ path: file, backup, created: created || undefined }],
      summary: `注册 ${entries.length} 个模型（选择器里以 "AccessMux ·" 开头，1 秒内热生效无需重启）`,
    };
  },
  async refresh(ctx) {
    const file = workbuddyFilePath(ctx);
    if (!existsSync(file)) return null;
    const text = readTextOrThrow(file, 'WorkBuddy 自定义模型配置');
    const shape = workbuddyArrayPointer(parseJson(text));
    if (!shape) return null;
    const replacements: Array<{ range: { start: number; end: number }; value: string }> = [];
    shape.entries.forEach((raw, index) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const row = raw as { id?: unknown; name?: unknown; url?: unknown };
      if (typeof row.id !== 'string' || typeof row.name !== 'string' || !row.name.startsWith('AccessMux ·') || row.url !== `${ctx.baseURL}/v1/chat/completions`) return;
      const described = ctx.modelDescriptions?.[row.id]?.name;
      if (!described) return;
      const name = `AccessMux · ${described}`;
      if (name === row.name) return;
      const pointer = shape.pointer.length ? [...shape.pointer, index, 'name'] : [index, 'name'];
      replacements.push({ range: locateValue(text, pointer), value: JSON.stringify(name) });
    });
    if (!replacements.length) return null;
    let edited = text;
    for (const item of replacements.sort((a, b) => b.range.start - a.range.start)) {
      edited = edited.slice(0, item.range.start) + item.value + edited.slice(item.range.end);
    }
    const backup = backupFile(file, { now: ctx.now });
    atomicWrite(file, edited, fileMode(file, 0o644));
    return { files: [{ path: file, backup }], summary: `更新 ${replacements.length} 个 AccessMux 模型显示名（仅改 name 字段）` };
  },
  async smoke(ctx) {
    const model = ctx.modelIds.find((m) => !m.startsWith('workbuddy:')) ?? ctx.modelIds[0];
    if (!model) return { ok: false, detail: '无可用模型' };
    return chatSmoke(ctx, model);
  },
  guideLines() {
    return [
      'WorkBuddy 接法（详见 docs/host-integration.md 第 7 节）：',
      '  往 ~/.workbuddy/models.json 追加条目（数组形态），字段照抄：',
      '  {"id":"<adapterId>:<modelId>","name":"AccessMux · …","vendor":"Custom",',
      '   "url":"http://127.0.0.1:8080/v1/chat/completions","apiKey":"local",',
      '   "supportsToolCall":false,"supportsImages":false,"supportsReasoning":false,',
      '   "useCustomProtocol":true,"onlyReasoning":false}',
    ];
  },
  rollbackLines(result) {
    const file = result?.files[0];
    if (file?.backup) {
      return [`cp "${file.backup}" "${file.path}"`];
    }
    if (file?.created) {
      return [`rm "${file.path}"（该文件是本次接入新建的）`];
    }
    return ['在 WorkBuddy 设置 → 模型管理 里删除 AccessMux · 条目，或从 ~/.workbuddy/models.json 删掉对应条目'];
  },
};

// ---------------------------------------------------------------- DSH

const DSH_PROFILE_PARTS = ['.dsh', 'profiles', 'desktop'];
const DSH_PLUGIN_NAME = 'dsh-accessmux-connect';

function dshProfileDir(ctx: HostContext): string {
  return join(ctx.homeDir, ...DSH_PROFILE_PARTS);
}

function dshPkgPath(ctx: HostContext): string {
  return join(dshProfileDir(ctx), 'package.json');
}

function dshLinkPath(ctx: HostContext): string {
  return join(dshProfileDir(ctx), 'node_modules', DSH_PLUGIN_NAME);
}

function dshPluginDir(ctx: HostContext): string {
  return join(ctx.repoRoot, 'integrations', DSH_PLUGIN_NAME);
}

function dshBundlesHas(pkg: unknown): boolean {
  const bundles =
    (pkg as { dsh?: { profile?: { bundles?: unknown } } } | null)?.dsh?.profile?.bundles;
  return Array.isArray(bundles) && bundles.includes(DSH_PLUGIN_NAME);
}

const dshHost: HostDef = {
  id: 'dsh',
  name: 'DeepSeek Harness（DSH）',
  kind: 'auto',
  detect(ctx) {
    if (!existsSync(dshProfileDir(ctx))) {
      return { installed: false, detail: '' };
    }
    const pkgPath = dshPkgPath(ctx);
    if (!existsSync(pkgPath)) {
      return {
        installed: true,
        canAuto: false,
        detail: '已安装 DSH，但 ~/.dsh/profiles/desktop/package.json 不存在，无法自动装插件',
      };
    }
    const pkg = parseJson(readTextOrThrow(pkgPath, 'DSH profile package.json'));
    const inBundles = dshBundlesHas(pkg);
    const linked = existsSync(dshLinkPath(ctx));
    if (inBundles && linked) {
      return { installed: true, canAuto: true, onboarded: true, detail: '已安装 DSH，AccessMux 插件已在位' };
    }
    if (inBundles !== linked) {
      return {
        installed: true,
        canAuto: false,
        detail: '已安装 DSH，但插件安装状态不一致（bundles 与 node_modules 只有一半）',
        warning:
          '建议先在 DSH 设置 → 插件里确认 dsh-accessmux-connect 状态（装/卸载一次），再跑 onboard',
      };
    }
    return { installed: true, canAuto: true, onboarded: false, detail: '已安装 DSH，可以装 AccessMux 插件' };
  },
  async onboard(ctx) {
    const pluginDir = dshPluginDir(ctx);
    if (!existsSync(join(pluginDir, 'package.json'))) {
      throw new OnboardError(
        `AccessMux 的 DSH 插件源码不在预期位置：${pluginDir}`,
        '请在 AccessMux 仓库目录里运行 onboard（插件随仓库分发）。',
      );
    }
    const pkgPath = dshPkgPath(ctx);
    const text = readTextOrThrow(pkgPath, 'DSH profile package.json');
    parseJson(text);
    let edited = appendToArray(text, ['dsh', 'profile', 'bundles'], DSH_PLUGIN_NAME);
    edited = appendToObject(edited, ['dependencies'], DSH_PLUGIN_NAME, `link:${pluginDir}`);
    const backup = backupFile(pkgPath, { now: ctx.now });
    atomicWrite(pkgPath, edited, fileMode(pkgPath, 0o644));
    // node_modules symlink（复刻 dshmarket link 安装形态）
    const linkPath = dshLinkPath(ctx);
    mkdirSync(join(dshProfileDir(ctx), 'node_modules'), { recursive: true });
    if (!existsSync(linkPath)) {
      symlinkSync(pluginDir, linkPath, 'dir');
    }
    return {
      files: [
        { path: pkgPath, backup },
        { path: linkPath, backup: null, created: true },
      ],
      summary: `安装插件 ${DSH_PLUGIN_NAME}（link 安装；完全退出 DSH ⌘Q 后重开生效）`,
    };
  },
  async smoke(ctx) {
    const model = ctx.modelIds[0];
    if (!model) return { ok: false, detail: '无可用模型' };
    const r = await chatSmoke(ctx, model);
    return {
      ...r,
      detail: `${r.detail}（DSH 插件本身需重启 DSH 后在模型选择器里确认 AccessMux 组）`,
    };
  },
  guideLines(ctx) {
    return [
      'DSH 手动接法（详见 docs/host-integration.md 第 5 节）：',
      '  1. 完全退出 DSH（⌘Q）。',
      '  2. 重开 DSH → 设置 → 插件 →「添加插件」→ 本地目录路径，粘贴：',
      `     ${dshPluginDir(ctx)}`,
      '  3. 重启 DSH，模型选择器出现 AccessMux 组。',
    ];
  },
  rollbackLines(result) {
    const pkg = result?.files.find((f) => f.path.endsWith('package.json'));
    const link = result?.files.find((f) => f.created);
    const lines: string[] = [];
    if (pkg?.backup) lines.push(`cp "${pkg.backup}" "${pkg.path}"`);
    if (link) lines.push(`rm "${link.path}"`);
    if (lines.length === 0) {
      lines.push(
        '从 ~/.dsh/profiles/desktop/package.json 删掉 bundles 和 dependencies 里的 dsh-accessmux-connect 两处，再删 node_modules/dsh-accessmux-connect',
      );
    }
    return lines;
  },
};

// ---------------------------------------------------------------- 指引型宿主（环境变量 / 手改配置）

/**
 * 指引文案里的示例模型名：探针就绪时用真实 id；拿不到（daemon 没起 / 探针未就绪）
 * 时显示 `[探测中]`，绝不打印看起来可以照抄的裸占位 `<adapterId>:<modelId>`（T024）。
 */
function firstModelOrPlaceholder(ctx: HostContext): string {
  return ctx.modelIds[0] ?? '[探测中]';
}

const claudeCodeHost: HostDef = {
  id: 'claude-code',
  name: 'Claude Code',
  kind: 'guide',
  detect(ctx) {
    const installed = existsSync(join(ctx.homeDir, '.claude'));
    return { installed, detail: installed ? '已安装 Claude Code' : '' };
  },
  guideLines(ctx) {
    const model = firstModelOrPlaceholder(ctx);
    return [
      'Claude Code 接法：在 ~/.zshrc（或启动前）加三行环境变量——',
      `  export ANTHROPIC_BASE_URL="${ctx.baseURL}"`,
      '  export ANTHROPIC_AUTH_TOKEN="local"        # 任意非空，本地服务不校验',
      `  export ANTHROPIC_MODEL="${model}"          # 完整清单：curl ${ctx.baseURL}/v1/models`,
      '  然后新开终端运行 claude。（onboard 不自动改 shell 配置文件。）',
    ];
  },
};

const codexHost: HostDef = {
  id: 'codex',
  name: 'Codex CLI',
  kind: 'guide',
  detect(ctx) {
    const installed = existsSync(join(ctx.homeDir, '.codex'));
    return { installed, detail: installed ? '已安装 Codex CLI' : '' };
  },
  guideLines(ctx) {
    const model = firstModelOrPlaceholder(ctx);
    return [
      'Codex CLI 接法：编辑 ~/.codex/config.toml——',
      '  model_provider = "accessmux"     # 顶层键，须放在文件里第一个 [表头] 之前',
      '  [model_providers.accessmux]',
      `  base_url = "${ctx.baseURL}/v1"`,
      '  api_key = "local"',
      `  启动：codex --model "${model}"（完整清单：curl ${ctx.baseURL}/v1/models）`,
      '（TOML 顶层键位置有讲究，onboard 暂不自动改这个文件。）',
    ];
  },
};

/** Hermes 这类无稳定注册面特征的宿主：只做检测 + 通用接法指引 */
const hermesHost: HostDef = {
  id: 'hermes',
  name: 'Hermes',
  kind: 'guide',
  detect(ctx) {
    const installed = existsSync(join(ctx.homeDir, '.hermes'));
    return { installed, detail: installed ? '已安装 Hermes' : '' };
  },
  guideLines(ctx) {
    const model = firstModelOrPlaceholder(ctx);
    return [
      'Hermes 接法（具体字段名以 Hermes 官方文档为准）：把 Base URL 指到本地服务，',
      `  OpenAI 兼容形态：OPENAI_BASE_URL=${ctx.baseURL}/v1、OPENAI_API_KEY=local、`,
      `  OPENAI_MODEL=${model}`,
      '（配置入口在各版本 Hermes 里不完全一致，onboard 不自动改。）',
    ];
  },
};

// ---------------------------------------------------------------- Trae / Qoder（T037 登记）

/**
 * Trae / Qoder 的自定义模型接入面（T037 探测，2026-10-03）：
 * - Trae（TRAE SOLO CN / Trae IDE 同一产品族、同一入口）：设置 → 模型 → 模型管理 →
 *   「添加模型...」→ 选预设服务商或「自定义模型」→ 填 API 格式 / 请求地址 / 模型 ID /
 *   API 密钥。依据：官方文档 docs.trae.ai「内置模型 & 自定义模型」；本机客户端 NLS 含
 *   「添加模型...」「模型管理编辑器」，extensions/ai-completion/resource/aiserver/server.js
 *   内含「不允许添加自定义模型。请联系管理员。」（入口存在，可能受租户策略限制）。
 * - Qoder（Qoder CN 桌面版 / Qoder IDE / Qoder CLI 同一入口）：设置 → 模型 →「+ 添加」→
 *   预设供应商或「自定义 Base URL」。依据：官方文档 docs.qoder.com/zh/qoder/custom-models
 *   与 docs.qoder.cn/qoder/custom-models。
 * 两者当前都只有"支持面"证据，**连通性未真机复核**：故按 guide 型登记（只检测 + 给指引，
 * 不自动写宿主配置），T037 真机连通通过后再决定是否升级为 auto 型（亮标铁律：实测过才亮）。
 */
const TRAE_DATA_DIRS = ['.trae', '.trae-cn'] as const;
const QODER_DATA_DIRS = ['.qoder-cn', '.qoder'] as const;

function firstExistingDir(homeDir: string, names: readonly string[]): string | null {
  for (const name of names) {
    const path = join(homeDir, name);
    if (existsSync(path)) return path;
  }
  return null;
}

/** Trae / Qoder 共用的填写项说明（Base URL / API Key / 模型名） */
function customModelFieldLines(ctx: HostContext): string[] {
  const model = firstModelOrPlaceholder(ctx);
  return [
    `  请求地址（Base URL）填 ${ctx.baseURL}/v1（OpenAI 兼容）；若该字段要完整端点，`,
    `  填 ${ctx.baseURL}/v1/chat/completions。API 密钥填任意非空值（如 local，本地服务不校验）。`,
    `  模型 ID / 模型名填 ${model}（完整清单：curl ${ctx.baseURL}/v1/models）。`,
  ];
}

const traeHost: HostDef = {
  id: 'trae',
  name: 'Trae',
  kind: 'guide',
  detect(ctx) {
    const dir = firstExistingDir(ctx.homeDir, TRAE_DATA_DIRS);
    return dir === null
      ? { installed: false, detail: '' }
      : { installed: true, detail: `已安装 Trae（数据目录 ${dir}）` };
  },
  guideLines(ctx) {
    return [
      'Trae 接法（TRAE SOLO CN / Trae IDE 同一入口；接入面依据官方文档，连通性待真机复核）：',
      '  设置 → 模型 → 模型管理 →「添加模型...」→ 选「自定义模型」→',
      ...customModelFieldLines(ctx),
      '  保存后回到对话，在模型选择器里选刚添加的模型即可。',
      '（onboard 不自动改 Trae 的配置。）',
    ];
  },
};

const qoderHost: HostDef = {
  id: 'qoder',
  name: 'Qoder',
  kind: 'guide',
  detect(ctx) {
    const dir = firstExistingDir(ctx.homeDir, QODER_DATA_DIRS);
    return dir === null
      ? { installed: false, detail: '' }
      : { installed: true, detail: `已安装 Qoder（数据目录 ${dir}）` };
  },
  guideLines(ctx) {
    return [
      'Qoder 接法（Qoder CN 桌面版 / Qoder IDE 同一入口；接入面依据官方文档，连通性待真机复核）：',
      '  设置 → 模型 →「+ 添加」→ 选「自定义 Base URL」→',
      ...customModelFieldLines(ctx),
      '  保存后回到对话，在模型选择器里选刚添加的模型即可。',
      '（onboard 不自动改 Qoder 的配置。）',
    ];
  },
};

/** 全部宿主清单（auto 型在前，体验上先解决可自动接入的） */
export function allHosts(): HostDef[] {
  return [
    zcodeHost,
    workbuddyHost,
    dshHost,
    claudeCodeHost,
    codexHost,
    hermesHost,
    traeHost,
    qoderHost,
  ];
}
