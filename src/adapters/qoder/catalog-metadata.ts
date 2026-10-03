import { abortable } from '../../util/abort.js';
// 只读本地元数据 + 官方活动页 GET。不碰 auth 原值，不 exchange、不 claim、不推理。
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ModelInfo, MetadataSource, TokenLimit } from '../../types.js';
import { positiveTokens, source, tokenLimit } from './catalog-specs.js';
import { fetchQoderCampaigns } from '../../checkin/qoder.js';

export type QoderModelMetadata = Omit<Partial<ModelInfo>, 'id' | 'provider' | 'tags'>;
export type QoderMetadataMap = Record<string, QoderModelMetadata>;
export interface QoderMetadataDeps {
  signal?: AbortSignal;
  homeDir?: string;
  /** 测试/嵌入调用可给明确文件列表；不读取整个 HOME。 */
  textFiles?: string[];
  runtimeFiles?: string[];
  settingsFile?: string | null;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  /** 已在进程内取得的 token；不自动用 PAT 发认证 POST。 */
  campaignToken?: () => string | undefined;
  fetchCampaignMetadata?: (token: string, signal?: AbortSignal) => Promise<unknown>;
  publicOffer?: boolean;
}
function object(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
}
function text(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
}

/** 日志可能在 JSON 前后带前缀；只解析完整 JSON 对象，不截取凭据文本。 */
function objects(line: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let start = -1; let depth = 0; let quoted = false; let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (start === -1) { if (c === '{') { start = i; depth = 1; } continue; }
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '{') depth++;
    if (c === '}' && --depth === 0) {
      try { const v = object(JSON.parse(line.slice(start, i + 1))); if (v) out.push(v); } catch { /* 非 JSON 日志片段忽略。 */ }
      start = -1;
    }
  }
  return out;
}

/** 仅向外返回模型元数据；session ID 只在本函数内用于关联字段。 */
export function parseQoderRuntimeFiles(files: Array<{ reference: string; contents: string; updatedAt: string }>, aliases: Record<string, string> = {}): QoderMetadataMap {
  const sessions = new Map<string, string>();
  const observations: Array<{ row: Record<string, unknown>; origin: MetadataSource; session?: string; model?: string }> = [];
  for (const file of files) {
    let fileModel: string | undefined;
    for (const line of file.contents.split('\n')) {
      const timestamp = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/)?.[0] ?? file.updatedAt;
      const visit = (raw: unknown, inherited?: string, session?: string, depth = 0): void => {
        if (depth > 10) return;
        if (typeof raw === 'string' && raw.startsWith('{')) { try { visit(JSON.parse(raw), inherited, session, depth + 1); } catch { /* 不回显原文。 */ } return; }
        const row = object(raw); if (!row) return;
        const sid = text(row['sessionId']) ?? text(row['session_id']) ?? session;
        const config = object(row['model_config']) ?? object(row['modelConfig']);
        const key = text(config?.['key']) ?? text(row['modelKey']) ?? text(row['key']);
        const rawModel = text(config?.['display_name']) ?? text(row['display_name']) ?? (key ? aliases[key] : undefined) ?? text(row['model']) ?? inherited;
        const model = rawModel ? aliases[rawModel] ?? rawModel : undefined;
        if (model && sid) sessions.set(sid, model);
        if (model) fileModel = model;
        if (positiveTokens(row['contextWindow']) !== undefined || positiveTokens(row['max_input_tokens']) !== undefined || typeof row['creditMultiplier'] === 'number') {
          observations.push({ row, origin: source(file.reference, '', timestamp, 'cn'), ...(sid ? { session: sid } : {}), ...(model ?? (!sid ? fileModel : undefined) ? { model: model ?? fileModel } : {}) });
        }
        for (const [k, value] of Object.entries(row)) {
          if (k === 'messages' || k === 'content' || k === 'prompt' || /token|auth|secret|credential/i.test(k) && k !== 'max_input_tokens') continue;
          if (Array.isArray(value)) { for (const v of value) visit(v, model, sid, depth + 1); }
          else if (typeof value === 'object' || k === 'model_config') visit(value, model, sid, depth + 1);
        }
      };
      for (const row of objects(line)) visit(row);
    }
  }
  const result: QoderMetadataMap = {};
  function set(model: string, field: 'minCtx' | 'maxInput', value: unknown, origin: MetadataSource): void {
    const limit = tokenLimit(value, origin); if (!limit) return;
    const entry = result[model] ??= {}; const previous = entry[field] as TokenLimit | undefined;
    if (!previous || Date.parse(limit.source.updated_at) >= Date.parse(previous.source.updated_at)) entry[field] = limit;
  }
  for (const observation of observations) {
    const model = observation.model ?? (observation.session ? sessions.get(observation.session) : undefined);
    if (!model) continue;
    set(model, 'minCtx', observation.row['contextWindow'], { ...observation.origin, field: 'contextWindow' });
    set(model, 'maxInput', observation.row['max_input_tokens'], { ...observation.origin, field: 'model_config.max_input_tokens' });
    const rate = observation.row['creditMultiplier'];
    if (typeof rate === 'number' && Number.isFinite(rate) && rate >= 0) {
      const entry = result[model] ??= {};
      const previous = typeof entry.priceMultiplier === 'object' ? entry.priceMultiplier : undefined;
      if (!previous || Date.parse(observation.origin.updated_at) >= Date.parse(previous.updated_at)) {
        const origin = { ...observation.origin, field: 'creditMultiplier' };
        entry.priceMultiplier = { value: rate, current: true, updated_at: origin.updated_at, source: origin };
        entry.free = rate === 0; entry.freeSource = origin;
        entry.feeFreshness = 'stale';
      }
    }
  }
  return result;
}

