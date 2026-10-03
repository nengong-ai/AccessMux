# AccessMux · 宿主接入说明

安装 Agent 默认只接当前宿主：从真实会话传入 `accessmux onboard --host <id> --yes`。
向导会准备后台服务并开 UI，已接入也可重跑；不再另起同端口前台 serve。
内置浏览器开页用 `--no-open-ui`，再打开输出的 `ACCESSMUX_UI_URL`；完整 URL 获取流程见
[安装手册](../INSTALL.md)。默认不发模型请求，自检需用户明确要求并加 `--smoke`。


把"被锁在桌面 IDE 里的 LLM 额度"经 AccessMux 的 OpenAI / Anthropic 兼容端点开放给
任意可配 Base URL 的宿主。本文给每宿主一段可照抄的配置片段。

从零安装（含"让 Agent 代装"的 runbook）见 [INSTALL.md](../INSTALL.md)；向导本身的细节见
[onboard.md](onboard.md)。

## 通用约定

无论哪个宿主，连接到 AccessMux 都遵循以下规则：

- **Base URL**：`http://127.0.0.1:<port>`,其中 `<port>` 是 `accessmux serve` 启动时
  打印的端口（默认 `8080`,可用 `--port <n>` 或环境变量 `ACCESSMUX_PORT` 覆盖）。
  AccessMux 仅监听 loopback,不暴露到网卡（D4 凭据安全金标准）。
- **模型名格式**：`<adapterId>:<modelId>`。`adapterId` 在 `/health` 端点列出
  （MVP: `workbuddy` / `trae-cn` / `trae-global`）；`modelId` 是该 adapter 报告的
  展示 id（待 T001/T002 实装后由 `GET /v1/models` 返回）。
- **模型徽标**：`/v1/models` 的 `name` / `display_name` 后缀仅使用上游免费、倍率或活动原文（`ACCESSMUX_MODEL_BADGES=0` 可关闭）；`id` 保持路由键不变，忽略展示名的宿主不会显示后缀。视觉标签分两层：`inputModalities` 说明上游能力，`bridgeInputModalities` / `supportsImages` 说明桥接实际可传的模态（T036 起图片按源点亮，见下条）。
- **元数据口径（T038）**：卡片直接显示上下文、免费和倍率，来源仅存数据层；上下文优先平台值再补厂商公开规格，`minCtx`、`maxInput`、`officialContext` 分列。`priceSnapshot` 保存当前倍率、活动范围和更新时间，`callVerified=false` 独立显示“调用待验证”。免费状态与倍率以各客户端/官网口径为准，随活动变化。
- **图片输入（T036）**：两个端点都收图——OpenAI 形 `{type:"image_url", image_url:{url}}`（http/https 链接或 `data:image/*;base64,…` data URI，链接由桥接代为下载）与 Anthropic 形 `{type:"image", source:…}`（`base64` / `url` 两种 source）。上限：单张解码后 5MB、单边 8000 像素、单请求 8 张、格式 PNG / JPEG / GIF / WebP（以字节嗅探为准）；超限报 400 小白可读文案。**能力按源点亮、打通才亮标**：`supportsImages: true` 的模型真正收图（zcode 直连 / opencode / qoder 已点亮，真机图片往返验证过；WorkBuddy 与 Trae 未点亮——私有报文的图片格式未做真机对照，带图请求被 400 明确拒绝而不是静默丢图）；image 之外的部件（audio_url / tool_result 等）仍明确报错，不静默丢弃。
- **协议端点**：
  - `POST /v1/chat/completions` — OpenAI Chat Completions,OpenAI 兼容宿主用
  - `POST /v1/messages` — Anthropic Messages（仅非流式,流式待 Phase 2）,Anthropic 兼容宿主用
  - `GET /v1/models` — 模型清单（`{object:"list", data:[{id:"<adapterId>:<modelId>",...}]}`）
  - `GET /health` — 健康检查 + 已注册 adapter 列表
- **认证**：MVP 阶段 AccessMux 端点本身不做认证（loopback + 随机端口即认证边界；
  D4）。进程内随机 secret 用于 adapter ↔ shim 之间,不出本进程。
- **token 用量（T023）**：响应里的 `usage` 来自上游真实计量，**原样透传**，不做估算改写：

  | 源 | usage 来源 |
  |---|---|
  | WorkBuddy / Trae CN / Trae Global | 上游真数透传（Trae 取上游 `token_usage` 事件） |
  | OpenCode | 上游真数透传（`info.tokens`；缓存读写与 reasoning 归入 details） |
  | ZCode（直连 + app-server 兜底） | 上游真数透传（直连取 Anthropic `message_start`/`message_delta`；兜底取 `turn.completed.payload.usage`） |
  | Qoder | **本地估算值（带 `estimated` 标识）**：上游零计量面，见 §10 |

  `estimated: true` 是 AccessMux 的非标准扩展字段（标准宿主忽略未知字段）：见到它即表示
  该值由本地分词估算（CJK 按字、拉丁按 1/4 字符），**不是上游真数**。真数缺位时协议层也只发
  带该标识的估算值，绝不无标识地编数。

  流式（`/v1/chat/completions`）按 OpenAI 惯例：客户端带
  `stream_options: {include_usage: true}` 时，在 `finish_reason` 帧之后、`[DONE]` 之前补一帧
  `choices: []` + `usage`（ZCode 宿主的 OpenAI 客户端恒带该选项）；不带该选项时不额外发帧，
  `usage` 直接挂在 `finish_reason` 帧上（OpenAI 客户端忽略未知字段，无害）。
  Anthropic 端点 `/v1/messages` 的 `usage` 按 Anthropic 形状给出（`input_tokens` 不含缓存命中，
  缓存读/写单列 `cache_read_input_tokens` / `cache_creation_input_tokens`）。

> 真机联调强依赖 T001（WorkBuddy adapter）和 T002（Trae adapter）实装完成。
> 在此之前,本说明的模型名都是占位示例,真跑会得到 `404 not_found_error`
> 或 `501 api_error`。协议层的正确性已由 `tests/protocol/messages.test.ts`
> 用 FakeAdapter 覆盖（22 passing,见 README 验收项）。

