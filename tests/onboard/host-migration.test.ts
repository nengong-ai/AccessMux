import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateAccessMuxEndpoint, type HostContext } from '../../src/onboard/hosts.js';

let home: string; let ctx: HostContext;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'accessmux-migrate-'));
  mkdirSync(join(home, '.workbuddy')); mkdirSync(join(home, '.zcode/v2'), {recursive:true});
  ctx = { homeDir: home, repoRoot: home, baseURL: 'http://127.0.0.1:18081', port: 18081, modelIds: ['trae-cn:synthetic'], fetchFn: async () => {throw new Error('no network');}, now: () => new Date('2026-10-03T01:00:00Z') };
});
afterEach(() => rmSync(home, {recursive:true,force:true}));

describe('恢复时仅迁移本产品URL', () => {
  it('WorkBuddy保留canonicalID/Key/其它provider字节，未知同名条目不动，写前备份', async () => {
    const path = join(home, '.workbuddy/models.json');
    const before = '[\n {"id":"keep","apiKey":"SYNTHETIC-KEEP","url":"https://example.invalid"},\n {"id":"trae-cn:synthetic","name":"AccessMux · 测试","apiKey":"SYNTHETIC-PRIVATE","url":"http://127.0.0.1:18080/v1/chat/completions"},\n {"id":"unknown:keep","name":"AccessMux · 自定义","url":"http://127.0.0.1:18080/v1/chat/completions"}\n]';
    writeFileSync(path,before);
    const result = await migrateAccessMuxEndpoint(ctx,'workbuddy','http://127.0.0.1:18080');
    expect(readFileSync(path,'utf8')).toBe(before.replace('http://127.0.0.1:18080/v1/chat/completions','http://127.0.0.1:18081/v1/chat/completions'));
    expect(readFileSync(result!.files[0]!.backup!,'utf8')).toBe(before);
    const files = readdirSync(join(home,'.workbuddy'));
    expect(await migrateAccessMuxEndpoint(ctx,'workbuddy','http://127.0.0.1:18080')).toBe(null);
    expect(readdirSync(join(home,'.workbuddy'))).toEqual(files);
  });
  it('ZCode只改BaseURL，providerUUID/order/default/modelIDs/Key保持原始字节',async()=>{
    const path=join(home,'.zcode/v2/provider_config.json');
    const before='{"schemaVersion":3,"config":{"providerOrder":["keep","owned-uuid"],"providerConfigRules":{"providerRules":[{"providerId":"keep","providerName":"Other","config":{"api":{"baseUrl":"https://example.invalid"}}},{"providerId":"owned-uuid","providerName":"AccessMux","config":{"access":{"apiKey":"SYNTHETIC-PRIVATE"},"api":{"type":"openai-chat-completions","baseUrl":"http://127.0.0.1:18080/v1"},"personalModelIds":["trae-cn:synthetic"],"modelOrder":["trae-cn:synthetic"]}}]},"defaultModelSelection":{"keep":"unchanged"}}}';
    writeFileSync(path,before,{mode:0o600});
    const result=await migrateAccessMuxEndpoint(ctx,'zcode','http://127.0.0.1:18080');
    expect(readFileSync(path,'utf8')).toBe(before.replace('http://127.0.0.1:18080/v1','http://127.0.0.1:18081/v1'));
    expect(readFileSync(result!.files[0]!.backup!,'utf8')).toBe(before);
  });
  it('不迁移外部地址或不明canonicalID，不写备份',async()=>{
    const path=join(home,'.workbuddy/models.json'); const before='[{"id":"private","name":"AccessMux · unknown","url":"http://127.0.0.1:18080/v1/chat/completions"}]';
    writeFileSync(path,before);
    expect(await migrateAccessMuxEndpoint(ctx,'workbuddy','https://example.invalid')).toBe(null);
    expect(await migrateAccessMuxEndpoint(ctx,'workbuddy','http://127.0.0.1:18080')).toBe(null);
    expect(readFileSync(path,'utf8')).toBe(before); expect(readdirSync(join(home,'.workbuddy'))).toEqual(['models.json']);
  });
});
