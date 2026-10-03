#!/usr/bin/env bash
# AccessMux 一键安装脚本（zsh / bash 兼容，macOS 与 Linux 通用）
#
# 依次做四件事：
#   1) 检查 Node 版本（要求 >= 22，不达标给 brew 指引）
#   2) npm install
#   3) npm run build
#   4) 启动接入向导 accessmux onboard（参数原样透传）
#
# 幂等：可以随时重复运行。已装的依赖会跳过下载、构建覆盖 dist、onboard 会跳过已接入的宿主。
#
# 用法：
#   ./install.sh                 交互式选择一次当前宿主
#   ./install.sh --host workbuddy --yes  仅接当前宿主（由 Agent 真实会话传入）
#   ./install.sh --dry-run       只预览将改动哪些文件，不写任何配置
#   ./install.sh --all-hosts --yes  用户明确要求时接入全部宿主
#   ./install.sh --host workbuddy --smoke  显式发测试消息（会用额度）
#   ./install.sh --port 8090     指定本地服务端口（默认 8080）
#   ./install.sh --no-onboard    只装依赖 + 构建，不跑接入向导
#   ./install.sh --help          看这段说明
#
# 脚本只写仓库内的 node_modules/ 与 dist/；宿主配置一律交给 onboard（自动备份 + 纯增写入 +
# 打印回滚命令）。不读、不打印、不上传任何凭据。

set -u

BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; RESET=''
if [ -t 1 ]; then
  BOLD=$(printf '\033[1m'); DIM=$(printf '\033[2m')
  RED=$(printf '\033[31m'); GREEN=$(printf '\033[32m'); YELLOW=$(printf '\033[33m')
  RESET=$(printf '\033[0m')
fi

step() { printf '\n%s==> %s%s\n' "$BOLD" "$1" "$RESET"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$1"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
die() {
  printf '\n%s✗ %s%s\n' "$RED" "$1" "$RESET" >&2
  shift
  for line in "$@"; do printf '  %s\n' "$line" >&2; done
  exit 1
}

usage() {
  cat <<'USAGE'
AccessMux 一键安装脚本（zsh / bash 兼容，macOS 与 Linux 通用）

依次做四件事：
  1) 检查 Node 版本（要求 >= 22，不达标给 brew 指引）
  2) npm install
  3) npm run build
  4) 启动接入向导 accessmux onboard（参数原样透传）

幂等：可以随时重复运行。已装的依赖会跳过下载、构建覆盖 dist、onboard 会跳过已接入的宿主。

用法：
  ./install.sh                 交互式选择一次当前宿主
  ./install.sh --host workbuddy --yes  仅接当前宿主（由 Agent 真实会话传入）
  ./install.sh --dry-run       只预览将改动哪些文件，不写任何配置
  ./install.sh --smoke         已接入的宿主也重新发一条测试消息
  ./install.sh --port 8090     指定本地服务端口（默认 8080）
  ./install.sh --no-onboard    只装依赖 + 构建，不跑接入向导
  ./install.sh --help          看这段说明

脚本只写仓库内的 node_modules/ 与 dist/；宿主配置一律交给 onboard（自动备份 + 纯增写入 +
打印回滚命令）。不读、不打印、不上传任何凭据。

装完怎么用、怎么卸载、出问题怎么查：见 INSTALL.md。
USAGE
}

RUN_ONBOARD=1
ONBOARD_ARGS=()
HAS_SCOPE=0
PREVIEW=0
for arg in "$@"; do
  case "$arg" in
    -h|--help) usage; exit 0 ;;
    --no-onboard) RUN_ONBOARD=0 ;;
    --host|--all-hosts) HAS_SCOPE=1; ONBOARD_ARGS+=("$arg") ;;
    --dry-run) PREVIEW=1; ONBOARD_ARGS+=("$arg") ;;
    *) ONBOARD_ARGS+=("$arg") ;;
  esac
done
if [ "$RUN_ONBOARD" -eq 1 ] && [ "$HAS_SCOPE" -eq 0 ] && [ "$PREVIEW" -eq 0 ] && [ ! -t 0 ]; then
  die "请明确当前宿主，例如 ./install.sh --host workbuddy --yes" \
    "Agent 从真实会话确定宿主；不确定时只问用户一次。全部接入请显式用 --all-hosts --yes。"
fi

# ---------- 0. 定位仓库根 ----------
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd) || die "无法定位脚本所在目录"
cd "$SCRIPT_DIR" || die "无法进入目录：$SCRIPT_DIR"

[ -f package.json ] || die "这里不是 AccessMux 仓库根目录（找不到 package.json）：$SCRIPT_DIR" \
  "请把 install.sh 放在仓库根目录下运行，或在仓库根目录执行：./install.sh"