## 1. Claude Code（Anthropic 兼容）

Claude Code 原生走 Anthropic Messages 协议,通过环境变量切到 AccessMux。

```bash
# ~/.zshrc 或启动前 export
export ANTHROPIC_BASE_URL="http://127.0.0.1:8080"
export ANTHROPIC_AUTH_TOKEN="local"          # 任意非空字符串,AccessMux MVP 不校验
export ANTHROPIC_MODEL="workbuddy:GLM-5.3"  # ← AccessMux 模型名格式

# 启动另一个 terminal
accessmux serve
claude
```

注意事项：
- `ANTHROPIC_MODEL` 必须是 AccessMux 认识的 `<adapterId>:<modelId>`,否则返回
  `404 not_found_error`。`GET /v1/models` 可查当前可用的真实模型 id。
- 流式请求会被 AccessMux 拒绝（`501 api_error`,Phase 2 启用 SSE 后即支持）。

## 2. Codex CLI（OpenAI 兼容）

Codex CLI 走 OpenAI Chat Completions。

`~/.codex/config.toml`:
```toml
model_provider = "accessmux"

[model_providers.accessmux]
base_url = "http://127.0.0.1:8080/v1"
# OpenAI 兼容层不做 token 校验；填任意非空字符串
api_key = "local"

[model_providers.accessmux.headers]
# 如需自定义 header,在这一层加
```

启动 Codex 时显式指定 AccessMux 格式的模型名：
```bash
codex --model "trae-cn:DeepSeek-V4-Flash" "写一个快排"
```

模型列表用 `accessmux provider list`（已注册 adapter）或 `curl http://127.0.0.1:8080/v1/models`
（具体模型 id）查。

## 3. MiniMax Code（当前不在 onboard 宿主列表）

AccessMux 当前不自动检测、不列出 MiniMax Code 接入项，也不输出其配置指引。本项只表示本地 onboard 支持范围，不会卸载应用、修改用户配置或影响模型路由。

## 4. Hermes（OpenAI 兼容）

Hermes 默认走 OpenAI 兼容端点。Hermes 配置文件里把 Base URL 指到 AccessMux 即可,
具体路径以 Hermes 文档为准；通用形态：

```bash
export OPENAI_BASE_URL="http://127.0.0.1:8080/v1"
export OPENAI_API_KEY="local"
export OPENAI_MODEL="workbuddy:Kimi-K3"
```

> 注：Hermes 真实环境变量名以官方文档为准,以上为通用示意；关键是把
> `Base URL` 指到 `http://127.0.0.1:8080`、模型名改成 `<adapterId>:<modelId>`。

## 5. DeepSeek Harness（DSH）—— 插件 dsh-accessmux-connect（T007 路线）

DSH 通过插件接入：`integrations/dsh-accessmux-connect/` 是一个 Cordis
bundle 插件（骨架照 dsh-workbuddy-connect），把 AccessMux 守护的全部模型
注册成 DSH 模型选择器里的 "AccessMux" 组。**零凭据配置**——不设
`ACCESSMUX_API_KEY`、不碰 DSH credentials service 就能用（见下方"为什么
没有凭据墙"）。

T006 曾走"cordis.patch.yml 配置直连"路线，已废弃：声明式 provider 会被
pi-ai 强制要求 `apiKeyEnv` 指向的凭据真实存在（MISSING_CREDENTIAL），且
当时把 profile 路径写错（真实 profile 见下）。两条路线的差异见
"插件 vs 配置直连"。

### 前置条件

```bash
accessmux serve
# 默认监听 http://127.0.0.1:8080（仅 loopback；D4）
```

### 安装（GUI「添加插件 → 本地目录路径」）

1. 完全退出 DSH（⌘Q，不是关窗口）。
2. 重新打开 DSH → 设置 → 插件（dshmarket）→「添加插件」→ 选择
   **本地目录路径**，粘贴：

   ```text
   <AccessMux源码目录>/integrations/dsh-accessmux-connect
   ```

3. 安装后重启 DSH（bundle 变更需要重启进程加载）。

> 本机 `dsh` CLI（0.1.5-rc.2）明确拒绝管理 desktop profile
> （"profile desktop is managed exclusively by the Electron application"），
> 所以桌面 GUI 的 profile 只能走 GUI 安装或手动改 profile 的
> `package.json` + `pnpm install`（不推荐手工操作）。

安装后模型选择器出现 **AccessMux** 组，模型名形如
`WorkBuddy · hy4-preview` / `Trae CN · glm-5.2` / `Trae Global · gpt-5.4`。
选一条直接发消息即可——前提只有 `accessmux serve` 在跑（插件每 60s 拉一次
模型目录，守护后启动也能自愈；守护不可达时该组隐藏）。

### 为什么没有凭据墙（INERT_AUTH）

T006 配置直连撞墙的机制：`llm-pi-ai` 的声明式 provider 带 `apiKeyEnv` 时，
pi-ai 会强制该校验凭据真实存在（MISSING_CREDENTIAL）；删掉 `apiKeyEnv`
则 ambient 凭据发现又会自作主张。

插件路线用 dsh-workbuddy-connect 同款的 **INERT_AUTH** 模式
（`adapter.js`）：pi-ai 的 ambient 凭据通道（credentials store /
authContext env / fileExists）全部显式回答"nothing stored, nothing set"，
认证由插件内部注入一个非空占位 key（`Authorization: Bearer local`），
AccessMux MVP 不校验。整个链路不读环境变量、不进 credentials service。

### 模型 id 编码

pi-ai 把模型 id 原样放进 wire `model` 字段，因此插件保留 AccessMux 的
全格式 id：`<adapterId>:<modelId>`（`workbuddy:hy4-preview` → WorkBuddy
bridge，`trae-cn:glm-5.2` → Trae CN bridge）。真实可用清单以
`curl http://127.0.0.1:8080/v1/models` 为准（当前 27 个：workbuddy 16 +
trae-cn 4 + trae-global 7）。上下文窗口/输出上限由插件按来源补齐保守值
（workbuddy 1M/64K，trae 200K/32K）；MVP 全部 text-only（贴图入口由宿主
关闭）。

