'use strict';
// 扫描 --uitest 的模板字符串区间，找出「单反斜杠 + 字母」的转义序列。
// 这些在模板串里会被吞掉（\s -> s），必须写成双反斜杠才能活着传到渲染层。
const fs = require('fs');
const path = require('path');
const p = path.join(__dirname, '..', 'src', 'main', 'main.js');
const lines = fs.readFileSync(p, 'utf8').split('\n');

let start = -1;
let end = -1;
for (let i = 0; i < lines.length; i++) {
  if (start < 0 && lines[i].includes("'--uitest'")) start = i;
  if (start >= 0 && lines[i].includes("console.log('UITEST '")) { end = i; break; }
}
console.log('uitest template range: lines ' + (start + 1) + '..' + (end + 1));

const re = new RegExp('(^|[^\\\\])\\\\[a-zA-Z]', 'g');
let hits = 0;
for (let i = start; i < end; i++) {
  re.lastIndex = 0;
  if (re.test(lines[i])) {
    hits++;
    console.log(String(i + 1).padStart(5) + ': ' + lines[i].trim().slice(0, 140));
  }
}
console.log('single-escape hits = ' + hits);
