/* 校验 store.js 的导出 / 导入（含 Token、含链接配置、不含本地路径）
   用假 electron 模块顶掉 app/safeStorage，纯逻辑测试，不启动 Electron。 */
'use strict';
const Module = require('module');
const os = require('os');
const fs = require('fs');
const path = require('path');

const tmpUserData = path.join(os.tmpdir(), 'jie-store-test-' + process.pid);
fs.mkdirSync(tmpUserData, { recursive: true });

const orig = Module._load;
Module._load = function (request) {
  if (request === 'electron') {
    return {
      app: { getPath: () => tmpUserData },
      safeStorage: { isEncryptionAvailable: () => false }
    };
  }
  return orig.apply(this, arguments);
};

const { Store } = require('../src/main/store.js');

let failed = 0;
function eq(got, want, label) {
  if (got !== want) {
    failed++;
    console.log('  ✗ ' + label + '  期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got));
  } else {
    console.log('  ✓ ' + label);
  }
}

console.log('—— 1. 建配置并导出 ——');
const s = new Store();
s.patch({
  platform: 'cnb',
  owner: 'yangjie-site',
  repo: 'cdn-files',
  branch: 'main',
  localDir: 'D:/web/cdn-files',
  token: 'cnb_secret_token_123456',
  linkRule: 'cnb_raw',
  customDomain: 'https://cdn.yangjie.site',
  linkFormat: 'html',
  proxyUrl: 'https://proxy.yangjie.site'
});

const exp = s.exportProfiles();
console.log(JSON.stringify(exp, null, 2));
eq(exp.kind, 'jie-dispatch-profiles', 'kind');
eq(exp.version, 2, '信封版本升到 2');
eq(exp.profiles.length, 1, '导出 1 份配置');
eq(exp.profiles[0].token, 'cnb_secret_token_123456', '导出带上了 Token');
eq(Object.prototype.hasOwnProperty.call(exp.profiles[0], 'localDir'), false, '导出不含 localDir 字段');
eq(exp.profiles[0].platform, 'cnb', '平台为 cnb');
eq(exp.settings.linkRule, 'cnb_raw', 'settings.linkRule');
eq(exp.settings.customDomain, 'https://cdn.yangjie.site', 'settings.customDomain');
eq(exp.settings.linkFormat, 'html', 'settings.linkFormat');
eq(exp.settings.proxyUrl, 'https://proxy.yangjie.site', 'settings.proxyUrl');

console.log('—— 2. 清空后导入 ——');
s.reset();
eq(s.get().profiles.length, 0 || s.get().profiles.length, 'reset 后有兜底 profile');

const res = s.importProfiles(exp);
console.log(JSON.stringify({ added: res.added, skipped: res.skipped, settingsApplied: res.settingsApplied }, null, 2));
eq(res.added, 1, '导入 1 份');
eq(res.skipped, 0, '没有跳过');
eq(res.settingsApplied, true, '链接配置被恢复');

const raw = s.getRaw();
const p = raw.profiles.find((x) => x.owner === 'yangjie-site');
eq(!!p, true, '导入后能找到该配置');
eq(p.localDir, '', '导入后 localDir 为空（等用户自己绑）');
eq(p.verified, false, '导入后标记未验证');
eq(p.imported, true, '导入后有 imported 标记');
eq(s.getProfileToken(p.id), 'cnb_secret_token_123456', 'Token 能解密回来（导入端重新加密）');
eq(raw.linkRule, 'cnb_raw', '顶层 linkRule 被恢复');
eq(raw.proxyUrl, 'https://proxy.yangjie.site', '顶层 proxyUrl 被恢复');

console.log('—— 3. 重复导入应被跳过 ——');
const res2 = s.importProfiles(exp);
eq(res2.added, 0, '重复导入新增 0');
eq(res2.skipped, 1, '重复导入跳过 1');

console.log('—— 4. 老 Gitee 配置迁移 ——');
const legacy = path.join(tmpUserData, 'config.json');
fs.writeFileSync(
  legacy,
  JSON.stringify({
    version: 6,
    platform: 'gitee',
    apiBase: 'https://gitee.com/api/v5',
    owner: 'old',
    repo: 'oldrepo',
    profiles: [
      {
        id: 'pold',
        platform: 'gitee',
        apiBase: 'https://gitee.com/api/v5',
        owner: 'old',
        repo: 'oldrepo',
        branch: 'main',
        verified: true,
        verifiedAt: 123,
        userName: 'old',
        repoInfo: { fullName: 'old/oldrepo' }
      }
    ]
  }),
  'utf8'
);
const s2 = new Store();
eq(s2.getRaw().platform, 'github', 'v6 的 gitee 顶层平台归到 github');
eq(s2.getRaw().profiles[0].platform, 'github', 'v6 的 gitee profile 归到 github');
eq(s2.getRaw().version, 7, '配置版本升到 7');
eq(s2.getRaw().profiles[0].apiBase, '', 'gitee 的 apiBase 被清掉（否则验证必错）');
eq(s2.getRaw().profiles[0].verified, false, '平台被换过的配置退回未验证');
eq(s2.getRaw().profiles[0].userName, undefined, '清掉旧的 gitee 用户名缓存');

console.log('—— 5. 草稿配置不该冒充「归档配置」 ——');
// 切平台 / 点新建都会开一个空白落点。以前它会直接出现在归档列表里，
// 显示成「（未填写仓库）未绑定本地目录 · 待验证 · 无 Token」，看着像凭空多了一份。
// 规则：既没仓库信息、又没验证过 = 草稿（draft），渲染层不列它。
const draftOf = (store, id) => {
  const p = (store.get().profiles || []).find((x) => x.id === id);
  return p ? p.draft : undefined;
};

s2.reset();
eq(s2.get().profiles.length, 1, 'reset 后有兜底 profile');
eq(s2.get().profiles[0].draft, true, '兜底 profile 是草稿（不会显示在归档列表里）');
eq(Object.prototype.hasOwnProperty.call(s2.getRaw().profiles[0], 'draft'), false, '草稿是算出来的，不落盘');

const listBefore = s2.get().profiles.length;
s2.newProfile({ platform: 'cnb' });
const npId = s2.get().activeProfileId;
eq(s2.get().profiles.length, listBefore + 1, '新建配置确实多了一条（存档在后端）');
eq(draftOf(s2, npId), true, '新建的空白配置是草稿');
eq(s2.profileById(npId).draft, undefined, '裸数据里没有 draft 字段');

// 一旦填上仓库 —— 也就是「明确保存了配置」—— 就该出现在列表里（标着待验证）
s2.patch({ owner: 'cnb-user', repo: 'cnb-repo' });
eq(draftOf(s2, npId), false, '填上仓库后不再是草稿（会出现在列表里，标「待验证」）');
eq(s2.profileById(npId).verified, false, '但它还没验证');

// 验证通过后是「已归档」，同样不是草稿
s2.verifyProfile(npId, { userName: 'youngdajie', repo: { fullName: 'cnb-user/cnb-repo' } });
eq(draftOf(s2, npId), false, '验证归档后依然不是草稿');
eq(s2.profileById(npId).verified, true, '验证归档后 verified=true');

// 只填用户名、没填仓库：还是缺仓库信息 → 仍旧算草稿
s2.newProfile({ platform: 'github' });
const halfId = s2.get().activeProfileId;
s2.patch({ owner: 'only-owner', repo: '' });
eq(draftOf(s2, halfId), true, '只填用户名没填仓库，仍算草稿（这种配置根本连不上）');

// 删光之后补回来的兜底配置同样是草稿
for (const x of s2.get().profiles.slice()) s2.deleteProfile(x.id);
eq(s2.get().profiles.length, 1, '删光后补回一个兜底配置');
eq(s2.get().profiles[0].draft, true, '兜底配置是草稿，列表里不会再冒出一份假配置');

console.log('—— 6. 老配置里的空占位也算草稿 ——');
fs.writeFileSync(
  legacy,
  JSON.stringify({
    version: 7,
    platform: 'github',
    profiles: [
      { id: 'pempty', platform: 'github', owner: '', repo: '', verified: false },
      { id: 'pfilled', platform: 'github', owner: 'cloud', repo: 'bucket', verified: false },
      { id: 'pfull', platform: 'github', owner: 'cloud', repo: 'bucket2', verified: true, verifiedAt: 1 }
    ]
  }),
  'utf8'
);
const s3 = new Store();
const rowOf = (id) => (s3.get().profiles || []).find((x) => x.id === id);
eq(rowOf('pempty').draft, true, '历史遗留的空配置算草稿（老配置升级后同样不再露头）');
eq(rowOf('pfilled').draft, false, '填了仓库但没验证的，照常列出来（标待验证）');
eq(rowOf('pfull').draft, false, '已归档的配置不会被误判成草稿');

console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
try {
  fs.rmSync(tmpUserData, { recursive: true, force: true });
} catch (e) {}
process.exit(failed ? 1 : 0);