### 流式

DSH 默认走流式（pi-ai `openai-completions`）；AccessMux 端返回 OpenAI
风格 SSE。客户端断开时守护主动 `session.cancel()` 释放 shim。

### 卸载 / 回滚

1. DSH 设置 → 插件 → 找到 **DSH AccessMux Connect** → 卸载（dshmarket
   会移除 link 并还原 profile 配置）。
2. AccessMux 守护不受影响（独立进程）；删除插件目录
   `integrations/dsh-accessmux-connect/` 即彻底移除源码。

### 插件 vs 配置直连（历史对照）

| | 插件（T007，现行） | 配置直连（T006，已废弃） |
|---|---|---|
| 凭据 | INERT_AUTH，零凭据 | 必须过 credentials service（MISSING_CREDENTIAL 墙） |
| 模型清单 | 守护目录自动刷新（60s） | 手工维护 yaml 列表 |
| profile 路径 | 由 dshmarket 管理，用户不碰 yaml | 手改 `~/.dsh/profiles/desktop/cordis.patch.yml` |
| 升级维护 | 模型增减跟随守护 | 上游每次变化要改 yaml |

> T006 时文档把 profile 写成
> `~/Library/Application Support/dsh-desktop/harness/profiles/web/`，是错的。
> 本机 desktop GUI 的真实 profile 是 **`~/.dsh/profiles/desktop/`**（cordis
> 主文件 `cordis.yml` 由 patch 层编译生成，手改请改 `cordis.patch.yml`）。
> 若有旧的配置直连残留，只恢复你自己的安装前备份；不要使用他人的机器快照。

## 6. ZCode（自动接入）

ZCode 的模型供应商配置在 **`~/.zcode/v2/provider_config.json`**（GUI 主进程实读，
app.asar 中 `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` 引用；`~/.zcode/cli/config.json` 管
MCP/plugins、`v2/config.json` 是另一层 bot registry，都不是这份）。接入方式：在该文件
**纯增**一个自定义 provider 条目（schema 照抄文件里既有自定义 provider——商汤/小红书
那两个 UUID 型），并把它追加进 `config.providerOrder`。

```json
{
  "providerId": "<uuidgen 生成的小写 UUID>",
  "providerName": "AccessMux",
  "config": {
    "group": "standard-personal",
    "access": { "type": "api-key", "apiKey": "local" },
    "api": {
      "type": "openai-chat-completions",
      "baseUrl": "http://127.0.0.1:8080/v1"
    },
    "personalModelIds": ["workbuddy:hy4-preview", "..."],
    "modelOrder": ["workbuddy:hy4-preview", "..."]
  }
}
```

- 模型清单**手写**（ZCode 不拉取 `/v1/models`），真实可用 id 以
  `curl http://127.0.0.1:8080/v1/models` 为准，照抄进 `personalModelIds` 与
  `modelOrder`（两处都要写）。
- `apiKey` 任意非空值（AccessMux MVP 不校验）；该文件本身 600 权限、明文存本机。
- **写文件时严禁 `jq -S`**（或任何会重排键序的工具）：ZCode 解析对文件形态敏感，
  键序重排后它静默 fallback 到账号登录 provider（GLM-5.3）而不报错。用不带 `-S` 的
  jq（保持插入序）写临时文件、`python3 -c "json.load"` 校验后原子 `mv`，权限保持
  600。T008 实测在重排文件上所有自定义 provider 全部失效，恢复原键序即复原。
- **生效与验证必须在 GUI 会话**：GUI 主进程会热识别新 provider（模型选择器下拉里
  直接出现 AccessMux 组，无需重启）。但手动 `node zcode.cjs -p` 的 headless 直跑进程
  不解析该文件里的自定义 provider（只认账号登录态），一律静默 fallback——别用
  headless 当验证通道。GUI 里新开任务/会话 → 模型选择器选 AccessMux 组的模型 → 发
  消息即完成接入。
- 验证来源证据：`~/.zcode/cli/rollout/model-io-sess_*.jsonl` 每条模型请求记录
  `.model.providerId` / `.model.modelId`；GUI 会话的请求也出现在
  `~/.zcode/v2/logs/<date>.log`（`收到 ZCode provider runtime headers 请求` 行）。

### 卸载 / 回滚

从 `provider_config.json` 删掉两处：`config.providerOrder` 里的 AccessMux UUID +
`config.providerConfigRules.providerRules` 末尾的 AccessMux 条目，其余一字不动；或
使用你本次安装前由 onboard 生成并打印的备份覆盖。`defaultModelSelection` 全程
未动，无需处理。

## 7. WorkBuddy —— 模型注册（T009 路线）

WorkBuddy 从"被桥接源"升级为"源 + 宿主"双身份：往 WorkBuddy 注册自定义模型、
上游指向 AccessMux。注册面是用户级 **`~/.workbuddy/models.json`**（JSON 数组，
每条一个模型；也接受 `{models:[...]}` 对象形态）。GUI 不需要重启——主进程
`fs.watch` 监听该文件，变更后 1 秒 debounce 热重载（主线程日志出现
`Loaded custom models config from user ... (entries=N)` 即生效）。

参考路线：zhijian 的 `workbuddy-cli-model-bridge` skill（把 CLIProxyAPI 模型
写入 WorkBuddy）；本仓把上游换成 AccessMux，手写等价条目。

### 注册条目（照抄即用）

```json
{
  "id": "trae-cn:glm-5.2",
  "name": "AccessMux · Trae CN glm-5.2",
  "vendor": "Custom",
  "url": "http://127.0.0.1:8080/v1/chat/completions",
  "apiKey": "local",
  "supportsToolCall": false,
  "supportsImages": false,
  "supportsReasoning": false,
  "useCustomProtocol": true,
  "onlyReasoning": false
}
```

要点（WorkBuddy 5.6.2 实测，源码解包核对）：

