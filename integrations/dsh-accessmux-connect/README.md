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
   <AccessMux源码目录>/integrations/dsh-accessmux-connect
   ```

3. 重启 DSH。模型选择器选 AccessMux 组直接用。

本插件是**纯 ESM JavaScript、零构建**（`main: index.js`），link 安装即用，
不需要 `npm install`/`build`。目录里的 `node_modules/` 只是开发与测试用的
devDependencies（宿主同版本），运行时不参与——插件的 peer 依赖
（`@deepseek-ai/*`、`@earendil-works/pi-ai`）由 DSH 宿主提供。

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
靠它路由）。选择器显示名形如 `WorkBuddy · hy4-preview`。守护提供公开显示名，插件优先消费该名称；窗口/上限/模态仍由插件按来源补保守值：
workbuddy 1M 上下文 / 64K 输出，trae 200K / 32K；**全部 text-only**（MVP
不接宿主附件服务，宿主因此不开放贴图入口）。目录每 60s 从守护刷新，
守护后启动也能自愈；守护不可达时组隐藏（不显示一份发不出请求的名单）。

## 开发

```sh
npm install        # 拉测试用 devDependencies（宿主同版本）
npm test           # 离线单测（fetch 全部注入替身）
npm run typecheck  # JSDoc + tsc --checkJs
```

## 宿主兼容

peer 范围 `>=0.1.5-rc.1 <0.3.0-0`（在 DSH 0.2.0-rc.2 + 内置
dsh-llm-pi-ai 0.2.0-rc.2 + pi-ai ^0.87.1 上验证）。**上界必须
`<0.3.0-0`**：DSH 0.1.7 起有 bundle 级 peer 门禁，范围写错（如
`<0.2.0-0`——SemVer 里 `0.2.0-rc.1 < 0.2.0-0`）会把整个插件静默跳过，
界面上表现为"插件凭空消失"（dsh-connect-trae 2.3.1 的实际事故）。
