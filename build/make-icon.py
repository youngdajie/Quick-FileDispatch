# -*- coding: utf-8 -*-
"""把 yangjie-favicon b3 系列的 PNG 拼成 Windows 用的多尺寸 icon.ico，并拷一份 SVG 进渲染层。

不依赖任何第三方库：ICO 允许直接内嵌 PNG（Vista+），所以只需按 ICONDIR 结构拼装。
"""

import os
import shutil
import struct

SRC_DIR = r"C:\Users\43487\DeskBox\我的桌面\项目文件\yangjie-favicon\01-B系列推荐\b3"
PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICO = os.path.join(PROJ, "build", "icon.ico")
OUT_PNG = os.path.join(PROJ, "build", "icon.png")
LOGO_DIR = os.path.join(PROJ, "src", "renderer", "assets")

# Windows 图标需要的尺寸；源文件里都有现成的，直接取，不做重采样
SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_png(size):
    path = os.path.join(SRC_DIR, "favicon-b3-%dx%d.png" % (size, size))
    if not os.path.exists(path):
        raise SystemExit("缺少源文件: " + path)
    with open(path, "rb") as f:
        data = f.read()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit("不是 PNG: " + path)
    return data


def build_ico(entries):
    n = len(entries)
    header = struct.pack("<HHH", 0, 1, n)
    offset = 6 + 16 * n
    dirs = b""
    payload = b""
    for size, data in entries:
        w = 0 if size >= 256 else size
        dirs += struct.pack("<BBBBHHII", w, w, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)
    return header + dirs + payload


def main():
    entries = [(s, load_png(s)) for s in SIZES]
    ico = build_ico(entries)
    with open(OUT_ICO, "wb") as f:
        f.write(ico)
    print("wrote %s (%d bytes, %d sizes: %s)"
          % (OUT_ICO, len(ico), len(entries), ", ".join(str(s) for s in SIZES)))

    with open(OUT_PNG, "wb") as f:
        f.write(dict(entries)[256])
    print("wrote", OUT_PNG)

    os.makedirs(LOGO_DIR, exist_ok=True)
    for name in ("favicon-b3.svg", "favicon-b3-small.svg"):
        src = os.path.join(SRC_DIR, name)
        if os.path.exists(src):
            dst = os.path.join(LOGO_DIR, "logo.svg" if "small" not in name else "logo-small.svg")
            shutil.copyfile(src, dst)
            print("copied", name, "->", dst)


if __name__ == "__main__":
    main()