- **`id` 就是 wire 上的 model 字段**，保留 AccessMux 全格式 `<adapterId>:<modelId>`。
  应用内部可能给 id 加 `custom-local:` 前缀做分组，发送时会剥掉，不影响路由。
- **`url` 写完整 endpoint** + `useCustomProtocol: true`（原样 POST，不拼路径）。
  另一种等价写法：url 写 `http://127.0.0.1:8080/v1` + `useCustomProtocol: false`
  （客户端会自动补 `/chat/completions`，但**不会**自动加 `/v1`）。
- **`apiKey` 任意非空**（AccessMux MVP 不校验）。用户级 models.json 的 apiKey
  字段在部分策略下会被 WorkBuddy 的 credential codec 加密（WBEF1）——明文写入
  安全：codec 对普通字符串原样透传，只识别 `$wbEncrypted` 包装对象。
- **`http://127.0.0.1` 明确允许**（校验逻辑只要求 http/https 协议）。
- **能力布尔按实测填写**：T009 probe 结果 text/流式 PASS、tool call 不通
  （OpenAI `tools` 参数经桥接层不产生 tool_calls，强制 `tool_choice` 也一样），
  故全部 false——WorkBuddy 会把该模型当纯对话模型，agent/工具模式不可用。
- **只增不改**：追加条目时保留文件里已有的手工模型；启动时的
  `LocalModelHardwareGate` 孤儿清理只清理本地硬件模型，不动 Custom 条目。

### 验证

1. 启动/聚焦 WorkBuddy，新建任务，模型选择器（输入框右下 "Select model"）
   出现 `AccessMux · ...` 条目。
2. 选中后发消息，收到真实回复。
3. 来源证据：`~/.workbuddy/traces/<pid>/trace_*.json` 的
   `trace.modelInfo.models` 记录 `trae-cn:glm-5.2`；generation span 的
   system prompt 首行自报 `powered by AccessMux · Trae CN glm-5.2`。

> WorkBuddy 是 Electron 应用，无障碍树在多显示器/多 Space 场景下时隐时现，
> GUI 自动化验证时先把窗口切到前台 Space 再操作；发送失败重试一次
> （AccessMux shim 单 session 约束，见排错表）。

### 自环注意事项

`workbuddy:hy4-preview` 这类条目在 WorkBuddy 里消费的是 WorkBuddy 自己的额度
（请求绕 AccessMux 一圈回到 WorkBuddy 源），技术上可用但语义自环，仅作
路由验证，日常使用优先 `trae-cn:*` / `trae-global:*`。

### 图片输入（T036 口径：未点亮，保持灰标）

WorkBuddy 上游不少模型带视觉标（catalog `inputModalities` 含 image），但桥接
图片路径**未点亮**：官方客户端发图的真实报文形态（是否上传文件服务换 URL、
还是内联 base64）未做 MITM 真机对照，不猜格式、不试错烧请求（R017 方法论：
先抓官方真报文再复刻）。带图请求在协议层被 400 明确拒绝（小白可读文案），
不是静默丢图；文字请求不受影响。后续点亮需先补真机报文对照。

### 卸载 / 回滚

1. 从 `~/.workbuddy/models.json` 删掉对应 `AccessMux ·` 条目（文件保存后
   1 秒内热生效，无需重启），其余条目不动。
2. 或恢复你本次安装前由 onboard 生成并打印的 models.json 备份，保留你自己的原配置。
3. GUI 侧也可在 设置 → 模型管理 里删除（效果同 1）。

## 8. OpenClaw 与其它能配 Base URL 的 IDE

任何支持自定义 OpenAI / Anthropic Base URL 的客户端都可以接入。统一配置：

| 协议族 | Base URL | 模型名格式 |
|---|---|---|
| Anthropic 兼容 | `http://127.0.0.1:8080` | `<adapterId>:<modelId>` |
| OpenAI 兼容 | `http://127.0.0.1:8080/v1` | `<adapterId>:<modelId>` |

API Key / Token 字段填任意非空字符串（MVP 不校验）。

## 9. OpenCode 免费档（T013 路线）

OpenCode 官方托管的免费模型网关（匿名、零凭据、零登录），经 AccessMux 拉起一个
**隔离的** `opencode serve --pure` 子进程消费。免费模型 = 上游模型目录里 cost
（input/output/cache 读写）全 0 的条目，清单以 `GET /v1/models` 实时为准
（T012 实测 8 个：mimo / space-bunny / longcat / nemotron / muse-spark / ling 等
"杂牌军"，无 glm/qwen 旗舰；上游随时可增减）。

> 机制来源（T034 换锚）：全部机制点依据官方 opencode（MIT）v1.18.31 源码与
> 文档（opencode.ai/docs/server、/docs/cli）实现；逐点锚点对照见 NOTICE
> 第 4 条与回执 R034。

### 前置条件

本机装有 opencode CLI（任一方式）：

```bash
brew install opencode          # 或官方安装脚本 https://opencode.ai
# 已装但不在默认路径时：
export ACCESSMUX_OPENCODE_BIN=/path/to/opencode
```

MVP 不含 npm 自动下载链（定位 `~/.opencode/bin`、`/opt/homebrew/bin`、
`/usr/local/bin` 三处），装好即可用。无需任何 API Key / 登录。

### 模型命名

`opencode:<modelId>`，modelId 是上游裸 id：`opencode:mimo-v2.6-flash-free`、
`opencode:space-bunny-free`（1M ctx）等。误把上游全名 `opencode/<id>` 塞回来也能识别。

### 验证

```bash
accessmux serve                                    # 或已有守护
curl -s http://127.0.0.1:8080/v1/models | grep opencode
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"opencode:mimo-v2.6-flash-free","messages":[{"role":"user","content":"hi"}]}'
```

### 隔离与生命周期（与其它源不同处）

- daemon 首次被探测（`/v1/models` 或首个请求）时懒启动隔离 serve，常驻复用；
  目录刷新在启动时做一次（最长 ~45s，失败不阻断）。
- 隔离语义：env 白名单（不透传其他源的 key）、XDG 四目录重定向到
  `~/.accessmux/opencode-runtime/`、随机进程间密码、`127.0.0.1` 随机端口、
  原生权限全 ask/deny（隔离实例不执行任何本地动作，模型尝试调工具会被拒绝并报错）。
