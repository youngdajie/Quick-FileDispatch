#!/usr/bin/env python3
"""
把 @jsquash/avif 的 ESM emscripten glue 转成「经典脚本」版本，供经典 Web Worker 用 importScripts 加载。

为什么需要它：
- 本项目的压缩 Worker 是经典 Worker（new Worker(url)），不能 import ESM；
- 但 CSP 是 script-src 'self'，又不能用 eval / new Function 去绕过；
- importScripts 只能加载经典脚本。
所以这里对第三方的 avif_enc.js 做最小改写：把 ESM 专有语法换成 worker 里等价的东西，
不动任何 wasm 调用逻辑。改写点只有 3 处：

  1. var _scriptDir = import.meta.url;                                    -> self.location.href
  2. if(import.meta.url===undefined){import.meta.url="https://localhost"} -> 整段删掉（worker 里一定有 location.href）
  3. new URL("avif_enc.wasm", import.meta.url).href                       -> new URL("avif_enc.wasm", self.location.href).href
  4. export default Module;                                               -> self.__avifFactory = Module;

升级 @jsquash/avif 时：重新执行本脚本即可，勿手改产物。
用法：python build-classic.py
"""

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "avif_enc.js")
OUT = os.path.join(HERE, "avif_enc.classic.js")


def main():
    if not os.path.exists(SRC):
        print("找不到 avif_enc.js", file=sys.stderr)
        return 1
    s = io.open(SRC, encoding="utf-8").read()
    before = s

    s = s.replace(
        'if(import.meta.url===undefined){import.meta.url="https://localhost"}', ""
    )
    s = s.replace("import.meta.url", "self.location.href")
    s = s.replace("export default Module;", "self.__avifFactory = Module;")

    if "import.meta" in s:
        print("仍有 import.meta 残留，中止", file=sys.stderr)
        return 1
    if "self.__avifFactory" not in s:
        print("出口改写失败，中止", file=sys.stderr)
        return 1

    io.open(OUT, "w", encoding="utf-8", newline="\n").write(s)
    print("已生成 %s（%d -> %d 字节）" % (os.path.basename(OUT), len(before), len(s)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
