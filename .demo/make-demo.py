# -*- coding: utf-8 -*-
"""造一个假的图床仓库，用于本地端到端验证"""
import os
import struct
import zlib
import random

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'repo')


def png(w, h, pixel):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        for x in range(w):
            r, g, b = pixel(x, y)
            raw += bytes((r, g, b))
    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b'\x89PNG\r\n\x1a\n'
            + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(bytes(raw), 6))
            + chunk(b'IEND', b''))


def make_specs():
    specs = [
        ('images/2026/09/sunset.png', 320, 200, lambda x, y, w=320, h=200: (240 - int(90 * y / h), 120 + int(90 * y / h), 80 + int(120 * x / w))),
        ('images/2026/09/deep-blue.png', 240, 240, lambda x, y: (40, 90 + (y % 120), 200 - (x % 120))),
        ('images/2026/09/mint.png', 280, 180, lambda x, y: (60, 200 - int(80 * y / 180), 160)),
        ('images/2026/08/old-photo.png', 200, 260, lambda x, y: (170, 150, 120)),
        ('logo/logo-mark.png', 128, 128, lambda x, y: (255, 255, 255) if (x - 64) ** 2 + (y - 64) ** 2 < 2600 else (79, 139, 255)),
        ('logo/wordmark.png', 300, 90, lambda x, y: (30, 40, 60) if (y // 10) % 3 == 0 else (235, 240, 250)),
    ]
    return specs


def main():
    os.makedirs(OUT, exist_ok=True)
    for rel, w, h, fn in make_specs():
        path = os.path.join(OUT, rel.replace('/', os.sep))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'wb') as f:
            f.write(png(w, h, fn))
        print('wrote', rel)
    # 顺手放两个非图片文件，验证「不设限制」
    readme = os.path.join(OUT, 'README.md')
    with open(readme, 'w', encoding='utf-8') as f:
        f.write('# 我的图床仓库\n\n这个仓库由 CloudPic 管理。\n')
    print('wrote README.md')
    data = os.path.join(OUT, 'assets', 'data.json')
    os.makedirs(os.path.dirname(data), exist_ok=True)
    with open(data, 'w', encoding='utf-8') as f:
        f.write('{"demo": true, "generated": "2026-09-15"}\n')
    print('wrote assets/data.json')


if __name__ == '__main__':
    random.seed(7)
    main()