- 回收：adapter dispose、daemon 收 SIGTERM/SIGINT、进程正常退出三条路都会杀掉
  serve 子进程（SIGTERM → 4s 宽限 → SIGKILL）。daemon 被 `kill -9` 无法拦截，
  极端情况下会留孤儿，`pkill -f 'opencode serve --pure'` 手动清。
- serve 子进程日志在 `~/.accessmux/opencode-runtime/serve.log`（排障入口）。

### 已知限制（MVP 裁剪，T013 验收口径 + T036 图片口径）

- **chat-only**：不透传 OpenAI tools，模型侧也不会执行本地工具；agent/工具任务不可用。
- **非真流式**：整段回复一次性吐出（SSE 形状完整但只有一帧 content），TTFT 看起来偏长。
- 免费档额度无计量面：`fetchQuota` 只报 ok/unknown，没有具体余量数字。
- 单条 user 消息直发；多轮历史折叠成带角色标签的转录（上游 API 不接受预置会话历史）。
- **图片输入已点亮（T036）**：图片按官方 FilePartInput 塑形（`{type:"file", mime, url:"data:<mime>;base64,…"}`，
  锚点 v1.18.31 `packages/schema/src/v1/session.ts:413-421`），catalog 里上游标了 image 的模型
  `supportsImages: true`（真机往返实证：自制标记图被模型读出）。无图请求报文与 T013 起逐字节一致。

### 卸载 / 回滚

无宿主侧写入，关闭即干净：

1. 配置 `adapters.opencode.enabled: false`（或 UI 卡片关闭）→ 不再出现在 `/v1/models`。
2. 停 daemon 即杀 serve 子进程；想彻底清状态删
   `~/.accessmux/opencode-runtime/`（只是 XDG 重定向目录 + serve.log，无凭据）。

## 10. Qoder 免费档（T020 路线，依附型）

Qoder 桌面版自带的 `qoderclicn` CLI（Bun 编译、可 headless）经 stream-json 常驻
驱动，消费**本机 Qoder 账号**的免费/权益额度。凭据由 qoderclicn 进程内自闭环：
AccessMux 不持有、不截获推理凭据（登录态失效时返回脱敏提示，去 Qoder 里重新登录即可）。
可选签到 PAT 是另一条官方令牌路径，由 AccessMux 从私有本机文件读取，不发给浏览器。

### 前置条件

装有 Qoder 桌面版（自带 CLI 在 `~/.qoder-cn/bin/qoderclicn/`）。无需配任何
API Key；`~/.qoder-cn` 下没有 CLI 时按 Qoder 官方安装。已装但二进制不在默认
位置时：`export ACCESSMUX_QODER_BIN=/path/to/qoderclicn`。

### 模型命名

`qoder:<modelId>`，modelId 照 `--list-models` 输出：`qoder:Qwen3.8-Flash`、
`qoder:GLM-5.3-Flash` 等；`qoder:qfmodel` 是"用户默认模型"（当前账号为
Qwen3.8-Flash）。**清单混有免费档与权益/付费模型，--list-models 不区分**：
adapter 的 probe 输出给未实证模型打了 `unverified` 标签（不虚标免费），但
`/v1/models` 线格式暂不展示 tags（协议层限制，全源一致）——**生产使用建议
先用已实证的 Qwen3.8-Flash / Qwen3.7-Flash**（或 `qfmodel`），其余模型首次
用短句试一下是否计费再放开。乱填模型名会被上游静默落到 Auto（可能计费），
adapter 已按清单拦截未知名。

### 验证

```bash
accessmux serve
curl -s http://127.0.0.1:8080/v1/models | grep qoder
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"qoder:qfmodel","messages":[{"role":"user","content":"hi"}]}'
```

### 生命周期与已知限制（MVP 口径）

- **每个桥接请求启动一条全新官方 CLI 会话**，结束或取消后回收进程，不按模型复用上下文。
  官方 stream-json 没有经过验证的 reset 合同，保暖复用会让独立对话串扰，因此每次都承担
  约 5 秒客户端冷启动开销（历史实测，仅供参考）。
- 每轮把宿主全量 messages 折叠成单条 user 消息发送（多轮呈转录形态，
  上游协议不接受预置会话历史）；**超长会话**会因此加速消耗上游上下文
  （compaction 由 Qoder 侧处理）。
- **chat-only**：`--tools ""` 禁全部内置工具，不透传 OpenAI tools；
  流式为真 delta（assistant 文本块逐块上屏）。
- **图片输入已点亮（T036）**：stream-json 用户 envelope 追加 Anthropic 形 image
  block（base64 source），qoderclicn 原生接受；真机往返实证 **Qwen3.8-Flash**
  能读图，`qoder:Qwen3.8-Flash` 的 `supportsImages: true`。其余模型未做图片
  往返，保持灰标不虚标。
- cancel（客户端断开）= 杀进程重起（qoderclicn 的 interrupt 控制消息实测
  被静默忽略）；正常结束的回合不受影响。
- **单租户**：`--config-dir` 隔离实测会把 auth 一起隔离（报 Not logged in），
  多账号不可行；一个 AccessMux 实例 = 一个 Qoder 账号。
- 上游无计量面：Qoder 源 usage 为**本地估算值（带 `estimated: true` 标识）**，
  不是上游真数；`fetchQuota` 只报 ok/unknown。
- daemon 被 `kill -9` 会留孤儿 CLI（任何进程级方案拦不住）：
  `pkill -f 'qoderclicn.*stream-json'` 手动清。日志在
  `~/.accessmux/qoder-runtime/cli-<model>.log`。

### 卸载 / 回滚

无宿主侧写入（不动 `~/.qoder-cn` 任何配置；会话记录是 Qoder CLI 自身行为）。
配置 `adapters.qoder.enabled: false` → 不出现在 `/v1/models`；停 daemon 即回收
常驻进程；删 `~/.accessmux/qoder-runtime/` 彻底清本地状态（无凭据）。

