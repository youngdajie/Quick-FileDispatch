"""
验证 exe 的 PE 资源目录里到底有没有图标和版本信息。

为什么要费劲解析 PE：`goversioninfo` 生成 .syso、Go 编译时嵌入 —— 这条链路
任何一环错了，exe 都会「编译成功但资源是空的」（放资源管理器里就是白板图标），
而编译本身**不会报任何错**。所以必须真的把资源表读出来看。

用法：python check-pe-resources.py <exe> [另一个exe]
"""

import struct
import sys


def u16(d, o):
    return struct.unpack_from("<H", d, o)[0]


def u32(d, o):
    return struct.unpack_from("<I", d, o)[0]


def parse_sections(d, pe_off):
    coff = pe_off + 4
    nsec = u16(d, coff + 2)
    opt_size = u16(d, coff + 16)
    opt = coff + 20
    magic = u16(d, opt)
    is64 = magic == 0x20B  # PE32+
    dd = opt + (112 if is64 else 96)
    sec = opt + opt_size

    out = []
    for i in range(nsec):
        base = sec + i * 40
        name = d[base : base + 8].rstrip(b"\0").decode("latin1")
        vsize = u32(d, base + 8)
        vaddr = u32(d, base + 12)
        rawsize = u32(d, base + 16)
        rawptr = u32(d, base + 20)
        out.append((name, vaddr, vsize, rawptr, rawsize))
    return out, dd


def rva_to_off(secs, rva):
    for _name, vaddr, vsize, rawptr, rawsize in secs:
        if vaddr <= rva < vaddr + max(vsize, rawsize):
            return rawptr + (rva - vaddr)
    return None


# 资源类型 ID -> 名字（PE 规范里固定的那几个）
TYPE_NAMES = {
    1: "RT_CURSOR",
    2: "RT_BITMAP",
    3: "RT_ICON",
    4: "RT_MENU",
    5: "RT_DIALOG",
    6: "RT_STRING",
    10: "RT_RCDATA",
    12: "RT_GROUP_CURSOR",
    14: "RT_GROUP_ICON",
    16: "RT_VERSION",
    24: "RT_MANIFEST",
}


def inspect(path):
    d = open(path, "rb").read()

    if d[:2] != b"MZ":
        return {"error": "不是 PE 文件（缺 MZ 头）"}

    pe_off = u32(d, 0x3C)
    if d[pe_off : pe_off + 4] != b"PE\0\0":
        return {"error": "PE 签名不对"}

    secs, dd = parse_sections(d, pe_off)
    res_rva = u32(d, dd + 2 * 8)
    res_size = u32(d, dd + 2 * 8 + 4)

    if res_rva == 0:
        return {"error": "没有资源表（DataDirectory[2] 为 0）"}

    off = rva_to_off(secs, res_rva)
    if off is None:
        return {"error": "资源表的 RVA 映射不到文件偏移"}

    # 资源目录第一层：类型
    n_named = u16(d, off + 12)
    n_id = u16(d, off + 14)
    types = []
    for i in range(n_named + n_id):
        entry = off + 16 + i * 8
        name_or_id = u32(d, entry)
        types.append(name_or_id)

    # 第二层：拿 RT_GROUP_ICON 下面的图标组数量（每个组 = 一个图标）
    def count_children(type_id):
        for i in range(n_named + n_id):
            entry = off + 16 + i * 8
            if u32(d, entry) != type_id:
                continue
            sub = u32(d, entry + 4) & 0x7FFFFFFF
            o = off + sub
            nn = u16(d, o + 12)
            ni = u16(d, o + 14)
            return nn + ni
        return 0

    return {
        "size": len(d),
        "res_rva": res_rva,
        "res_size": res_size,
        "types": types,
        "icon_groups": count_children(14),
        "icons": count_children(3),
        "versions": count_children(16),
    }


if __name__ == "__main__":
    for path in sys.argv[1:]:
        r = inspect(path)
        print(f"\n=== {path.split(chr(92))[-1]} ===")
        if "error" in r:
            print("  " + r["error"])
            continue
        print(f"  文件大小   : {r['size']:,} 字节")
        print(f"  资源表     : RVA={r['res_rva']:#x}  Size={r['res_size']:,} 字节")
        print("  资源类型   :")
        for t in r["types"]:
            print(f"      {t:>3}  {TYPE_NAMES.get(t, '(其他)')}")
        print(f"  图标组数量 : {r['icon_groups']}   图标条目: {r['icons']}")
        print(f"  版本资源   : {r['versions']} 个")
        verdict = []
        if r["icon_groups"] > 0:
            verdict.append("有图标 ✓")
        if r["versions"] > 0:
            verdict.append("有版本信息 ✓")
        print("  结论       : " + ("、".join(verdict) if verdict else "**没有图标也没有版本信息 ✗**"))
