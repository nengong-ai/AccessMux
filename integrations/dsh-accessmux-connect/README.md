# dsh-accessmux-connect

把 [AccessMux](../../) 本地桥接守护的模型接入 DeepSeek Harness（DSH）的
Cordis bundle 插件。安装后 DSH 模型选择器出现 **AccessMux** 组
（`workbuddy:*` / `trae-cn:*` / `trae-global:*`），**零凭据配置**即可真机
对话、消费桥接额度。

骨架照 dsh-workbuddy-connect：pi-ai `createProvider` + `PiAiAdapter`
（宿主 seam），认证走 INERT_AUTH（ambient 凭据通道置空 + 内部注入占位
key）。与 workbuddy 插件的两处结构差异都是简化：

1. **没有 loopback shim**——AccessMux 自身就是 loopback 守护且不校验 key；
2. **没有凭据 store**——不存在桌面凭据可读，这正是绕开 DSH credentials
   service 凭据墙（MISSING_CREDENTIAL）的机制。

## 安装（本地目录路径）

前置：`accessmux serve` 在跑（默认 `http://127.0.0.1:8080`）。

1. 完全退出 DSH（⌘Q）。
2. 重新打开 DSH → 设置 → 插件 →「添加插件」→ **本地目录路径**，粘贴：

   ```text
   <你的 AccessMux clone 目录>/integrations/dsh-accessmux-connect
   ```

3. 重启 DSH。模型选择器选 AccessMux 组直接用。

本插件是**纯 ESM JavaScript、零构建**（`main: index.js`），link 安装即用，
插件本身无需编译。插件的 peer 依赖（`@deepseek-ai/*`、
`@earendil-works/pi-ai`）由 DSH 宿主提供；开发用 `npm ci` 安装的
`node_modules/` 不随源码发布。使用 AccessMux 的 onboard 安装入口或
DSH 的本地 bundle 入口，保留宿主对 link 包的模块解析规则。

> 卸载：DSH 插件页卸载即可；源码删除本目录即彻底移除。

## 配置（可选）

插件带全默认值，装完即用。需要改时在 profile 的 `cordis.patch.yml` 给
insert 条目加 `config:`：

```yaml
- insert:
    - id: llm-accessmux
      name: dsh-accessmux-connect
      config:
        baseURL: http://127.0.0.1:8080/v1  # 默认值
        apiKey: local                       # 占位；AccessMux 不校验
        pollMs: 60000                       # 目录刷新间隔
```

## 模型 id 与元数据

模型 id 保留 AccessMux 全格式 `<adapterId>:<modelId>`（wire `model` 字段
靠它路由）。选择器显示名形如 `WorkBuddy · hy4-preview`。守护的
`/v1/models` 不带窗口/上限/模态，插件按来源补保守值：
workbuddy 1M 上下文 / 64K 输出，trae 200K / 32K；**全部 text-only**（MVP
不接宿主附件服务，宿主因此不开放贴图入口）。目录每 60s 从守护刷新，
守护后启动也能自愈；首次守护不可达时组隐藏，后续失败保留最后一次成功目录。
这份缓存不是当前源可用或档位仍有效的证明；公共 daemon 会在请求前核验能力。

## 开发

```sh
npm install        # 拉测试用 devDependencies（宿主同版本）
npm test           # 离线单测（fetch 全部注入替身）
npm run typecheck  # JSDoc + tsc --checkJs
node scripts/verify-live.mjs [modelId]
# 生产路径验证：真 daemon + pi-ai 真实对话（会消费一次桥接额度）
```

## 宿主兼容

peer 范围 `>=0.1.5-rc.1 <0.3.0-0`（在 DSH 0.2.0-rc.2 + 内置
dsh-llm-pi-ai 0.2.0-rc.2 + pi-ai ^0.87.1 上验证）。**上界必须
`<0.3.0-0`**：DSH 0.1.7 起有 bundle 级 peer 门禁，范围写错（如
`<0.2.0-0`——SemVer 里 `0.2.0-rc.1 < 0.2.0-0`）会把整个插件静默跳过，
界面上表现为"插件凭空消失"（dsh-connect-trae 2.3.1 的实际事故）。

