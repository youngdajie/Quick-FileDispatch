#!/usr/bin/env bash
#
# 出包：编译 → 注入图标与版本信息 → 打成 NSIS 安装包。
#
# 三步都不能少：
#   1. go build 出来的是单 exe，本身就能跑；
#   2. 但 Go **不会给 exe 嵌图标和版本信息**（Electron 版是 electron-builder 做的），
#      少了它资源管理器里就是个白板图标。这里用 goversioninfo 生成资源文件
#      （.syso）放在包目录里，go build 会自动嵌进去；
#   3. 最后套一层 NSIS —— 开始菜单 / 桌面快捷方式、添加删除程序里的卸载入口
#      都得靠它（脚本在 tools/installer/installer.nsi）。
#
# **本地和 CNB 流水线跑的是同一个脚本**。这一点是刻意的：两套构建流程必然
# 漂移，最后表现成「本地出的包是好的、流水线出的包是白板图标」这种极难查的问题。
#
# 用法：
#   bash tools/installer/build.sh              # 版本号从 main.go 读
#   bash tools/installer/build.sh 3.3.0        # 指定版本号（本地自测用）
#
# 依赖：
#   Go              PATH 里，或 $HOME/.workbuddy/binaries/go/go
#   goversioninfo   没装会自动 go install（用国内代理，见下）
#   makensis        PATH 里，或 $HOME/.workbuddy/binaries/nsis/Bin/makensis.exe
#
# 为什么不再用 rcedit：它是 Windows 程序，CNB 的构建节点是 Linux，
# 跑不起来（wine 那条路太脆）。goversioninfo 是纯 Go 的，两个平台都能跑，
# 顺带把「本地装 Node 包才有 rcedit」这个依赖也去掉了。

set -e
cd "$(dirname "$0")/../.."

PROJ="$(pwd)"

# ---------------------------------------------------------------- 平台探测
# Git Bash / MSYS / Cygwin 认成 Windows；其余当 Unix。
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*) ON_WINDOWS=1 ;;
  *)                    ON_WINDOWS=0 ;;
esac

# ---------------------------------------------------------------- Go
if ! command -v go >/dev/null 2>&1; then
  GO_HOME="${HOME}/.workbuddy/binaries/go/go"
  [ -d "$GO_HOME" ] || { echo "没找到 go，也没找到隔离安装目录 $GO_HOME"; exit 2; }
  export PATH="$GO_HOME/bin:$PATH"
  if [ "$ON_WINDOWS" = 1 ]; then
    # go.exe 是原生 Windows 程序，看不懂 Git Bash 的 /c/... 写法
    export GOROOT="$(cygpath -m "$GO_HOME" 2>/dev/null || printf '%s' "$GO_HOME")"
    export GOPATH="$(cygpath -m "${HOME}/.workbuddy/binaries/go/gopath" 2>/dev/null || echo "${HOME}/.workbuddy/binaries/go/gopath")"
  fi
fi
# 只认本机装的那个版本：go.mod 里写 go 1.24 是为了兼容性，
# 不是让 toolchain 去网上下载别的版本
export GOTOOLCHAIN=local

# ---------------------------------------------------------------- goversioninfo
# 没装就现装。走国内代理 —— 默认的 proxy.golang.org 在国内基本连不上
# （实测：dial tcp 超时），不设这个流水线会在这一步卡死。
GOVI="$(command -v goversioninfo 2>/dev/null || true)"
if [ -z "$GOVI" ]; then
  GOPATH_BIN="$(go env GOPATH)/bin"
  if [ -x "$GOPATH_BIN/goversioninfo" ]; then
    GOVI="$GOPATH_BIN/goversioninfo"
  elif [ -x "$GOPATH_BIN/goversioninfo.exe" ]; then
    GOVI="$GOPATH_BIN/goversioninfo.exe"
  fi
