import { describe, expect, it } from 'vitest';
import { buildOnboardPrompt } from '../src/ui/public/onboard-prompt.js';

const base = { uiUrlHint: 'http://127.0.0.1:43123/ui/' };

describe('统一宿主接入提示词', () => {
  it('思考能力取当前桥接控制与宿主交集，不猜档位或关闭思考', () => {
    const prompt = buildOnboardPrompt(base);
    for (const text of ['bridgeReasoning', 'supportedEfforts', '本机宿主 schema 值域的交集', '不默认关闭模型思考', '单档只配置该档', '不配置 off', 'reasoning_effort', '已有 AccessMux 只更新非秘密能力字段', '不自动执行付费验证']) expect(prompt).toContain(text);
  });
  it('本机地址只作提示，接收机器独立确认服务与实时 canonical 目录', () => {
    const prompt = buildOnboardPrompt(base);
    expect(prompt).toContain('http://127.0.0.1:43123/ui/');
    expect(prompt).toContain('转发到其他机器后不能直接沿用');
    expect(prompt).toContain('ACCESSMUX_UI_URL');
    expect(prompt).toContain('GET /health');
    expect(prompt).toContain('service: "accessmux"');
    expect(prompt).toContain('GET /v1/models');
    expect(prompt).toContain('使用同一 origin 加 /v1/chat/completions');
    expect(prompt).toContain('canonical 路由 ID');
    expect(prompt).toContain('只有你确实无法识别自己运行在哪个宿主时');
  });
  it('两台合成机器的目录、费用与协议状态不同，也不传播快照', () => {
    const machineA = { uiUrlHint: 'http://127.0.0.1:43123', exposeAnthropic: true, models: [
      { id: 'qoder:opencode-go/private-qwen-max', displayName: '用户私配模型甲', fees: '0.29× 限时免费' },
    ] };
    const machineB = { uiUrlHint: 'http://127.0.0.1:49152', exposeAnthropic: false, models: [
      { id: 'fixture:other-machine-model', displayName: '另一台模型乙', fees: '2× 不免费' },
    ] };
    const promptA = buildOnboardPrompt(machineA);
    const promptB = buildOnboardPrompt(machineB);
    expect(promptA.replace('43123', '49152')).toBe(promptB);
    for (const value of ['qoder:opencode-go/private-qwen-max', '用户私配模型甲', '0.29×', 'fixture:other-machine-model', '另一台模型乙', '2×']) {
      expect(promptA).not.toContain(value);
      expect(promptB).not.toContain(value);
    }
    expect(promptA).not.toContain('Anthropic 兼容端点已在');
    expect(promptA).toContain('不猜测启用状态');
    expect(promptA).toContain('不能把自定义 provider 宣称为 Qoder 官方模型');
    expect(promptA).toContain('可以接入多个模型');
  });
  it('复制后目录变化要求重新获取；失效 ID 不写入，不从旧快照补模型或费用', () => {
    const prompt = buildOnboardPrompt(base);
    expect(prompt).toContain('写配置前重新 GET /v1/models');
    expect(prompt).toContain('若目标 ID 已失效或不在新目录中，停止写入');
    expect(prompt).toContain('幂等增量协调');
    expect(prompt).toContain('不重复添加');
    expect(prompt).toContain('不补写旧费率或承诺');
  });
  it('空目录、请求失败和未确认费用分别说明，保留宿主配置', () => {
    const emptyMachine = { ...base, models: [] };
    const prompt = buildOnboardPrompt(emptyMachine);
    expect(prompt).toContain('目录为空、请求失败或结构不合法时，保留宿主配置');
    expect(prompt).toContain('不要猜模型、使用旧快照兜底');
    expect(prompt).toContain('缺少字段或费用待更新时明确未确认');
    expect(prompt).toContain('不靠调用扣费来验证免费');
  });
  it('没有地址也能生成可转发模板；不编造固定端口', () => {
    const prompt = buildOnboardPrompt();
    expect(prompt).toContain('缺少地址时只询问服务 URL');
    expect(prompt).not.toContain('http://');
    expect(prompt).not.toContain('8080');
  });
  it.each([
    'https://example.com/ui/',
    'http://user:secret@127.0.0.1:43123/ui/',
    'javascript:alert(1)',
    'not-a-url',
  ])('非本机或含秘密的地址不会混进提示词：%s', (uiUrlHint) => {
    const prompt = buildOnboardPrompt({ uiUrlHint });
    expect(prompt).not.toContain('生成此提示词的页面地址提示');
    expect(prompt).not.toContain(uiUrlHint);
  });
  it('地址提示只保留 loopback origin，查询串和路径不带入', () => {
    const prompt = buildOnboardPrompt({ uiUrlHint: 'http://[::1]:43123/ui/private-name?token=synthetic-secret' });
    expect(prompt).toContain('http://[::1]:43123/ui/');
    expect(prompt).not.toContain('private-name');
    expect(prompt).not.toContain('synthetic-secret');
  });
  it('不编造 flags 或字段，要求备份、单宿主修改并避免真实密钥、计费和重启', () => {
    const prompt = buildOnboardPrompt(base);
    expect(prompt).toContain('accessmux help');
    expect(prompt).toContain('node dist/cli/index.js help');
    expect(prompt).not.toContain('onboard --help');
    expect(prompt).toContain('写入前备份');
    expect(prompt).toContain('不改其它应用');
    expect(prompt).toContain('只新增 AccessMux 条目');
    expect(prompt).toContain('local');
    expect(prompt).toContain('MiniMax 真实 Key');
    expect(prompt).toContain('不要自动发可能计费的推理请求');
    expect(prompt).toContain('不要退出或重启正在运行的宿主');
    expect(prompt).toContain('不要读取密钥、私有配置、账号文件或进程环境来寻找地址');
    expect(prompt).toContain('不要读取含密钥的整个配置文件');
    expect(prompt).toContain('仅在确认旧本地 URL 属于当前宿主的 AccessMux 条目');
    expect(prompt).toContain('其它 provider 的 URL 保持不动');
    expect(prompt).not.toMatch(/--(?:host|config|port|yes|all)\b/);
    expect(prompt).not.toMatch(/\/Users\/[^\s/]+|\/home\/[^\s/]+|sk-[A-Za-z0-9]/);
  });
});
