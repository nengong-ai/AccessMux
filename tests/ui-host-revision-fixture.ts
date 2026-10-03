import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import { modelDirectoryEntry } from '../src/ui/model-badges.js';
import type { LaunchContext, ProbeResult, ProviderAdapter, ProviderSession } from '../src/adapters/types.js';
import { buildDefaultConfig, ConfigStore } from '../src/config/index.js';
import type { ChatCompletionChunk, ChatMessage, ModelInfo, QuotaState } from '../src/types.js';
import { mountUiRoutes } from '../src/ui/index.js';
import type { HostDef } from '../src/onboard/hosts.js';

const useLocalIcons = process.argv.includes('--local-icons');
const portArg = process.argv.find((arg) => arg.startsWith('--port='))?.slice('--port='.length);
const port = portArg ? Number(portArg) : 0;
const home = mkdtempSync(join(tmpdir(), 'accessmux-t035-host-fixture-'));
const modelData: ModelInfo[] = [
  { id: 'glm-fixture-text', provider: 'fixture', name: '合成文本模型', minCtx: 32_000, inputModalities: ['text'] },
  { id: 'vision-fixture', provider: 'fixture', name: '合成视觉模型', minCtx: 128_000, inputModalities: ['text', 'image'], reasoning: { supported: true, supportedEfforts: ['low'] } },
];
const syntheticPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/pZkAAAAASUVORK5CYII=', 'base64');
class FixtureAdapter implements ProviderAdapter {
  readonly sandbox = 'none' as const;
  readonly displayName = '隔离合成源';
  constructor(readonly id: string) {}
  async probe(): Promise<ProbeResult> { return { availability: 'available', auth: 'logged-in', models: modelData }; }
  async launch(_context: LaunchContext): Promise<ProviderSession> { return { async *runTurn(_input: { model: string; messages: ChatMessage[]; stream: boolean }): AsyncIterable<ChatCompletionChunk> { yield { delta: 'fixture', done: true }; }, async cancel() {} }; }
  async fetchQuota(): Promise<QuotaState> { return 'unknown'; }
  async dispose(): Promise<void> {}
}
const fixtureIds = ['zcode', 'workbuddy', 'dsh', 'claude-code', 'codex', 'hermes'];
const fixtureNames = ['ZCode · 合成状态宿主名称长样例', 'WorkBuddy · 合成状态宿主名称长样例', 'DeepSeek Harness · DSH 合成名称', 'Claude Code CLI · 合成名称', 'Codex CLI · 合成名称', 'Hermes · 合成状态名称长样例'];
const hosts: HostDef[] = fixtureIds.map((id, index) => ({
  id, name: fixtureNames[index]!, kind: index < 3 ? 'auto' : 'guide',
  detect: () => ({ installed: true, ...(index < 3 ? { onboarded: true } : {}) }),
  guideLines: () => ['合成 fixture，仅供界面验收'],
  onboard: async () => { throw new Error('fixture 不修改宿主配置'); },
}));
clearRegistry();
const adapter = new FixtureAdapter('fixture');
registerAdapter(adapter);
const config = buildDefaultConfig([adapter]);
config.output.port = 43123;
config.output.exposeAnthropic = false;
config.adapters.fixture = { enabled: true };
config.models.allow.fixture = { 'glm-fixture-text': true, 'vision-fixture': true };
const store = new ConfigStore(config);
mkdirSync(home, { recursive: true });
const app = Fastify();
app.get('/health', async () => ({ ok: true, adapters: ['fixture'] }));
app.get('/v1/models', async () => ({ object: 'list', data: modelData.map((model) => modelDirectoryEntry('fixture', model, { bridgeImages: false })) }));
mountUiRoutes(app, {
  store,
  configPath: join(home, 'config.yaml'),
  ...(useLocalIcons ? {} : { localAppIconLoader: () => syntheticPng }),
  uiServices: {
    homeDir: home,
    allHosts: () => hosts,
    readPat: () => undefined,
    runCheckin: async () => [],
    adapterTimeoutMs: 50,
  },
});
await app.listen({ host: '127.0.0.1', port: Number.isFinite(port) && port >= 0 ? port : 0 });
const address = app.server.address();
if (!address || typeof address === 'string') throw new Error('无法读取 fixture 监听端口');
process.stdout.write(`合成状态（3 个 onboarded、3 个 unknown；非真实接入声明）：http://127.0.0.1:${address.port}/ui/\n`);
process.stdout.write(`fixture 状态：http://127.0.0.1:${address.port}/api/state\n`);
process.stdout.write(`端口配置 43123；`);
process.stdout.write(useLocalIcons ? '图标模式：仅只读固定本机 App 资源\n' : '图标模式：合成注入，不读取本机 App\n');
const shutdown = async () => { await app.close(); clearRegistry(); rmSync(home, { recursive: true, force: true }); process.exit(0); };
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
