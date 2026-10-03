// T039 浏览器验收：真实 UI route/control-plane + 注入的 Qoder 运行时/费用源。
// 不读取真实 HOME、凭据或网络；管理端点只存在于这个测试进程。
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { QoderAdapter } from '../src/adapters/qoder/index.js';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import type { ProbeContext, ProbeResult, ProviderAdapter } from '../src/adapters/types.js';
import { ConfigStore, buildDefaultConfig } from '../src/config/index.js';
import type { ModelInfo, QuotaState } from '../src/types.js';
import { mountUiRoutes } from '../src/ui/index.js';
import type { HostDef } from '../src/onboard/hosts.js';

type Scenario = 'unknown' | 'fresh-free' | 'fresh-paid' | 'fresh-free-no-rate' | 'fresh-paid-no-rate' | 'expired-last-free' | 'renewed-free' | 'fee-failed' | 'failed' | 'fallback' | 'config-disabled' | 'environment-disabled';
const scenarios = new Set<Scenario>(['unknown', 'fresh-free', 'fresh-paid', 'fresh-free-no-rate', 'fresh-paid-no-rate', 'expired-last-free', 'renewed-free', 'fee-failed', 'failed', 'fallback', 'config-disabled', 'environment-disabled']);
const counts = { probe: 0, quota: 0, qoderVersion: 0, qoderCatalog: 0, qoderMetadata: 0, forceRefresh: 0, ordinaryProbe: 0 };
const temp = mkdtempSync(join(tmpdir(), 'accessmux-t039-ui-fixture-'));
const fixtureEnv: Record<string, string | undefined> = { ACCESSMUX_DISABLE_ADAPTERS: '' };
let scenario: Scenario = 'unknown';
let lastQoderOffer: { at: string; scenario: string; version: string; status: number } | undefined;

function evidence(at = new Date().toISOString()) {
  return { kind: 'platform' as const, reference: 'qoder:fixture-offer', field: 'model.fee', updated_at: at, region: 'cn' };
}
function scenarioModel(): ModelInfo {
  const id = 'fixture-model'; const provider = 't039-fixture'; const origin = evidence();
  if (scenario === 'fresh-free' || scenario === 'fresh-free-no-rate') return { id, provider, free: true, freeSource: origin, feeFreshness: 'fresh', ...(scenario === 'fresh-free' ? { priceMultiplier: { value: 0, current: true, updated_at: origin.updated_at, source: origin } } : {}) };
  if (scenario === 'fresh-paid' || scenario === 'fresh-paid-no-rate') return { id, provider, free: false, freeSource: origin, feeFreshness: 'fresh', ...(scenario === 'fresh-paid' ? { priceMultiplier: { value: 2, current: true, updated_at: origin.updated_at, source: origin } } : {}) };
  if (scenario === 'unknown') return { id, provider };
  return { id, provider };
}
class ScenarioAdapter implements ProviderAdapter {
  readonly id = 't039-fixture'; readonly displayName = 'T039 可变费用源'; readonly sandbox = 'none' as const;
  async probe(ctx?: ProbeContext): Promise<ProbeResult> {
    counts.probe++; if (ctx?.forceRefresh) counts.forceRefresh++; else counts.ordinaryProbe++;
    if (scenario === 'failed') throw new Error('fixture failure; never exposed');
    const fallback = scenario === 'fallback';
    return { availability: fallback ? 'unverified' : 'available', catalogSource: fallback ? 'fallback' : 'current', reasonCode: fallback ? 'catalog-fallback' : 'directory-ready', auth: 'unknown', observedAt: new Date().toISOString(), models: [scenarioModel()] };
  }
  async fetchQuota(): Promise<QuotaState> { counts.quota++; return 'unknown'; }
  async launch(): Promise<never> { throw new Error('fixture 不允许推理'); }
  async dispose(): Promise<void> {}
}

