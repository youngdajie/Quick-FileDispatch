#!/usr/bin/env node
/**
 * 分批逻辑的单元测试。
 *
 * 用法：node tools/test-upload-batch.mjs
 *
 * 为什么给这几行算术单独写测试：分批错了的后果是「用户等完整个上传
 * 才被后端拒绝」，而且只在**大文件 + 多个**的特定组合下才暴露 ——
 * 手工点不出来，必须靠算。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcPath = path.join(here, '..', 'src', 'renderer', 'js', 'lib', 'upload-batch.js');

// 用 data: URL 导入源码。
// 免去为「Node 把 .js 当 CommonJS」而在项目根加 package.json 的麻烦 ——
// 这是个 Go 项目，不想为了跑一个测试引入前端构建配置。
const src = fs.readFileSync(srcPath, 'utf8');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { bodyCost, planBatches, SAFE_BODY, IPC_LIMIT } = mod;

const mb = 1024 * 1024;

let pass = 0;
let fail = 0;
function eq(got, want, name) {
  if (got === want) {
    pass++;
    console.log('  ✓ ' + name + '  (' + got + ')');
  } else {
    fail++;
    console.log('  ✗ ' + name + '  期望 ' + want + '，实际 ' + got);
  }
}
function ok(cond, name, extra) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + name + (extra ? '  (' + extra + ')' : ''));
  } else {
    fail++;
    console.log('  ✗ ' + name + (extra ? '  (' + extra + ')' : ''));
  }
}

const f = (sizeMB, name) => ({ outSize: sizeMB * mb, outName: name });

console.log('\n=== 1. bodyCost（请求体占用估算）===');
// base64 是 4 字节 / 3 字节，末尾不足 3 字节时补 padding（= 也占一个字符）
eq(bodyCost(0, ''), 30, '0 字节：只有字段开销');
eq(bodyCost(3, ''), 34, '3 字节 → 4 个字符');
eq(bodyCost(1, ''), 34, '1 字节也要补 padding，同样 4 个字符');
eq(bodyCost(2, ''), 34, '2 字节 → 4 个字符');
eq(bodyCost(4, ''), 38, '4 字节 → 两组，8 个字符');
eq(bodyCost(0, 'abcd'), 34, '文件名长度计入');
eq(bodyCost(200 * mb, ''), Math.ceil((200 * mb) / 3) * 4 + 30, '200MB 的 base64 长度');

console.log('\n=== 2. planBatches（分批）===');
eq(planBatches([f(200, 'a.bin')]).length, 1, '单个 200MB → 1 批');

const two200 = planBatches([f(200, 'a'), f(200, 'b')]);
eq(two200.length, 2, '2×200MB → 2 批（400MB×1.33 超过 512MB 上限）');

const ten100 = planBatches(Array.from({ length: 10 }, (_, i) => f(100, 'f' + i)));
ok(ten100.length >= 4, '10×100MB 分成多批', ten100.length + ' 批');

const empty = planBatches([]);
eq(empty.length, 1, '空队列也给一个空批（调用方不用特判）');
eq(empty[0].items.length, 0, '空批里没有条目');

console.log('\n=== 3. 不变量（每批都不超限、条目不丢不重）===');
const many = planBatches(Array.from({ length: 23 }, (_, i) => f(50, 'x' + i)));
let allWithin = true;
let maxBody = 0;
for (const b of many) {
  if (b.bodyBytes > SAFE_BODY) allWithin = false;
  maxBody = Math.max(maxBody, b.bodyBytes);
}
ok(allWithin, '每一批都没超过安全上限', many.length + ' 批，最大 ' + (maxBody / mb).toFixed(1) + ' MB');
ok(maxBody <= IPC_LIMIT, '最大批也没超过硬上限');

const flat = many.flatMap((b) => b.items);
eq(flat.length, 23, '条目总数不丢');
eq(new Set(flat).size, 23, '条目不重复');
// 顺序也要保持：上传顺序影响不了结果，但批次乱序会让进度条跳动
let ordered = true;
for (let i = 1; i < flat.length; i++) {
  if (flat[i - 1].outName !== 'x' + (i - 1)) ordered = false;
}
ok(ordered, '条目顺序保持不变');

const sumBytes = many.reduce((s, b) => s + b.bytes, 0);
eq(sumBytes, 23 * 50 * mb, '字节总数不丢');

console.log('\n=== 4. 边界情况 ===');
// 刚好放得下
const justSize = Math.floor((SAFE_BODY - 200 - 30) / 4) * 3;
const justFit = planBatches([{ outSize: justSize, outName: '' }]);
eq(justFit.length, 1, '刚好放下时仍然是一批');

// 单个文件就超上限：目前不会发生（平台单文件上限 200MB 更严），
// 但要保证行为可预期 —— 单独成批，由后端给出明确错误
const hugeMB = Math.ceil((SAFE_BODY / 4) * 3 / mb) + 50;
const huge = planBatches([{ outSize: hugeMB * mb, outName: 'huge.bin' }]);
eq(huge.length, 1, '单个超大文件单独成批');
ok(huge[0].bodyBytes > SAFE_BODY, '这一批会超限（后端拒绝并给友好提示，不会崩）');

// 名称很长的文件（带 hash 的那种）
const longNames = Array.from({ length: 5 }, (_, i) => ({
  outSize: 100 * mb,
  outName: 'deep/nested/dir/' + 'a'.repeat(60) + i + '.bin'
}));
const ln = planBatches(longNames);
let lnWithin = true;
for (const b of ln) if (b.bodyBytes > SAFE_BODY) lnWithin = false;
ok(lnWithin, '长文件名也按实际开销计算', ln.length + ' 批');

console.log('\n=== 5. 与后端上限的一致性 ===');
eq(IPC_LIMIT, 512 * 1024 * 1024, 'IPC_LIMIT 与 webui.maxIPCPayloadBytes 一致');
ok(SAFE_BODY < IPC_LIMIT, '安全上限留有余量', ((1 - SAFE_BODY / IPC_LIMIT) * 100).toFixed(0) + '%');

console.log('\n================================');
console.log('结果：' + pass + ' 通过 / ' + fail + ' 失败');
console.log(fail === 0 ? 'ALL_PASS' : 'HAS_FAILURE');
process.exit(fail === 0 ? 0 : 1);
