# AccessMux 一键接入（onboard）

> 本文只讲向导本身的细节。从零开始的完整安装（含"让 Agent 代装"的 runbook）见
> [INSTALL.md](../INSTALL.md)。

不想看原理？在终端里跑这一条命令，然后跟着提示回车就行：

```bash
accessmux onboard --host workbuddy --yes
```

（开发仓里跑：`node dist/cli/index.js onboard`，首次先 `npm run build`。）

## 它会做什么

1. **自动检测**你电脑上装了哪些能接入的软件（宿主）：ZCode、WorkBuddy、
   DeepSeek Harness（DSH）、Claude Code、Codex CLI、Hermes；
2. 只处理 `--host` 指定的当前宿主；未传时交互终端问一次宿主，无人值守则报错；
3. 自动帮你改好各宿主的配置（**改之前一定先备份**，做完告诉你怎么撤销）；
4. 启动/复用服务，确认 UI 返回网页后打开实际地址；默认不发测试消息；
5. 打印完成清单：接了什么、备份在哪、怎么回滚、下一步做什么。

全程不需要看别的文档。已经接入过的宿主会自动跳过——**这条命令随时重跑都安全**，
不会产生重复配置。

## 命令参数

| 参数 | 作用 |
|---|---|
| `--host <id>` | 从 Agent 真实会话传入当前宿主；只处理它 |
| `--all-hosts` | 用户明确要求时处理全部检测到的宿主 |
| `--yes` | 确认选定范围，不代替宿主选择 |
| `--no-open-ui` | 打印准确 URL，交 Agent 内置浏览器开页一次 |
| `--dry-run` | 只显示将要做什么，不写任何文件 |
| `--smoke` | 已接入的宿主也重新发测试消息（确认一切正常） |
| `--port <n>` | 指定本地服务端口（默认 8080） |

## 接入后怎么用

打开宿主软件 → 模型选择器里选 **AccessMux** 组（或 "AccessMux ·" 开头的模型）→
正常发消息。选的模型来自哪家的额度，就在消费哪家的额度。

前提：接入的模型需要本地服务在跑。onboard 过程中会自动把服务拉起来；
之后用同一条 `onboard --host <id> --yes` 启动/复用服务并开页。
不要在已有后台服务的同一端口再跑前台 serve。端口冲突时以 `ACCESSMUX_UI_URL` 的实际地址为准。

## 各宿主接入方式一览

| 宿主 | 方式 | 生效条件 |
|---|---|---|
| ZCode | 自动注册自定义供应商（纯增写入 `~/.zcode/v2/provider_config.json`） | 立即（GUI 热识别，无需重启） |
| WorkBuddy | 自动注册模型（追加进 `~/.workbuddy/models.json`） | 1 秒内热生效，无需重启 |
| DSH | 自动安装 AccessMux 插件（link 安装进 DSH 桌面 profile） | **需完全退出 DSH（⌘Q）后重开** |
| Claude Code | 手动：3 行环境变量（onboard 会打印现成的） | 新开终端 |
| Codex CLI | 手动：~/.codex/config.toml 片段（onboard 会打印） | 下次启动 codex |
| Hermes | 手动：Base URL 指到本地服务（onboard 会打印） | 视版本而定 |

WorkBuddy 上的模型清单自动排除了 `workbuddy:*`（那是"自己桥接自己"的绕圈模型），
日常优先用 `trae-cn` / `trae-global` 的模型。

## 出问题时怎么办

先看 onboard 自己打印的信息：每一步失败都会附"怎么办"。常见情况：

- **提示后台服务启动失败/连不上**：手动跑 `accessmux serve`，看到
  `listening on http://127.0.0.1:8080` 后重跑 `accessmux onboard`。
- **提示没有模型 / 桥接源不在线**：打开对应桌面 IDE（WorkBuddy / Trae）确认已登录，
  等 1-2 分钟后重跑。
- **模型选择器里看不到 AccessMux**：
  - DSH：插件要重启 DSH 才加载（⌘Q 完全退出后重开）；
  - ZCode：确认写的是 `~/.zcode/v2/provider_config.json` 这个文件；
  - WorkBuddy：看主进程日志有没有 `Loaded custom models config` 行。
- **发消息报 500 "shim is already running"**：单会话限制，等几秒重试一次就好。
- **DSH 重开后插件不生效，日志里有 pnpm/依赖校验报错（全新机器常见，无 lockfile 记录）**：
  到 `~/.dsh/profiles/desktop` 目录跑一次 `pnpm install`，再完全退出 DSH（⌘Q）重开。
- **想撤销接入**：用完成清单里打印的回滚命令（每步改前都有备份），或参考
  [host-integration.md](host-integration.md) 各宿主段的「卸载 / 回滚」。

更多细节与排错速查表见 [宿主接入说明](host-integration.md)。