## 11. ZCode Start Plan（T019 路线，双形态）

消费**本机 ZCode 账号的 Start Plan 免费额度**（GLM-5.3-Flash / GLM-5.2 /
GLM-5-Turbo，官方口径 1 亿 token/日、当日发放当日过期）。双形态：

- **主形态·直连**（默认）：AccessMux 读 `~/.zcode/v2/credentials.json` 解密
  `zcodejwttoken`（AES-256-GCM，官方开源公式），直接请求官方
  `zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages` 端点，**零常驻进程**、
  单请求 input ≈273 token（省额度）。上游 3012 门槛 = `body.system` 首部必须
  携带官方 harness 提示词前缀（1253 字符）——**前缀是 ZCode 开源仓库里的
  公开常量**（`cli-prefix.ts` + `identity.ts`，本仓 `src/adapters/zcode/prefix.ts`
  逐字节重建并做 sha256 自检 `7e93b986…`）。这是"明示适配"：文档公示携带
  前缀这一事实，不伪造设备指纹、不伪造客户端证明、不改写前缀内容。
- **依附兜底·app-server 当前禁用**：旧实现以 yolo 模式启动官方 agent，会把纯文本接口
  扩大为可执行本地工具的会话。现有官方源码快照的 tool allowlist 语义尚未被可靠地绑定到
  当前 App 内置 CLI，也没有对所有运行期能力的生效证明，因此安全门采取拒绝启动。
  **直连遇到 405/3012 时标为 unavailable 并报错，不启动 CLI、不自动完成当次请求**。
  `ACCESSMUX_ZCODE_FORM=app-server` 也只返回 unavailable，不能越过安全门。
  UI 显示直连 / 不可用状态及固定脱敏原因；重启可重新尝试直连，但不是绕过上游限制。

### 前置条件

装有 ZCode 桌面版且已登录（GUI 登录一次即产生 `zcodejwttoken`；无 refresh
流程，401 = 需重新登录 ZCode）。兜底形态另需标准安装路径下的 App 内置文件
（`/Applications/ZCode.app/Contents/…`），不在默认位置时用
`ACCESSMUX_ZCODE_ELECTRON` / `ACCESSMUX_ZCODE_CLI_CJS` /
`ACCESSMUX_ZCODE_BUILTIN_CONFIG` 指定。

### 模型命名

`zcode:<modelId>`：`zcode:GLM-5.3-Flash`、`zcode:GLM-5.2`、`zcode:GLM-5-Turbo`。
**清单按 balance 的 capabilities 动态过滤（权益以 balance 为准）**：Start Plan
在 provider 目录里挂三 名模型，但权益粒度可能只放行其一（T019 真机实证：
GLM-5.2 / GLM-5-Turbo 请求即 `400 code 3006 "model not allowed"`）——probe
只列权益实际覆盖的模型；balance 拿不到（或认不出 capabilities）时退回固定
三名并把该源标 unverified。清单以 `GET /v1/models` 实时输出为准，硬点未放行
的模型名会被上游 3006 拒（adapter 已附提示语）。

### 验证

```bash
accessmux serve
curl -s http://127.0.0.1:8080/v1/models | grep zcode
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"zcode:GLM-5.3-Flash","messages":[{"role":"user","content":"hi"}]}'
```

### 已知限制与坑（T019 口径 + T036 图片口径）

- **chat-only**：不透传 OpenAI tools；直连形态纯文本/图片往返（图片 T036 点亮，见下），app-server 入口硬禁用。
- **图片输入已点亮（T036，仅直连形态）**：请求按标准 Anthropic image block（base64 source）
  塑形追加在 user content blocks；真机往返实证 **GLM-5.3-Flash** 能读图（答出图中标记），
  `zcode:GLM-5.3-Flash` 的 `supportsImages: true`。GLM-5.2 / GLM-5-Turbo 未做图片往返，
  保持灰标不虚标（上游 3006 门也常只放行 flash 一名）。无图请求报文与 T019 起逐字节一致。
- 直连形态历史单请求 input ≈273 token，具体值取决于请求。旧兜底的历史成本约为
  每回合 ≈70K input、首回合 26-43s、常驻 400-500MB；这些是被禁用方案的代价，
  不是当前仍可用的能力承诺。
- HOME / workspace 重定向只隔离默认产物与插件，不是 OS 沙箱，不能限制绝对路径、Shell
  或网络访问。恢复兜底前必须完成可实证的本地工具拒绝 / 受限执行环境验证。
- 额度按日发放（北京时间当日 00:00 过期）：`fetchQuota` 如实映射
  ok/exhausted/unknown，不编余量数字；balance 端点间歇 429 属限流，
  稍后重试即可。
- 429（限流，自动重试一次）与 3012（前缀门，当前无安全兜底而报不可用）已分类处理；
  401 = 登录态失效，去 ZCode 客户端重新登录。
- daemon 被 `kill -9` 时兜底形态可能留孤儿 Electron 子进程：
  `pkill -f 'zcode.cjs app-server'` 手动清。日志在
  `~/.accessmux/zcode-runtime/appserver.log`。

### 卸载 / 回滚

无宿主侧写入（只读 `~/.zcode/v2` 凭据文件，不解包不修改）。配置
`adapters.zcode.enabled: false` → 不出现在 `/v1/models`；停 daemon 即回收
兜底形态子进程；删 `~/.accessmux/zcode-runtime/` 彻底清本地状态（沙箱 HOME +
workspace + 日志，无凭据副本——JWT 只在进程内存中解密使用）。

## 12. 自动签到 `accessmux checkin`（T027 路线）

一次性把各源**每日免费额度**领进账号，幂等（重复跑安全），跑一次输出每源一行
结果。可手动跑，也可以挂你自己的 cron / launchd（本项目不建常驻调度服务）。

```bash
accessmux checkin            # 逐源领取；退出码 0 = 无意外失败（含全已领/活动关闭/跳过）
accessmux checkin --set-pat  # 写入 Qoder PAT（隐藏输入，0600 存本机）
```

