/*
 * 离线验证云端检测器依赖的 Git 原语（src/main/git.js）：
 *   headShaFull / fetchRef / compareRefs / fetchHeadSha / pushHead
 *
 * 造一个裸仓库冒充「云端」，一个本地克隆冒充「本地」，用 url.insteadOf
 * 把 https://cnb:tok@cnb.cool/... 重写到裸仓库，全程不碰网络，
 * 也不动用户真实 ~/.gitconfig（GIT_CONFIG_GLOBAL 指向临时文件）。
 *
 * 覆盖用户举的场景：云端提交了 3888a2a、本地还停在旧提交 → 应当判出 local-behind；
 * 反过来本地有新提交没推 → local-ahead。
 */
'use strict';

const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'jie-detect-'));
const USER_DATA = path.join(ROOT, 'userData');
fs.mkdirSync(USER_DATA, { recursive: true });

const GC = path.join(ROOT, 'gitconfig');
fs.writeFileSync(GC, '', 'utf8');
process.env.GIT_CONFIG_GLOBAL = GC;

const AUTH = 'https://cnb:tok@cnb.cool/youngdajie/cnb-files.git';

const origLoad = Module._load;
Module._load = function (r) {
  if (r === 'electron') return { app: { getPath: () => USER_DATA }, safeStorage: { isEncryptionAvailable: () => false } };
  return origLoad.apply(this, arguments);
};

const gitCli = (args, cwd) =>
  cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const BARE = path.join(ROOT, 'remote.git');
const LOCAL = path.join(ROOT, 'local');
const OTHER = path.join(ROOT, 'other');
const insteadOfTarget = BARE.replace(/\\/g, '/');

let failed = 0;
function check(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  else {
    failed++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}

function commit(dir, file, content, msg) {
  fs.writeFileSync(path.join(dir, file), content, 'utf8');
  gitCli(['add', '-A'], dir);
  gitCli(['commit', '-m', msg], dir);
  return gitCli(['rev-parse', 'HEAD'], dir);
}

async function main() {
  const git = require('../src/main/git.js');

  // 「云端」裸仓库 + 首个提交
  gitCli(['init', '--bare', '-b', 'main', BARE]);
  gitCli(['init', '-b', 'main', LOCAL]);
  gitCli(['config', 'user.name', 'youngdajie'], LOCAL);
  gitCli(['config', 'user.email', 'ok@yangjie.site'], LOCAL);
  const c1 = commit(LOCAL, 'a.txt', 'one', 'c1');
  gitCli(['remote', 'add', 'origin', 'https://cnb.cool/youngdajie/cnb-files.git'], LOCAL);
  gitCli(['push', BARE, 'HEAD:main'], LOCAL);

  // 带凭据的 CNB 远端 → 本地裸仓库
  fs.writeFileSync(GC, '[url "' + insteadOfTarget + '"]\n\tinsteadOf = ' + AUTH + '\n', 'utf8');

  const conn = { platform: 'cnb', owner: 'youngdajie', repo: 'cnb-files', branch: 'main', token: 'tok', dir: LOCAL };

  console.log('—— 1. 本地与云端一致 ——');
  let f = await git.fetchRef(conn);
  check(f.ok, 'fetchRef 成功', f.message);
  let cmp = await git.compareRefs(LOCAL);
  check(cmp && cmp.ahead === 0 && cmp.behind === 0, 'ahead=0 behind=0（same）', JSON.stringify(cmp));

  console.log('—— 2. 云端新提交、本地没跟（用户举的场景）——');
  // 另开一个工作副本模拟「别人在云端提交」
  gitCli(['clone', BARE, OTHER]);
  gitCli(['config', 'user.name', 'cloudy'], OTHER);
  gitCli(['config', 'user.email', 'cloudy@x'], OTHER);
  const c2 = commit(OTHER, 'b.txt', 'two', 'cloud commit 3888a2a');
  gitCli(['push', BARE, 'HEAD:main'], OTHER);

  check(gitCli(['rev-parse', 'HEAD'], LOCAL) === c1, '本地还停在旧提交 ' + c1.slice(0, 7));
  const cloudHead = await git.headShaFull(OTHER);
  check(cloudHead === c2, '云端新提交 ' + c2.slice(0, 7));

  f = await git.fetchRef(conn);
  check(f.ok, 'fetchRef 成功', f.message);
  const short = await git.fetchHeadSha(LOCAL);
  check(short.length >= 7, 'fetchHeadSha 拿到云端短 SHA', short);
  cmp = await git.compareRefs(LOCAL);
  check(
    cmp && cmp.ahead === 0 && cmp.behind === 1,
    '判出 local-behind（云端新、本地落后 1）',
    JSON.stringify(cmp)
  );

  console.log('—— 3. 本地新提交、没推 ——');
  const c3 = commit(LOCAL, 'c.txt', 'three', 'local-only commit');
  f = await git.fetchRef(conn);
  check(f.ok, 'fetchRef 成功', f.message);
  cmp = await git.compareRefs(LOCAL);
  check(
    cmp && cmp.ahead === 1 && cmp.behind === 1,
    '判出 diverged（本地领先 1、落后 1）',
    JSON.stringify(cmp)
  );

  console.log('—— 4. pushHead 把本地提交推上云端 ——');
  // 先让本地对齐云端（模拟用户先拉后推）
  const base = ['-c', 'safe.directory=*', '-c', 'credential.helper='];
  await git.run(base.concat(['fetch', '--depth', '50', AUTH, 'main']), LOCAL);
  await git.run(base.concat(['reset', '--soft', 'FETCH_HEAD']), LOCAL);
  // reset --soft 会把本地独有改动变成「已暂存」，重新提交一次
  const c4 = commit(LOCAL, 'c.txt', 'three-updated', 'local after pull');
  const pushed = await git.pushHead(conn);
  check(pushed.ok, 'pushHead 成功', pushed.message);
  const bareHead = gitCli(['--git-dir=' + BARE, 'rev-parse', 'main']);
  check(bareHead === c4, '云端 main 已指向本地最新提交 ' + c4.slice(0, 7));

  f = await git.fetchRef(conn);
  cmp = await git.compareRefs(LOCAL);
  check(cmp && cmp.ahead === 0 && cmp.behind === 0, '推完再比：ahead=0 behind=0', JSON.stringify(cmp));

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
