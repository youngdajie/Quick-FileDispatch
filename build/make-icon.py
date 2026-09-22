# -*- coding: utf-8 -*-
"""生成 Windows 用图标（build/icon.ico、build/icon.png）与渲染层的 logo。

**所有尺寸都从 1024 那张主图缩放出来。**

为什么不能按尺寸逐个取源文件：源目录里那套 favicon 的 16/24/32 是设计师单独做的
「浅底 + 深蓝线」小尺寸版，48 往上才是「蓝底 + 白轮」。两种设计混进同一个 .ico，
Windows 会按需要的档位去挑 —— 任务栏（48 档）是蓝底，右键菜单和资源管理器的小图标
（16~32 档）却成了浅底，同一个程序两副面孔。应用图标不是浏览器 favicon，
必须一套设计走到底，所以这里统一从主图缩。

依赖 Pillow（重采样用它最省事）：
    pip install pillow

用法：
    python build/make-icon.py
"""

import io
import os
import struct

from PIL import Image

SRC_DIR = r"C:\Users\43487\DeskBox\我的桌面\项目文件\yangjie-favicon\01-B系列推荐\b3"
MASTER = "favicon-b3-1024x1024.png"

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_ICO = os.path.join(PROJ, "build", "icon.ico")
OUT_PNG = os.path.join(PROJ, "build", "icon.png")
LOGO_DIR = os.path.join(PROJ, "src", "renderer", "assets")

# Windows 图标需要的尺寸。ICO 允许直接内嵌 PNG（Vista+），所以按 ICONDIR 结构拼装即可
SIZES = [16, 24, 32, 48, 64, 128, 256]


def load_master():
    path = os.path.join(SRC_DIR, MASTER)
    if not os.path.exists(path):
        raise SystemExit("缺少主图: " + path)
    im = Image.open(path)
    if im.size != (1024, 1024):
        raise SystemExit("主图不是 1024x1024: " + str(im.size))
    return im.convert("RGBA")


def render_png(master, size):
    """把主图缩到目标尺寸，返回 PNG 字节。

    先按整数倍做一次面积平均（reduce），把比例压到 4 倍以内再交给 LANCZOS。
    1024 直接缩到 16 是 64 倍，LANCZOS 会在圆角边缘拉出一圈振铃；
    面积平均不会。32/64/128/256 这些能整除的尺寸，一步 reduce 就到位了。
    """
    im = master
    k = im.width // size
    while k > 1 and im.width % k:
        k -= 1
    if k > 1:
        im = im.reduce(k)
    if im.width != size:
        im = im.resize((size, size), Image.LANCZOS)

    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


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
    master = load_master()
    entries = [(s, render_png(master, s)) for s in SIZES]

    with open(OUT_ICO, "wb") as f:
        f.write(build_ico(entries))
    print("wrote %s (%d sizes: %s)"
          % (OUT_ICO, len(entries), ", ".join(str(s) for s in SIZES)))

    # icon.png 留 256 —— electron-builder 在没给 .ico 的场合会用它
    with open(OUT_PNG, "wb") as f:
        f.write(dict(entries)[256])
    print("wrote", OUT_PNG)

    # 渲染层那两个 logo 是矢量，直接拷源文件（跟 .ico 的两套设计无关）
    os.makedirs(LOGO_DIR, exist_ok=True)
    for name, dst in (("favicon-b3.svg", "logo.svg"), ("favicon-b3-small.svg", "logo-small.svg")):
        src = os.path.join(SRC_DIR, name)
        if os.path.exists(src):
            with open(src, "rb") as a, open(os.path.join(LOGO_DIR, dst), "wb") as b:
                b.write(a.read())
            print("copied", name, "->", dst)


if __name__ == "__main__":
    main()