输出四类正常结论 + 失败：`已领取` / `已领`（幂等路径，不重复发领取请求）/
`活动关闭` / `跳过+原因` / `失败`。红线条内不做的：多账号、验证码静默绕过、
任务玩法类（连登兑换等）。

### 各源行为

| 源 | 动作 | 前置 |
|---|---|---|
| **WorkBuddy** | 查季性签到状态（`active` 门控）→ 活跃且未签才领，+100 credits/日 | 本机登录过 WorkBuddy（复用 adapter 凭据链；活动关季时输出"活动关闭"） |
| **Qoder** | PAT 换 token → 拉活动 → 领「每天领 100 Credits」（幂等） | 生成 PAT：qoder.com.cn → 账号设置 → 个人访问令牌，然后 `accessmux checkin --set-pat` |
| **ZCode** | 只探测可领活动（不做自动领取） | 本机登录过 ZCode；Start Plan 本就**每日自动发放**（无需签到），探测到有活动时提示去官方客户端领 |

Trae 签到需设备身份校验，本项目不提供（月度积分自动发放不受影响）。

**ZCode 为什么只提示不领**：活动 claim 可能要求阿里云验证码参数，静默绕过
验证码超出本项目红线；有活动时输出"提示：有可领活动，去官方客户端领取"。

### Qoder PAT 说明

- PAT 是本项目里**唯一新增的用户输入项**，性质同"用户自带 Key"（官方授权
  第三方的令牌正门，非逆向凭据）；
- 存放位置 `~/.accessmux/qoder.pat`（权限 0600），只用于换 checkin 的短时
  token，不落日志、不入回执、不参与推理链（与 qoder attach 桥接链完全隔离）；
- 配置面另有 `qoder.pat` 字段可手写兜底（不推荐：它会被 `/api/state` 回给
  浏览器——推荐一律用 `--set-pat`）；
- PAT 失效时输出"跳过：PAT 无效或已过期，请重新生成"，不自动登录、不抓取。

### 每源开关

配置 `checkin.sources`（如 `workbuddy: false`）可关掉单个源；全不配 = 全开。
缺失的源不会报错，输出"跳过+原因"（如"未配置 PAT"/"未检测到登录态"）。

### 排错

| 现象 | 原因 | 修法 |
|---|---|---|
| `workbuddy 跳过：未检测到 WorkBuddy 登录态` | 没装/没登录过 WorkBuddy | 打开 WorkBuddy 登录一次（凭据解密要应用本体） |
| `workbuddy 活动关闭：本季签到活动未开放` | 活动是季性的，当前季已关（正常状态） | 无需处理；开季后再跑 |
| `qoder 跳过：未配置 PAT` | 没跑过 `--set-pat` | qoder.com.cn → 账号设置 → 个人访问令牌 → `accessmux checkin --set-pat` |
| `qoder 跳过：PAT 无效或已过期` | PAT 被吊销/轮换 | 重新生成 PAT 再 `--set-pat` |
| `qoder 活动关闭：今日无活动下发` | 服务端没对账号开放本波活动，或活动间隙 | 用 Qoder 官方客户端看活动页确认；次日再跑 |
| `zcode 跳过：免费额度每日自动发放…当前无可领活动` | 常态（Start Plan 自动发放，活动面当前空） | 无需处理 |
| `zcode 提示：有可领活动，请去官方客户端领取` | 探测到活动，但领取需验证码 | 打开 ZCode 官方客户端手动领取 |

### 卸载 / 回滚

- 删 `~/.accessmux/qoder.pat` 即清除 PAT；
- 配置 `checkin.sources.<源>: false` 关单源；本命令无任何常驻进程与落盘状态。

## 排错速查

