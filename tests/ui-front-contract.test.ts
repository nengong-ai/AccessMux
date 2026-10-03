import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const html = readFileSync(new URL('../src/ui/public/index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/ui/public/app.ts', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/ui/public/style.css', import.meta.url), 'utf8');
const toggles = readFileSync(new URL('../src/ui/public/toggle.ts', import.meta.url), 'utf8');
const prompt = readFileSync(new URL('../src/ui/public/onboard-prompt.ts', import.meta.url), 'utf8');

describe('T033 前端公开交互约束', () => {
  it('页面四区块保持新手顺序，输出设置最后', () => {
    const positions = ['hosts-block', 'source-status-block', 'models-block', 'checkin-block', 'output-block'].map((id) => html.indexOf(`<section id="${id}"`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('只允许本机访问');
    expect(html).toContain('Claude Code 等宿主使用');
  });
  it('宿主状态卡不参与提示词选择，统一弹窗可直接复制自识别提示词', () => {
    expect(html).toContain('id="onboard-open"');
    expect(html).toContain('接入提示词');
    expect(html).not.toContain('onboard-host-select');
    expect(html).not.toContain('current-host-select');
    expect(html).toContain('id="onboard-prompt"');
    expect(html).toContain('id="copy-onboard"');
    expect(source).toContain("button.dataset.claimSource");
    expect(source).not.toContain('data-onboard-host');
    expect(source).toContain('image.complete && image.naturalWidth === 0');
    expect(html).toContain('复制提示词');
    expect(prompt).toContain('接收它的 Agent');
    expect(source).not.toContain('selectedHostId');
    expect(source).toContain('const visibleActivities: ModelActivity[] = model.activities?.length ? model.activities : (model.activityLabels ?? []).map((label) => ({ label, scheduleMeaning: \'label\' }));');
    expect(source).toContain('const activityCards = visibleActivities.map((activity) => {');
    expect(source).toContain("class=\"badge ${tone}\"");
    expect(source).toContain("import { formatModelActivity } from './activity-presentation.js'");
    expect(source).not.toContain('标签展示时段');
  });
  it('reset仅重置选择且auto签到启用前明确确认', () => {
    expect(source).toContain("'/api/config/reset-selection'");
    expect(source).not.toContain("'/api/config/reset'");
    expect(source).toContain('确认启用？');
    expect(source).toContain('自动签到领额度');
    expect(source).toContain("${source.name} 自动签到领额度");
  });
  it('模型过滤仅free真值；勾选保存是partial避免覆盖筛选隐藏项', () => {
    expect(source).toContain('model.free !== true');
    expect(source).toContain('[input.dataset.modelId]: value');
    expect(source).toContain('adapter.models.filter((model) => matches(model, adapter))');
    expect(source).not.toContain('collectModelsPayload');
  });
  it('响应式模型卡片使用本地图标和真实桥接图片能力', () => {
    expect(css).toContain('@media(max-width:760px)');
    expect(css).toContain('overflow-wrap: anywhere');
    expect(css).toContain('grid-template-columns: repeat(3,minmax(0,1fr))');
    expect(source).toContain('escapeHtml(model.description)');
    expect(source).toContain("model.bridgeInputModalities?.includes('image')");
    expect(source).toContain('上游支持图片 · 桥接未开放');
    expect(source).toContain('feeFreshness === \'unknown\'');
    expect(source).not.toContain('model.iconUrl');
  });

  it('模型启用控件为开关，详情含完整可复制路由', () => {
    expect(source).toContain('role="switch"');
    expect(toggles).toContain("input.setAttribute('role', 'switch')");
    expect(toggles).toContain("input.addEventListener('pointercancel'");
    expect(toggles).toContain('input.setPointerCapture(event.pointerId)');
    expect(source).toContain('data-copy-route');
    expect(source).toContain('aria-checked=');
    expect(source).toContain('全选当前结果');
    expect(source).toContain('只看免费');
  });

  it('保存失败回滚配置，状态刷新失败保留已保存配置', () => {
    expect(source).toContain('const prior = structuredClone(state.config)');
    expect(source).toContain('if (!saved) state.config = prior');
    expect(source).toContain('设置已保存，但状态刷新失败');
  });

  it('上下文数值保留大字号且超窄顶栏给刷新按钮留足空间', () => {
    expect(css).toContain('.model-spec>div:first-child>span {');
    expect(css).not.toContain('.model-spec>div:first-child span {');
    expect(css).toContain('.model-spec strong {\n  display: block;\n  font-size: 22px;');
    expect(css).toContain('@media(max-width:360px) {\n  .topbar .local-tag {\n    display: none');
    expect(css).toContain('.topbar #probe-btn {\n    min-height: 44px;');
  });

  it('动态内容转义且品牌图标由本地品牌模块提供', () => {
    expect(source).toContain('escapeHtml(modelName)');
    expect(source).toContain('appBrandIcon(host.id)');
    expect(source).toContain('modelBrandIcon(model.id)');
    expect(source).toContain('compactContext(model.minCtx)');
    expect(source).toContain('调用待验证');
    expect(source).toContain("link.setAttribute('aria-current', 'location')");
    expect(source).toContain("from './brand-assets.js'");
    expect(source).toContain('wireLocalImages');
    expect(source).toContain('image.hidden = true');
    expect(source).toContain('aria-expanded');
    expect(source).toContain("setLocalSaveStatus(patch, '保存中…', '')");
    expect(source).toContain('if (!port.dataset.dirty) port.value');
    expect(source).toContain('if (patch.output.port !== undefined && saved)');
    expect(source).toContain('if (localResult) setLocalSaveStatus(patch, localResult.message, localResult.kind)');
    expect(source).toContain('(key.checkin && element.dataset.checkinSource === key.checkin)');
    expect(source).toContain('data-model-id="${escapeHtml(model.id)}"');
    expect(source).toContain('input.checked = false; syncSwitch(input)');
    expect(source).not.toContain('host?.querySelector(\'.local-save-status\')');
    expect(html).toContain('data-free-filter');
    expect(html).toContain('id="clear-filters"');
    expect(html).toContain('保存输出设置');
    expect(html).toContain('class="skeleton-card"');
  });
});
