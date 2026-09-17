/*
 * 离线验证 CNB 写入通道（main/cnb.js）。
 *
 * CNB 的写入 = 「把仓库弄到本地工作区 → 改文件 → commit → push」，
 * 所以这里造一个本地裸仓库冒充「云端」，再用 git 的 url.<base>.insteadOf
 * 把 https://cnb:tok@cnb.cool/youngdajie/cnb-files.git 重写到那个裸仓库上 ——
 * 全程不碰网络，也不动用户的全局 git 配置（改用 GIT_CONFIG_GLOBAL 指向临时文件）。
 */
'use strict';

const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jie-cnb-'));
const USER_DATA = path.join(ROOT, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const GLOBAL_CFG = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GLOBAL_CFG, '', 'utf8');
// git 会优先读这个文件当全局配置，从而完全不碰用户真正的 ~/.gitconfig
process.env.GIT_CONFIG_GLOBAL = GLOBAL_CFG;

const AUTH_URL = 'https://cnb:tok@cnb.cool/youngdajie/cnb-files.git';

const origLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return { app: { getPath: () => USER_DATA }, safeStorage: { isEncryptionAvailable: () => false } };
  }
  return origLoad.apply(this, arguments);
};

const git = (args, cwd) =>
  cp.execFileSync('git', args, { cwd: cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let failed = 0;
function check(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  else {
    failed++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}
function eq(got, want, label) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  check(g === w, label, g === w ? g : '期望 ' + w + '，实际 ' + g);
}

const BARE = path.join(ROOT, 'remote.git');
const WORK = path.join(ROOT, 'work');
// 注意：Windows 上不能用 file:///C:/... 形式（git 会解析成 /C:/... 然后报「不是仓库」），
// 直接给本地路径即可。
const fileUrl = BARE.replace(/\\/g, '/');

function readBare(rel) {
  return git(['--git-dir=' + BARE, 'show', 'main:' + rel]);
}
function listBare() {
  return git(['--git-dir=' + BARE, 'ls-tree', '-r', '--name-only', 'main']).split('\n').filter(Boolean).sort();
}

async function main() {
  console.log('git: ' + git(['--version']));

  // 1) 造「云端」裸仓库 + 一份工作副本
  git(['init', '--bare', '-b', 'main', BARE]);
  git(['init', '-b', 'main', WORK]);
  git(['config', 'user.name', 'youngdajie'], WORK);
  git(['config', 'user.email', 'ok@yangjie.site'], WORK);
  fs.writeFileSync(path.join(WORK, 'seed.txt'), 'seed', 'utf8');
  git(['add', '-A'], WORK);
  git(['commit', '-m', 'seed'], WORK);
  git(['remote', 'add', 'origin', 'https://cnb.cool/youngdajie/cnb-files.git'], WORK);
  git(['push', BARE, 'HEAD:main'], WORK);

  // 2) 把带凭据的 CNB 远端重写到本地裸仓库（覆盖 clone 与 push 两条路径）
  fs.writeFileSync(
    GLOBAL_CFG,
    '[url "' + fileUrl + '"]\n\tinsteadOf = ' + AUTH_URL + '\n',
    'utf8'
  );

  const cnb = require('../src/main/cnb.js');
  const conn = {
    platform: 'cnb',
    owner: 'youngdajie',
    repo: 'cnb-files',
    branch: 'main',
    token: 'tok',
    localDir: WORK
  };

  console.log('—— 1. 上传（就地使用绑定的本地目录）——');
  const up = await cnb.uploadBatch(conn, [
    { path: 'images/new.png', buff: Buffer.from('NEW-PNG') },
    { path: 'docs/deep/a.txt', buff: Buffer.from('DEEP') }
  ], 'chore: test upload');
  eq(up.map((r) => r.ok), [true, true], '两条都成功');
  eq(up[0].via, 'local', '走的是绑定目录（不是临时克隆）');
  eq(listBare(), ['docs/deep/a.txt', 'images/new.png', 'seed.txt'], '裸仓库内容');
  eq(readBare('images/new.png'), 'NEW-PNG', '上传内容正确');
  eq(readBare('docs/deep/a.txt'), 'DEEP', '自动建了多级目录');

  console.log('—— 2. 改名 / 移动 ——');
  const mv = await cnb.moveBatch(conn, [{ from: 'images/new.png', to: 'images/renamed.png' }], 'chore: move');
  eq(mv.map((r) => r.ok), [true], '移动成功');
  eq(listBare(), ['docs/deep/a.txt', 'images/renamed.png', 'seed.txt'], '移动后裸仓库内容');
  eq(readBare('images/renamed.png'), 'NEW-PNG', '内容跟着走');

  console.log('—— 3. 删除 ——');
  const del = await cnb.deleteBatch(conn, ['docs/deep/a.txt'], 'chore: delete');
  eq(del.map((r) => r.ok), [true], '删除成功');
  eq(listBare(), ['images/renamed.png', 'seed.txt'], '删除后裸仓库内容');

  console.log('—— 4. 替换内容 ——');
  const rep = await cnb.replaceFile(conn, 'images/renamed.png', Buffer.from('REPLACED'), 'chore: replace');
  eq(rep.used, 'local', '替换走绑定目录');
  eq(readBare('images/renamed.png'), 'REPLACED', '替换后的内容');

  console.log('—— 5. 没绑本地目录时：临时克隆 → 提交推送 → 清理 ——');
  fs.rmSync(WORK, { recursive: true, force: true });
  const conn2 = Object.assign({}, conn, { localDir: '' });
  const up2 = await cnb.uploadBatch(conn2, [{ path: 'tmp/from-clone.txt', buff: Buffer.from('CLONE') }], 'chore: temp');
  eq(up2.map((r) => r.ok), [true], '临时克隆路径也成功');
  eq(up2[0].via, 'temp', 'via=temp');
  eq(readBare('tmp/from-clone.txt'), 'CLONE', '内容已推到云端');
  const workRoot = path.join(USER_DATA, 'cnb-work');
  const leftovers = fs.existsSync(workRoot) ? fs.readdirSync(workRoot) : [];
  eq(leftovers, [], '临时工作区已清理干净');

  console.log('—— 6. 绑的目录指向别的仓库时不误推 ——');
  const OTHER = path.join(ROOT, 'other');
  git(['init', '-b', 'main', OTHER]);
  git(['config', 'user.name', 'x'], OTHER);
  git(['config', 'user.email', 'x@x'], OTHER);
  fs.writeFileSync(path.join(OTHER, 'other.txt'), 'other', 'utf8');
  git(['add', '-A'], OTHER);
  git(['commit', '-m', 'other'], OTHER);
  git(['remote', 'add', 'origin', 'https://github.com/someone/other-repo.git'], OTHER);
  const up3 = await cnb.uploadBatch(
    Object.assign({}, conn, { localDir: OTHER }),
    [{ path: 'safe.txt', buff: Buffer.from('SAFE') }],
    'chore: safe'
  );
  eq(up3.map((r) => r.ok), [true], '仍能成功');
  eq(up3[0].via, 'temp', '误配目录时改走临时克隆，不往别人的仓库里塞东西');
  eq(readBare('safe.txt'), 'SAFE', '内容推到正确的云端');
  eq(fs.existsSync(path.join(OTHER, 'safe.txt')), false, '没有污染那个不属于本仓库的目录');

  console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
  try {
    fs.rmSync(ROOT, { recursive: true, force: true });
  } catch (e) {}
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log('测试异常：' + (e && e.message));
  console.log(e && e.stack);
  process.exit(2);
});