| 现象 | 原因 | 修法 |
|---|---|---|
| `404 not_found_error` | 模型名格式错或 adapter 未注册 | `curl http://127.0.0.1:8080/v1/models` 查正确 id |
| `POST /v1/messages` 404 "Anthropic 兼容端点未启用" | 配置 `output.exposeAnthropic` 未勾选（默认关；T021 起该勾选真实摘挂端点，不再只是配置占位） | `/ui` 输出设置勾选"暴露 Anthropic 兼容端点"并保存，即时生效 |
| `501 api_error` "流式" (Phase 2 历史) | 已移除;流式由 T006 起原生支持 | — |
| `501 api_error` 含 "T001-workbuddy-adapter" / "T002-trae-adapter" | 真实 adapter 还没实装 | 等 T001/T002 验收,或先用 FakeAdapter 测协议层 |
| `500` "shim is already running" | （历史）适配器单 session 约束被撞 | T010 已修复：shim 改会话池管理，并发 launch 串行排队复用，不再抛此类错误；仍见到说明 daemon 版本过旧 |
| 连接拒绝 | `accessmux serve` 没起,或端口不对 | 终端确认 `listening on http://127.0.0.1:<port>` |
| 凭据相关报错 | 桌面 IDE 凭据已过期 / 重新登录 | 重启 host 前先重新登录桌面 IDE,等 adapter sweep |
| DSH 模型选择器看不到 AccessMux 组 | 插件没装上，或 `accessmux serve` 没起（目录拉不到时组隐藏） | GUI 插件页确认 dsh-accessmux-connect 已装；终端确认守护在 8080；完全退出并重启 DSH |
| DSH 选 AccessMux 模型报 MISSING_CREDENTIAL | 还在用 T006 配置直连残留配置 | 已废弃该路线：按第 5 节装插件；确认 cordis.patch.yml 里没有 accessmux 块（T007 已清理） |
| DSH headless 报 `pi-ai provider "accessmux" has no configured model` | （T023 发现）插件首次目录刷新 fire-and-forget，headless 启动期解析默认模型时目录仍空；GUI 启动慢无感 | **T025 已修复**：目录消费入口等首刷落定再读。headless 可用（T025 起）：插件装进含 `dsh-headless` bundle 的 profile，`agent-default-model` 指到 accessmux 即可 |
| qoder:* 全缺席 / probe unavailable | 没装 Qoder，或 qoderclicn 不在 `~/.qoder-cn/bin/` | 装 Qoder 桌面版；或用 `ACCESSMUX_QODER_BIN=<路径>` 显式指定 |
| qoder 请求报 "Not logged in · Please run /login" | 本机 Qoder 账号登录态失效 | 打开 Qoder 桌面版重新登录；adapter 不接触凭据，只能由 Qoder 自己刷新 |
| qoder 报"未知模型已拦截" | 模型名不在 `--list-models` 清单（乱填会落 Auto 计费，被拦） | `curl http://127.0.0.1:8080/v1/models` 查 qoder:* 正确 id；带 unverified 标签的未实证免费 |
| 回合中途报错"进程在回合中途退出" | qoderclicn 崩溃/被断开（含 cancel 杀进程） | 直接重试：下次请求会自动重起新进程新会话 |
| ZCode 选了 AccessMux 模型但回复来源是 GLM-5.3 | provider_config.json 被键序重排（如 `jq -S`）导致解析失败静默 fallback；或用 headless `zcode -p` 验证（它不认自定义 provider） | 从备份恢复文件原键序；验证只用 GUI 会话；rollout jsonl 的 `.model.providerId` 是判定来源的铁证 |
| ZCode 模型选择器里没有 AccessMux 组 | 配置没写进 `~/.zcode/v2/provider_config.json`（写错文件），或只加了 rules 没加 `providerOrder` | 按第 6 节两处都写；GUI 主进程热识别，无需重启 |
| WorkBuddy 模型选择器里没有 AccessMux 条目 | models.json 没写对（JSON 语法错会整文件被跳过并打 `Failed to load` 日志），或条目缺 `id`/`url` 等必填字段被 `dropped N invalid` | 按第 7 节条目照抄；看主线程日志 `Loaded custom models config` 行确认 |
| WorkBuddy 选 AccessMux 模型发送失败/无回复 | （T010 前）并发撞 shim 单 session 500；或 `accessmux serve` 没起 | T010 已修复并发竞态；先看守护在不在 8080，再翻守护 stderr 的请求日志行定位 |
| WorkBuddy 模型经宿主（ZCode 等）发消息 400 `11128 Illegal API invocation from an unapproved channel` | 上游对第三方 agent harness 的 system prompt 有指纹门（T010 实证：命中 Claude Code 模板句 "Main branch (you will usually use this for PRs)" 即拦，一词之差即过，5/5 确定性） | **T010 已适配**：workbuddy 路由自动剥离宿主 system 提示词（body-shaper），对话内容（user/assistant 消息）原样保留。代价：agent 行为约定随提示词丢失，ZCode+workbuddy 的 agent 回合质量轻微下降，纯问答无感。宿主注入的项目上下文（AGENTS.md/git 状态）走 user 消息，不受影响 |
| 守护 stderr 里每请求一行 `[accessmux-req]` | T010 加的请求日志（默认开） | `model/status/duration_ms/ttft_ms/error`（已脱敏）；`ACCESSMUX_REQUEST_LOG=0` 关，`ACCESSMUX_DEBUG=1` 追加 msg_count/prompt_chars |
| WorkBuddy 里 AccessMux 模型不能跑 agent/工具任务 | 桥接层不透传 OpenAI tools（probe 实测），注册时 `supportsToolCall` 已如实置 false | 属 MVP 已知限制；纯对话可用，Phase 2 视协议支持再开 |
| `opencode:*` 报 "找不到可用的 opencode 二进制" | 本机未装 opencode CLI，或不在默认候选路径 | `brew install opencode`，或 `ACCESSMUX_OPENCODE_BIN=<路径>` 显式指定（T013 MVP 不含自动下载） |
| opencode 模型回复报 "Model access is disabled" | 上游对该模型关闭了匿名免费档（big-pickle 先例，T012 实测 403） | 换 `/v1/models` 里其他免费模型；清单以实时目录为准 |
| opencode 模型报 "chat-only 模型尝试调用本地工具，已被隔离权限拦截" | MVP 裁剪：不透传 tools，隔离实例的原生工具全部被拒 | 纯对话使用；tools 透传属 Phase 2 |
| daemon 起后首个 opencode 请求偏慢 | serve 启动含一次上游目录刷新（上限 45s，失败不阻断） | 稍候重试；排障看 `~/.accessmux/opencode-runtime/serve.log` |
| `zcode:*` 全缺席 / probe unavailable | 未装/未登录 ZCode，或 `~/.zcode/v2/credentials.json` 里没有 zcodejwttoken，或前缀常量自检失配 | 装 ZCode 桌面版并登录一次；看 `accessmux status` 输出 |
| zcode 请求报 "登录态已失效"（401） | JWT 被服务端拒绝（无 refresh 流程，失效只能重登） | 打开 ZCode 客户端重新登录，等下一次 probe |
| zcode 请求报 "前缀门拦截" / 通道不可用 | 直连撞 405/3012；安全兜底当前禁用 | 查看 UI 通道状态，等待适配更新；不要改前缀、启用 yolo 或伪造设备身份硬闯 |
| zcode 报 HTTP 429 | 上游限流（balance/messages 端点间歇出现） | adapter 已自动重试一次；持续 429 稍后再用 |
| zcode 报 "不在当前 Start Plan 权益内"（3006 model not allowed） | 该模型在 provider 目录但当前权益没放行（权益粒度随计划变化） | 以 `GET /v1/models` 实时清单为准（probe 按 balance capabilities 过滤）；换列出的模型 |
| zcode 请求始终走兜底形态（慢、费 token） | 直连前缀门持续失配，或 `ACCESSMUX_ZCODE_FORM=app-server` 显式指定 | 检查环境变量；否则等上游稳定/版本更新后重启 daemon 重试直连 |
| 回合中途报 "app-server: 进程在请求中途退出" | 兜底形态子进程崩溃或被 cancel 杀掉 | 直接重试：下回合自动重起进程 |

> 清理子进程 / 停测试守护用精确匹配：带 `--port <n>`（或日志路径、完整命令行），
> 别用 `pkill -f 'serve'` 这类宽匹配——本机可能同时跑着别的会话的同形态进程（T021/T022 实收教训）。
