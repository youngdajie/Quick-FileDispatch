/**
 * 配置字段的「一份定义」。
 *
 * 同一批字段有两个入口要用：
 *   ① 设置页的配置向导弹窗（lib/config-wizard.js）—— 一屏一项
 *   ② 新手指引（lib/onboard.js）—— 几项拼一屏
 *
 * 以前两边各写一份：标签、占位符、帮助文案、校验规则全都要改两遍，
 * 改着改着就不一致了（新手引导里就没有「链接规则 / 默认复制格式」）。
 * 现在每个字段在这里描述一次：html / bind / valid，两边都按它渲染。
 */

const CPLinks = window.CPLinks;

export const PLATFORMS = [
  {
    id: 'github',
    name: 'GitHub',
    note: '全球最大的代码托管平台 · raw 域名国内访问偶有波动，可以切 CDN'
  },
  {
    id: 'cnb',
    name: 'CNB',
    note: '腾讯云原生构建的代码托管 · 国内直连快 · 写入走 Git'
  }
];

export const SYNC_STRATEGIES = [
  { id: 'pull', name: '常规 pull（本地有改动会提示）' },
  { id: 'reset', name: '强制对齐云端（丢弃本地改动）' }
];

export const TOKEN_HELP = {
  github:
    'GitHub 需要 <b>Personal Access Token</b>（经典版或细粒度均可），至少勾选 <b>repo</b>（读写仓库内容）。' +
    '申请地址：<a href="#" data-ext="https://github.com/settings/tokens/new?scopes=repo&description=JIE-Dispatch">github.com/settings/tokens</a>' +
    '<br>Token 只保存在本机，用 Windows 系统级加密（DPAPI）存储，不会写到任何仓库里',
  cnb:
    'CNB 需要 <b>访问令牌</b>，在「个人设置 → 访问令牌」创建，勾选 <b>repo-code</b>（仓库代码读写）等权限。' +
    '注意必须用<b>经典令牌</b>——MCP 令牌调不了 REST 接口（会一路 404）。' +
    '申请地址：<a href="#" data-ext="https://cnb.cool/profile/token">cnb.cool/profile/token</a>' +
    '<br>Token 只保存在本机，用 Windows 系统级加密存储，不会写到任何仓库里'
};

const esc = (s) =>
  String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const platOf = (v) => (v === 'cnb' ? 'cnb' : 'github');
const platName = (v) => (platOf(v) === 'cnb' ? 'CNB' : 'GitHub');

/** 统一的「标签 + 输入框」积木 */
function field(label, id, value, placeholder, hint, extra) {
  return (
    '<label class="field">' +
    '<span class="field-label">' + esc(label) + (hint ? ' <span class="hint">' + hint + '</span>' : '') + '</span>' +
    '<input type="text" id="' + id + '" value="' + esc(value) + '" placeholder="' + esc(placeholder || '') + '" />' +
    (extra || '') +
    '</label>'
  );
}

function bindInput(sel, get, set, transform) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.value = get() == null ? '' : String(get());
  el.oninput = () => {
    let v = el.value;
    if (transform) v = transform(v);
    if (v !== el.value) el.value = v;
    set(v);
  };
}

/** 下拉的绑定：值变了就通知宿主（向导要重画说明与预览） */
function bindSelect(sel, get, set, after) {
  const el = document.querySelector(sel);
  if (!el) return;
  el.value = get();
  el.onchange = () => {
    set(el.value);
    if (after) after();
  };
}

/**
 * 六个配置字段。每个字段：
 *   label   步骤条 / 分组的短名
 *   title   这一屏的大标题（引导里拼屏时不用）
 *   html    渲染成 HTML
 *   bind    绑定输入事件（把值写回 draft）
 *   valid   能不能进下一步 / 能不能保存
 *   hint    没填好时给的提醒
 */
