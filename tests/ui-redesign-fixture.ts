import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import type { LaunchContext, ProbeResult, ProviderAdapter, ProviderSession } from '../src/adapters/types.js';
import { buildDefaultConfig, ConfigStore } from '../src/config/index.js';
import type { ChatCompletionChunk, ChatMessage, ModelInfo, QuotaState } from '../src/types.js';
import { mountUiRoutes } from '../src/ui/index.js';
import type { HostDef } from '../src/onboard/hosts.js';

const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZkAAAAASUVORK5CYII=', 'base64');
let saveAttempts = 0;
let successfulSaves = 0;
let fixtureSaveMode: 'normal' | 'failure' | 'delay' = 'normal';

class FixtureAdapter implements ProviderAdapter {
  readonly sandbox = 'none' as const;
  constructor(readonly id: string, readonly displayName: string, private readonly models: ModelInfo[], readonly bridgeImages: boolean) {}
  async probe(): Promise<ProbeResult> { return { availability: this.models.length === 0 ? 'unavailable' : 'available', auth: 'logged-in', models: this.models }; }
  async launch(_context: LaunchContext): Promise<ProviderSession> {
    return { async *runTurn(_input: { model: string; messages: ChatMessage[]; stream: boolean }): AsyncIterable<ChatCompletionChunk> { yield { delta: 'fixture', done: true }; }, async cancel() {} };
  }
  async fetchQuota(): Promise<QuotaState> { return 'unknown'; }
  async dispose(): Promise<void> {}
}
function fixtureHost(id: string, name: string): HostDef {
  return { id, name, kind: 'guide', detect: () => ({ installed: true }), guideLines: () => ['仅供 T035 界面验收'], onboard: async () => { throw new Error('fixture 不执行宿主接入'); } };
}
function sampleModels(prefix: string, free: boolean, image: boolean): ModelInfo[] {
  const ids = prefix === 'workbuddy' ? ['glm-5.3', 'deepseek-v4.1-flash', 'qwen3.5-plus', 'kimi-k2.5'] : ['deepseek-v4.1', 'qwen3.5-coder', 'kimi-k2-thinking', 'glm-5.1'];
  return ids.map((id, index) => ({
    id, provider: prefix, name: `${id.toUpperCase()} 合成测试模型 ${index + 1}`,
    minCtx: [1_000_000, 200_000, 128_000, 32_000][index],
    ...(index === 0 && free ? { free: true, priceScope: 'entitlement' as const } : index === 1 ? { priceMultiplier: 0.5 } : {}),
    ...(index === 2 ? { tags: ['unverified'] } : {}),
    ...(index === 3 ? { activityLabels: ['限时活动'] } : {}),
    inputModalities: (image || (prefix === 'qoder' && index === 0)) ? ['text', 'image'] as const : ['text'] as const,
    ...(image && index === 0 ? { bridgeInputModalities: ['text', 'image'] as const } : { bridgeInputModalities: ['text'] as const }),
    reasoning: { supported: index < 3, supportedEfforts: index < 3 ? ['low', 'high'] : [] },
    description: `仅用于 T035 UI 返工验收的合成模型 ${id}`,
  }));
}
const scenario = process.argv[2] ?? 'normal';
const requestedPort = Number(process.argv[3] ?? 0);
if (!['normal', 'empty', 'slow', 'save-failure'].includes(scenario)) throw new Error('场景需为 normal、empty、slow 或 save-failure');
if (scenario === 'save-failure') fixtureSaveMode = 'failure';
const home = mkdtempSync(join(tmpdir(), 'accessmux-t035-fixture-'));
mkdirSync(home, { recursive: true });
const adapters: FixtureAdapter[] = [
  new FixtureAdapter('workbuddy', 'WorkBuddy（合成测试源）', scenario === 'empty' ? [] : sampleModels('workbuddy', true, true), true),
  new FixtureAdapter('qoder', 'Qoder（合成测试源）', scenario === 'empty' ? [] : sampleModels('qoder', false, false), false),
];
clearRegistry(); adapters.forEach(registerAdapter);
const baseConfig = buildDefaultConfig(adapters);
baseConfig.adapters.workbuddy = { enabled: true };
baseConfig.models.allow.workbuddy = { 'glm-5.3': true, 'deepseek-v4.1-flash': false, 'qwen3.5-plus': true, 'kimi-k2.5': true };
baseConfig.models.allow.qoder = { 'deepseek-v4.1': true, 'qwen3.5-coder': true, 'kimi-k2-thinking': true, 'glm-5.1': true };
const checkinEnabled = process.argv.includes('--checkin-enabled');
if (checkinEnabled) baseConfig.checkin = { sources: { workbuddy: true, qoder: false, zcode: false } };
const store = new ConfigStore(baseConfig);
const app = Fastify();
app.addHook('onRequest', async (request, reply) => {
  if (request.method === 'POST' && request.url.startsWith('/api/config')) {
    saveAttempts++;
    if (fixtureSaveMode === 'delay') await new Promise((resolve) => setTimeout(resolve, 2_500));
    if (fixtureSaveMode === 'failure') return reply.code(500).send({ error: { message: '合成场景：保存失败' } });
  }
  if (scenario === 'slow' && request.url.startsWith('/api/bootstrap')) await new Promise((resolve) => setTimeout(resolve, 2_500));
});
app.addHook('onResponse', async (request, reply) => {
  if (request.method === 'POST' && request.url === '/api/config' && reply.statusCode < 400) successfulSaves++;
});
app.get('/fixture', async () => ({ scenario, sources: adapters.map(({ id, displayName, bridgeImages }) => ({ id, displayName, bridgeImages })), saveAttempts, successfulSaves, config: store.get() }));
app.post('/fixture/save-mode', async (request, reply) => {
  const mode = (request.body as { mode?: string } | undefined)?.mode;
  if (mode !== 'normal' && mode !== 'failure' && mode !== 'delay') return reply.code(400).send({ error: '模式无效' });
  fixtureSaveMode = mode;
  return { mode: fixtureSaveMode };
});
app.get('/fixture/', async (_request, reply) => reply.type('text/html; charset=utf-8').send(`<!doctype html><meta charset="utf-8"><title>T035 fixture 控制</title><h1>T035 fixture 控制</h1><p>仅合成测试配置；图片是合成 PNG，不代表 WorkBuddy 图标。</p><p id="state">加载中</p><button data-mode="normal">正常保存</button><button data-mode="failure">保存失败</button><button data-mode="delay">延迟保存</button><script>async function refresh(){const s=await fetch('/fixture').then(r=>r.json());document.querySelector('#state').textContent=JSON.stringify(s)}document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{await fetch('/fixture/save-mode',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:b.dataset.mode})});await refresh()});refresh()</script>`));
mountUiRoutes(app, {
  store, configPath: join(home, 'config.yaml'),
  workBuddyIconLoader: () => syntheticPng,
  uiServices: {
    homeDir: home, repoRoot: process.cwd(), allHosts: () => [fixtureHost('workbuddy', 'WorkBuddy（合成宿主）'), fixtureHost('qoder', 'Qoder（合成宿主）')],
    readPat: () => undefined,
    runCheckin: async (options) => [{ source: options.sources?.workbuddy ? 'workbuddy' : 'qoder', verdict: 'claimed', message: 'fixture 合成领取', checkedAt: new Date().toISOString() }],
  },
});
await app.listen({ host: '127.0.0.1', port: Number.isFinite(requestedPort) ? requestedPort : 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('无法读取 fixture 监听端口');
process.stdout.write(`场景 ${scenario}: http://127.0.0.1:${address.port}/ui/ · fixture 状态 /fixture\n`);
const shutdown = async () => { await app.close(); clearRegistry(); rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