function qoderOfferText(): string {
  const date = (value: Date) => `${value.getFullYear()}年${value.getMonth() + 1}月${value.getDate()}日 ${String(value.getHours()).padStart(2, '0')}:${String(value.getMinutes()).padStart(2, '0')}`;
  const oldEnd = date(new Date(Date.now() - 2 * 86_400_000));
  const futureEnd = date(new Date(Date.now() + 28 * 86_400_000));
  if (scenario === 'fresh-free' || scenario === 'renewed-free') return `Qwen3.8-Flash 活动正在进行，免费期现已延长，计费系数由 2× 降至 0×，有效期至 ${futureEnd}。`;
  if (scenario === 'fresh-paid') return 'Qwen3.8-Flash 当前免费活动已结束，已恢复原价，计费系数：2×。';
  if (scenario === 'fresh-free-no-rate') return `Qwen3.8-Flash 活动正在进行，免费期现已延长，有效期至 ${futureEnd}。`;
  if (scenario === 'fresh-paid-no-rate') return 'Qwen3.8-Flash 当前免费活动已结束，已恢复原价。';
  if (scenario === 'expired-last-free') return `Qwen3.8-Flash 活动正在进行，免费期现已延长，计费系数由 2× 降至 0×，有效期至 ${oldEnd}。`;
  if (scenario === 'unknown' || scenario === 'fee-failed' || scenario === 'failed' || scenario === 'fallback' || scenario === 'config-disabled' || scenario === 'environment-disabled') return 'Qwen3.8-Flash 型号更新说明；本页没有活动或费率结论。';
  return 'Qwen3.8-Flash 页面未提供费用信息。';
}
const qoder = new QoderAdapter({
  runtimeDeps: {
    home: join(temp, 'qoder-home'), candidates: ['/isolated/fixture-qoderclicn'],
    exists: (path) => path === '/isolated/fixture-qoderclicn',
    execFile: async (_file, args) => {
      if (args[0] === '-v') { counts.qoderVersion++; return { stdout: '9.9.9' }; }
      if (args[0] === '--list-models') {
        counts.qoderCatalog++;
        if (scenario === 'failed') throw new Error('isolated fixture catalog failure');
        return { stdout: 'Qwen3.8-Flash\n' };
      }
      throw new Error('unexpected fixture CLI call');
    },
  },
  metadataDeps: {
    homeDir: join(temp, 'qoder-metadata-home'), textFiles: [], runtimeFiles: [], settingsFile: null,
    publicOffer: true, campaignToken: () => undefined,
    fetchImpl: async (input) => {
      counts.qoderMetadata++;
      const status = scenario === 'fee-failed' ? 503 : 200;
      lastQoderOffer = { at: new Date().toISOString(), scenario, version: 'offer-v1', status };
      if (String(input) !== 'https://docs.qoder.cn/events/flashoffer.md') throw new Error('unexpected isolated fixture URL');
      if (status !== 200) return new Response('fixture metadata endpoint failure', { status });
      return new Response(qoderOfferText(), { status, headers: { 'content-type': 'text/markdown' } });
    },
  },
});
const fixture = new ScenarioAdapter();
clearRegistry(); registerAdapter(qoder); registerAdapter(fixture);
const config = buildDefaultConfig([qoder, fixture]);
config.output.port = 43123;
config.adapters['t039-fixture'] = { enabled: true };
const store = new ConfigStore(config);
const hosts: HostDef[] = [{
  id: 'qoder', name: 'Qoder', kind: 'guide', detect: () => ({ installed: true, detail: 'fixture only' }),
  guideLines: () => ['测试提示词'], onboard: async () => { throw new Error('fixture 不改宿主配置'); },
}];
const app = Fastify();
app.get('/__fixture', async (_req, reply) => reply.type('text/html; charset=utf-8').send(managerHtml));
app.get('/__fixture/state', async () => ({ scenario, counts, lastQoderOffer, registered: ['qoder', 't039-fixture'], qoderIsolation: { home: 'temporary fixture directory only', localFiles: [], network: 'disabled except injected in-memory response', credentialSource: 'none' } }));
app.post('/__fixture/scenario', async (req, reply) => {
  const value = (req.body as { scenario?: unknown } | undefined)?.scenario;
  if (typeof value !== 'string' || !scenarios.has(value as Scenario)) return reply.code(400).send({ error: 'unknown scenario' });
  scenario = value as Scenario;
  fixtureEnv.ACCESSMUX_DISABLE_ADAPTERS = scenario === 'environment-disabled' ? 'trae-cn' : '';
  const current = store.get();
  store.set({ ...current, adapters: { ...current.adapters, 't039-fixture': { enabled: scenario !== 'config-disabled' } } });
  return { scenario, counts };
});
mountUiRoutes(app, {
  store, configPath: join(temp, 'config.yaml'),
  uiServices: {
    homeDir: join(temp, 'host-home'), repoRoot: temp, allHosts: () => hosts,
    readPat: () => undefined, runCheckin: async () => [], adapterTimeoutMs: 250, env: fixtureEnv,
  },
});

const managerHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>T039 fixture controls</title>
<style>body{font:15px system-ui,sans-serif;background:#f5f5f7;color:#222;margin:24px;max-width:900px}main{background:white;border:1px solid #ddd;border-radius:14px;padding:20px}h1{font-size:20px}button,select{font:inherit;padding:9px 12px;margin:4px;border:1px solid #ccd;border-radius:8px;background:white}button{background:#0066cc;color:white}pre{white-space:pre-wrap;background:#f5f5f7;padding:12px;border-radius:9px}.links a{margin-right:16px}</style>
<main><h1>T039 隔离状态 fixture</h1><p>这里只切换合成目录/费用源。Qoder 使用注入 CLI、临时 HOME 与禁用网络；没有真实凭据或模型请求。</p>
<p class="links"><a href="/ui/?host=qoder">打开生产 UI 页面（当前宿主 Qoder）</a><a href="/ui?host=qoder">验证 /ui 重定向</a></p>
<label for="scenario">场景</label><select id="scenario">${[...scenarios].map((v) => `<option>${v}</option>`).join('')}</select><button id="apply">切换场景</button><button id="refresh" onclick="document.querySelector('#scenario').dispatchEvent(new Event('change'));window.open('/ui/?host=qoder','_blank')">另开 UI 页面</button>
<p>应用场景后，回 UI 点击“刷新状态”。失败场景用于检查上次目录；恢复页面后仍可从进程内快照看到旧值。</p><pre id="state">读取计数中…</pre></main>
<script>const show=async()=>{const r=await fetch('/__fixture/state');document.querySelector('#state').textContent=JSON.stringify(await r.json(),null,2)};document.querySelector('#apply').onclick=async()=>{await fetch('/__fixture/scenario',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scenario:document.querySelector('#scenario').value})});await show()};setInterval(show,1000);show();</script>`;

const requestedPort = Number(process.argv.find((v) => v.startsWith('--port='))?.slice(7) ?? 0);
await app.listen({ host: '127.0.0.1', port: Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('fixture failed to bind');
process.stdout.write(`UI fixture: http://127.0.0.1:${address.port}/ui/?host=qoder\n`);
process.stdout.write(`Scenario controls: http://127.0.0.1:${address.port}/__fixture\n`);
process.stdout.write('Scenario set includes unknown, fresh-free, fresh-paid, fresh-free-no-rate, fresh-paid-no-rate, expired-last-free, renewed-free, fee-failed, failed, fallback, config-disabled, environment-disabled.\n');
const stop = async () => { await app.close(); await qoder.dispose(); clearRegistry(); rmSync(temp, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', () => { void stop(); }); process.once('SIGTERM', () => { void stop(); });
