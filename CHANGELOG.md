# Changelog

## 0.1.0 · 首发

源码首发准备日期：2026-10-03；实际上传以 GitHub 提交为准。npm / Release 尚未发布。

### 功能

- 五个模型源、六个独立 adapter：WorkBuddy、Trae CN、Trae Global、ZCode、Qoder、OpenCode。每个源独立探测和启停；模型清单跟随上游与账号权益变化。
- 本机 OpenAI Chat Completions 和 Anthropic Messages 双协议端点，统一 `<adapterId>:<modelId>` 路由。服务仅监听 `127.0.0.1`，提供健康检查、模型清单与浏览器配置页。
- OpenAI 端点支持非流式和 SSE 流式，包含收尾帧与 usage 帧；客户端断开会取消上游任务，正常退出清理子进程。
- WorkBuddy、Trae、OpenCode、ZCode 接通上游真实 token 用量；缓存用量按协议口径转换。Qoder 无上游计量，用本地估算并明确标记 `estimated: true`；其他缺少计量的响应同样标记估算。
- `accessmux onboard` 一键检测宿主、接入、自检，包含写前备份、键序保护、幂等跳过和回滚指引。ZCode、WorkBuddy 自动注册；DSH 插件接入需要源码发行形态；其他宿主提供配置指引。
- `accessmux checkin` 支持 WorkBuddy 季性活动签到、Qoder PAT 正门领取；未登录、未配 PAT、活动关闭时优雅跳过。Qoder PAT 独立文件权限 0600；ZCode 免费额度每日自动发放，活动只探测并提示去官方客户端。
- 三档进程形态均无需打开源应用 GUI：Trae / ZCode 默认直连零额外进程；WorkBuddy 首次取凭据瞬时启动官方 helper；OpenCode / Qoder 使用隔离的无界面 CLI 子进程。详见 README 卖点矩阵。
- Node.js 22+，MIT 许可，GitHub 源码安装；npm 全局 CLI 和 GitHub Release tgz 是后续发布渠道；`--version` / `-v` 输出包版本。

### 已知限制

- MVP 多数源 chat-only；图片输入按模型能力开放（ZCode 直连 / OpenCode / Qoder），不是完整工具调用或 agent 协议代理。Trae 的 SOLO tools 会被重写。
- **Anthropic Messages 当前只支持非流式；`stream: true` 返回 501。** 流式支持不能笼统理解成双协议均支持。
- WorkBuddy 会剥离宿主 system 提示词来适配上游，宿主 agent 行为约定可能丢失。
- OpenCode 回复是整段返回，不是真正逐 token 流式；免费模型与可用性由上游决定。
- Qoder 单租户；usage 为估算，清单混免费和权益模型。
- ZCode 清单按账号权益过滤；默认附带官方 harness 前缀（1253 字符、不改写）。405/3012 报不可用，app-server 兜底因无法可靠限制本地工具权限而硬禁用。
- **npm / Release tgz 不带 integrations/，不提供 DSH 插件自动接入所需实体；需要 DSH 时使用已审计的源码安装。** 包内 install.sh 是源码安装脚本，不用于运行时 tgz。
- 桌面应用依赖、登录态、免费活动、上游协议都可能变化；没有凭据的新机器不会凭空获得额度。主要桌面桥接链路已在 macOS 验证，不保证其他平台同等支持。
- Trae 签到涉及设备身份校验，不提供；月度积分自动发放不受影响。不提供账号共享、Key 转卖或设备级反作弊模拟。
