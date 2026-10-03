import { accessMuxWordmark, appBrandIcon, localAppIconFamily, modelBrandIcon } from './brand-assets.js';
import { buildOnboardPrompt } from './onboard-prompt.js';
import { formatModelActivity } from './activity-presentation.js';
import { bindSwitch, syncSwitch } from './toggle.js';
import type { ModelActivity, PriceMultiplier, TokenLimit } from '../../types.js';

export {};

type AuthState = 'logged-in' | 'logged-out' | 'unknown';
interface Model {
  id: string; name?: string; provider?: string; tags?: string[]; minCtx?: number | TokenLimit;
  maxInput?: TokenLimit; officialContext?: TokenLimit; callVerified?: boolean;
  priceMultiplier?: number | PriceMultiplier; free?: boolean; priceScope?: 'model' | 'entitlement';
  feeFreshness?: 'fresh' | 'stale' | 'failed' | 'unknown'; feeCheckedAt?: string;
  activityLabels?: string[]; activities?: ModelActivity[]; description?: string; iconUrl?: string;
  reasoning?: { supported?: boolean; supportedEfforts?: string[]; canDisableThinking?: boolean };
  inputModalities?: Array<'text' | 'image'>;
  bridgeInputModalities?: Array<'text' | 'image'>;
}
interface AdapterInfo {
  id: string; displayName: string; auth: AuthState; availability: string; models: Model[];
  quota?: 'ok' | 'exhausted' | 'unknown'; quotaMessage?: string;
  form?: 'direct' | 'app-server' | 'unavailable'; reason?: string; fallbackAvailable?: boolean; tools?: 'disabled';
  sourceState?: 'not-installed' | 'logged-out' | 'disabled' | 'environment-disabled' | 'probing' | 'failed' | 'ready' | 'unconfirmed';
  sourceMessage?: string; nextAction?: string; directoryReady?: boolean; checkedAt?: string;
  catalogSource?: 'current' | 'cache' | 'fallback'; historyModels?: Model[];
}
interface Config {
  version: 1; output: { port: number; host: string; protocol: 'openai'; exposeAnthropic: boolean };
  adapters: Record<string, { enabled: boolean }>;
  models: { allow: Record<string, Record<string, boolean>> };
  checkin?: { sources?: { workbuddy?: boolean; qoder?: boolean; zcode?: boolean } };
}
interface HostInfo { id: string; name: string; kind: 'auto' | 'guide'; status: 'onboarded' | 'not-onboarded' | 'unknown'; statusLabel: string; message?: string }
interface CheckinInfo { source: string; name: string; supported: boolean; enabled: boolean; status: string; message: string; checkedAt?: string }
interface StateResponse { config: Config; adapters: AdapterInfo[]; hosts: HostInfo[]; checkin: { sources: CheckinInfo[] }; configExists?: boolean; configPath?: string }
type ConfigPatch = { output?: { port?: number; exposeAnthropic?: boolean }; adapters?: Record<string, { enabled: boolean }>; models?: { allow: Record<string, Record<string, boolean>> }; checkin?: { sources: Record<string, boolean> } };
const $ = <T extends HTMLElement = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`UI 元素不存在：${selector}`);
  return element as T;
};
const escapeHtml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
let state: StateResponse | undefined;
let configPath = '';
let saving = false;
let refreshing = false;
let checkinTimer: ReturnType<typeof setInterval> | undefined;
async function api<T>(url: string, payload?: unknown): Promise<T> {
  const response = await fetch(url, { ...(payload === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }), signal: AbortSignal.timeout(60_000) });
  const body = await response.json() as T & { error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? `请求失败（${response.status}）`);
  return body;
}
function setStatus(message: string, kind = ''): void { $('#save-status').textContent = message; $('#save-status').className = `status ${kind}`; }
function authLabel(auth: AuthState): string { return auth === 'logged-in' ? '已登录' : auth === 'logged-out' ? '未登录' : '登录态未确认'; }
export function wireLocalImages(root: ParentNode): void {
  root.querySelectorAll<HTMLImageElement>('img[src^="/ui/app-icons/"]').forEach((image) => {
    if (image.dataset.errorBound === 'true') return;
    image.dataset.errorBound = 'true';
    const fallback = image.dataset.iconFallback;
    const handleError = () => {
      if (fallback) {
        const holder = image.closest('.app-icon, .source-icon');
        if (holder) holder.innerHTML = fallback.replace(/&quot;/g, '"');
      } else {
        image.hidden = true;
        image.closest('.app-icon, .source-icon')?.classList.add('icon-empty');
      }
    };
    image.addEventListener('error', handleError, { once: true });
    if (image.complete && image.naturalWidth === 0) handleError();
  });
}
function sourceEnabled(id: string): boolean { return state?.config.adapters[id]?.enabled ?? true; }
function modelEnabled(adapter: string, model: string): boolean { return state?.config.models.allow[adapter]?.[model] ?? true; }
function checked(value: boolean): string { return value ? 'checked' : ''; }
function switchMarkup(value: boolean, label: string, attrs: string): string { return `<label class="switch-control"><input type="checkbox" data-config-control ${attrs} role="switch" aria-label="${escapeHtml(label)}" aria-checked="${value}" ${checked(value)} ${saving ? 'disabled' : ''}><span class="switch-track" aria-hidden="true"><span class="switch-thumb"></span></span></label>`; }
function iconFamilyClass(id: string): string { const family = localAppIconFamily(id); return family ? ` family-icon family-icon-${family}` : ''; }
function iconFamilyData(id: string): string { const family = localAppIconFamily(id); return family ? ` data-icon-family="${escapeHtml(family)}"` : ''; }
function setSaveBusy(busy: boolean): void { saving = busy; document.querySelectorAll<HTMLInputElement | HTMLButtonElement>('[data-config-control], #save-btn, #reset-btn, #wizard-finish').forEach((element) => { element.disabled = busy; }); }
function renderHosts(): void {
  const hosts = state?.hosts ?? [];
  $('#hosts-list').innerHTML = hosts.length === 0 ? '<p class="empty">未检测到支持的宿主。任何能自定义 Base URL 的应用都可以手动接入。</p>' : hosts.map((host) => {
    const icon = appBrandIcon(host.id);
    const displayName = host.id === 'dsh' ? 'DeepSeek Harness' : host.name;
    const message = host.message === '未确认：此宿主的接入状态暂不能确定' ? '' : host.message;
    return `<article class="host-card"><div class="host-card-main">${icon ? `<span class="app-icon${iconFamilyClass(host.id)}"${iconFamilyData(host.id)}>${icon}</span>` : ''}<div class="host-card-copy"><h3>${escapeHtml(displayName)}</h3><span class="pill ${host.status === 'onboarded' ? 'good' : host.status === 'unknown' ? 'warning' : ''}" title="${message ? escapeHtml(message) : ''}">${host.status === 'unknown' ? '未确认' : escapeHtml(host.statusLabel)}</span></div></div>${message ? `<p class="hint host-card-message">${escapeHtml(message)}</p>` : ''}</article>`;
  }).join('');
  wireLocalImages($('#hosts-list'));
}
function renderSourceStatuses(): void {
  if (!state) return;
  const cards = state.adapters.map((adapter) => {
    const environmentDisabled = adapter.sourceState === 'environment-disabled';
    const enabled = sourceEnabled(adapter.id);
    const stateText: Record<string, string> = {
      'not-installed': '未安装', 'logged-out': '未登录', disabled: '配置已关闭',
      'environment-disabled': '环境已禁用', probing: '探测中', failed: '未更新',
      ready: '目录就绪', unconfirmed: '未确认',
    };
    const tone = adapter.sourceState === 'ready' ? 'good' : adapter.sourceState === 'failed' ? 'error' : adapter.sourceState === 'disabled' || environmentDisabled ? 'muted' : 'warning';
    const stamp = adapter.checkedAt ? `检查于 ${formatTime(adapter.checkedAt)}` : '';
    const feeCounts = adapter.models.reduce((counts, model) => { counts[model.feeFreshness ?? 'unknown']++; return counts; }, { fresh: 0, stale: 0, failed: 0, unknown: 0 });
    const feeSummary = adapter.models.length === 0 ? '' : feeCounts.failed > 0 ? `更新失败 ${feeCounts.failed} 个；上次值已保留` : feeCounts.stale > 0 ? `${feeCounts.stale} 个模型待更新` : feeCounts.unknown === adapter.models.length ? '未确认' : feeCounts.unknown > 0 ? `${feeCounts.fresh} 个已确认 · ${feeCounts.unknown} 个未确认` : '已取得新证据';
    const feeTime = adapter.models.map((model) => model.feeCheckedAt).filter((value): value is string => Boolean(value)).sort().at(-1);
    return `<article class="source-status-card ${tone}" data-source-status="${escapeHtml(adapter.id)}"><div class="source-status-heading"><span class="source-icon${appBrandIcon(adapter.id) ? '' : ' icon-empty'}${iconFamilyClass(adapter.id)}"${iconFamilyData(adapter.id)} aria-hidden="true">${appBrandIcon(adapter.id)}</span><div><h3>${escapeHtml(adapter.displayName)}</h3><span class="pill ${tone}">${stateText[adapter.sourceState ?? 'unconfirmed'] ?? '未确认'}</span></div><label class="source-toggle-label">启用此源</label>${switchMarkup(enabled, `启用 ${adapter.displayName}`, `data-adapter-id="${escapeHtml(adapter.id)}" data-role="adapter-enabled" ${environmentDisabled ? 'disabled' : ''}`)}</div><p>${escapeHtml(adapter.sourceMessage ?? '源状态未确认')}</p><p class="hint">下一步：${escapeHtml(adapter.nextAction ?? '检查来源后刷新')}${stamp ? ` · ${stamp}` : ''}</p>${feeSummary ? `<p class="fee-pending">费用：${escapeHtml(feeSummary)}${feeTime ? ` · 检查于 ${escapeHtml(formatTime(feeTime))}` : ''}</p>` : ''}</article>`;
  }).join('');
  $('#source-status-list').innerHTML = cards || '<p class="empty">当前没有可展示的桥接源。</p>';
  wireLocalImages($('#source-status-list'));
  bindRenderedSwitches($('#source-status-list'));
}
function renderCheckin(): void {
  const focus = captureFocus();
  $('#checkin-list').innerHTML = (state?.checkin?.sources ?? []).map((source) => {
    if (!source.supported) return `<div class="checkin-row unsupported"><div class="checkin-name"><span class="app-icon${appBrandIcon(source.source) ? '' : ' icon-empty'}${iconFamilyClass(source.source)}"${iconFamilyData(source.source)} aria-hidden="true">${appBrandIcon(source.source)}</span><span>${escapeHtml(source.name)}<span class="unsupported-text">${escapeHtml(source.message)}</span></span></div></div>`;
    const running = source.status === 'running';
    const good = source.status === 'claimed' || source.status === 'already';
    const enabled = state?.config.checkin?.sources?.[source.source as 'workbuddy' | 'qoder'] === true;
    return `<div class="checkin-row"><div class="checkin-name"><span class="app-icon${iconFamilyClass(source.source)}"${iconFamilyData(source.source)} aria-hidden="true">${appBrandIcon(source.source)}</span><span>${escapeHtml(source.name)}<small>自动签到</small><span class="checkin-status ${good ? 'good' : source.status === 'error' ? 'error' : ''}" role="status">${escapeHtml(source.message)}${source.checkedAt ? ` · ${escapeHtml(formatTime(source.checkedAt))}` : ''}</span></span></div>${switchMarkup(enabled, `${source.name} 自动签到领额度`, `data-checkin-source="${escapeHtml(source.source)}"`)}<button type="button" class="secondary" data-claim-source="${escapeHtml(source.source)}" ${!enabled || running ? 'disabled' : ''}>${running ? '领取中…' : '立即领取'}</button></div>`;
  }).join('');
  wireLocalImages($('#checkin-list'));
  bindRenderedSwitches($('#checkin-list'));
  restoreFocus(focus);
}
function formatTime(value: string): string { const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function badge(label: string, style = ''): string { return `<span class="badge ${style}">${escapeHtml(label)}</span>`; }
export function modelBadges(model: Model): string {
  const labels: string[] = [];
  const raw = model.priceMultiplier;
  const historical = model.feeFreshness === 'stale' || model.feeFreshness === 'failed';
  const value = typeof raw === 'object' ? (raw.current || historical ? raw.value : undefined) : raw;
  const feeCurrent = model.feeFreshness !== 'unknown' && model.feeFreshness !== 'stale' && model.feeFreshness !== 'failed';
  const free = model.free === true && feeCurrent && (typeof raw !== 'object' || raw.current);
  if (free) labels.push(badge('免费', 'free'));
  if (model.free === false && feeCurrent && !model.activities?.length) labels.push(badge('不免费', 'paid'));
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (feeCurrent || historical) && (model.free !== true || value === 0)) labels.push(badge(historical ? `上次 ${value}×` : model.activities?.length ? `当前 ${value}×` : `${value}×`, historical ? 'stale-fee' : 'multiplier'));
  if (model.free === true && historical) labels.push(badge('上次免费', 'stale-fee'));
  if (model.free === false && historical) labels.push(badge('上次不免费', 'stale-fee'));
  if (historical) labels.push(badge('待更新', 'stale-fee'));
  if (model.feeFreshness === 'unknown' || model.feeFreshness === undefined && model.free === undefined && raw === undefined) labels.push(badge('费用未确认', 'fee-unknown'));
  if (model.feeFreshness === 'failed' && model.free === undefined && raw === undefined) labels.push(badge('费用未确认·待更新', 'fee-unknown'));
  return labels.join('');
}
export function modelVerification(model: Model): string {
  return model.callVerified === false || model.callVerified === undefined && model.tags?.includes('unverified') ? badge('调用待验证', 'warning model-call-verification') : '';
}
function effortLabel(value: string): string { const labels: Record<string, string> = { none: '关闭', off: '关闭', disabled: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '极高', max: '最高' }; return labels[value] ?? value; }
function capabilities(model: Model): string {
  const labels = ['文本'];
  if (model.reasoning?.supported === true || (model.reasoning?.supportedEfforts?.length ?? 0) > 0) labels.push('推理');
  if (model.bridgeInputModalities?.includes('image')) labels.push('图片输入');
  else if (model.inputModalities?.includes('image')) labels.push('上游支持图片 · 桥接未开放');
  return `<div class="capabilities">${labels.map((label) => `<span>${label === '图片输入' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="8" cy="9" r="1.5"/><path d="m4 18 6-6 4 4 3-3 4 5"/></svg>' : label === '推理' ? '<span aria-hidden="true">✧</span>' : '<span aria-hidden="true">T</span>'}${escapeHtml(label)}</span>`).join('')}</div>`;
}
function modelIcon(model: Model): string { const icon = modelBrandIcon(model.id); return icon ? `<span class="model-glyph" aria-hidden="true">${icon}</span>` : ''; }
function modelFamily(model: Model): string {
  const id = model.id.toLowerCase().replace(/^[^:]+:/, '');
  if (/^(glm|z\.ai|zai)([-/:.]|$)/.test(id)) return 'GLM';
  if (/^(deepseek|ds)([-/:.]|$)/.test(id)) return 'DeepSeek';
  if (/^(kimi|moonshot)([-/:.]|$)/.test(id)) return 'Kimi';
  if (/^(qwen|qwq)([-/:.]|$)/.test(id) || /^qwen\d/.test(id)) return 'Qwen';
  if (/^(minimax|abab)([-/:.]|$)/.test(id)) return 'MiniMax';
  if (/^(hunyuan|hy[34])([-/:.]|$)/.test(id)) return '混元';
  if (/^gemini([-/:.]|$)/.test(id)) return 'Gemini';
  if (/^claude([-/:.]|$)/.test(id)) return 'Claude';
  if (/^(gpt|openai)([-/:.]|$)/.test(id)) return 'OpenAI';
  return '';
}
export function compactContext(raw: number | TokenLimit | undefined): { label: string; full: string } {
  const value = typeof raw === 'object' && raw !== null ? raw.value : raw;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return { label: '—', full: '上下文未知' };
  const full = `${new Intl.NumberFormat('zh-CN').format(value)} tokens`;
  const compact = value >= 1_000_000
    ? `${value % 1_000_000 === 0 ? value / 1_000_000 : Number((Math.floor(value / 10_000) / 100).toFixed(2))}M`
    : value >= 1_000 ? `${value % 1_000 === 0 ? value / 1_000 : Number((Math.floor(value / 10) / 100).toFixed(2))}K`
    : String(value);
  return { label: compact, full };
}
function matches(model: Model, adapter: AdapterInfo): boolean {
  const query = $<HTMLInputElement>('#model-search').value.trim().toLocaleLowerCase();
  if ($<HTMLInputElement>('#free-only').checked && (model.free !== true || model.feeFreshness === 'stale' || model.feeFreshness === 'failed')) return false;
  return query === '' || [model.id, model.name, model.description, adapter.id, adapter.displayName, ...(model.activityLabels ?? [])].filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}
function formStatus(adapter: AdapterInfo): string {
  if (!adapter.form) return '';
  const label = adapter.form === 'direct' ? '直连正常' : adapter.form === 'app-server' ? '已降级：官方 CLI' : '通道不可用';
  return `<p class="hint source-form">通道：${label}${adapter.reason ? ` · ${escapeHtml(adapter.reason)}` : ''}${adapter.fallbackAvailable === false ? ' · 安全兜底已禁用' : ''}</p>`;
}
function renderModels(): void {
  if (!state) return;
  let visible = 0;
  const groups: string[] = [];
  const expandedRoutes = new Set(Array.from(document.querySelectorAll<HTMLDetailsElement>('.model-more[open]')).map((details) => details.dataset.route).filter((route): route is string => Boolean(route)));
  const filtered = $<HTMLInputElement>('#model-search').value.trim() !== '' || $<HTMLInputElement>('#free-only').checked;
  for (const adapter of state.adapters.filter((a) => a.directoryReady && sourceEnabled(a.id))) {
    const models = adapter.models.filter((model) => matches(model, adapter));
    const selectedInView = models.filter((model) => modelEnabled(adapter.id, model.id)).length;
    const enabled = sourceEnabled(adapter.id);
    const selected = adapter.models.filter((model) => modelEnabled(adapter.id, model.id)).length;
    if (models.length === 0 && filtered) continue;
    visible += models.length;
    const quota = adapter.quota === 'exhausted' ? '额度已用尽' : adapter.quota === 'ok' ? '额度状态可用' : '额度余量未知';
    const catalogNote = adapter.auth === 'unknown' ? '目录已取得，登录态未确认' : '';
    groups.push(`<article class="source-group ${enabled ? '' : 'disabled'}" data-source-group="${escapeHtml(adapter.id)}">
      <header class="source-header"><div class="source-heading"><span class="source-icon${appBrandIcon(adapter.id) ? '' : ' icon-empty'}${iconFamilyClass(adapter.id)}"${iconFamilyData(adapter.id)} aria-hidden="true">${appBrandIcon(adapter.id)}</span><div><h3>${escapeHtml(adapter.displayName)}</h3><div class="source-summary"><span class="pill ${adapter.auth === 'logged-in' ? 'good' : ''}">${authLabel(adapter.auth)}</span><span class="quota-text" title="${escapeHtml(adapter.quotaMessage ?? '上游未提供具体余额')}">${quota}</span></div></div></div><div class="source-actions"><span class="hint">${adapter.models.length} 个模型</span><button type="button" class="text-button" data-config-control data-select-source="${escapeHtml(adapter.id)}" data-select-value="true" ${saving || models.length === 0 ? 'disabled' : ''}>全选当前结果</button><button type="button" class="text-button" data-config-control data-select-source="${escapeHtml(adapter.id)}" data-select-value="false" ${saving || models.length === 0 ? 'disabled' : ''}>全不选</button></div></header>
      ${formStatus(adapter)}${catalogNote ? `<p class="hint source-form">${catalogNote}</p>` : ''}<p class="source-selection">${enabled ? `已选 ${selected} / ${adapter.models.length} 个模型` : `此源已停用 · 已选模型会保留，启用后恢复`}${filtered ? ` · 当前结果已选 ${selectedInView} / ${models.length}` : ''}</p>
      <div class="model-grid">${models.length === 0 ? (filtered ? '<p class="empty">此来源没有符合当前筛选条件的模型。调整搜索或免费筛选即可查看。</p>' : '<p class="empty">暂无模型。请先在对应应用登录，然后刷新状态；停用的源不会自动探测。</p>') : models.map((model) => {
        const modelName = model.name ?? model.id;
        const efforts = model.reasoning?.supportedEfforts ?? [];
        const context = compactContext(model.minCtx);
        const icon = modelIcon(model);
        const family = modelFamily(model);
        const visibleActivities: ModelActivity[] = model.activities?.length ? model.activities : (model.activityLabels ?? []).map((label) => ({ label, scheduleMeaning: 'label' }));
        const activityCards = visibleActivities.map((activity) => {
          const summary = formatModelActivity(activity, { detailed: true });
          let detail = summary.slice(activity.label.length).trim();
          if ((model.feeFreshness === 'stale' || model.feeFreshness === 'failed') && !detail.includes('待更新')) detail = `${detail}${detail ? ' · ' : ''}待更新`;
          const kind = activity.kind ?? (/免费|free/i.test(activity.label) ? 'free' : /折扣|discount/i.test(activity.label) ? 'discount' : 'other');
          const tone = activity.scheduleMeaning === 'label' ? 'activity-pending' : kind === 'free' ? 'free' : kind === 'discount' ? 'multiplier' : 'paid';
          return `<div class="model-activity"><span class="badge ${tone}">${escapeHtml(activity.label)}</span>${detail ? `<span>${escapeHtml(detail)}</span>` : ''}</div>`;
        });
        return `<article class="model-card ${icon ? '' : 'model-icon-missing'} ${modelEnabled(adapter.id, model.id) ? 'selected' : ''}" data-model-id="${escapeHtml(model.id)}"><div class="model-card-head">${icon}<div class="model-title"><h4>${escapeHtml(modelName)}</h4><span>${escapeHtml(adapter.displayName)}${family ? ` · ${escapeHtml(family)}` : ''}</span></div>${switchMarkup(modelEnabled(adapter.id, model.id), `${adapter.displayName} ${modelName}`, `data-role="model-allow" data-adapter-id="${escapeHtml(adapter.id)}" data-model-id="${escapeHtml(model.id)}"`)}</div><div class="model-state"><span>${modelEnabled(adapter.id, model.id) ? '已启用' : '未启用'}${!enabled ? ' · 此源停用，选择暂不生效' : ''}</span>${modelVerification(model)}</div>${capabilities(model)}<div class="model-spec"><div><span>上下文</span><strong title="${escapeHtml(context.full)}"><span>${escapeHtml(context.label)}</span>${context.label === '—' ? '' : ' <small>tokens</small>'}</strong></div><div class="model-fees">${modelBadges(model)}</div></div>${activityCards.length ? `<div class="model-activities">${activityCards.join('')}</div>` : ''}<details class="model-more" data-route="${escapeHtml(adapter.id)}:${escapeHtml(model.id)}"><summary>模型详情</summary><div class="detail-content"><div class="route-row"><code data-model-route="${escapeHtml(adapter.id)}:${escapeHtml(model.id)}" data-route-value="${escapeHtml(adapter.id)}:${escapeHtml(model.id)}">${escapeHtml(adapter.id)}:${escapeHtml(model.id)}</code><button type="button" class="text-button" data-copy-route="${escapeHtml(adapter.id)}:${escapeHtml(model.id)}">复制完整 ID</button></div>${model.maxInput ? `<p>最大输入：${escapeHtml(compactContext(model.maxInput).label)} tokens</p>` : ''}${model.description ? `<p>${escapeHtml(model.description)}</p>` : ''}${efforts.length ? `<p>推理档位：${escapeHtml(efforts.map(effortLabel).join('、'))}</p>` : ''}${model.reasoning?.canDisableThinking ? '<p>可关闭推理</p>' : ''}${(model.activityLabels ?? []).length ? `<p>活动：${escapeHtml(model.activityLabels!.join('、'))}</p>` : ''}</div></details></article>`;
      }).join('')}</div></article>`);
  }
  const history = state.adapters.filter((a) => !a.directoryReady && a.historyModels?.length).map((adapter) => `<details class="stale-directory"><summary>${escapeHtml(adapter.displayName)} · 上次目录 · 当前未就绪</summary><p class="hint">${escapeHtml(adapter.sourceMessage ?? '本次未更新')}；历史费用仅供参考，待刷新确认。</p><div class="stale-fee-list">${adapter.historyModels!.map((model) => `<div><span>${escapeHtml(model.name ?? model.id)}</span><span>${model.free === true ? '上次免费' : model.free === false ? '上次不免费' : '费用未确认'}${typeof model.priceMultiplier === 'object' ? ` · ${model.priceMultiplier.value}×` : typeof model.priceMultiplier === 'number' ? ` · ${model.priceMultiplier}×` : ''} · 待更新</span></div>`).join('')}</div></details>`).join('');
  $('#models-list').innerHTML = `${groups.length === 0 ? (filtered ? '<p class="empty">没有匹配的就绪模型。试试更短的关键词，或取消“只看免费”。</p>' : '<p class="empty">当前没有已确认就绪的模型目录；请查看上方桥接源状态。</p>') : groups.join('')}${history}`;
  $('#model-count').textContent = `${visible} 个模型`;
  document.querySelectorAll<HTMLDetailsElement>('.model-more').forEach((details) => { if (expandedRoutes.has(details.dataset.route ?? '')) details.open = true; });
  $('#clear-filters').hidden = !filtered;
  document.querySelectorAll<HTMLButtonElement>('[data-free-filter]').forEach((button) => { button.setAttribute('aria-pressed', String(button.dataset.freeFilter === String($<HTMLInputElement>('#free-only').checked))); });
  wireLocalImages($('#models-list'));
  bindRenderedSwitches($('#models-list'));
}
function renderOutput(): void {
  if (!state) return;
  const port = $<HTMLInputElement>('#port-output');
  if (!port.dataset.dirty) port.value = String(state.config.output.port);
  const expose = $<HTMLInputElement>('#expose-anthropic');
  expose.checked = state.config.output.exposeAnthropic;
  syncSwitch(expose);
  $('#endpoint-display').textContent = `http://127.0.0.1:${state.config.output.port}/v1`;
  $('#anthropic-summary').textContent = expose.checked ? 'Anthropic 已启用' : 'Anthropic 未启用';
  if (expose.dataset.bound !== 'true') {
    expose.dataset.bound = 'true';
    bindSwitch(expose, (value) => {
      if (state) {
        $('#output-save-status').textContent = '保存中…';
        void persist({ output: { exposeAnthropic: value } }, value ? '已启用 Anthropic 兼容端点' : '已关闭 Anthropic 兼容端点');
      }
    });
  }
}
function bindRenderedSwitches(root: ParentNode): void {
  root.querySelectorAll<HTMLInputElement>('.switch-control input').forEach((input) => {
    if (input.dataset.bound === 'true') return;
    input.dataset.bound = 'true';
    bindSwitch(input, (value) => {
      if (saving) return;
      if (input.dataset.checkinSource && value && !window.confirm('启用后，服务运行期间会自动查询并领取这个源的免费额度。确认启用？')) { input.checked = false; syncSwitch(input); return; }
      if (input.dataset.role === 'adapter-enabled' && input.dataset.adapterId) void persist({ adapters: { [input.dataset.adapterId]: { enabled: value } } });
      else if (input.dataset.role === 'model-allow' && input.dataset.adapterId && input.dataset.modelId) void persist({ models: { allow: { [input.dataset.adapterId]: { [input.dataset.modelId]: value } } } });
      else if (input.dataset.checkinSource) void persist({ checkin: { sources: { [input.dataset.checkinSource]: value } } }, value ? '已开启自动签到 · 仅服务运行期间领取' : '已关闭自动签到');
    });
  });
}
function renderAll(): void { renderHosts(); renderSourceStatuses(); renderCheckin(); renderModels(); renderOutput(); $('#config').hidden = false; $('#load-status').hidden = true; $('#config-path-display').textContent = configPath; $('#wizard-config-path').textContent = configPath; $('#wizard').hidden = state?.configExists !== false; }
function captureFocus(): { element: HTMLElement; id?: string; adapter?: string; model?: string; checkin?: string; selectionStart?: number | null; selectionEnd?: number | null } | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return undefined;
  const input = active as HTMLInputElement;
  return {
    element: active,
    ...(active.id ? { id: active.id } : {}),
    ...(active.dataset.adapterId ? { adapter: active.dataset.adapterId } : {}),
    ...(active.dataset.modelId ? { model: active.dataset.modelId } : {}),
    ...(active.dataset.checkinSource ? { checkin: active.dataset.checkinSource } : {}),
    ...(typeof input.selectionStart === 'number' ? { selectionStart: input.selectionStart, selectionEnd: input.selectionEnd } : {}),
  };
}
function restoreFocus(key: ReturnType<typeof captureFocus>): void {
  if (!key || (document.activeElement !== document.body && document.activeElement !== key.element)) return;
  const candidate = Array.from(document.querySelectorAll<HTMLElement>('input,button,summary')).find((element) =>
    (key.id && element.id === key.id) || (key.adapter && element.dataset.adapterId === key.adapter && (!key.model || element.dataset.modelId === key.model)) || (key.checkin && element.dataset.checkinSource === key.checkin),
  );
  if (!candidate) return;
  candidate.focus({ preventScroll: true });
  if (candidate instanceof HTMLInputElement && key.selectionStart !== undefined && key.selectionStart !== null) candidate.setSelectionRange(key.selectionStart, key.selectionEnd ?? key.selectionStart);
}
export function updateSaveStatus(target: HTMLElement, message: string, kind: string): HTMLElement {
  let status = target.querySelector<HTMLElement>('.local-save-status');
  if (!status) { status = document.createElement('span'); status.className = 'local-save-status'; status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); target.append(status); }
  status.textContent = message;
  status.className = `local-save-status ${kind}`;
  return status;
}
function setLocalSaveStatus(patch: ConfigPatch, message: string, kind: string): void {
  if (patch.output) {
    const status = $('#output-save-status');
    status.textContent = message;
    status.className = `status ${kind}`;
    return;
  }
  if (patch.models?.allow) {
    const entries = Object.entries(patch.models.allow);
    for (const [adapter, models] of entries) {
      const source = document.querySelector<HTMLElement>(`[data-source-group="${CSS.escape(adapter)}"]`);
      const ids = Object.keys(models);
      const host = entries.length > 1 || ids.length !== 1
        ? source
        : source?.querySelector<HTMLElement>(`[data-model-id="${CSS.escape(ids[0] ?? '')}"]`);
      if (host) updateSaveStatus(host, message, kind);
    }
    return;
  }
  const host = patch.adapters
    ? document.querySelector<HTMLElement>(`[data-source-group="${CSS.escape(Object.keys(patch.adapters)[0] ?? '')}"]`)
    : patch.checkin ? $('#checkin-list') : null;
  if (host) updateSaveStatus(host, message, kind);
}
async function persist(patch: ConfigPatch, message = '已保存 · 下次请求立即生效'): Promise<void> {
  if (!state || saving) return;
  const focus = captureFocus();
  const prior = structuredClone(state.config);
  setSaveBusy(true); setStatus('保存中…'); setLocalSaveStatus(patch, '保存中…', '');
  let saved = false;
  let localResult: { message: string; kind: string } | undefined;
  try {
    const response = await api<{ config: Config }>('/api/config', patch);
    state.config = response.config; state.configExists = true; $('#wizard').hidden = true; saved = true;
    if (patch.output) renderOutput();
    setStatus(message, 'ok');
    if (patch.adapters) { const updated = await api<StateResponse>('/api/state'); state.adapters = updated.adapters; }
    if (patch.checkin) state.checkin = await api<StateResponse['checkin']>('/api/checkin');
    localResult = { message, kind: 'ok' };
  } catch (error) {
    if (!saved) state.config = prior;
    const failure = saved ? '设置已保存，但状态刷新失败；稍后点“刷新状态”重试' : `保存失败：${error instanceof Error ? error.message : '请重试'}`;
    if (patch.output) $('#output-save-status').textContent = saved ? failure : `保存失败：${error instanceof Error ? error.message : '请重试'}`;
    setStatus(failure, saved ? '' : 'error');
    localResult = { message: failure, kind: saved ? '' : 'error' };
  } finally {
    setSaveBusy(false);
    if (patch.models || patch.adapters) renderModels();
    if (patch.adapters) renderSourceStatuses();
    if (patch.checkin) renderCheckin();
    if (patch.output) {
      const port = $<HTMLInputElement>('#port-output');
      if (patch.output.port !== undefined && saved) { port.value = String(state.config.output.port); delete port.dataset.dirty; }
      const expose = $<HTMLInputElement>('#expose-anthropic');
      expose.checked = state.config.output.exposeAnthropic;
      syncSwitch(expose);
      $('#anthropic-summary').textContent = expose.checked ? 'Anthropic 已启用' : 'Anthropic 未启用';
      $('#endpoint-display').textContent = `http://127.0.0.1:${state.config.output.port}/v1`;
      if (patch.output.port !== undefined) $('#output-save-status').textContent = saved ? '已保存' : `保存失败：${localResult?.message.replace(/^保存失败：/, '') ?? '请重试'}；端口草稿已保留`;
      else if (patch.output.exposeAnthropic !== undefined) $('#output-save-status').textContent = saved ? 'Anthropic 设置已即时保存' : 'Anthropic 设置保存失败';
    }
    if (localResult) setLocalSaveStatus(patch, localResult.message, localResult.kind);
    restoreFocus(focus);
  }
}
async function refresh(): Promise<void> {
  if (refreshing || saving) return;
  refreshing = true; const button = $<HTMLButtonElement>('#probe-btn'); button.disabled = true; button.textContent = '刷新中…'; setStatus('正在读取本机状态…');
  try { const result = await api<{ adapters: AdapterInfo[]; metadataSync?: 'updated' | 'current' | 'skipped' | 'failed' }>('/api/probe', {}); if (state) state.adapters = result.adapters; renderAll(); const failed = result.adapters.some((a) => a.sourceState === 'failed' || a.sourceState === 'probing' || a.models.some((m) => m.feeFreshness === 'failed')); const message = result.metadataSync === 'failed' ? failed ? '部分状态未更新，WorkBuddy 名称未同步' : '状态已刷新，但 WorkBuddy 名称未同步' : failed ? '部分状态未更新' : result.metadataSync === 'updated' ? '状态已刷新 · WorkBuddy 模型名称已同步' : '状态已刷新'; setStatus(message, failed || result.metadataSync === 'failed' ? '' : 'ok'); }
  catch (error) { setStatus(`刷新失败：${error instanceof Error ? error.message : '请重试'}`, 'error'); }
  finally { refreshing = false; button.disabled = false; button.textContent = '刷新状态'; }
}
async function claim(source: string): Promise<void> {
  if (!state) return; const item = state.checkin.sources.find((entry) => entry.source === source);
  if (!item?.supported || !item.enabled || item.status === 'running') return;
  item.status = 'running'; item.message = '正在查询并领取…'; renderCheckin();
  try { const result = await api<{ checkin: StateResponse['checkin'] }>('/api/checkin', { source }); state.checkin = result.checkin; setStatus('领取状态已更新', 'ok'); }
  catch (error) { item.status = 'error'; item.message = '本次领取未完成，请刷新状态后重试'; setStatus(error instanceof Error ? error.message : '领取失败', 'error'); }
  renderCheckin();
}
function renderOnboardPrompt(): void {
  if (!state) return;
  const models = state.adapters.filter((adapter) => adapter.directoryReady && sourceEnabled(adapter.id))
    .flatMap((adapter) => adapter.models.filter((model) => modelEnabled(adapter.id, model.id)).map((model) => {
      const fee = modelBadges(model).replace(/<[^>]*>/g, '').trim();
      return { id: `${adapter.id}:${model.id}`, displayName: model.name ?? model.id, ...(fee ? { fees: fee } : {}) };
    }));
  $<HTMLTextAreaElement>('#onboard-prompt').value = buildOnboardPrompt({
    port: state.config.output.port,
    exposeAnthropic: state.config.output.exposeAnthropic,
    models,
  });
  $<HTMLButtonElement>('#copy-onboard').disabled = false;
}
async function openOnboard(): Promise<void> {
  renderOnboardPrompt();
  $('#onboard-status').textContent = '';
  $<HTMLDialogElement>('#onboard-dialog').showModal();
}
async function copy(text: string, statusElement: HTMLElement): Promise<void> { try { await navigator.clipboard.writeText(text); statusElement.textContent = '已复制'; } catch { statusElement.textContent = '浏览器无法自动复制，请选中上方内容手动复制。'; } }
async function resetSelection(): Promise<void> {
  if (!state || saving || !window.confirm('重置所有桥接源与模型勾选？输出设置、签到开关与令牌不会改变。')) return;
  setSaveBusy(true); try { const result = await api<{ config: Config }>('/api/config/reset-selection', {}); state.config = result.config; renderAll(); setStatus('源与模型已重置；输出和签到设置保持不变', 'ok'); } catch (error) { setStatus(error instanceof Error ? error.message : '重置失败', 'error'); } finally { setSaveBusy(false); }
}
async function main(): Promise<void> {
  const wordmark = accessMuxWordmark(); if (wordmark) document.querySelector('.wordmark')!.innerHTML = wordmark;
  state = await api<StateResponse>('/api/bootstrap'); configPath = state.configPath ?? ''; renderAll();
  $('#model-search').addEventListener('input', renderModels);
  $('#free-only').addEventListener('change', renderModels);
  const navLinks = Array.from(document.querySelectorAll<HTMLAnchorElement>('.section-nav a[data-nav]'));
  const navObserver = new IntersectionObserver((entries) => {
    const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
    if (!visible) return;
    navLinks.forEach((link) => {
      const active = link.dataset.nav === (visible.target as HTMLElement).id;
      if (active) link.setAttribute('aria-current', 'location');
      else link.removeAttribute('aria-current');
    });
  }, { rootMargin: '-18% 0px -65% 0px', threshold: [0, 0.2, 0.5] });
  document.querySelectorAll<HTMLElement>('.section[id]').forEach((section) => navObserver.observe(section));
  $('#port-output').addEventListener('input', () => { $('#port-output').dataset.dirty = 'true'; });
  $('#probe-btn').addEventListener('click', () => { void refresh(); });
  $('#output-options-btn').addEventListener('click', () => {
    const details = $<HTMLDetailsElement>('#output-details');
    details.open = !details.open;
    $('#output-options-btn').setAttribute('aria-expanded', String(details.open));
    if (details.open) details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  document.querySelectorAll<HTMLButtonElement>('[data-free-filter]').forEach((button) => button.addEventListener('click', () => {
    $<HTMLInputElement>('#free-only').checked = button.dataset.freeFilter === 'true';
    renderModels();
  }));
  $('#clear-filters').addEventListener('click', () => { $<HTMLInputElement>('#model-search').value = ''; $<HTMLInputElement>('#free-only').checked = false; renderModels(); });
  $('#save-btn').addEventListener('click', () => {
    const input = $<HTMLInputElement>('#port-output');
    if (!input.reportValidity() || !state) return;
    $('#output-save-status').textContent = '保存中…';
    void persist({ output: { port: Number(input.value) } }, '输出设置已保存 · 改端口需重启服务');
  });
  $('#reset-btn').addEventListener('click', () => { void resetSelection(); }); $('#wizard-finish').addEventListener('click', () => { void persist({}, '默认配置已生成并保存'); });
  $('#copy-endpoint').addEventListener('click', () => { void copy($('#endpoint-display').textContent ?? '', $('#save-status')); });
  $('#onboard-open').addEventListener('click', () => { void openOnboard(); });
  $('#onboard-close').addEventListener('click', () => { $<HTMLDialogElement>('#onboard-dialog').close(); });
  $('#copy-onboard').addEventListener('click', () => { void copy($<HTMLTextAreaElement>('#onboard-prompt').value, $('#onboard-status')); });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id === 'free-only') renderModels();
    else if (target.id === 'expose-anthropic') {
      target.setAttribute('aria-checked', String(target.checked));
      $('#anthropic-summary').textContent = target.checked ? 'Anthropic 已启用' : 'Anthropic 未启用';
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target; if (!(target instanceof Element)) return;
    const button = target.closest<HTMLButtonElement>('button');
    if (button && !button.disabled) {
      if (button.dataset.claimSource) void claim(button.dataset.claimSource);
      else if (button.dataset.selectSource && state && !saving) {
        const adapter = state.adapters.find((entry) => entry.id === button.dataset.selectSource); if (!adapter) return;
        const allow = Object.fromEntries(adapter.models.filter((model) => matches(model, adapter)).map((model) => [model.id, button.dataset.selectValue === 'true']));
        void persist({ models: { allow: { [adapter.id]: allow } } });
      }
      else if (button.dataset.copyRoute) void copy(button.dataset.copyRoute, $('#save-status'));
    }
  });
  checkinTimer = setInterval(() => { if (!state || document.hidden || saving || refreshing) return; void api<StateResponse['checkin']>('/api/checkin').then((result) => { if (state) { state.checkin = result; renderCheckin(); } }).catch(() => undefined); }, 15_000);
  window.addEventListener('pagehide', () => { if (checkinTimer) clearInterval(checkinTimer); });
}
if (typeof document !== 'undefined') void main().catch(() => { $('#load-status').textContent = '读取本机状态失败。确认 AccessMux 服务仍在运行，然后刷新页面重试。'; $('#load-status').classList.add('error'); $('#probe-btn').addEventListener('click', () => { window.location.reload(); }); });
