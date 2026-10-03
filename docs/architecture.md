# AccessMux · 架构与技术约定

本文说明公开源码的架构与实际安全边界。

## 技术栈

Node.js 22+ / TypeScript 5.6+ / Fastify 5 / zod 3 / vitest。HTTP 用 Node 内置 fetch（undici）；流式用原生 Readable；不引入重型框架。不走 Rust。

## 4 层架构

```text
┌─ Protocol Surfaces（src/protocol/）────────────────────────────┐
│  GET /health · GET /v1/models · POST /v1/chat/completions       │
│  （/v1/messages 仅非流式；其余扩展接口待后续）  │
├─ Router Core（src/router/）────────────────────────────────────┤
│  模型名 → canonical group → 候选 (adapter, model) → QoS 排序    │
│  → 显式 queue + 取消守卫 + 有限重排队                            │
├─ Upstream Adapters（src/adapters/）────────────────────────────┤
│  每个桥接源一个目录：workbuddy/ trae/ …（插件化，单源互不影响）   │
│  ProviderAdapter：probe / launch / supportedModes / fetchQuota  │
│  / dispose；Quota 状态 ok | exhausted | unknown                 │
├─ Catalog & Credential（src/catalog/）──────────────────────────┤
│  模型目录缓存：定时 sweep + 单飞 inflightFetch + 代际 abort      │
│  + invalidate() 快照重建；随机 secret；凭据仅在 daemon 内使用   │
└────────────────────────────────────────────────────────────────┘
```

代码骨架目录与上述一一对应：`src/adapters/`（types.ts 定义 ProviderAdapter 接口，registry.ts 注册表）、`src/router/`、`src/protocol/`、`src/catalog/`、`src/cli/`（`accessmux serve|status|provider list`）。

## 凭据安全（D30 修订后的实际边界）

- WorkBuddy / Trae 的凭据读取、解密、刷新，以及 ZCode 直连的 JWT 解密都在 AccessMux daemon 进程内完成。内部 shim 是同一 Node.js 进程里的 HTTP server，不是独立凭据进程。目录或闭包隔离不等于进程隔离。
- 凭据只在必要的 adapter / checkin 路径使用，不进入浏览器配置响应、宿主响应、诊断日志、Git 或项目记忆；测试只用合成凭据。dispose 清除缓存引用，但 JavaScript 字符串不能保证物理擦除。
- 内部 shim 使用 loopback 监听、随机端口和随机 secret；主服务使用 loopback Host / Origin 门。secret 不保护 daemon 内存，也不防止同一用户权限下的恶意本地进程。模型客户端的无 Origin 本机请求仍受支持，不应把服务暴露到公网。
- 本机凭据副本和兼容 PAT 配置按敏感文件处理：目录 0700、文件 0600，私有临时文件原子替换；真实宿主登录文件只读，不收紧或改写宿主资产。
- Qoder 推理凭据由官方 CLI 自行持有；可选签到 PAT 则由 AccessMux 从本机文件读取。ZCode app-server 兜底已禁用，不经其 stdio 传递凭据。
- **已知限制 / Phase 2**：真实的独立凭据进程和 IPC 能力句柄尚未实现。这是 D30 明确接受的边界降级，不再承诺“凭据不出 shim 进程”。

## 机制参考

| 要做的事 | 参考 |
|---|---|
| shim + 随机端口 secret、多区域、展示 id ↔ wire id | dsh-connect-trae（报告 §12 #1-#3） |
| Adapter 继承扩展、reasoning 字段翻译 | dsh-workbuddy-connect（#4-#5） |
| Quota 注册表、stall 守护、配置分层 | FeiZhuLulu/Agent-Bridge（#6-#9） |
| 路由 DSL、QoS 公式、provider 字典 | ellipticmarketing/modelrelay（#10-#12） |
| 队列状态机、取消守卫、ProviderRouting | ericflo/modelrelay（#13-#16，用 TS 重写） |
| Adapter 接口、沙箱档位、BoundedBuffer | is-bo/agentbridge（#17-#20） |
| MCP 工具集、Identity 隔离 | agentmuxai/agentmux（#21-#25，Phase 2） |

**不抄**（报告 §12 不抄表）：DSH Cordis 框架与私有包、Trae 反作弊 header 模拟、Electron/CEF 桌面 UI、tmux/Discord 强绑定、SaaS 部署形态。

## Adapter 接口（权威定义在 src/adapters/types.ts）

`ProviderAdapter`：`id` / `displayName` / `sandbox` / `probe()` / `launch()` / `supportedModes()` / `fetchQuota()` / `dispose()`；`ProviderSession`：`runTurn()`（流式）/ `startSession()` / `cancel()` / `status()`。LockedUsage 适配器额外持有自己的 shim 与凭据读取逻辑，凭据处理不得上抛出该目录。

## 上游稳定性预期

所有国内桌面 IDE 的锁定额度都依赖未公开路径，上游发版随时可能让 adapter 失效（报告 §7.2）。因此：每源独立 adapter、独立测试；失效按单源修复，不改核心层协议。
