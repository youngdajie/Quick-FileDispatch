/* 验证 links.js 的直链生成（GitHub + CNB 双平台） */
'use strict';
const L = require('../src/renderer/js/lib/links.js');

let failed = 0;
function eq(got, want, label) {
  if (got === want) console.log('  ✓ ' + label + '  ' + got);
  else {
    failed++;
    console.log('  ✗ ' + label + '\n      期望 ' + want + '\n      实际 ' + got);
  }
}

const gh = { platform: 'github', owner: 'youngdajie', repo: 'my-images', branch: 'main', linkRule: 'auto' };
const cnb = { platform: 'cnb', owner: 'youngdajie', repo: 'cnb-files', branch: 'main', linkRule: 'auto' };

console.log('—— 平台默认（auto）——');
eq(L.buildUrl(gh, 'a/b c.png'), 'https://raw.githubusercontent.com/youngdajie/my-images/main/a/b%20c.png', 'GitHub auto');
eq(L.buildUrl(cnb, 'a/b c.png'), 'https://cnb.cool/youngdajie/cnb-files/-/git/raw/main/a/b%20c.png', 'CNB auto');

console.log('—— 显式规则 ——');
eq(L.buildUrl(Object.assign({}, cnb, { linkRule: 'cnb_raw' }), 'x.txt'), 'https://cnb.cool/youngdajie/cnb-files/-/git/raw/main/x.txt', 'CNB raw');
eq(
  L.buildUrl(Object.assign({}, cnb, { linkRule: 'cnb_jsdmirror' }), 'x.txt'),
  'https://cdn.jsdmirror.com/cnb/youngdajie/cnb-files@main/x.txt',
  'CNB jsdmirror'
);
eq(L.buildUrl(Object.assign({}, gh, { linkRule: 'jsdelivr' }), 'x.txt'), 'https://cdn.jsdelivr.net/gh/youngdajie/my-images@main/x.txt', 'GitHub jsDelivr');

console.log('—— 自定义域名：没填时按平台兜底 ——');
eq(
  L.buildUrl(Object.assign({}, cnb, { linkRule: 'custom', customDomain: '' }), 'x.txt'),
  'https://cnb.cool/youngdajie/cnb-files/-/git/raw/main/x.txt',
  'CNB custom 空 → 平台兜底'
);

console.log('—— 额度表 ——');
eq(L.limitOf('cnb').maxFile, 200 * 1024 * 1024, 'CNB 单文件 200MB');
eq(L.limitOf('github').maxFile, 100 * 1024 * 1024, 'GitHub 单文件 100MB');
eq(L.limitOf('').name, 'GitHub', '未知平台回退 GitHub');

console.log('—— 规则表里不再有 Gitee ——');
eq(L.LINK_RULES.some((r) => /gitee/i.test(r.id) || r.platforms.includes('gitee')), false, '无任何 gitee 规则');
eq(L.LINK_RULES.filter((r) => r.platforms.includes('cnb')).map((r) => r.id).join(','), 'auto,cnb_raw,cnb_jsdmirror,custom', 'CNB 可用规则');

console.log(failed ? '\n结果：' + failed + ' 项失败' : '\n结果：全部通过');
process.exit(failed ? 1 : 0);