grep -q '"name"[[:space:]]*:[[:space:]]*"accessmux"' package.json 2>/dev/null \
  || die "package.json 里的项目名不是 accessmux，可能拿错目录了：$SCRIPT_DIR"

printf '%sAccessMux 安装脚本%s  %s(%s)%s\n' "$BOLD" "$RESET" "$DIM" "$SCRIPT_DIR" "$RESET"

# ---------- 1. 环境检查 ----------
step "1/4 检查环境"

if ! command -v node >/dev/null 2>&1; then
  die "没有找到 node（Node.js 未安装或不在 PATH 里）" \
    "macOS 安装：brew install node" \
    "其它系统：https://nodejs.org 下载 LTS 版" \
    "装完新开一个终端，再跑一次本脚本。"
fi
NODE_BIN=$(command -v node)
NODE_VER=$("$NODE_BIN" -v 2>/dev/null)
NODE_MAJOR=$(printf '%s' "$NODE_VER" | sed 's/^v//' | cut -d. -f1)
case "$NODE_MAJOR" in
  ''|*[!0-9]*) die "读不出 node 版本号（node -v 输出：${NODE_VER}）" "请重装 Node：brew install node" ;;
esac
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node 版本过低：当前 ${NODE_VER}，AccessMux 要求 v22 或更高" \
    "macOS 升级：brew install node（或 brew upgrade node）" \
    "其它系统：https://nodejs.org 下载 LTS 版" \
    "升级后新开一个终端，再跑一次本脚本。"
fi
ok "Node ${NODE_VER}（${NODE_BIN}）"

if ! command -v npm >/dev/null 2>&1; then
  die "没有找到 npm（通常随 Node 一起安装）" \
    "macOS：brew install node" \
    "或检查 PATH 是否包含 npm 的安装目录。"
fi
ok "npm $(npm -v 2>/dev/null)"

# ---------- 2. 依赖 ----------
step "2/4 安装依赖（npm install）"
if [ -d node_modules ]; then
  printf '%s   已有 node_modules，本次只做增量更新%s\n' "$DIM" "$RESET"
fi
if [ -f package-lock.json ]; then
  INSTALL_ARGS=(ci)
else
  INSTALL_ARGS=(install --package-lock=false)
fi
if ! npm "${INSTALL_ARGS[@]}"; then
  die "npm install 失败" \
    "常见原因：网络不通（npm 源访问不了）、Node 版本过低、或 npm 缓存损坏。" \
    "可尝试：npm cache verify 后重跑；或换源 npm config set registry https://registry.npmmirror.com" \
    "上面的完整报错就是线索，别跳过它。"
fi
ok "依赖就绪"

# ---------- 3. 构建 ----------
step "3/4 构建（npm run build）"
if ! npm run build; then
  die "npm run build 失败" \
    "先确认 Node 版本 >= 22（node -v），再重跑 npm install，然后重试本脚本。" \
    "上面的完整报错就是线索，别跳过它。"
fi
[ -f dist/cli/index.js ] || die "构建产物缺失：$SCRIPT_DIR/dist/cli/index.js" \
  "npm run build 没报错但产物不在，请检查 tsconfig.json 的 outDir 配置。"
ok "构建完成（dist/cli/index.js 已就位）"

# ---------- 4. 接入向导 ----------
if [ "$RUN_ONBOARD" -eq 0 ]; then
  printf '\n%s跳过接入向导（--no-onboard）。%s\n' "$DIM" "$RESET"
  printf '需要时手动跑：%snode dist/cli/index.js onboard --host <id> --yes%s\n' "$BOLD" "$RESET"
  exit 0
fi

step "4/4 接入向导（accessmux onboard）"

"$NODE_BIN" "$SCRIPT_DIR/dist/cli/index.js" onboard "${ONBOARD_ARGS[@]}"
ONBOARD_CODE=$?

printf '\n'
if [ "$ONBOARD_CODE" -eq 0 ]; then
  ok "接入向导完成"
  printf '  %s下一步：打开你的 Agent → 模型选择器里选 "AccessMux" 组 → 发消息。%s\n' "$BOLD" "$RESET"
  printf '  %s重新开页/启动服务：重跑相同的 onboard 命令；地址以上方实际 URL 为准%s\n' "$DIM" "$RESET"
  printf '  %s卸载与回滚：见 INSTALL.md 第 2.7 节（onboard 每次写入前都有备份）%s\n' "$DIM" "$RESET"
else
  warn "接入向导没有全部成功（退出码 $ONBOARD_CODE）——上面每条失败都附了原因和手动接法。"
  printf '  %s依赖与构建已完成，修掉上面的问题后重跑本脚本即可（幂等，不会重复注册）。%s\n' "$DIM" "$RESET"
fi
exit "$ONBOARD_CODE"
