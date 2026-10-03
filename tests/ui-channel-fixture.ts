import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildServer } from '../src/protocol/server.js';
import { buildDefaultConfig, ConfigStore } from '../src/config/index.js';
import { clearRegistry, registerAdapter } from '../src/adapters/registry.js';
import { FakeAdapter } from './protocol/fake-adapter.js';

clearRegistry();
let unavailable = false;
const adapter = new FakeAdapter({ id: 'zcode', displayName: 'ZCode · 合成测试', modelIds: ['synthetic-model'] });
Object.assign(adapter, {
  formSnapshot: () => ({
    form: unavailable ? 'unavailable' : 'direct',
    fallbackAvailable: false,
    tools: 'disabled',
    ...(unavailable ? { reason: '合成 405/3012：未能可靠限制本地工具，兜底禁用' } : {}),
  }),
});
registerAdapter(adapter);
const root = mkdtempSync(join(tmpdir(), 'accessmux-r031-ui-'));
const configPath = join(root, 'config.yaml');
writeFileSync(configPath, 'synthetic fixture only', { mode: 0o600 });
const app = buildServer({ store: new ConfigStore(buildDefaultConfig([adapter])), configPath });
app.post('/fixture/unavailable', async () => { unavailable = true; return { ok: true }; });
console.log(await app.listen({ host: '127.0.0.1', port: 0 }));
process.on('SIGTERM', () => { void app.close().then(() => process.exit(0)); });
