# AccessMux 安装与接入

AccessMux 把桌面 IDE 里锁定的模型额度（WorkBuddy / Trae / Qoder / ZCode / OpenCode 等），
经本机一个 OpenAI / Anthropic 兼容端点，开放给任意能配 Base URL 的 Agent 宿主。
装它不需要打开被桥接的应用的界面，也不需要在终端里长期盯着一个界面。

本文给两种读者：

- **顶部**「发给任意 Agent 的话」——复制一段话丢给你的 AI Agent，让它替你装（推荐）；
- **中部**「Agent 执行手册」——命令级 runbook，每步带期望输出，Agent 照着执行并自检；
- **底部**「30 秒版（给人看）」——你自己动手时只看这一节。

向导细节见 [docs/onboard.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/onboard.md)，各宿主逐条配置与排错见
[docs/host-integration.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md)。

---

## 一、发给任意 Agent 的话（复制即用）

普通人只需把真实 GitHub HTTPS 仓库链接交给本地 Agent，说：

```text
<GitHub HTTPS 仓库链接>
帮我安装 AccessMux，并接入你自己。装好后打开本地 UI。
```

Agent 须从真实会话确定当前宿主，不能凭本机安装列表猜测。不确定时只问一次
“你现在用的是哪个宿主？”。默认只接这一个；用户明确要求全部时才用 `--all-hosts`。
支持的 id：`workbuddy`、`zcode`、`dsh`、`claude-code`、`codex`、`hermes`、`trae`、`qoder`。
其中指引型宿主仍需要按官方配置方式完成一步，向导不会把打印指引称为实际接入。

Agent 执行下节 runbook，保留已有文件，宿主写入走 onboard 的备份/纯增路径；不读取或
打印凭据，不修改 shell 配置，不提交/推送，不发模型消息、不签到、不代登录。
有宿主内置浏览器时传 `--no-open-ui`，再用官方浏览器工具打开输出的
`ACCESSMUX_UI_URL`；否则让向导自动用系统浏览器打开。打开失败时给用户可点击的地址。

**发行边界**：GitHub 源码仓库提供安装脚本、构建配置与 DSH 插件实体。
先确认 HTTPS 仓库确实可读且包含下文文件，再安装；npm / Release 尚未发布。

---

## npm / Release 安装（0.1.0，公开发布后可用）

Node.js 要求 22+。macOS 未安装 Node 时先执行 `brew install node`。

```sh
npm install -g accessmux@0.1.0
accessmux --version
accessmux onboard --dry-run
accessmux onboard --host workbuddy --yes
```

版本输出应是 `0.1.0`。预览后确认再运行最后一条；没有源/宿主的新机器打印缺少登录态或
「没有检测到支持的宿主」是正常结果，先装好并登录一个支持的源，或装 opencode CLI。
需要重新开页或确保服务在跑时用 `accessmux onboard --host workbuddy --yes`；只有要单独前台服务时用 `accessmux serve`，仅监听本机；另开终端用
`curl http://127.0.0.1:<实际端口>/health` 检查。

从 GitHub Release 下载 tgz 后无需构建，直接安装：

```sh
npm install -g "<下载目录>/accessmux-0.1.0.tgz"
accessmux --version
accessmux onboard --dry-run
```

**npm / Release tgz 不含源码、测试、内部记录和 integrations/。DSH 插件需要完整源码安装，
请使用源码目录里的 `node dist/cli/index.js onboard`；仅在源码目录运行 npm 版 `accessmux`
仍会从 npm 包根目录找插件，不能代替源码版。** 包内 install.sh 仅用于完整源码仓库；不要
在 npm 包或 tgz 解包目录运行，那里没有构建工具和源文件。

Qoder 签到是可选功能：在官方账号设置生成 PAT 后执行 `accessmux checkin --set-pat`，
隐藏输入写到 `~/.accessmux/qoder.pat`（0600）；不要把 PAT 填在命令行参数、回复或日志里。
无 PAT 时 `accessmux checkin` 会跳过 Qoder。Trae 签到不提供；ZCode 日常额度自动发放。