## 动态思考程度（0.1.1）

仅消费 `/v1/models` 的有效 `bridgeReasoning` 控制，不能用上游 `reasoning`
标签代替。模型档位与锁定 SDK 词表 `off/minimal/low/medium/high/xhigh/max`
取交集；未支持档位显式禁用，空/未知集合不生成全档，`off` 还须
`canDisableThinking: true`。只支持 high 的模型只提供 high。
同 ID 同名的能力变化也会触发宿主重读，无需手工维护型号名单。

显式选档位才发送同名 `reasoning_effort`；未选档位保留上游默认。
SDK 将 off 与省略选项合并，因此插件为显式 off 使用独立的 SDK 调用快照，
不会把 off 重映射为其它档，也不会在并发请求之间共享状态。
已 prepare 的调用固定其目录快照；新调用使用刷新后的能力。
这不声明思考文本、图片或工具传输能力。

```sh
npm ci
npm test
npm run typecheck
node scripts/verify-reasoning.mjs /tmp/dsh-synthetic-sdk.json
```

`verify-reasoning` 仅请求随机端口合成 loopback 服务。

公开首装验证在 **AccessMux 仓库根目录** 执行，Node >=22，需联网匿名读取
GitHub 和安装 npm 依赖。先检出已公开、包含本版验证器的完整 40 位提交 SHA：

```sh
# 在干净公开 clone 中检出要验的发行提交后执行
PUBLIC_SHA="$(git rev-parse HEAD)"
node integrations/dsh-accessmux-connect/scripts/verify-first-install.mjs \
  --sha "$PUBLIC_SHA" --evidence-dir "$(mktemp -d)/first-install"
```

验证器重新匿名 clone `https://github.com/nengong-ai/AccessMux.git` 并检出
`--sha`，核实际 HEAD；只使用该公开提交的输入，不覆盖调用者的工作区。
运行结果记录实际 SHA、公共 tree、所有运行输入的 SHA-256 和资源清理结果。
无需 `investigations/receipts/tasks/memory` 或任何内部 manifest。
验证尚未发布的候选时，应使用下方的显式候选模式；旧公开提交 `8e87356e98eadeb97fbd1e4ef92b620893010f1d`
不含新版验证脚本，不能用于证明本版首装。SHA 未公开、不是完整 SHA、入口
缺失或所调用脚本与提交内脚本不同，都会明确失败；不会自动发布。
证据目录必须尚不存在，避免覆盖以前的结果。

维护者验证未发布候选时，额外显式传入两个参数：

```sh
node integrations/dsh-accessmux-connect/scripts/verify-first-install.mjs \
  --sha "$PUBLIC_BASE_SHA" --evidence-dir "$NEW_EVIDENCE_DIR" \
  --candidate-root "$PUBLIC_CANDIDATE_ROOT" --manifest "$FROZEN_MANIFEST"
```

候选 manifest 格式为 `{ "schemaVersion": 1, "publicCommit": "40位公开基线SHA",
"files": [{ "path": "仓库相对路径", "sha256": "64位SHA-256" }] }`。
只有脚本列明的已审公共路径可覆盖；逐项核 HASH，拒绝重复、未知
路径、符号链接及哈希漂移，插件 package/lock 必须成对，根 package/lock
始终保留公开基线。manifest 可放仓库外，不会复制进公开树，也不扫描本机全树。
候选结果会标 `mode: candidate`，不能代替发布后新 SHA 的匿名复核。

两种模式都在隔离 HOME 执行真实 onboard 与 Cordis/SDK 消费，再用真实公共
生产 daemon、WorkBuddy/Trae 生产适配器和独立合成上游 HTTP 验证参数。
测试不读真实 profile/Key、不启动全源/签到、不占用 8080、不请求真实模型，
临时 clone/HOME/服务均回收。另一台实体机器、正式 DSH GUI 的档位可见性和
官方桌面 bundle loader 仍须单独验收；Node preserve-symlinks 的 SDK 验证
不能代替完整桌面加载验证。
