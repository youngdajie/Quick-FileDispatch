#!/usr/bin/env bash
#
# Go 版出包：编译 → 注入图标 → 打成 NSIS 安装包。
#
# 三步都不能少：
#   1. go build 出来的是单 exe，本身就能跑；
#   2. 但 Go **不会给 exe 嵌图标和版本信息**（Electron 版是 electron-builder 注入的），
#      所以要用 rcedit 补上，否则资源管理器里是个白板图标；
#   3. 最后套一层 NSIS —— 开始菜单 / 桌面快捷方式、添加删除程序里的卸载入口
#      都得靠它（脚本在 tools/installer/installer.nsi）。
#
# 用法：
#   bash tools/installer/build.sh
#   bash tools/installer/build.sh 2.8.1-go   # 指定版本号
#
# 版本号默认从 main.go 的 const version 读，不用两处手动同步。
#
# 依赖（都装在本机的隔离目录里，不污染用户环境）：
#   Go      $HOME/.workbuddy/binaries/go/go
#   NSIS    $HOME/.workbuddy/binaries/nsis/Bin/makensis.exe
#   rcedit  $HOME/.workbuddy/binaries/node/workspace/node_modules/rcedit/bin/rcedit-x64.exe
#
# 为什么不用 .demo/ 放脚本：那个目录在 .gitignore 里（本机测试脚手架，不入库），
# 脚本放那儿等于没提交。Go 环境也顺手在这里自己找，不再依赖 .demo/goenv.sh。

set -e
cd "$(dirname "$0")/../.."

# Go 是隔离安装的，平时不在 PATH 里；没找到就自己加
if ! command -v go >/dev/null 2>&1; then
  GOROOT_WIN="${HOME}/.workbuddy/binaries/go/go"
  [ -d "$GOROOT_WIN" ] || { echo "没找到 go，也没找到隔离安装目录 $GOROOT_WIN"; exit 2; }
  export PATH="$GOROOT_WIN/bin:$PATH"
  # go.exe 是原生 Windows 程序，看不懂 Git Bash 的 /c/... 写法，GOROOT 要 C:/... 形式
  export GOROOT="$(cygpath -m "$GOROOT_WIN" 2>/dev/null || printf '%s' "$GOROOT_WIN")"
  export GOPATH="$(cygpath -m "${HOME}/.workbuddy/binaries/go/gopath" 2>/dev/null || echo "${HOME}/.workbuddy/binaries/go/gopath")"
fi
# 只认本机装的那个版本：go.mod 里写 go 1.24 是为了兼容性，
# 不是让 toolchain 去网上下载别的版本
export GOTOOLCHAIN=local

MAKENSIS="$HOME/.workbuddy/binaries/nsis/Bin/makensis.exe"
RCEDIT="$HOME/.workbuddy/binaries/node/workspace/node_modules/rcedit/bin/rcedit-x64.exe"

for f in "$MAKENSIS" "$RCEDIT"; do
  [ -f "$f" ] || { echo "缺 $f —— 先装（NSIS 用官方安装包静默装到 ~/.workbuddy/binaries/nsis，rcedit 在隔离的 node workspace 里 npm i）"; exit 2; }
done

VERSION="${1:-$(grep -m1 'const version' main.go | sed -E 's/.*"(.*)".*/\1/')}"
[ -n "$VERSION" ] || { echo "从 main.go 里没读到版本号"; exit 2; }
# VIProductVersion 只认 X.X.X.X 这种纯数字，把 -go 这类后缀去掉再补一位
VERSION_NUM="$(printf '%s' "$VERSION" | sed -E 's/-.*//').0"

# 本机没有 bc，用 awk 算 MiB
mib() { stat -c%s "$1" | awk '{printf "%.1f MiB", $1/1048576}'; }

OUT_DIR="$PWD/dist-go"
EXE="$OUT_DIR/QuickFileDispatch-$VERSION.exe"

echo "== 版本号 $VERSION（VI 用 $VERSION_NUM）"

echo "== 1/3 go build"
# 不加 -ldflags="-s -w"：刚起步，留着符号表，崩溃时栈能看出函数名。
# 等稳定了再考虑（实测能小 3~4 MB）。
go build -o "$EXE" .
echo "   $(mib "$EXE")"

echo "== 2/3 rcedit 注入图标与版本信息"
"$RCEDIT" "$EXE" \
  --set-icon build/icon.ico \
  --set-file-version "$VERSION_NUM" \
  --set-product-version "$VERSION" \
  --set-version-string "FileDescription" "快捷文件分发服务@JIE" \
  --set-version-string "ProductName" "快捷文件分发服务@JIE" \
  --set-version-string "CompanyName" "小杰" \
  --set-version-string "LegalCopyright" "Copyright (c) 2026 小杰"

echo "== 3/3 makensis 打安装包"
"$MAKENSIS" \
  "/DVERSION=$VERSION" \
  "/DVERSION_NUM=$VERSION_NUM" \
  "/DSRC_EXE=$(cygpath -w "$EXE")" \
  "/DOUT_DIR=$(cygpath -w "$OUT_DIR")" \
  "/DICON_FILE=$(cygpath -w "$PWD/build/icon.ico")" \
  "/DLICENSE_FILE=$(cygpath -w "$PWD/LICENSE")" \
  tools/installer/installer.nsi

SETUP="$OUT_DIR/QuickFileDispatch-Setup-$VERSION.exe"
echo
echo "== 完成"
echo "   单 exe   $(mib "$EXE")  $EXE"
echo "   安装包   $(mib "$SETUP")  $SETUP"
