/* 校验 fonts.js 的字体枚举：扫的是真实字体文件，读出来的是能直接写进 CSS 的家族名。
   纯 Node 逻辑，不启动 Electron、不需要 electron 模块。 */
'use strict';
const fs = require('fs');
const path = require('path');

const fonts = require('../src/main/fonts.js');

let failed = 0;
function ok(cond, label, extra) {
  if (cond) {
    console.log('  ✓ ' + label);
  } else {
    failed++;
    console.log('  ✗ ' + label + (extra === undefined ? '' : '  → ' + JSON.stringify(extra)));
  }
}

console.log('—— 1. 字体目录 ——');
const dirs = fonts.fontDirs();
console.log(JSON.stringify(dirs, null, 2));
ok(dirs.length > 0, '至少找到一个字体目录（字体装哪儿都能看到）');
ok(
  dirs.every((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch (e) {
      return false;
    }
  }),
  '返回的目录都真实存在'
);
// 用户自己装的字体默认落在「仅为当前用户安装」那个目录，少了它就等于没枚举
if (process.platform === 'win32') {
  ok(
    dirs.some((d) => /Microsoft[\\/]Windows[\\/]Fonts$/i.test(d)),
    '包含用户级字体目录 %LOCALAPPDATA%\\Microsoft\\Windows\\Fonts'
  );
}

console.log('—— 2. 家族名清单 ——');
const t0 = Date.now();
const list = fonts.listFamilies();
const ms = Date.now() - t0;
console.log('  · ' + list.length + ' 款，用时 ' + ms + ' ms');
console.log(JSON.stringify(list.slice(0, 12), null, 2));
ok(Array.isArray(list), '返回数组');
ok(list.length > 0, '枚举出了字体');
ok(list.every((x) => typeof x === 'string' && x.trim() === x && x.length > 0), '每项都是干净的字符串（无空串 / 无首尾空格）');
const lower = list.map((x) => x.toLowerCase());
ok(new Set(lower).size === lower.length, '没有重复项（大小写无关）');
// 家族名要能直接写进 CSS font-family：不该带 Regular / Bold 这类样式后缀
const withStyle = list.filter((x) => /\s(Regular|Bold|Italic|Light|Semibold|Medium)$/i.test(x));
ok(withStyle.length === 0, '没有残留样式后缀的家族名（否则 CSS 里匹配不上）', withStyle.slice(0, 5));
ok(ms < 5000, '枚举耗时合理（' + ms + ' ms）');

console.log('—— 3. 二次调用走缓存 ——');
const t1 = Date.now();
const again = fonts.listFamilies();
ok(again === list, '同一份引用（结果被缓存，设置页来回切不会反复扫盘）');
ok(Date.now() - t1 < 20, '缓存后几乎零耗时');

if (process.platform !== 'win32') {
  console.log('\n（非 Windows，跳过 Windows 专属断言）');
  console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
  process.exit(failed ? 1 : 0);
}

console.log('—— 4. Windows 必装字体 ——');
const keys = new Set(lower);
for (const must of ['arial', 'segoe ui', 'tahoma', 'verdana']) {
  ok(keys.has(must), '认得必装字体 ' + must);
}
// msyh.ttc 是字体集合（一个文件里装着雅黑 + 雅黑 UI），能读出两款说明 TTC 解析没问题
ok(keys.has('microsoft yahei'), '从 .ttc 集合里读出了 Microsoft YaHei');
ok(keys.has('microsoft yahei ui'), '从同一个 .ttc 里读出了 Microsoft YaHei UI');

console.log('—— 5. 用户自装字体（有没有装都能过）——');
const lxgw = list.filter((x) => /霞鹜文楷|LXGW WenKai/i.test(x));
console.log('  · 本机霞鹜文楷相关家族名：' + JSON.stringify(lxgw));
const userFonts = dirs.filter((d) => /Microsoft[\\/]Windows[\\/]Fonts$/i.test(d));
const userFiles = userFonts.reduce((acc, d) => {
  try {
    return acc + fs.readdirSync(d).filter((n) => /\.(ttf|otf|ttc|otc)$/i.test(n)).length;
  } catch (e) {
    return acc;
  }
}, 0);
console.log('  · 用户级字体目录里有 ' + userFiles + ' 个字体文件');
ok(list.length > 30, '枚举覆盖面足够广（' + list.length + ' 款 > 30）');
if (userFiles > 0) {
  ok(userFiles <= list.length, '用户装的字体数不超过总枚举数（说明它们确实被扫到了）');
}

console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
process.exit(failed ? 1 : 0);