更新用 `npm install -g accessmux@latest`。更新前先停下自己启动的服务，更新后重新启动。
卸载先恢复 onboard 打印的宿主备份并停下自己的服务，再运行 `npm uninstall -g accessmux`；
不会自动删除 `~/.accessmux/` 或其中的 PAT。若要删除状态目录，先确认备份和凭据是否仍需要，
不要让 Agent 盲删。

## 二、Agent 执行手册（完整源码安装）

> 这一节写给 Agent。每一步都有「期望输出」，对不上就停下来排查再继续。
> 命令默认在 AccessMux 仓库根目录执行。

### 2.0 边界（先读，再动手）

**可以写**：

- 仓库内的构建产物：`node_modules/`、`dist/`（由 `npm install` / `npm run build` 生成）；
- AccessMux 自己的状态目录 `~/.accessmux/`（配置、沙箱与日志；可能含 WorkBuddy 凭据副本及可选 Qoder PAT，**不要上传状态目录**）；
- 宿主配置文件——但**只能通过 `onboard` 写入**（`~/.zcode/v2/provider_config.json`、
  `~/.workbuddy/models.json`、`~/.dsh/profiles/desktop/` 等）。onboard 会自动备份、纯增写入、
  并打印逐宿主回滚命令；手改没有这些保障。

**不可动**：

- 用户的凭据、API Key、OAuth token、登录态文件：不读取、不复制、不打印、不上传。
  AccessMux 自身也不需要用户提供任何 Key（见「三、常见问题 · 安全吗」）；
- 用户的其它配置文件（shell 配置、编辑器配置、无关应用配置）；
- 仓库内 `src/`、`tests/` 等源码目录（安装任务不改代码）；
- 不 `git add/commit/push`，不删除用户已有文件，不卸载用户装过的软件。

**遇到要用户本人做的事就停下**：桌面应用登录、GUI 里点插件安装、sudo 提权——
把这些步骤原样报给用户，不要尝试代做。

### 2.0a 从 GitHub 链接取得源码

1. 验证用户给的是 GitHub HTTPS 仓库 URL；读取仓库说明，确认是 AccessMux 的正式来源。
2. 选择不存在的目录，或用 `mktemp` 创建空目录。已有 AccessMux 目录不自动覆盖；
   用户明确要求复用时先核对来源、版本和本地改动，有改动时保留并另选新目录。
3. 例如在用户选择的安装父目录执行（变量由 Agent 填入，不把凭据塞进 URL）：

```sh
REPO_URL='<用户给出的 GitHub HTTPS 仓库链接>'
INSTALL_DIR=$(mktemp -d '<安装父目录>/accessmux.XXXXXX')
git clone -- "$REPO_URL" "$INSTALL_DIR"
cd "$INSTALL_DIR"
```

获取失败就报告实际错误；不臆造下载成功、不切换未经核对的镜像。检查 `package.json`
的名称为 `accessmux`，并确认有 `install.sh`、`INSTALL.md`、源码及锁文件，再往下走。
正式 Release 可安装时也可选已核对的运行时包；DSH 插件必须使用完整源码。

### 2.1 环境检查

```sh
node -v
npm -v
```

期望输出：`node -v` 打印 `v22` 或更高（例如 `v24.21.0`；`package.json` 要求 `node >= 22`）；
`npm -v` 打印任意版本号（随 Node 自带）。

- **Node 低于 22 或没装**：macOS 用 `brew install node`；其它系统去 <https://nodejs.org> 装 LTS。
  装完**新开一个终端**再验一次 `node -v`，不要在同一个 shell 里继续。
- `node -v` 报 `command not found`：Node 没装，或 PATH 没生效——先解决这一条，别继续往下走。

### 2.2 安装依赖并构建

```sh
npm ci
npm run build
```

期望输出：`npm ci` 结束时打印 `added N packages`（依赖已齐时是 `up to date, audited N packages`），
**没有 `npm ERR!`**；`npm run build` 无报错退出，末尾有
`copy-assets: <仓库>/src/ui/public -> <仓库>/dist/ui/public` 一行。

构建成功的判定（可直接核对）：

```sh
test -f dist/cli/index.js && echo BUILD_OK
```

期望输出：`BUILD_OK`。

```sh
node dist/cli/index.js help
```

期望输出（用法清单，节选）：

