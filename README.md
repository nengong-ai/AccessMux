# AccessMux · 0.1.0

MIT（本项目代码；移植部分保留上游条款）· Node.js 22+ · [第三方声明](NOTICE) · [更新记录](CHANGELOG.md) · [发布手册](docs/release-runbook.md)

把桌面 IDE 里"锁定"的模型额度，经本机一个 OpenAI / Anthropic 兼容端点，开放给任意能配
Base URL 的 Agent 宿主消费——让限定用量在不同 Agent 之间流动。

**不用打开被桥接的应用**：只要这台机器上登录过一次对应账号，额度就能被任意宿主消费。
AccessMux 本身是后台服务，没有桌面 GUI，也没有要盯着的终端界面。

- 想装：看 [INSTALL.md](INSTALL.md)（含"复制一段话让 Agent 替你装"的模板）
- 想接具体宿主：先用 `accessmux onboard --dry-run` 查看接入计划；[源码文档](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 提供逐宿主说明
- 想懂原理：看 [源码架构文档](https://github.com/nengong-ai/AccessMux/blob/main/docs/architecture.md)

npm 和 Release tgz 仅带运行时与发布说明，不带内部任务、回执、研究材料或 DSH 插件。
需要 DSH 插件时请走源码安装，并使用源码目录内的 CLI；仅切换当前目录再运行 npm 版命令无效。
源码发行包含 `src/`、合成测试、构建配置、宿主文档和 `integrations/dsh-accessmux-connect/`。
源码首发使用全新发行仓库，只有审计后的干净首发历史；不上传原开发历史、内部记录或本机状态。
GitHub 获取与安装以仓库实际内容为准；npm 和 Release 尚未发布，不能把包名当成在线可用证明。
OpenCode 适配机制锚定 MIT 许可的官方 opencode 项目（[第三方声明](NOTICE) 第 4 条）。

## 30 秒安装

**让 Agent 代装（推荐）**：打开 [INSTALL.md](INSTALL.md)，把第一节那段话复制给你的 Agent，
直接发真实 GitHub HTTPS 仓库链接，说“帮我安装并接入你自己，装好打开 UI”。
Agent 从真实会话传入当前宿主，只配置这一个；不确定时只问一次。
安装前检查仓库来源与文件，见安装手册。

**自己动手（npm 发布后）**：没装 Node 的 macOS 用户先执行 `brew install node`，再运行：

```sh
npm install -g accessmux@0.1.0
accessmux --version
accessmux onboard --dry-run
accessmux onboard --host workbuddy --yes
```

`--version` 应输出 `0.1.0`。没有源或宿主的新机器可正常安装，但不会凭空得到模型额度；
先安装并登录至少一个支持的源，或装免登录的 opencode CLI。
Release 附件也可安装：`npm install -g "<下载目录>/accessmux-0.1.0.tgz"`。

**源码安装（含 DSH 插件）**：

```sh
cd "<AccessMux 源码目录>"
./install.sh --host workbuddy --yes
```

install.sh 只用于完整源码目录；不要在 npm 包或 Release tgz 解包目录运行它。
源码手动安装可用 `npm install`、`npm run build`、`node dist/cli/index.js onboard`。
向导自动启动/复用后台服务并打开真实 UI 地址。Agent 有内置浏览器时加 `--no-open-ui`，
再打开输出的 `ACCESSMUX_UI_URL`，避免重复开页。已接入也可重跑向导来开页；不要再次
前台启动同端口 serve。其它宿主替换 `--host`；全部接入用 `--all-hosts --yes`。

装完：打开你的 Agent（ZCode / Claude Code / WorkBuddy / DSH / Codex CLI / Hermes…）→
模型选择器里选 **AccessMux** 组（或 `AccessMux ·` 开头的模型）→ 正常发消息。
**选的模型来自哪家额度，就在花哪家额度。**

## 卖点：三档进程形态，五个源全部零 GUI

被桥接的应用不用开，安装向导会打开本地 UI——区别只在"为了拿到额度，额外起了什么"：

| 档位 | 含义 | 本项目的源 |
|---|---|---|
| **零进程** | 一次请求就是一次 HTTPS 调用，AccessMux 守护之外不起任何进程 | Trae CN / Trae Global、ZCode（直连形态，默认） |
| **瞬时 spawn** | 只在需要时拉一下官方组件取凭据材料，拿到即回收，不留常驻 | WorkBuddy（首次解密凭据时拉官方 Electron helper，payload 到手即杀，之后进程内复用） |
| **无界面子进程** | 官方 headless 子进程，无窗口、无 TUI | OpenCode（隔离 `opencode serve --pure`，闲置回收）；Qoder（每次请求一条全新 CLI 会话，结束即回收，避免不同对话串扰） |

跨档共同点：

- **零 GUI**：不需要打开被桥接应用的界面（登录过一次即可，额度属于你的账号）；
- **无 TUI**：AccessMux 本体是后台守护进程 + HTTP 端点，配置界面是浏览器里的本地网页
  （`http://127.0.0.1:8080/ui`），不是终端界面；
- **不绑宿主**：输出端是标准 OpenAI / Anthropic 兼容端点，谁都能接。
- **图片输入按源点亮**（T036）：OpenAI `image_url` 与 Anthropic `image` block 双格式收图（http 链接或 base64 data URI），单张 5MB / 单边 8000px / 单请求 8 张上限；ZCode（GLM-5.3-Flash）、OpenCode、Qoder（Qwen3.8-Flash）已真机图片往返点亮，`/v1/models` 里 `supportsImages: true` 的模型才收图，未点亮的源带图请求明确报错不静默丢图。
- **本地模型管理**：`/ui` 可看宿主接入、签到状态，按源搜索与勾选模型；上下文优先平台值、再用厂商规格，卡片直接显示上下文/免费/倍率，“调用待验证”单列，来源与活动更新时间留在数据层，不编余额、不上传。

一句话取舍：**原生应用内的体验永远最好（开箱即用），AccessMux 解决的是额度散落、多套餐、
低配内存（8-16GB 开不动多个 Agent）、工作流习惯留在单一 Agent 的场景**——它是补充，不是替代。

## 支持的源

| 源 | 形态 | 额度来源 | 主要限制 |
|---|---|---|---|
| **WorkBuddy** | LockedUsage（桥接） | 本机 WorkBuddy 账号额度 | 需装 WorkBuddy 5.6+（凭据解密要应用本体）；chat-only，不支持 tools/agent 任务；经第三方宿主转发时上游按 system prompt 指纹拦截，AccessMux 自动剥离宿主 system 提示词（纯问答无感，agent 行为约定会丢） |
| **Trae CN / Trae Global** | LockedUsage（桥接） | 本机 Trae IDE 账号额度 | CN 与 Global 是两个独立 adapter、各自可单独关（国内使用默认走 CN 端点，不默认数据出境）；不模拟设备级反作弊 header；模型清单跟随 Trae 目录刷新 |
| **Qoder** | FreeTier（依附本机 CLI） | 本机 Qoder 账号的免费 / 权益额度 | 需装 Qoder 桌面版；单租户（一个 AccessMux 实例 = 一个 Qoder 账号）；清单混免费与权益模型，建议先用已实证的；chat-only；上游无计量面（usage 为本地估算，带 `estimated` 标识） |
| **ZCode** | FreeTier（直连） | 本机 ZCode 账号的 Start Plan 免费额度（官方口径 1 亿 token/日，当日发放当日过期） | 需装 ZCode 桌面版并登录过；默认请求附带官方开源 harness 前缀（1253 字符，不改写）；清单按 balance 权益实时过滤；chat-only；405/3012 报不可用，app-server 兜底因本地工具权限未可靠限制而禁用 |
| **OpenCode** | FreeTier（官方免费网关） | 上游匿名免费模型（零凭据、零登录） | 需装 opencode CLI（`brew install opencode`）；chat-only；非真流式（整段回复一次吐出）；清单随上游变动；无额度计量（每回合 token 用量为上游真数） |

模型清单、数量都以运行时为准，别照抄文档：

```sh
curl -s http://127.0.0.1:8080/v1/models   # 模型名格式：<adapterId>:<modelId>
```

每个源一个独立 adapter：单源失效（上游改版、账号掉线、没装）只是它自己从清单里消失，
不影响其它源。

## 常见问题

**要打开被桥接的应用吗？**
不用。日常只要 `accessmux serve`（或 onboard 起的后台服务）在跑。前提是这台机器上
**登录过一次**对应应用——之后不必让它开着。具体到进程形态见上面的三档表。

**收费吗？**
AccessMux 本身免费、不要 Key、不用注册，它不提供也不转卖任何额度。你消费的是自己已有账号
的额度：本机登录的 IDE 额度，或 OpenCode 这类官方免费档。

**安全吗？**
服务只监听 `127.0.0.1`，主服务校验 loopback Host 和浏览器同源 Origin；内部 shim 另有随机端口与 secret。
WorkBuddy / Trae 凭据及 ZCode 直连 JWT **在 daemon 进程内存中读取、解密和使用**，
不会返回给浏览器或模型宿主，诊断出口统一脱敏。shim 与 daemon 同进程，**没有独立凭据进程隔离**；
完整进程隔离留到 Phase 2。HOME / workspace 重定向也不是操作系统沙箱，不能保护你免受同权限本地恶意程序侵害。
本机状态目录可能包含凭据副本与可选 Qoder 签到 PAT（`~/.accessmux/qoder.pat`）；
敏感目录 / 文件收紧为 0700 / 0600，更新使用私有临时文件原子替换。不要上传状态目录或其中任何文件。
项目红线：不提供/不倒卖 Key，不做账号共享、代充、拼车，不做设备级反作弊模拟。

**支持工具调用（agent 模式）吗？**
多数源目前是 chat-only：不透传 `tools`，agent/工具类任务跑不了（Trae 走 SOLO 协议会重写
`tools` 字段）。这是 MVP 的已知限制，Phase 2 视上游协议再开。

**上游改版了怎么办？**
每个源一个 adapter，单源挂掉不影响其它；某个源失效时它自己从 `/v1/models` 消失，其余照常。
npm 安装用 `npm install -g accessmux@latest` 更新；源码安装用 `git pull` 后重跑
`./install.sh`（幂等，不会重复注册）。更新前先停下自己启动的服务，更新后重新启动。

**一次能用几个源？**
默认全开（WorkBuddy、Trae CN、Trae Global、Qoder、ZCode、OpenCode 六个 adapter 同时在线），
也可以只留想要的：配置里关掉对应 adapter（或 `ACCESSMUX_DISABLE_ADAPTERS=opencode,qoder`
临时禁用）。

**有图形界面吗？**
没有桌面 GUI，也不需要 TUI：服务在后台跑，配置界面是浏览器打开的本地网页
`http://127.0.0.1:8080/ui`。接入用 `accessmux onboard`（交互式回车即可），
或者干脆交给 Agent（见 [INSTALL.md](INSTALL.md)）。

**响应里的 token 用量是真的吗？**
多数源是上游真数原样透传（WorkBuddy / Trae / OpenCode / ZCode 直连）。Qoder 源
上游不计量，AccessMux 改用本地分词估算，并在 `usage` 里带非标准字段 `estimated: true`
标明——见到这个字段就说明是估算值，不是上游真数；真数缺位时也只会给带标识的估算值。

**想撤销接入？**
`onboard` 每次写入前都备份，并在完成清单里打印逐宿主的回滚命令；彻底卸载见
[INSTALL.md](INSTALL.md) 第 2.7 节。

**有每日签到/领积分吗？**
有：`accessmux checkin` 一次性领取各源的每日免费额度（幂等，可挂 cron）。当前覆盖
WorkBuddy 季性签到（+100 credits/日）、Qoder「每天领 100 Credits」（需先生成一次
PAT：`accessmux checkin --set-pat`）；ZCode 的 Start Plan 本就每日自动发放、无需
签到（探测到活动时会提示去官方客户端领）。详见
[源码宿主说明](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 第 12 节。
Trae 签到需设备身份校验，本项目不提供（月度积分自动发放不受影响）。

长请求默认总预算 300 秒、单次输出等待 90 秒；超时会取消本请求的上游工作。
可用 `ACCESSMUX_TURN_TIMEOUT_MS` / `ACCESSMUX_IDLE_TIMEOUT_MS` 设置正整数毫秒。
控制面探测默认 5 秒；目录、额度与 CLI 原有预算仍保留。

## 开发

```sh
npm install
npm test          # vitest
npm run typecheck # tsc --noEmit
npm run dev       # tsx 直跑 CLI（accessmux serve）
npm run build     # tsc → dist/，构建产物是 onboard 启动守护的唯一入口
```

协议端点（本地，默认端口 8080，`--port <n>` 或 `ACCESSMUX_PORT` 覆盖）：

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI Chat Completions（流式 + 非流式） |
| `POST /v1/messages` | Anthropic Messages，当前仅非流式（需在 `/ui` 里勾选"暴露 Anthropic 兼容端点"） |
| `GET /v1/models` | 模型清单，id 格式 `<adapterId>:<modelId>` |
| `GET /health` | 健康检查 + 已注册 adapter 列表 |
| `GET /ui` | 本地配置界面（网页） |

CLI 子命令：`serve` / `ui` / `onboard` / `status` / `provider list` / `checkin` /
`config init` / `config path`（完整用法 `node dist/cli/index.js help`）。

## 源码仓库布局

- `src/`：adapter、协议、路由、CLI、UI 与安装接线。
- `tests/`：离线合成测试；不包含真实账户采集、截图和运行日志。
- `integrations/dsh-accessmux-connect/`：DSH 插件源码与合成测试。
- `scripts/`、`tsconfig.json`、锁文件：可复现构建入口。
- [安装手册](INSTALL.md)、[向导细节](https://github.com/nengong-ai/AccessMux/blob/main/docs/onboard.md)、[宿主接入](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md)、
  [架构](https://github.com/nengong-ai/AccessMux/blob/main/docs/architecture.md)、[许可与归属](NOTICE)：使用与开发文档。

npm / Release tgz 只带运行时与随包说明。源码安装、测试和 DSH 插件使用源码仓库。
