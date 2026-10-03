# AccessMux 0.1.0 发布手册

版权署名：nengong。源码目标：`https://github.com/nengong-ai/AccessMux`；包名：`accessmux`。
目标地址不是发布成功证据，上传后须以匿名 HTTPS 获取验证。

## 首发形态与发布门

GitHub 首发为审计后的**完整源码发行**：从固定、已确认的开发候选提交，按显式白名单
导出到全新目录，清洗公开副本，再初始化只有一个干净首发提交的 Git 仓库。
不得 push 原开发仓库分支或历史。OpenCode 机制已换锚至官方 MIT 源，原 ow-bridge
许可问题已关闭；上游原始许可与归属继续保留在 [NOTICE](../NOTICE) 和
`docs/third-party-licenses/`，关闭该项不代表整体验收通过。

顺序是：取消/超时与安装接线收尾 → 独立复审 → 完整公开副本审计 → 上传 → 匿名验证。
测试全绿不能替代独立复审、敏感信息审计或主控放行。当前任务授权执行者在这些门通过后
创建/复用有权限的公开 `nengong-ai/AccessMux` 并上传；npm publish、GitHub Release
和本机安装状态清理不在此次授权内。开发库业务修复由主控提交并确认完整候选 SHA。

## 源码与运行时包分别包含什么

| 发行物 | 内容与使用入口 |
|---|---|
| GitHub 源码 | 生产 `src/`、构建脚本/配置、package.json 和锁文件、必要 DSH 插件源码、离线合成测试、README/INSTALL/CHANGELOG/LICENSE/NOTICE、安装/架构/宿主/许可文档；使用根目录 `./install.sh --host <id> --yes` |
| npm / Release tgz（后续渠道） | 编译 JS/类型、UI HTML/CSS、随包发布说明和许可；没有 src/tests/integrations，不能自动安装 DSH 插件。用 `npm install -g <已验收 tgz>` 或发布后的 registry 安装 |

DSH 实体位于 `integrations/dsh-accessmux-connect/`。使用源码根目录内的
`node dist/cli/index.js onboard --host dsh --yes`；仅切换目录再调用 npm 版 CLI
不会改变它的插件查找根目录。包内 `install.sh` 只适用于完整源码树。

随包必须公示：服务仅 loopback；凭据在 daemon 进程内存中处理、无独立凭据进程隔离；
OpenAI 支持 SSE、Anthropic Messages 仅非流式；多数源 chat-only；Qoder usage 估算；
ZCode 默认附带官方 harness 前缀（1253 字符，不改写），405/3012 报不可用，
app-server 兜底因本地工具权限未可靠限制而禁用。免费活动和模型可用性以来源的当前结果为准。

## 公开副本审计

记录开发候选完整 SHA、白名单、每个公开文件 SHA-256、清洗差异、扫描范围/结果、
许可证、相对链接解析和安装实体检查。副本不带开发 Git 历史、内部治理/研究/任务/回执/记忆、
真实采集/截图/日志/机器状态、node_modules、dist 恢复包、.env/.npmrc 或凭据。
测试只含合成输入。不能靠改名隐藏泄漏，不能删除许可正文和署名来清洗。

在新目录用锁文件安装、构建并运行合成测试；在隔离 HOME/状态目录验证安装入口，
不读取真实凭据、不改真实宿主、不发模型请求、不签到。运行时 tgz 用同一最终候选构建，
核对包清单、SHA-256、隔离安装与随包链接；后续 npm 与 Release 使用**同一个**验收 tgz。

## GitHub 上传与验证

现有 gh / 官方浏览器登录态只读核对账号与所有权。不读取/打印 token，不把凭据放进
命令行、remote 或日志。仓库不存在才创建 Public；已存在则核对可见性、内容与权限。
名称冲突、无权限或已有不同项目时停下交用户裁决；不覆盖、不 force push、不暗改归属。

仅在已审计的新发行目录建立 Git，使用 nengong 署名及公开 noreply 邮箱，按已审计
文件清单暂存，核对首发提交只有允许的文件。上传不触碰原开发仓库的 remote。
创建/推送失败先读取远端实际状态，不能把网络错误当成没有发生，也不能强推补救。

上传后匿名 HTTPS 读仓库并 clone 到新的临时目录，核 HEAD 等于审计的首发 commit，
README/INSTALL/src/DSH 实体与链接可达；再在隔离配置检查安装入口。
交付正式 HTTPS URL、公开 commit、文件清单与验证证据，明确本机安装未清理。
未取得成功证据不得开始演示前清理。

## 后续 npm / Release（另行授权）

保留最终验收 tgz 路径及 SHA-256。发布前核对账号、包名占用、版本和当时平台政策；
GitHub Release 的 tag 指向已核对公开提交，并上传同一 tgz。npm 登录授权在官方
交互流程完成，不把 token 写到项目中。两个渠道尚未发布时，文档应明确标为待发布。
任何误公开都不能靠删文件保证收回下载、fork 或缓存；真实凭据泄漏需先吊销轮换。