```text
accessmux —— 统一管理免费/低价 LLM 入口的桥接器

用法:
  accessmux serve [--port <n>]    启动本地服务（默认 8080，仅 127.0.0.1；内置 /ui）
  accessmux ui   [--port <n>]    仅启动本地配置界面（默认 8081，仅 127.0.0.1）
  accessmux onboard --host <id> [--yes]  当前宿主接入、启动/复用服务、打开 UI
                      [--all-hosts] [--dry-run] [--smoke] [--no-open-ui]
  accessmux status                各 adapter 探测状态
  accessmux provider list         已注册 adapter 列表
  accessmux config init           [--config FILE]  生成默认配置文件（缺文件时）
  accessmux config path           打印当前生效的配置文件路径
```

> 下文命令都写成 `node dist/cli/index.js <子命令>`，在仓库根目录下等价于全局命令
> `accessmux <子命令>`。想用短命令可以执行 `npm link`（会在全局装一个软链，属于本机开发
> 便利，非必需）；`npm link` 失败不影响安装，继续用 `node dist/cli/index.js` 即可。

### 2.3 当前宿主接入、服务与 UI

以真实会话在 WorkBuddy 为例；其它宿主替换 id。先只读预览，然后按用户的安装请求执行：

```sh
node dist/cli/index.js onboard --host workbuddy --dry-run
node dist/cli/index.js onboard --host workbuddy --yes
```

完整源码也可直接 `./install.sh --host workbuddy --yes`，依次检查 Node、安装依赖、构建、接入。
`--yes` 只确认选定范围，不能代替当前宿主选择；所有宿主需显式 `--all-hosts --yes`。
未传范围的交互终端只问一次宿主；无人值守缺范围会报错。

正式执行先启动或复用 AccessMux 服务，再确认 `/ui` 返回网页并打开 UI。默认端口已被
其它服务占用时尝试附近空闲端口；新版本核对 `/health` 的 `service: accessmux`；旧版本额外核对目录形状和 UI 标题，避免重复启动。
输出中的 `ACCESSMUX_UI_URL=http://127.0.0.1:<实际端口>/ui` 才是本轮地址，不照抄 8080。

Agent 有内置浏览器时使用：

```sh
node dist/cli/index.js onboard --host workbuddy --yes --no-open-ui
```

然后用宿主官方浏览器工具打开输出地址一次。没有该能力时省略 `--no-open-ui`，程序
使用系统浏览器兜底；无图形环境或打开失败则打印可点击 URL。不能承诺每个 Agent 都有侧栏。

无源、无模型或宿主已接入时也会准备服务、确认 UI 并尝试开页。无模型时不写入空清单，
在 UI 查源状态，修复后重跑。自动接入保留既有备份/纯增/幂等实现，不改其它宿主。
指引型宿主会打印需要用户/Agent 按官方方式完成的配置，不能仅凭指引说已接入。

默认不发送模型消息、不领取积分；配置接入、目录可用、模型调用验证是三层不同证据。
用户明确要求真实调用自检时才加 `--smoke`（会消耗源额度）。重复执行已接入宿主不会
重复注册；ZCode 原有清单同步能力保留，源为空时不会覆盖旧清单。

### 2.4 验证（服务、目录与可选调用分开）

**不要在 onboard 之后再次前台 serve 同一端口。** 向导已经准备后台服务。
使用它打印的实际地址；下面的 `<实际端口>` 必须替换，不先假设 8080。

**检查 1 · 健康**

```sh
curl -s http://127.0.0.1:<实际端口>/health
```

期望输出（adapter 列表按本机注册情况变化，非空即可）：

```json
{"ok":true,"service":"accessmux","adapters":["workbuddy","trae-cn","trae-global","opencode","qoder","zcode"]}
```

**检查 2 · 模型清单**

```sh
curl -s http://127.0.0.1:<实际端口>/v1/models | head -c 300
```

期望输出：`{"object":"list","data":[{"id":"<adapterId>:<modelId>",…` 开头的 JSON。
`data` 数组非空即通过——**每个源有多少模型以这条命令的实时输出为准**，不要照抄文档里的数字
（上游清单会变）。

**检查 3 · 可选真实对话（需用户明确要求，会用额度）**

