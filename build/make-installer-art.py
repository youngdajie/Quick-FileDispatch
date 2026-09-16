# -*- coding: utf-8 -*-
"""生成 NSIS 安装向导用的位图（Header 150x57 / Sidebar 164x314）。

为什么要自己画：NSIS 默认那套 nsis3-metro 是 2015 年的浅灰蓝渐变，
和程序里的深色界面完全是两个世界；安装界面是用户见到的第一屏，值得对齐一下。

依赖 Pillow（本地生成用，不进产品依赖）：
  pip install Pillow
只被 build 时手动执行，产物直接进 build/ 目录，随包提交。

**改完 package.json 的 version 之后必须重跑本脚本再打包**，否则安装向导里
印的还是上一版的版本号（位图里写死了版本，electron-builder 不会重画）。
  python build/make-installer-art.py   # 或 npm run art
"""

import json
import os
from PIL import Image, ImageDraw, ImageFont

PROJ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(PROJ, "build")
ICON = os.path.join(OUT_DIR, "icon.png")
FONT_DIR = os.environ.get("WINDIR", r"C:\Windows") + r"\Fonts"

with open(os.path.join(PROJ, "package.json"), encoding="utf-8") as fh:
    VERSION = json.load(fh)["version"]

SS = 4  # 超采样倍数：小字号直接画会糊，先放大画再缩回来

# 和 app.css 深色主题同一套色
C_BG_TOP = (13, 23, 40)
C_BG_BOT = (7, 11, 18)
C_ACCENT = (78, 155, 234)
C_ACCENT_DEEP = (43, 108, 184)
C_TEXT = (232, 238, 247)
C_DIM = (159, 176, 198)
C_MUTED = (107, 124, 147)
C_LINE = (27, 41, 64)

PRODUCT = "快捷文件分发服务@JIE"
TAGLINE = "GitHub / Gitee 仓库当文件仓库用"
SUB = "本地多核压缩 · 云端文件管理"


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), size)


def grad(size, top, bot, diag=False):
    """竖直（或斜向）渐变底"""
    w, h = size
    img = Image.new("RGB", size)
    px = img.load()
    span = (w + h) if diag else h
    for y in range(h):
        for x in range(w):
            t = (x + y) / span if diag else y / max(1, h - 1)
            t = max(0.0, min(1.0, t))
            px[x, y] = (
                round(top[0] + (bot[0] - top[0]) * t),
                round(top[1] + (bot[1] - top[1]) * t),
                round(top[2] + (bot[2] - top[2]) * t),
            )
    return img


def rounded_icon(size):
    src = Image.open(ICON).convert("RGBA").resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * 0.22), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(src, (0, 0), mask)
    return out


def text_w(draw, s, f):
    box = draw.textbbox((0, 0), s, font=f)
    return box[2] - box[0]


def build_header():
    """150x57，NSIS 会把它贴在向导页头部右侧（MUI_HEADERIMAGE_RIGHT）"""
    W, H = 150, 57
    img = grad((W * SS, H * SS), (16, 28, 48), C_BG_BOT, diag=True).convert("RGB")

    # 左上往右下撒一点品牌色雾，免得整块死黑
    haze = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    ImageDraw.Draw(haze).ellipse([-30 * SS, -30 * SS, 90 * SS, 45 * SS], fill=C_ACCENT_DEEP + (70,))
    img = Image.alpha_composite(img.convert("RGBA"), haze).convert("RGB")
    d = ImageDraw.Draw(img)

    f_name = font("msyhbd.ttc", 11 * SS)
    f_sub = font("msyh.ttc", 8 * SS)

    pad = 12 * SS
    name = PRODUCT
    d.text((W * SS - pad - text_w(d, name, f_name), 10 * SS), name, font=f_name, fill=C_TEXT)
    d.text((W * SS - pad - text_w(d, TAGLINE, f_sub), 28 * SS), TAGLINE, font=f_sub, fill=C_MUTED)

    # 贴着文字区的那一侧留一条 2px 品牌色，当作和左边标题的分界
    d.rectangle([0, 0, 2 * SS, H * SS], fill=C_ACCENT)

    # 底部渐隐细线
    line = Image.new("RGB", (W * SS, 2 * SS))
    lp = line.load()
    for x in range(W * SS):
        t = 1 - x / (W * SS - 1)
        bg = (10, 17, 30)
        c = C_ACCENT
        col = tuple(round(bg[i] + (c[i] - bg[i]) * (t ** 0.7)) for i in range(3))
        for y in range(2 * SS):
            lp[x, y] = col
    img.paste(line, (0, H * SS - 2 * SS))

    return img.resize((W, H), Image.LANCZOS)


