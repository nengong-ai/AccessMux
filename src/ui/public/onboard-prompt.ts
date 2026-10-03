export interface OnboardPromptInput {
  /** 只作生成页面所在机器的地址提示；接收者必须重新确认自己的服务。 */
  uiUrlHint?: string;
}

function localAddressHint(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' || url.username || url.password || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
    return url.origin;
  } catch { return undefined; }
}

export function buildOnboardPrompt(input: OnboardPromptInput = {}): string {
  const hint = localAddressHint(input.uiUrlHint);
  return `请在你当前运行的 Agent 宿主中接入本机 AccessMux，只修改你自己正在使用的宿主，不改其它应用。这个任务由接收它的 Agent 根据当前会话/运行环境识别自己的宿主，不需要用户先选择宿主；只有你确实无法识别自己运行在哪个宿主时，才向我询问一次。

这份提示词可以转发给其他机器使用，不携带生成页面的模型清单、显示名、费用或免费快照。所有接入内容都必须在执行时从接收机器重新获取。

先确认你自己这台机器的服务地址：
- 优先使用本次安装输出的 ACCESSMUX_UI_URL；如果没有，从用户提供的服务地址或本机可见的 AccessMux 启动信息确认。不要读取密钥、私有配置、账号文件或进程环境来寻找地址，不要猜另一台机器的端口；缺少地址时只询问服务 URL。
${hint ? `- 生成此提示词的页面地址提示：${hint}/ui/。它只属于生成页面的机器；转发到其他机器后不能直接沿用，端口也可能不同。\n` : ''}- 对候选地址只读 GET /health，核对 HTTP 成功且返回 ok: true、service: "accessmux"；再 GET /v1/models 获取本机当前目录。不要用只有进程存活或端口开放的结果替代检查。
- 确认地址后，以实际服务 origin 加 /v1 作为 OpenAI Base URL；若宿主要求完整请求地址，使用同一 origin 加 /v1/chat/completions。

模型与展示字段只来自执行时的目录：
- 直接使用这次 GET /v1/models 返回的 data 数组及原始完整 id（adapter:model）作为 canonical 路由 ID，不改写、不拼造 ID。可以接入多个模型；支持该机器已有的自定义来源，但不能把自定义 provider 宣称为 Qoder 官方模型或每个人都有的模型。
- 显示名、费用和免费状态只采用本次响应实际提供的展示字段。缺少字段或费用待更新时明确未确认；不从模型名字、历史活动、0 倍率片段或其他机器的快照推断当前免费，不补写旧费率或承诺。
- 目录为空、请求失败或结构不合法时，保留宿主配置，说明本机没有可接入的当前目录，并引导在 UI 检查来源后刷新。不要猜模型、使用旧快照兜底或要求用户重写模型清单。
- 复制后目录可能已经变化：写配置前重新 GET /v1/models。若目标 ID 已失效或不在新目录中，停止写入并说明；重新获取成功后，只对仍有效的模型幂等增量协调，不重复添加，也不删除用户已有供应商或默认模型。
- 按你正在运行的宿主当前版本官方 schema 核实可用能力；不要因图标推断能力。此桥接提供 Chat Completions，不代表完整 Agent 工具调用或 Responses API 兼容。只有宿主明确需要且有当前服务已启用的公开证据时才使用 Anthropic 兼容端点；没有证据时说明限制，不猜测启用状态或擅自开协议。

配置修改要求：
- 优先使用宿主官方、当前版本支持的配置入口与 schema。先运行 accessmux help；若本次是源码安装且没有全局命令，则在此次实际仓库运行 node dist/cli/index.js help。按安装上下文选择已支持的入口，只在确认支持后对你当前这个宿主做有界操作；不要猜 flags，也不要运行会自动修改所有宿主的通用向导。
- 写入前备份现有配置；只新增 AccessMux 条目，不删除供应商、不覆盖默认模型。不要读取含密钥的整个配置文件；使用宿主官方配置接口，或仅在能够隔离 AccessMux 非秘密字段且不读取其它字段时安全纯增，否则说明需要用户在官方界面完成。确保重复执行不会产生重复条目；已有 AccessMux 条目只更新本次目录可确认的非秘密展示字段，不改旧 ID、key、默认模型或其它字段。仅在确认旧本地 URL 属于当前宿主的 AccessMux 条目、且新地址已通过服务身份检查时，才把它同步到实际服务地址；其它 provider 的 URL 保持不动。无法安全更新时保留原条目并说明限制。
- 本地 API Key 使用非秘密占位值 local。不要读取、复制或打印任何真实 token/密钥；不要写入 MiniMax 真实 Key，不增加云端服务或遥测。
- 验证仅做只读 GET /health、GET /v1/models。不要自动发可能计费的推理请求，不靠调用扣费来验证免费；若需要推理自检，先说明会消耗额度并征得我同意。不要退出或重启正在运行的宿主。
- 不要替我执行重启。配置完成后提示我刷新模型列表；若没有出现 AccessMux，完全退出并重新打开应用。命令行宿主可能需要新开会话。

最终报告要区分已完成与未完成：列出实际服务地址、宿主、导入模型数量、实际修改文件、备份位置，以及是否需要我刷新或重开宿主；说明模型目录和费用来自本机执行时查询，不得声称未实际验证的操作成功。`;
}
