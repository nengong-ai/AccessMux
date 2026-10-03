export interface OnboardPromptModel {
  id: string;
  displayName: string;
  fees?: string;
}

export interface OnboardPromptInput {
  port: number;
  exposeAnthropic: boolean;
  models: OnboardPromptModel[];
}

export function buildOnboardPrompt(input: OnboardPromptInput): string {
  const endpoint = `http://127.0.0.1:${input.port}/v1`;
  const models = input.models.length
    ? input.models.map((model) => `- ${model.id} — ${model.displayName}${model.fees ? `（${model.fees}）` : ''}`).join('\n')
    : '- 当前没有已启用模型；先读取 /v1/models 的真实结果';
  const anthropic = input.exposeAnthropic
    ? 'Anthropic 兼容端点已在 AccessMux 配置中开启；只有当前宿主明确需要时才使用，并核对它支持的具体 API。'
    : 'Anthropic 兼容端点当前未开启。默认使用 OpenAI Chat Completions；如需 Anthropic 协议，先向我确认启用，不要配置当前不可用的协议。';
  return `请在你当前运行的 Agent 宿主中接入本机 AccessMux，只修改你自己正在使用的宿主，不改其它应用。这个任务由接收它的 Agent 根据当前会话/运行环境识别自己的宿主，不需要用户先选择宿主；只有你确实无法识别自己运行在哪个宿主时，才向我询问一次。

AccessMux 本机地址：
- OpenAI Base URL：${endpoint}
- Chat Completions 完整 URL（若宿主要求完整地址）：${endpoint}/chat/completions
- 只读检查：GET http://127.0.0.1:${input.port}/health 和 GET ${endpoint}/models
- 使用 /v1/models 返回的真实完整模型 ID（adapter:model）作为路由 ID，不改写 ID。当前就绪且启用模型快照：
${models}
- 显示名与费用/优惠说明供人识别；请求仍使用上面的原始 ID。免费、夜间免费、限时优惠可能有时段限制，未确认或待更新信息不要当成当前承诺。
- 按你正在运行的宿主当前版本官方 schema 核实可用能力；不要因图标推断能力，不覆盖现有默认模型。此桥接提供 Chat Completions，不代表完整 Agent 工具调用或 Responses API 兼容。
- ${anthropic}

配置修改要求：
- 优先使用宿主官方、当前版本支持的配置入口与 schema。若 accessmux onboard 可用，先运行 accessmux onboard --help，只在确认支持后对你当前这个宿主做有界操作；不要猜 flags，也不要运行会自动修改所有宿主的通用向导。
- 写入前备份现有配置；只新增 AccessMux 条目，不删除供应商、不覆盖默认模型；确保重复执行不会产生重复条目。若配置中已有 AccessMux 条目，只更新与本次真实目录明确对应的显示名/活动说明，不改 ID、URL、key、默认模型或其它字段；如果无法用宿主官方格式安全更新，则保留原条目并说明限制。
- 本地 API Key 使用非秘密占位值 local。不要读取、复制或打印任何真实 token/密钥；不要写入 MiniMax 真实 Key，不增加云端服务或遥测。
- 先做只读 GET /health、GET /v1/models 验证。不要自动发可能计费的推理请求；若需要推理自检，先说明会消耗额度并征得我同意。不要退出或重启正在运行的宿主。
- 不要替我执行重启。配置完成后提示我刷新模型列表；若没有出现 AccessMux，完全退出并重新打开应用。命令行宿主可能需要新开会话。

最终报告要区分已完成与未完成：列出实际修改文件、备份位置、导入模型数量，以及是否需要我刷新或重开宿主；不得声称未实际验证的操作成功。`;
}