def build_sidebar():
    """164x314，出现在欢迎页 / 完成页左侧（MUI_WELCOMEFINISHPAGE_BITMAP）"""
    W, H = 164, 314
    img = grad((W * SS, H * SS), (14, 24, 42), (6, 9, 16), diag=True)

    # 顶部一团品牌色雾（斜向渐变配一点光，避免大片纯色发闷）
    haze = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
    ImageDraw.Draw(haze).ellipse([-60 * SS, -90 * SS, 180 * SS, 70 * SS], fill=C_ACCENT_DEEP + (64,))
    img = Image.alpha_composite(img.convert("RGBA"), haze).convert("RGB")
    d = ImageDraw.Draw(img)

    # 应用图标
    ico = rounded_icon(58 * SS)
    img.paste(ico, (17 * SS, 32 * SS), ico)

    f_name = font("msyhbd.ttc", 12 * SS)
    f_tag = font("msyh.ttc", 8 * SS)
    f_sub = font("msyh.ttc", 8 * SS)

    # 产品名一行放下：中文用亮色，@JIE 用品牌色
    y = 108 * SS
    part1, part2 = "快捷文件分发服务", "@JIE"
    d.text((17 * SS, y), part1, font=f_name, fill=C_TEXT)
    d.text((17 * SS + text_w(d, part1, f_name) + 4 * SS, y), part2, font=f_name, fill=C_ACCENT)

    d.text((17 * SS, 132 * SS), TAGLINE, font=f_tag, fill=C_MUTED)

    # 分隔线 + 三行要点
    d.line([(17 * SS, 152 * SS), (147 * SS, 152 * SS)], fill=C_LINE, width=max(1, SS // 2))
    items = ["本地多核压缩", "云端 · 本地双向同步", "GitHub / Gitee 双平台"]
    yy = 165 * SS
    for it in items:
        d.ellipse([17 * SS, yy + 4 * SS, 21 * SS, yy + 8 * SS], fill=C_ACCENT)
        d.text((28 * SS, yy - 1 * SS), it, font=f_sub, fill=C_DIM)
        yy += 18 * SS

    # 底部：版本 + 作者
    d.line([(17 * SS, 268 * SS), (147 * SS, 268 * SS)], fill=C_LINE, width=max(1, SS // 2))
    d.text((17 * SS, 276 * SS), "v" + VERSION, font=f_sub, fill=C_MUTED)
    d.text((17 * SS, 291 * SS), "yangjie.site", font=f_sub, fill=C_DIM)

    return img.resize((W, H), Image.LANCZOS)


def main():
    if not os.path.exists(ICON):
        raise SystemExit("缺少 " + ICON)

    header = build_header()
    sidebar = build_sidebar()

    # NSIS 要 24 位 BMP
    header.convert("RGB").save(os.path.join(OUT_DIR, "installerHeader.bmp"), "BMP")
    sidebar.convert("RGB").save(os.path.join(OUT_DIR, "installerSidebar.bmp"), "BMP")
    # 同时留一份 PNG 方便肉眼检查（不参与打包）
    header.save(os.path.join(OUT_DIR, "installerHeader.preview.png"))
    sidebar.save(os.path.join(OUT_DIR, "installerSidebar.preview.png"))

    for n in ("installerHeader.bmp", "installerSidebar.bmp"):
        p = os.path.join(OUT_DIR, n)
        print("%-26s %8d bytes" % (n, os.path.getsize(p)))
    # 把版本号打出来：位图里印的就是它，版本对不上会很难察觉
    print("版本号 v%s（取自 package.json，位图里印的就是这个）" % VERSION)


if __name__ == "__main__":
    main()