fi
if [ -z "$GOVI" ]; then
  echo "== 安装 goversioninfo（首次需要，之后走缓存）"
  export GOPROXY="${GOPROXY:-https://goproxy.cn,direct}"
  go install github.com/josephspurrier/goversioninfo/cmd/goversioninfo@latest
  GOPATH_BIN="$(go env GOPATH)/bin"
  if   [ -x "$GOPATH_BIN/goversioninfo" ];     then GOVI="$GOPATH_BIN/goversioninfo"
  elif [ -x "$GOPATH_BIN/goversioninfo.exe" ]; then GOVI="$GOPATH_BIN/goversioninfo.exe"
  else echo "goversioninfo 装完却找不到，检查 GOPATH/bin：$GOPATH_BIN"; exit 2
  fi
fi

# ---------------------------------------------------------------- makensis
if command -v makensis >/dev/null 2>&1; then
  MAKENSIS="$(command -v makensis)"
elif [ -f "$HOME/.workbuddy/binaries/nsis/Bin/makensis.exe" ]; then
  MAKENSIS="$HOME/.workbuddy/binaries/nsis/Bin/makensis.exe"
else
  echo "没找到 makensis —— Linux 上装 nsis（apt-get install -y nsis / apk add nsis），"
  echo "Windows 上用官方安装包静默装到 ~/.workbuddy/binaries/nsis"
  exit 2
fi

# ---------------------------------------------------------------- 版本号
VERSION="${1:-$(grep -m1 'const version' main.go | sed -E 's/.*"(.*)".*/\1/')}"
[ -n "$VERSION" ] || { echo "从 main.go 里没读到版本号"; exit 2; }

# VIProductVersion 只认 X.X.X.X 这种纯数字，把 -go 这类后缀去掉再补一位
CORE="$(printf '%s' "$VERSION" | sed -E 's/-.*//')"
VERSION_NUM="${CORE}.0"
VER_MAJOR="$(printf '%s' "$CORE" | cut -d. -f1)"
VER_MINOR="$(printf '%s' "$CORE" | cut -d. -f2)"
VER_PATCH="$(printf '%s' "$CORE" | cut -d. -f3)"
[ -n "$VER_PATCH" ] || VER_PATCH=0

# 本机没有 bc，用 awk 算 MiB
mib() { stat -c%s "$1" 2>/dev/null | awk '{printf "%.1f MiB", $1/1048576}' \
        || ls -l "$1" | awk '{printf "%.1f MiB", $5/1048576}'; }

OUT_DIR="$PROJ/dist-go"
EXE="$OUT_DIR/QuickFileDispatch-$VERSION.exe"
SYSO="$PROJ/resource.syso"

mkdir -p "$OUT_DIR"

echo "== 版本号 $VERSION（VI 用 $VERSION_NUM）"

echo "== 1/4 生成图标与版本资源（goversioninfo）"
# 从模板生成 json：版本号只在 main.go 定义一处，不在这里再抄一遍
VI_JSON="$(mktemp 2>/dev/null || echo "$OUT_DIR/versioninfo.json")"
sed -e "s/@VER_MAJOR@/$VER_MAJOR/g" \
    -e "s/@VER_MINOR@/$VER_MINOR/g" \
    -e "s/@VER_PATCH@/$VER_PATCH/g" \
    -e "s/@VERSION_NUM@/$VERSION_NUM/g" \
    -e "s/@VERSION@/$VERSION/g" \
    tools/installer/versioninfo.json.in > "$VI_JSON"
"$GOVI" -o "$SYSO" "$VI_JSON"
[ -f "$SYSO" ] || { echo "goversioninfo 没生成 $SYSO"; exit 3; }
echo "   $(mib "$SYSO")"