从检查 2 的输出里挑一个模型 id，替换下面的 `<model-id>`（例如 `opencode:mimo-v2.6-flash-free`
这类免费档模型适合首次验证；桥接源模型会消耗你自己的额度，一条短消息消耗极少）：

```sh
curl -s http://127.0.0.1:<实际端口>/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"<model-id>","messages":[{"role":"user","content":"只回复两个字：你好"}]}'
```

期望输出：HTTP 200 的 OpenAI 结构，`choices[0].message.content` 里有实际内容，例如：

```json
{"id":"chatcmpl-…","object":"chat.completion","model":"<model-id>","choices":[{"index":0,"message":{"role":"assistant","content":"你好"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}
```

（示例数字只表示结构，实际用量以响应为准。WorkBuddy / Trae / OpenCode / ZCode 接通上游真数；
Qoder 和真数缺位的响应使用带 `estimated: true` 的估算，不把估算当上游计量。）

服务/目录检查成功说明目录可读；可选真实对话成功才证明这一个模型的调用。
不把 HTTP 200、usage=0 或余额变化当作免费证明。检查失败时看第 2.6 节排错，或查
[docs/host-integration.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 末尾的「排错速查」表（现象 → 原因 → 修法）。

### 2.5 把 AccessMux 接到 Agent 自己

**如果 Agent 跑在 ZCode / WorkBuddy / DSH 上**：2.3 已经自动接好了。让用户在这些应用里
打开模型选择器，选 **AccessMux** 组（或 `AccessMux ·` 开头的模型），直接发消息即可。
（DSH 需完全退出（⌘Q）后重开一次以加载插件；ZCode / WorkBuddy 热生效，无需重启。）

**如果 Agent 是 Claude Code / Codex CLI / Hermes / 其它可配 Base URL 的客户端**：
`onboard` 已经在输出里打印了现成的配置片段（2.3 的「其它检测到的宿主」段），照抄进对应
配置文件即可。通用规则：

| 协议族 | Base URL | 模型名格式 |
|---|---|---|
| OpenAI 兼容 | `http://127.0.0.1:8080/v1` | `<adapterId>:<modelId>` |
| Anthropic 兼容 | `http://127.0.0.1:8080` | `<adapterId>:<modelId>` |

API Key / Token 字段填任意非空字符串（本地端点不校验；**不要**在这里填用户的真实 Key）。
逐宿主的完整片段见 [docs/host-integration.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 第 1–8 节。

### 2.6 排错速查

| 现象 | 原因 | 修法 |
|---|---|---|
| `node -v` 低于 22 | Node 版本不够（要求 >= 22） | `brew install node`，新开终端重验 |
| `npm run build` 报 TypeScript 错 | 依赖没装全 / Node 版本过低 | 重跑 `npm install`；确认 Node >= 22 |
| 连接被拒（curl 报 Failed to connect） | 守护没起，或端口不对 | 确认 `serve` 输出里有 `listening on http://127.0.0.1:<port>` |
| `/health` 返回 `adapters: []` | 没注册任何 adapter | 在仓库根目录启动（别在别处跑 `dist/cli/index.js`），确认 `npm run build` 已跑 |
| `/v1/models` 里某个源一个模型都没有 | 该源的桌面应用没装/没登录，或 CLI 不在默认路径 | 登录对应应用后重试；或按 host-integration 用 `ACCESSMUX_*_BIN` 指定路径 |
| chat 报 `404 not_found_error` | 模型名不在清单里 | `curl http://127.0.0.1:<实际端口>/v1/models` 取真实 id |
| chat 报 `400 … model not allowed`（ZCode 3006） | 该模型不在当前账号权益内 | 换 `/v1/models` 里列出的模型 |
| onboard 报「后台服务启动超时」 | 端口被占 / 构建产物缺失 | 先 `npm run build`；换 `--port <其它端口>` 重试 |
| onboard 报「当前不是交互终端」 | Agent 在非 TTY 里跑 onboard | 传 `--host <id> --yes`，全部接入才用 `--all-hosts --yes` |
| 宿主里看不到 AccessMux 模型组 | 配置没写对，或守护没在跑 | 重跑 `onboard`（幂等）；确认服务在打印的实际端口 |

完整排错表（含各源特有的坑）见
[docs/host-integration.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 的「排错速查」。

### 2.7 卸载与回滚

**只回滚宿主接入**（AccessMux 本体留着）：用 2.3 完成清单里每个宿主下面打印的
`回滚：` 命令（形如 `cp "<备份文件>" "<配置文件>" && chmod 600 "<配置文件>"`），
一条条执行即可。或参考 [docs/host-integration.md](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) 各节的
「卸载 / 回滚」。

**彻底卸载**：

前台服务用 Ctrl-C 正常退出。后台服务先用本机进程工具核对本次安装目录的完整
CLI 路径和 PID，确认属于你自己的服务，再对该 PID 发 `kill -TERM <已核对的PID>`。
正常退出会回收它自己的子进程；不要用宽泛 pkill 去扫其它 Agent 的服务。

恢复宿主备份后，确认状态目录里的凭据副本、PAT、配置备份都不再需要，再由用户删除
状态目录及本次安装目录。不要把卸载或排障变成清空现有配置。

---

## 三、30 秒版（给人看）

### 三步走

**1. 装 Node 22+**（没装过 Node 的话）

```sh
brew install node
```

**2. npm 安装（公开发布后）**

```sh
npm install -g accessmux@0.1.0
accessmux --version
accessmux onboard --dry-run
accessmux onboard --host workbuddy --yes
```

无源码构建步骤。需要 DSH 插件时改走下面的完整源码路线。

**或：拉源码，跑安装脚本**

```sh
cd "<AccessMux 源码目录>"
./install.sh --host workbuddy --yes
```

（把 workbuddy 换成当前宿主。脚本检查 Node、用锁文件安装依赖、构建，再启动/复用服务、
接入当前宿主并开页。手动做用 `npm ci`、`npm run build`、
`node dist/cli/index.js onboard --host <id> --yes`，不另起同端口 serve。）

**3. 看实际 UI 地址，在宿主里选 AccessMux 模型**

看到「接入完成」就好了。之后打开你的 Agent（ZCode / Claude Code / WorkBuddy…），
在模型选择器里选 **AccessMux** 组的模型，正常发消息——选的模型来自哪家额度，就在花哪家额度。

### 常见问题

**要打开被桥接的应用吗？**
不用。日常使用只要 `accessmux serve` 这个后台服务在跑。前提是你在这台机器上**登录过一次**
对应应用（额度属于你的账号）——之后不需要把它开着。进程形态分三档：Trae / ZCode 直连是
零额外进程，WorkBuddy 只在首次取凭据时瞬时拉一下官方组件，OpenCode / Qoder 是常驻无界面
子进程。详见 [README](README.md) 的卖点矩阵。

**收费吗？**
AccessMux 本身免费、不要 Key、不要注册，它不提供也不转卖任何额度。你消费的是你自己
已有账号的额度（本机登录的 IDE 额度，或 OpenCode 这类官方免费档）。

**安全吗？**
服务只监听 `127.0.0.1`（不暴露到局域网/公网），AccessMux 不把上游登录凭据写进日志或发给宿主；
状态目录可能含 WorkBuddy 凭据副本和可选 Qoder PAT（`~/.accessmux/qoder.pat`），
文件权限 0600，整个状态目录都不要上传。项目红线：不做账号共享、不倒卖 Key、不做设备级反作弊模拟。

**支持工具调用（agent 模式）吗？**
多数源目前是 chat-only（纯对话）：不透传 `tools`，agent/工具类任务跑不了。Trae 走
SOLO 协议会重写 `tools` 字段。这是 MVP 的已知限制，Phase 2 视上游协议再开。

**上游改版了怎么办？**
每个源一个独立 adapter，单源挂掉不影响其它源；某个源失效时它自己从 `/v1/models` 消失，
其余照常。AccessMux 会跟进适配——`git pull` 更新后重跑 `install.sh` 即可。

**想撤销？**
见「二、Agent 执行手册」的 2.7 卸载与回滚（onboard 每次写入前都有备份）。

---

其它文档：[向导细节](https://github.com/nengong-ai/AccessMux/blob/main/docs/onboard.md) ·
[宿主接入与排错](https://github.com/nengong-ai/AccessMux/blob/main/docs/host-integration.md) ·
[架构](https://github.com/nengong-ai/AccessMux/blob/main/docs/architecture.md) · 后续版本计划