export const FIELDS = {
  owner: {
    label: '用户名',
    title: '你的用户名 / 组织名',
    html: (d) =>
      field(
        platName(d.platform) === 'CNB' ? '用户名 / 组织名' : 'GitHub 用户名 / 组织名',
        'wzOwner',
        d.owner,
        'your-name',
        '仓库地址里 <code>' + (d.platform === 'cnb' ? 'cnb.cool/' : 'github.com/') + '你的名字/…</code> 中间那一段'
      ),
    bind: (d) => bindInput('#wzOwner', () => d.owner, (v) => (d.owner = v)),
    valid: (d) => !!String(d.owner || '').trim()
  },
  repo: {
    label: '仓库',
    title: '仓库叫什么名字',
    html: (d) =>
      field('仓库名', 'wzRepo', d.repo, 'my-files', '只填仓库名，不带用户名，也不要带斜杠') +
      '<p class="wz-note">仓库不存在也可以先填 —— 程序会在验证那一步告诉你它到底能不能用</p>',
    // 仓库名里出现 / 或 \ 基本都是把 owner/repo 整段粘进来了，直接抹掉
    bind: (d) =>
      bindInput('#wzRepo', () => d.repo, (v) => (d.repo = v), (v) => v.replace(/[\\/]/g, '').trim()),
    valid: (d) => !!String(d.repo || '').trim() && String(d.repo).indexOf('/') < 0
  },
  branch: {
    label: '分支',
    title: '用哪个分支',
    html: (d) =>
      field('分支', 'wzBranch', d.branch || 'main', 'main', '留空就用 main —— 新建的仓库本来也就是它') +
      '<p class="wz-note">填的不是默认分支也没关系，上传会往这里写</p>',
    bind: (d) => bindInput('#wzBranch', () => d.branch || 'main', (v) => (d.branch = v || 'main')),
    valid: () => true
  },
  token: {
    label: '令牌',
    title: '访问令牌（Token）',
    html: (d) =>
      '<label class="field">' +
      '<span class="field-label">Token <span class="hint">' + (d.tokenKept ? '已保存过，留空表示不改' : '必填') + '</span></span>' +
      '<span class="wz-tokenrow">' +
      '<input type="password" id="wzToken" value="' + esc(d.token) + '" placeholder="粘贴 Token' +
      (d.tokenKept ? '，留空表示不修改' : '') + '" autocomplete="off" />' +
      '<button type="button" class="btn btn-ghost btn-sm" id="wzTokenEye">显示</button>' +
      '</span></label>' +
      '<details class="wz-adv"' + (d.apiBase ? ' open' : '') + '>' +
      '<summary>接口地址（高级）</summary>' +
      field('API 地址', 'wzApiBase', d.apiBase, platOf(d.platform) === 'cnb' ? 'https://api.cnb.cool' : 'https://api.github.com', '留空用官方地址；私有部署才需要改') +
      '</details>' +
      '<div class="wz-help" id="wzTokenHelp" data-plat="' + platOf(d.platform) + '">' + TOKEN_HELP[platOf(d.platform)] + '</div>',
    bind: (d) => {
      bindInput('#wzToken', () => d.token, (v) => (d.token = v));
      bindInput('#wzApiBase', () => d.apiBase, (v) => (d.apiBase = v));
      const eye = document.querySelector('#wzTokenEye');
      if (eye) {
        eye.onclick = () => {
          const el = document.querySelector('#wzToken');
          el.type = el.type === 'password' ? 'text' : 'password';
          eye.textContent = el.type === 'password' ? '显示' : '隐藏';
        };
      }
      const help = document.querySelector('#wzTokenHelp');
      if (help) {
        help.onclick = (e) => {
          const a = e.target.closest('a[data-ext]');
          if (!a) return;
          e.preventDefault();
          window.cloudpic.shell.openExternal(a.dataset.ext);
        };
      }
    },
    valid: (d) => !!String(d.token || '').trim() || !!d.tokenKept,
    hint: (d) => (d.tokenKept ? '留空表示沿用已保存的 Token' : '粘贴一个能读写仓库的令牌')
  },
  local: {
    label: '本地',
    title: '本地目录',
    html: (d, o) => {
      const canClone = !!(o && o.editing);
      return (
        '<label class="field">' +
        '<span class="field-label">本地目录 <span class="hint">这一份配置在本机的落脚点</span></span>' +
        '<span class="wz-dirrow">' +
        '<input type="text" id="wzLocalDir" value="' + esc(d.localDir) + '" placeholder="例如 D:\\my-files" />' +
        '<button type="button" class="btn btn-ghost btn-sm" id="wzPickDir">选择文件夹</button>' +
        (canClone ? '<button type="button" class="btn btn-ghost btn-sm" id="wzClone">克隆到该目录</button>' : '') +
        '</span></label>' +
        (canClone ? '' : '<p class="wz-note">保存后可以在文件管理页把仓库克隆下来；这里先绑定一个目录即可</p>')
      );
    },
    bind: (d, o) => {
      bindInput('#wzLocalDir', () => d.localDir, (v) => (d.localDir = v));
      const pick = document.querySelector('#wzPickDir');
      if (pick && o && o.onPickDir) pick.onclick = () => o.onPickDir();
      const cl = document.querySelector('#wzClone');
      if (cl && o && o.onClone) cl.onclick = () => o.onClone(cl);
    },
    valid: () => true
  },
  link: {
    label: '链接',
    title: '上传完复制什么链接',
    html: (d) => {
      const rules = CPLinks.LINK_RULES.filter((r) => r.platforms.indexOf(platOf(d.platform)) >= 0);
      const rule = rules.find((r) => r.id === d.linkRule) || rules[0] || { id: 'auto', desc: '' };
      return (
        '<label class="field">' +
        '<span class="field-label">链接规则 <span class="hint">决定上传后生成什么形式的地址</span></span>' +
        '<select id="wzRule">' +
        rules.map((r) => '<option value="' + r.id + '"' + (r.id === d.linkRule ? ' selected' : '') + '>' + esc(r.name) + '</option>').join('') +
        '</select></label>' +
        '<p class="wz-note" id="wzRuleDesc">' + esc(rule.desc || '') + '</p>' +
        '<label class="field" id="wzDomainField"' + (d.linkRule === 'custom' ? '' : ' hidden') + '>' +
        '<span class="field-label">自定义域名 / 前缀</span>' +
        '<input type="text" id="wzDomain" value="' + esc(d.customDomain) + '" placeholder="https://files.example.com/{path}" />' +
        '</label>' +
        '<label class="field">' +
        '<span class="field-label">默认复制格式 <span class="hint">跟着这份配置走（图床要 Markdown，素材库多半要裸链接）</span></span>' +
        '<select id="wzFormat">' +
        CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '"' + (f.id === d.linkFormat ? ' selected' : '') + '>' + esc(f.name) + '</option>').join('') +
        '</select></label>' +
        '<div class="wz-preview" id="wzPreview"></div>'
      );
    },
    bind: (d, o) => {
      const paint = () => {
        const box = document.querySelector('#wzPreview');
        if (box) box.innerHTML = linkPreviewHtml(d);
        // 「自定义域名」只在选了 custom 时才露出来
        const dom = document.querySelector('#wzDomainField');
        if (dom) dom.hidden = d.linkRule !== 'custom';
        const rules = CPLinks.LINK_RULES.filter((r) => r.platforms.indexOf(platOf(d.platform)) >= 0);
        const cur = rules.find((r) => r.id === d.linkRule);
        const desc = document.querySelector('#wzRuleDesc');
        if (desc) desc.textContent = (cur && cur.desc) || '';
      };
      bindSelect('#wzRule', () => d.linkRule, (v) => (d.linkRule = v), () => {
        paint();
        if (o && o.onChange) o.onChange();
      });
      bindInput('#wzDomain', () => d.customDomain, (v) => {
        d.customDomain = v;
        paint();
      });
      bindSelect('#wzFormat', () => d.linkFormat, (v) => (d.linkFormat = v));
      paint();
    },
    valid: (d) => !(d.linkRule === 'custom' && !String(d.customDomain || '').trim()),
    hint: (d) => (d.linkRule === 'custom' && !String(d.customDomain || '').trim() ? '自定义域名还没填' : '')
  }
};

/** 链接预览那一块（向导和引导都要，凑一处写） */
export function linkPreviewHtml(d) {
  const sample = {
    platform: platOf(d.platform),
    owner: d.owner || 'owner',
    repo: d.repo || 'repo',
    branch: d.branch || 'main',
    linkRule: d.linkRule,
    customDomain: d.customDomain
  };
  const url = CPLinks.buildUrl(sample, 'images/2026/09/example.jpg');
  const shown = CPLinks.formatLink(url, d.linkFormat, 'example.jpg', true);
  return (
    '<div class="wz-preview-label">效果预览</div>' +
    '<code class="wz-preview-url">' + esc(url) + '</code>' +
    '<div class="wz-preview-copy">复制格式：' + esc(shown) + '</div>'
  );
}

/** 新手指引里几位拼一屏时的「字段容器」（不带标题，紧凑排布） */
export function inlineFields(list, d, o) {
  return list.map((k) => FIELDS[k].html(d, o)).join('');
}