echo "== 2/4 go build（交叉编译到 Windows）"
# 固定 GOOS/GOARCH：不管在 Windows 还是 Linux 上跑，产物都必须是 Windows amd64。
# 这也让「本地能编、流水线编不出来」这类问题失去土壤。
# -H=windowsgui：GUI 子系统，双击不弹 CMD 窗口（2026-09-23 反馈）。
# 不加 -ldflags="-s -w"：留着符号表，崩溃时栈能看出函数名。
#
# 防呆：先记旧 mtime，编完必须变新。出过一次「go build 没生效、安装包把
# 早上的旧 exe 打进去」的事故（装上还是老版），不检查根本发现不了。
old_mtime=$(stat -c%Y "$EXE" 2>/dev/null || echo 0)
GOOS=windows GOARCH=amd64 go build -ldflags "-H=windowsgui" -o "$EXE" .
new_mtime=$(stat -c%Y "$EXE" 2>/dev/null || echo 0)
if [ "$new_mtime" -le "$old_mtime" ]; then
  echo "go build 没有产出新文件（mtime 没前进），终止——先查为什么"
  exit 3
fi
echo "   $(mib "$EXE")"

echo "== 3/4 校验资源确实嵌进去了"
# 这一步不是多余的：goversioninfo 静默失败（比如图标路径写错）时
# go build 照样成功，只是 exe 里没有任何资源 —— 表现成「资源管理器白板图标」，
# 而且要等用户装上才发现。这里当场用 PE 结构验一遍。
if command -v python3 >/dev/null 2>&1 && [ -f tools/check-pe-resources.py ]; then
  python3 tools/check-pe-resources.py "$EXE" | grep -q "有图标" \
    || { echo "exe 里没有图标资源 —— goversioninfo 那步没生效"; exit 3; }
  echo "   图标与版本信息都在"
else
  echo "   （跳过：没有 python3，装到机器上时留意图标是否是白板）"
fi

echo "== 4/4 makensis 打安装包"
#
# 这里有三个**平台差异**，都实踩过：
#   1. 定义符号的开关前缀：Windows 是 /D，Linux 是 -D。
#      在 Linux 上传 /D 会被当成**脚本文件名**，报
#      `Can't open script "/DVERSION=..."`（2026-09-26 实踩）。
#   2. 路径形式：Windows 的 makensis.exe 认 C:\... 看不懂 /c/...（要 cygpath -w）。
#   3. Git Bash 的路径翻译：会把 "/DVERSION=..." 当成 POSIX 路径翻成
#      "<PortableGit>/DVERSION=..."，得靠 MSYS_NO_PATHCONV 关掉（2026-09-23 实踩）。
if [ "$ON_WINDOWS" = 1 ]; then
  D='/D'
  SRC_ARG="$(cygpath -w "$EXE")"
  OUT_ARG="$(cygpath -w "$OUT_DIR")"
  ICON_ARG="$(cygpath -w "$PROJ/build/icon.ico")"
  LIC_ARG="$(cygpath -w "$PROJ/LICENSE")"
else
  D='-D'
  SRC_ARG="$EXE"
  OUT_ARG="$OUT_DIR"
  ICON_ARG="$PROJ/build/icon.ico"
  LIC_ARG="$PROJ/LICENSE"
fi

DFLAGS=(
  "${D}VERSION=$VERSION"
  "${D}VERSION_NUM=$VERSION_NUM"
  "${D}SRC_EXE=$SRC_ARG"
  "${D}OUT_DIR=$OUT_ARG"
  "${D}ICON_FILE=$ICON_ARG"
  "${D}LICENSE_FILE=$LIC_ARG"
)

if [ "$ON_WINDOWS" = 1 ]; then
  MSYS_NO_PATHCONV=1 "$MAKENSIS" "${DFLAGS[@]}" tools/installer/installer.nsi
else
  "$MAKENSIS" "${DFLAGS[@]}" tools/installer/installer.nsi
fi

# 资源文件是中间产物，别留在工作区里（.gitignore 也忽略了它，双保险）
rm -f "$SYSO" "$VI_JSON" 2>/dev/null || true

SETUP="$OUT_DIR/QuickFileDispatch-Setup-$VERSION.exe"
[ -f "$SETUP" ] || { echo "安装包没生成：$SETUP"; exit 3; }

echo
echo "== 完成"
echo "   单 exe   $(mib "$EXE")  $EXE"
echo "   安装包   $(mib "$SETUP")  $SETUP"
