/* 用假 API 验证 platform.js 的 CNB 客户端与 GitHub 客户端 */
'use strict';
const os = require('os');
const path = require('path');

process.env.MOCK_PORT = '8799';
require('./mock-server.js');

const { CloudClient } = require('../src/main/platform.js');

let failed = 0;
function eq(got, want, label) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  if (g !== w) {
    failed++;
    console.log('  ✗ ' + label + '  期望 ' + w + '，实际 ' + g);
  } else {
    console.log('  ✓ ' + label + '  ' + g);
  }
}
function ok(cond, label, extra) {
  if (cond) console.log('  ✓ ' + label + (extra ? '  ' + extra : ''));
  else {
    failed++;
    console.log('  ✗ ' + label + (extra ? '  ' + extra : ''));
  }
}

const BASE = 'http://127.0.0.1:8799';

async function main() {
  console.log('—— CNB 客户端 ——');
  const cnb = new CloudClient({
    platform: 'cnb',
    owner: 'youngdajie',
    repo: 'cnb-files',
    branch: 'main',
    token: 'cnb_fake_token_0001',
    apiBase: BASE
  });
  eq(cnb.isCnb, true, 'isCnb');
  eq(cnb.slug, 'youngdajie/cnb-files', 'slug 是「组织/仓库」整体');

  const me = await cnb.whoami();
  eq(me.login, 'youngdajie', 'whoami.login');
  eq(me.name, 'youngdajie', 'whoami.name');

  const info = await cnb.repoInfo();
  eq(info.fullName, 'youngdajie/cnb-files', 'repoInfo.fullName');
  eq(info.private, false, 'repoInfo.private（Public → false）');
  eq(info.htmlUrl, 'https://cnb.cool/youngdajie/cnb-files', 'repoInfo.htmlUrl');

  const root = await cnb.listDir('');
  eq(root.map((i) => i.type + ':' + i.name).sort(), ['dir:docs', 'dir:images'], '根目录列目录');
  eq(root[0].downloadUrl.indexOf('https://cnb.cool/youngdajie/cnb-files/-/git/raw/main/'), 0, 'CNB 直链前缀');

  const docs = await cnb.listDir('docs');
  eq(docs.map((i) => i.path), ['docs/readme.md'], 'docs 目录列目录');
  eq(docs[0].type, 'file', 'docs/readme.md 是文件');

  const raw = await cnb.readRaw('docs/readme.md');
  eq(raw.toString('utf8'), '# cnb demo repo', 'readRaw 内容');

  const buf = await cnb.readFile('docs/readme.md');
  eq(buf ? buf.toString('utf8') : null, '# cnb demo repo', 'readFile 内容（base64 解码）');

  const sha = await cnb.headSha();
  eq(sha, '3888a2a1000000000000000000000000000000ff', 'headSha（云端 HEAD）');
  eq(sha.slice(0, 7), '3888a2a', '云端短 SHA');

  const stats = await cnb.countFiles('');
  ok(stats.files >= 2, 'countFiles 递归统计', JSON.stringify(stats));

  eq(cnb.rawUrl('a/b.png'), 'https://cnb.cool/youngdajie/cnb-files/-/git/raw/main/a/b.png', 'rawUrl');
  eq(cnb.gitRemote, 'https://cnb.cool/youngdajie/cnb-files.git', 'gitRemote');

  console.log('—— CNB 写接口必须明确拒绝（写要通过 git 完成）——');
  let writeErr = null;
  try {
    await cnb.uploadBatch([{ path: 'x.txt', buff: Buffer.from('x') }], 'msg');
  } catch (e) {
    writeErr = e.message;
  }
  ok(!!writeErr && /Git/.test(writeErr), 'uploadBatch 在 CNB 上抛「走 Git」提示', writeErr);

  console.log('—— GitHub 客户端仍然正常 ——');
  const gh = new CloudClient({
    platform: 'github',
    owner: 'youngdajie',
    repo: 'my-images',
    branch: 'main',
    token: 'ghp_fake',
    apiBase: BASE
  });
  eq(gh.isCnb, false, 'isCnb=false');
  const gme = await gh.whoami();
  eq(gme.login, 'youngdajie', 'github whoami');
  const gsha = await gh.headSha();
  eq(gsha, 'commit-0', 'github headSha');

  console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
  process.exit(failed ? 1 : 0);
}

setTimeout(main, 400);
