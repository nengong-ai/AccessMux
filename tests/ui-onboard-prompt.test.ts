import { describe, expect, it } from 'vitest';
import { buildOnboardPrompt } from '../src/ui/public/onboard-prompt.js';

const base = {
  port: 43123, exposeAnthropic: false, models: [
    { id: 'fixture:model-one', displayName: '模型一 · 限时免费' },
    { id: 'qoder:model-two', displayName: '模型二', fees: '0.29×' },
  ],
};

describe('统一宿主接入提示词', () => {
  it('使用配置端口和真实模型 ID，并区分 chat-completions 完整地址', () => {
    const prompt = buildOnboardPrompt(base);
    expect(prompt).toContain('http://127.0.0.1:43123/v1');
    expect(prompt).toContain('http://127.0.0.1:43123/v1/chat/completions');
    expect(prompt).toContain('fixture:model-one');
    expect(prompt).toContain('qoder:model-two');
    expect(prompt).not.toContain('window.location.port');
    expect(prompt).toContain('只有你确实无法识别自己运行在哪个宿主时');
    expect(prompt).toContain('限时免费');
  });
  it('Anthropic 默认关闭时不宣称可用，开启时仍要求核对具体 API', () => {
    expect(buildOnboardPrompt(base)).toContain('Anthropic 兼容端点当前未开启');
    const enabled = buildOnboardPrompt({ ...base, exposeAnthropic: true });
    expect(enabled).toContain('Anthropic 兼容端点已在 AccessMux 配置中开启');
    expect(enabled).toContain('核对它支持的具体 API');
  });
  it('不编造 flags 或字段，要求备份、单宿主修改并避免真实密钥、计费和重启', () => {
    const prompt = buildOnboardPrompt(base);
    expect(prompt).toContain('accessmux onboard --help');
    expect(prompt).toContain('写入前备份');
    expect(prompt).toContain('不改其它应用');
    expect(prompt).toContain('只新增 AccessMux 条目');
    expect(prompt).toContain('local');
    expect(prompt).toContain('MiniMax 真实 Key');
    expect(prompt).toContain('不要自动发可能计费的推理请求');
    expect(prompt).toContain('不要退出或重启正在运行的宿主');
    expect(prompt).not.toMatch(/--(?:host|config|port|yes|all)\b/);
    expect(prompt).not.toMatch(/\/Users\/[^\s/]+|\/home\/[^\s/]+|sk-[A-Za-z0-9]/);
  });
});