export function parseQoderTextCache(raw: unknown, updatedAt: string): { aliases: Record<string, string>; models: QoderMetadataMap } {
  const root = object(raw) ?? {};
  const content = object(root['content']) ?? object(root['locales']) ?? root;
  const locale = object(content['zh']) ?? object(content['zh-CN']) ?? object(content['en']) ?? content;
  const aliases: Record<string, string> = {}; const models: QoderMetadataMap = {};
  for (const [key, value] of Object.entries(locale)) {
    const match = /^modelSelector\.item\.([^.]+)$/.exec(key);
    if (match && text(value)) aliases[match[1]!] = text(value)!;
  }
  for (const [key, id] of Object.entries(aliases)) {
    const description = text(locale[`modelSelector.item.${key}.description`]) ?? text(locale[`modelSelector.item.${key}.markdownDescription`]);
    if (!description) continue;
    const entry: QoderModelMetadata = { description: Array.from(description.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')).slice(0, 180).join('') };
    const context = /\b(\d+(?:\.\d+)?)\s*([MK])\s*(?:token[s]?\s*)?(?:上下文|context)/i.exec(description);
    if (context) entry.minCtx = tokenLimit(Number(context[1]) * (context[2]!.toUpperCase() === 'M' ? 1_000_000 : 1_000), source('qoder:dynamic-text-cache', `modelSelector.item.${key}.markdownDescription.context`, updatedAt, 'cn'));
    models[id] = entry;
  }
  return { aliases, models };
}

/** 模型参数缓存只挑 token 窗口，第三方 provider 的 key/headers 完全不返回。 */
export function parseQoderSettings(raw: unknown, aliases: Record<string, string>, updatedAt: string): QoderMetadataMap {
  const root = object(raw) ?? {}; const result: QoderMetadataMap = {};
  const preferences = object(object(root['model'])?.['preferences']) ?? {};
  for (const [key, rawPreference] of Object.entries(preferences)) {
    const value = object(rawPreference)?.['contextWindow']; const id = aliases[key];
    const limit = tokenLimit(value, source('qoder:settings/model-policy', `model.preferences.${key}.contextWindow`, updatedAt, 'cn'));
    if (id && limit) result[id] = { minCtx: limit };
  }
  const providers = object(root['providers']) ?? {};
  for (const [provider, rawProvider] of Object.entries(providers)) {
    const rows = object(rawProvider)?.['models']; if (!Array.isArray(rows)) continue;
    for (const rawModel of rows) {
      const row = object(rawModel); const id = text(row?.['model']) ?? text(row?.['id']);
      const limit = tokenLimit(row?.['contextWindow'], source('qoder:settings/custom-model', 'providers.models.contextWindow', updatedAt));
      if (id && limit) result[`${provider}/${id}`] = { minCtx: limit };
    }
  }
  return result;
}

/** 活动页当前文案解析；没有明确的延期/进行中证据就不给免费标。 */
export function parseQoderFlashOffer(contents: string, updatedAt: string): QoderModelMetadata {
  const plain = contents.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<[^>]*>/g, ' ').replace(/[*_`]/g, '').replace(/\s+/g, ' ');
  if (!/Qwen3\.8-Flash/i.test(plain)) return {};
  const rate = /计费系数(?:由\s*[\d.]+[×x]\s*降至|\s*[:：]\s*)\s*([\d.]+)[×x]/i.exec(plain);
  const value = rate ? Number(rate[1]) : undefined;
  if (/(?:本次|当前|免费)活动(?:已结束|已终止)|已恢复(?:原价|计费)/.test(plain)) {
    const origin = source('https://docs.qoder.cn/events/flashoffer', 'currentOffer', updatedAt, 'cn');
    return { free: false, freeSource: origin, feeFreshness: 'fresh', feeCheckedAt: updatedAt,
      ...(value !== undefined && Number.isFinite(value) && value >= 0 ? { priceMultiplier: { value, current: true, updated_at: updatedAt, source: origin } } : {}),
    };
  }
  if (!/(?:继续免费|免费期现已延长|活动正在进行)/.test(plain)) return {};
  const origin = { ...source('https://docs.qoder.cn/events/flashoffer', 'currentOffer', updatedAt, 'cn'), entitlement: 'personal' };
  const start = /(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})\s*起/.exec(plain);
  const end = /(?:有效期至|截止到|截止日期)\s*(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*(\d{1,2}):(\d{2})/.exec(plain);
  const startsAt = start ? `${start[1]}-${start[2]!.padStart(2, '0')}-${start[3]!.padStart(2, '0')}T${start[4]!.padStart(2, '0')}:${start[5]}:00+08:00` : undefined;
  const endsAt = end ? `${end[1]}-${end[2]!.padStart(2, '0')}-${end[3]!.padStart(2, '0')}T${end[4]!.padStart(2, '0')}:${end[5]}:00+08:00` : undefined;
  const observed = Date.parse(updatedAt);
  // 时限只降为 stale，不把免费翻译成收费；未来活动尚未开始时不给免费结论。
  if (startsAt && Number.isFinite(observed) && Date.parse(startsAt) > observed) return {};
  const expired = endsAt !== undefined && Number.isFinite(observed) && Date.parse(endsAt) <= observed;
  const activity = { label: '限时免费', region: 'cn', entitlement: 'personal', timezone: 'Asia/Shanghai',
    ...(startsAt ? { starts_at: startsAt } : {}),
    ...(endsAt ? { ends_at: endsAt } : {}),
  };
  return { free: true, freeSource: origin, freeActivity: activity, feeFreshness: expired ? 'stale' : 'fresh', feeCheckedAt: updatedAt, activityLabels: ['限时免费'],
    ...(value !== undefined && Number.isFinite(value) && value >= 0 ? { priceMultiplier: { value, current: !expired, updated_at: updatedAt, source: origin, activity } } : {}),
  };
}

async function logFiles(root: string, filename: string, limit: number): Promise<string[]> {
  try { const dirs = await readdir(root, { withFileTypes: true }); const files = await Promise.all(dirs.filter((d) => d.isDirectory()).map(async (d) => { const path = join(root, d.name, filename); try { return { path, at: (await stat(path)).mtimeMs }; } catch { return undefined; } })); return files.filter((v): v is { path: string; at: number } => v !== undefined).sort((a, b) => b.at - a.at).slice(0, limit).map((v) => v.path); } catch { return []; }
}

export async function collectQoderMetadata(deps: QoderMetadataDeps = {}): Promise<QoderMetadataMap> {
  deps.signal?.throwIfAborted();
  const home = deps.homeDir ?? homedir(); const now = deps.now?.() ?? new Date();
  const texts = deps.textFiles ?? [join(home, 'Library/Application Support/QoderCN/User/dynamic-text-cache.json'), join(home, '.qoder-cn/.auth/dynamic-texts.json')];
  const aliases: Record<string, string> = {}; const result: QoderMetadataMap = {};
  for (const file of texts) {
    try { const [contents, info] = await Promise.all([readFile(file, { encoding: 'utf8', signal: deps.signal }), stat(file)]); const parsed = parseQoderTextCache(JSON.parse(contents), info.mtime.toISOString()); Object.assign(aliases, parsed.aliases); for (const [id, metadata] of Object.entries(parsed.models)) result[id] = { ...result[id], ...metadata }; } catch { /* 缺缓存可用官方规格。 */ }
  }
  const files = deps.runtimeFiles ?? [...await logFiles(join(home, '.qoder-cn/logs/runs'), 'qodercli.log', 30), ...await logFiles(join(home, 'Library/Application Support/com.qodercn.app.stable/logs'), 'main.log', 10)];
  const logs = await Promise.all(files.map(async (file) => { try { const info = await stat(file); if (info.size > 8_000_000) return undefined; return { reference: file.endsWith('main.log') ? 'qoder:runtime/model-policy' : 'qoder:runtime/model-config', contents: await readFile(file, { encoding: 'utf8', signal: deps.signal }), updatedAt: info.mtime.toISOString() }; } catch { return undefined; } }));
  const runtime = parseQoderRuntimeFiles(logs.filter((v): v is NonNullable<typeof v> => v !== undefined), aliases);
  for (const [id, metadata] of Object.entries(runtime)) result[id] = { ...result[id], ...metadata };
  const settingsFile = deps.settingsFile === undefined ? join(home, '.qoder-cn/settings.json') : deps.settingsFile;
  if (settingsFile) {
    try {
      const [contents, info] = await Promise.all([readFile(settingsFile, { encoding: 'utf8', signal: deps.signal }), stat(settingsFile)]);
      const settings = parseQoderSettings(JSON.parse(contents), aliases, info.mtime.toISOString());
      for (const [id, fields] of Object.entries(settings)) {
        const old = result[id]?.minCtx; const fresh = fields.minCtx;
        if (typeof fresh === 'object' && (typeof old !== 'object' || Date.parse(fresh.source.updated_at) >= Date.parse(old.source.updated_at))) result[id] = { ...result[id], ...fields };
      }
    } catch { /* 参数缓存缺失不影响其它来源。 */ }
  }
  deps.signal?.throwIfAborted();
  if (deps.publicOffer !== false) {
    const signal = deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000);
    try {
      const response = await abortable((deps.fetchImpl ?? fetch)('https://docs.qoder.cn/events/flashoffer.md', { method: 'GET', signal }), signal);
      if (response.ok) {
        const parsed = parseQoderFlashOffer(await abortable(response.text(), signal), now.toISOString());
        result['Qwen3.8-Flash'] = { ...result['Qwen3.8-Flash'], ...parsed,
          ...(Object.keys(parsed).length === 0 ? { feeFreshness: 'unknown' as const, feeCheckedAt: now.toISOString() } : {}),
        };
      }
    } catch { /* 保留旧证据并在 adapter 合并层标待更新。 */ }
  }
  deps.signal?.throwIfAborted();
  const token = deps.campaignToken?.();
  if (token) {
    try { const payload = object(deps.fetchCampaignMetadata ? await abortable(deps.fetchCampaignMetadata(token, deps.signal), deps.signal) : { campaigns: await abortable(fetchQoderCampaigns(token, { fetchImpl: (input, init) => {
        deps.signal?.throwIfAborted();
        const signal = deps.signal ? AbortSignal.any([deps.signal, ...(init?.signal ? [init.signal] : [])]) : init?.signal;
        return (deps.fetchImpl ?? fetch)(input, { ...init, signal });
      } }), deps.signal) }); const campaigns = Array.isArray(payload?.['campaigns']) ? payload['campaigns'] : [];
      for (const raw of campaigns) {
        const row = object(raw); if (!row || row['active'] !== true || !Array.isArray(row['modelIds'])) continue;
        const until = typeof row['endTime'] === 'string' ? Date.parse(row['endTime']) : undefined;
        const start = typeof row['startTime'] === 'string' ? Date.parse(row['startTime']) : undefined;
        if (until !== undefined && (!Number.isFinite(until) || now.getTime() >= until) || start !== undefined && (!Number.isFinite(start) || now.getTime() < start)) continue;
        const value = row['creditMultiplier']; if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) continue;
        const origin = source('qoder:/sash/api/v1/me/campaigns', 'campaigns.creditMultiplier', now.toISOString(), 'cn');
        for (const id of row['modelIds']) { if (typeof id !== 'string') continue; result[aliases[id] ?? id] = { ...result[aliases[id] ?? id], priceMultiplier: { value, current: true, updated_at: now.toISOString(), source: origin }, free: value === 0, freeSource: origin, feeFreshness: 'fresh', feeCheckedAt: now.toISOString() }; }
      }
    } catch { /* 只读 token 不可用就跳过，绝不自动 exchange。 */ }
  }
  deps.signal?.throwIfAborted();
  return result;
}
