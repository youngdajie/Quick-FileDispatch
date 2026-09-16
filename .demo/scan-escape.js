'use strict';
/**
 * 扫描 --uitest 的模板字符串区间，找出「单反斜杠」的转义序列。
 *
 * 背景：自检脚本是主进程里的一个模板字符串，`\s` / `\d` / `\.` / `\/` 这类
 * 「无效转义」会被模板字符串直接吃掉（`\s` -> `s`），于是
 *   - 正则变成永不匹配（断言静默失效，最坑）
 *   - 或者渲染层 SyntaxError，整段脚本一行不跑
 * 规矩：凡是经过模板字符串传递的正则，反斜杠一律双写。
 *
 * 用法：node .demo/scan-escape.js   （有输出即代表有问题）
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'src', 'main', 'main.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

let start = -1;
let end = -1;
for (let i = 0; i < lines.length; i++) {
  if (start < 0 && lines[i].includes("'--uitest'")) start = i;
  if (start >= 0 && lines[i].includes("console.log('UITEST '")) {
    end = i;
    break;
  }
}
console.log('uitest template range: lines ' + (start + 1) + '..' + (end + 1));

// 单反斜杠 = 一个反斜杠，其前面不是反斜杠、后面也不是反斜杠
const single = /(^|[^\\])\\([^\\]|$)/;

let hits = 0;
for (let i = start; i < end; i++) {
  const line = lines[i];
  if (single.test(line)) {
    hits++;
    console.log(String(i + 1).padStart(5) + ': ' + line.trim().slice(0, 150));
  }
}

if (hits) {
  console.log('\n发现 ' + hits + ' 处未双写的反斜杠 —— 模板字符串会把它吃掉，请改成双反斜杠。');
  process.exit(1);
}
console.log('OK：uitest 模板串里没有未双写的反斜杠。');
