/** 设置页 */

import { $, $$, ok, err, warn, confirmDialog, modal, escapeHtml, debounce } from '../lib/dom.js';
import state from '../lib/state.js';
import {
  applyTheme,
  applyFont,
  applyGlass,
  stackFor,
  installedFontGroups,
  installFontCount,
  PRIMARY_FONT_NAME
} from '../lib/appearance.js';
import { brandIcon } from '../lib/brandicons.js';

const CPLinks = window.CPLinks;
let tokenTouched = false;

const PLATFORM_NAME = { github: 'GitHub', cnb: 'CNB' };

const TOKEN_HELP = {
  github:
    'GitHub 需要 <b>Personal Access Token</b>（经典版或细粒度均可），至少勾选 <b>repo</b>（读写仓库内容）' +
    '申请地址：<a href="#" data-ext="https://github.com/settings/tokens/new?scopes=repo&description=JIE-Dispatch">github.com/settings/tokens</a>' +
    'Token 只保存在本机，用 Windows 系统级加密（DPAPI）存储，代码不会把它写到任何地方',
  cnb:
    'CNB 需要 <b>访问令牌</b>，请在「个人设置 → 访问令牌」创建，并勾选 <b>repo-code</b>（仓库代码读写）等权限' +
    '注意必须用<b>经典令牌</b>——MCP 令牌调不了 REST 接口（会一路 404）' +
    '申请地址：<a href="#" data-ext="https://cnb.cool/profile/token">cnb.cool/profile/token</a>' +
    'Token 只保存在本机，用 Windows 系统级加密存储'
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SLIDE_OUT = 190;
const SLIDE_IN = 300;

/** 平台切换时先滑出、换内容、再滑入；滑动期间压掉自动重画，否则图层会闪 */
let slideLock = false;

/* ---------------------------------------------------------------- 编辑目标 */

/**
 * 「正在编辑哪一份配置」和「当前使用哪一份配置」是两件事，这里把它们拆开。
 *
 * 以前点 GitHub / CNB 两个按钮 = 那份配置立刻生效，于是你只想看看 CNB 的表单
 * 长什么样，上传页、管理页就跟着换仓库了 —— 一个「配置」动作不该有这种副作用。
 * 现在的分工：
 *   - 平台按钮 / ＋新建：只换「正在编辑的对象」，保存写进那一份；
 *   - 真正「当前使用」的是哪一份，只由右上角「归档配置」下拉决定（选中即生效）。
 *
 * editTargetId 有三种值：
 *   ''                 跟着当前生效的那份（默认）
 *   <profile id>       某一份归档配置
 *   '__new__:<platform>' 还没创建，保存时才落成一份新配置
 */
let editTargetId = '';
/** 每个平台上次编辑的是哪一份，来回切平台时别跳到别的配置上 */
const lastEdited = { github: '', cnb: '' };

function platOf(v) {
  return v === 'cnb' ? 'cnb' : 'github';
}

/** 当前真正生效的平台 */
function activePlatform() {
  return platOf((state.cfg || {}).platform);
}

function activeProfileId() {
  return (state.cfg && state.cfg.activeProfileId) || '';
}

function profileById(id) {
  return state.profiles.find((p) => p.id === id) || null;
}

/**
 * 解析编辑对象：{ mode: 'active' | 'profile' | 'new', platform, profile }
 *   active  —— 编辑的就是当前生效的那份，保存直接落盘到顶层
 *   profile —— 编辑的是另一份归档配置，保存只写进它
 *   new     —— 这个平台还没有配置，表单是空的，保存时新建一份
 */
function editTarget() {
  if (editTargetId === '') {
    const p = profileById(activeProfileId());
    return { mode: 'active', platform: activePlatform(), profile: p };
  }
  if (editTargetId.indexOf('__new__:') === 0) {
    return { mode: 'new', platform: platOf(editTargetId.slice('__new__:'.length)), profile: null };
  }
  const p = profileById(editTargetId);
  if (!p) {
    // 那份配置被删了 / 导入覆盖了，退回「当前生效」
    editTargetId = '';
    return editTarget();
  }
  const plat = platOf(p.platform);
  if (p.id === activeProfileId()) return { mode: 'active', platform: plat, profile: p };
  return { mode: 'profile', platform: plat, profile: p };
}

function rememberEditTarget() {
  const t = editTarget();
  if (t.profile) lastEdited[t.platform] = t.profile.id;
  return t;
}

/** 点平台按钮：只把「编辑对象」换到这个平台，不动全局生效的那份 */
async function pickPlatform(plat) {
  const cur = editTarget();
  if (cur.platform === plat) return; // 已经在这个平台的表单上，别乱跳

  const remembered = profileById(lastEdited[plat]);
  let id = '';
  if (remembered && platOf(remembered.platform) === plat) id = remembered.id;
  else if (activePlatform() === plat) id = '';
  else {
    const p = state.profileFor(plat);
    id = p ? p.id : '__new__:' + plat;
  }

  const back = cur.platform === 'cnb' && plat === 'github';
  slideLock = true;
  try {
    editTargetId = id;
    playOut(back);
    await wait(SLIDE_OUT);
    fill();
  } finally {
    slideLock = false;
  }
  playIn(back);
}

/**
 * 把「正在编辑的那份」设为全局当前使用。
 * 平台按钮不再负责切换生效配置，这里给一个就地入口 ——
 * 免得用户为了切过去还得跑到右上角下拉里再找一遍。
 */
async function useEditingTarget() {
  const t = editTarget();
  if (t.mode === 'active') return;
  const back = activePlatform() === 'cnb' && t.platform === 'github';
  let name = '';
  let moved = false;
  slideLock = true;
  try {
    await save({ silent: true });
    const again = editTarget();
    if (again.profile) {
      name = platLabel(again.profile);
      playOut(back);
      await wait(SLIDE_OUT);
      // 先归位再激活：activateProfile 会 emit→fill()，这会儿编辑对象就该是「新的生效项」了
      editTargetId = '';
      await state.activateProfile(again.profile.id);
      fill();
      moved = true;
    }
  } catch (e) {
    err(e.message || String(e));
  } finally {
    slideLock = false;
  }
  if (moved) {
    playIn(back);
    ok('已把「' + name + '」设为当前使用');
  }
}

function platLabel(p) {
  if (!p) return '这份配置';
  return profileLabel(p) + '（' + (PLATFORM_NAME[platOf(p.platform)] || 'GitHub') + '）';
}

/* ---------------------------------------------------------------- 归档配置 */

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function profileLabel(p) {
  return p.name || [p.owner, p.repo].filter(Boolean).join('/') || '未命名配置';
}

/** 归档卡片里「云端 ↕ 本地」那三个小图标（和文件管理页的检测器同一套形状） */
const CD_ICON = {
  cloud:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 11.2 4 4 0 0 0 7 19h10.5z"/></svg>',
  monitor:
    '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="12" rx="2"/><path d="M9 20h6"/></svg>',
  swap:
    '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 4v15"/><path d="M5 7l3-3 3 3"/><path d="M16 20V5"/><path d="M13 17l3 3 3-3"/></svg>'
};

function profileRow(p) {
  const plat = PLATFORM_NAME[p.platform] || 'GitHub';
  const bits = [];
  if (p.verified) {
    bits.push('<span class="pf-badge ok">已归档</span>');
    if (p.repoInfo && p.repoInfo.private) bits.push('<span class="pf-badge">私有</span>');
    if (p.verifiedAt) bits.push('<span class="pf-sub">' + fmtDate(p.verifiedAt) + ' 验证</span>');
  } else {
    bits.push('<span class="pf-badge warn">待验证</span>');
  }
  if (!p.hasToken) bits.push('<span class="pf-badge danger">无 Token</span>');

  // 链接规则是每份配置自己的 —— 摆到列表里，一眼能看出这几份配置各用什么规则
  const ruleId = p.linkRule || 'auto';
  const rule = CPLinks.LINK_RULES.find((r) => r.id === ruleId);
  const ruleText = ruleId === 'auto'
    ? '链接：自动（' + (platOf(p.platform) === 'cnb' ? 'CNB 国内 CDN' : 'jsDelivr CDN') + '）'
    : '链接：' + ((rule && rule.name) || ruleId);

  /* 正方形卡片（杰哥定的版式）：内容竖排、一层一层往下读 ——
     ①平台 + 使用中徽章 ②「云端 ↕ 本地」小图（只画图标和字，不写路径）
     ③别名 ④状态徽章行 ⑤链接规则 ⑥操作按钮沉底。
     具体路径不摆在卡片上：鼠标移到「云端」/「本地」文字上，气泡里给完整内容
     —— 卡片小、路径长，写上去只会把版式撑乱。 */
  const cloudVal = p.owner && p.repo ? p.owner + '/' + p.repo : '';
  const localVal = p.localDir || '';
  const cloudTitle = cloudVal || '未填写仓库';
  const localTitle = localVal || '未绑定本地目录';
  return (
    '<div class="pf-row' + (p.isActive ? ' active' : '') + '" data-id="' + escapeHtml(p.id) + '">' +
    '<div class="pf-top">' +
    '<span class="pf-platform pf-' + escapeHtml(p.platform || 'github') + '">' + plat + '</span>' +
    (p.isActive ? '<span class="pf-cur">使用中</span>' : '') +
    '</div>' +
    '<div class="pf-cd">' +
    '<div class="pf-cd-row' + (cloudVal ? '' : ' bad') + '">' +
    '<span class="pf-cd-ico cloud">' + CD_ICON.cloud + '</span>' +
    // title 挂在**文字**上（不是整行）：气泡要对准「云端」这两个字，
    // 挂在行上会以「图标 + 文字」的整行中心定位，看着偏左（杰哥点名的）
    '<span class="pf-cd-label" title="' + escapeHtml(cloudTitle) + '">云端</span>' +
    '</div>' +
    '<div class="pf-cd-link">' + CD_ICON.swap + '</div>' +
    '<div class="pf-cd-row' + (localVal ? '' : ' bad') + '">' +
    '<span class="pf-cd-ico local">' + CD_ICON.monitor + '</span>' +
    '<span class="pf-cd-label" title="' + escapeHtml(localTitle) + '">本地</span>' +
    '</div>' +
    '</div>' +
    // 别名和链接规则都是完整可见的文字，不再挂 title ——
    // 悬停弹一个跟眼前一模一样的气泡只会打扰（杰哥点名的）
    (p.name ? '<div class="pf-alias">' + escapeHtml(p.name) + '</div>' : '') +
    '<div class="pf-meta">' +
    '<div class="pf-badges">' + bits.join('') + '</div>' +
    '<span class="pf-rule">' + escapeHtml(ruleText) + '</span>' +
    '</div>' +
    '<div class="pf-ops">' +
    (p.isActive ? '' : '<button type="button" class="btn btn-ghost btn-sm" data-act="use">切换</button>') +
    '<button type="button" class="btn btn-ghost btn-sm" data-act="rename" title="重命名这份配置">改名</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-act="del" title="删除这份配置">删除</button>' +
    '</div>' +
    '</div>'
  );
}

function sortProfiles(a, b) {
  if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
  return (b.verifiedAt || b.createdAt || 0) - (a.verifiedAt || a.createdAt || 0);
}

/**
 * 归档列表。排序：已归档在前（按验证时间倒序），待验证的沉底。
 * 面板只在「切平台 / 切配置 / 验证归档 / 删除 / 改名」后重建，
 * 不参与每次按键的刷新，免得正在填表时列表跳动。
 */
function renderProfiles() {
  // 只列「归档过」的：draft（切平台/新建开出来的空落点）不进列表
  const list = state.archivedProfiles.slice().sort(sortProfiles);
  const box = $('#profileList');
  const empty = $('#profileEmpty');
  const count = $('#profCount');
  if (!box) return;
  box.innerHTML = list.map(profileRow).join('');
  empty.hidden = list.length > 0;
  box.hidden = list.length === 0;

  const verified = list.filter((p) => p.verified).length;
  if (count) {
    count.hidden = !list.length;
    count.textContent = verified ? verified + ' 个可用' : list.length + ' 个待验证';
    count.className = 'prof-count' + (verified ? '' : ' is-warn');
  }
  const cur = state.cfg || {};
  const hint = $('#profHint');
  if (hint) {
    hint.textContent =
      (cur.owner && cur.repo ? cur.owner + '/' + cur.repo : '未填写仓库') +
      (cur.localDir ? ' ←→ ' + cur.localDir : ' ←→ 未绑定本地目录');
  }
  fillProfilePick();
}

/** 仓库标题右边的「归档配置」下拉：列出已归档的配置 + 新建入口 */
function fillProfilePick() {
  const sel = $('#profilePick');
  if (!sel) return;
  const list = state.archivedProfiles.slice().sort(sortProfiles);
  const cur = (state.cfg && state.cfg.activeProfileId) || '';
  /**
   * kind 决定这条在自绘面板里的身份（见 cselect.js）：
   *   note   = 只读说明；action = 底部动作（会自动画一条分隔线）；不传 = 普通选项。
   * 分隔线由样式画，不再往列表里塞「──────」那种假选项。
   */
  const opt = (v, t, kind) =>
    '<option value="' +
    escapeHtml(v) +
    '"' +
    (kind ? ' data-kind="' + kind + '"' : '') +
    (kind && kind !== 'action' ? ' disabled' : '') +
    '>' +
    escapeHtml(t) +
    '</option>';

  let html = '';
  // 正在编辑一份还没归档的草稿：单独占一条只读说明，免得下拉显示成
  // 「已经选中了别的配置」、和下面表单里填的内容对不上。
  if (state.isDraft) html += opt('__draft__', '新配置 · 尚未归档', 'note');
  if (!list.length) {
    if (!state.isDraft) html += opt('', '还没有归档配置', 'note');
  } else {
    html += list
      .map((p) =>
        opt(
          p.id,
          profileLabel(p) +
            '（' + (PLATFORM_NAME[p.platform] || 'GitHub') + '）' +
            (p.verified ? '' : ' · 待验证')
        )
      )
      .join('');
  }
  html += opt('__new__', '＋ 新建一份空白配置…', 'action');
  sel.innerHTML = html;
  sel.value = state.isDraft ? '__draft__' : list.some((p) => p.id === cur) ? cur : list.length ? list[0].id : '__new__';
}

/**
 * ＋新建：把编辑对象换成一个「还没落盘的新配置」。
 *
 * 以前这里是立刻在配置里塞一份空白草稿并切过去 —— 点两下就多两条看不见的
 * 草稿，取消了也留在那儿。现在只在内存里记一个落点，真去保存了才会建出来，
 * 半路放弃等于什么都没发生。
 */
async function newProfile() {
  const t = editTarget();
  const plat = t.platform;
  editTargetId = '__new__:' + plat;
  fill();
  ok('已切到一份空白的 ' + (PLATFORM_NAME[plat] || '') + ' 配置 —— 填好仓库再保存就会建出来');
}

async function renameProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  const wrap = document.createElement('div');
  wrap.className = 'prof-rename';
  wrap.innerHTML =
    '<p class="hint" style="margin:0 0 10px">给这份配置起个好认的名字（留空则显示 owner/repo）</p>' +
    '<input type="text" id="profRenameInput" maxlength="40" />';
  const input = wrap.querySelector('#profRenameInput');
  input.value = p.name || '';
  modal({
    title: '重命名配置',
    node: wrap,
    buttons: [
      { label: '取消' },
      {
        label: '保存',
        primary: true,
        onClick: async () => {
          await state.updateProfile(id, { name: input.value.trim() });
          ok('已重命名');
          return true;
        }
      }
    ]
  });
  setTimeout(() => input.focus(), 60);
}

async function removeProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  const yes = await confirmDialog(
    '删除配置',
    '将从本机移除「' + profileLabel(p) + '」及其 Token。仓库里的文件不受影响',
    '删除'
  );
  if (!yes) return;
  await state.removeProfile(id);
  ok('已删除');
}

/* ---------------------------------------------------------------- 平台图层滑动 */

function playOut(back) {
  const pane = $('#repoPane');
  if (!pane) return;
  pane.classList.remove('slide-out-left', 'slide-in-right', 'slide-out-right', 'slide-in-left');
  void pane.offsetWidth;
  pane.classList.add(back ? 'slide-out-right' : 'slide-out-left');
}

function playIn(back) {
  const pane = $('#repoPane');
  if (!pane) return;
  pane.classList.remove('slide-out-left', 'slide-out-right', 'slide-in-left', 'slide-in-right');
  void pane.offsetWidth;
  pane.classList.add(back ? 'slide-in-left' : 'slide-in-right');
  setTimeout(
    () => pane.classList.remove('slide-in-left', 'slide-in-right'),
    SLIDE_IN + 40
  );
}

/**
 * 切到某一份配置 —— 这才是真正「换生效配置」的动作，入口有两个：
 * 右上角「归档配置」下拉，以及配置列表里的「切换」按钮。
 * （平台按钮不干这事，见上面的 editTarget 注释。）
 */
async function switchToProfile(id) {
  const target = state.profiles.find((x) => x.id === id);
  if (!target) return;
  if (target.id === activeProfileId()) {
    editTargetId = '';
    fillPlatform();
    return;
  }
  const curPlat = activePlatform();
  const nextPlat = platOf(target.platform);
  const changed = curPlat !== nextPlat;
  const back = curPlat === 'cnb' && nextPlat === 'github';

  slideLock = true;
  try {
    // 先把当前表单落盘，免得切走丢数据（不弹提示，避免噪音）
    await save({ silent: true });
    if (changed) {
      playOut(back);
      await wait(SLIDE_OUT);
    }
    // 先归位再激活：activateProfile 会 emit→fill()，这会儿编辑对象就该是「新的生效项」了
    editTargetId = '';
    await state.activateProfile(id);
    fill();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    slideLock = false;
  }
  if (changed) playIn(back);
  ok('已切换到「' + platLabel(target) + '」');
}

/* ---------------------------------------------------------------- 导出 / 导入 */

function skipLine(s) {
  const p = s.profile || {};
  const name = [p.owner, p.repo].filter(Boolean).join('/') || p.name || '（无仓库信息）';
  return (
    '<div class="imp-item">' +
    '<span class="ii-tag">跳过</span>' +
    '<div class="ii-main"><div class="ii-name">' + escapeHtml(name) + '</div>' +
    '<div class="ii-why">' + escapeHtml(s.reason || '未导入') + '</div></div>' +
    '</div>'
  );
}

/** 导出前的确认：这个 JSON 里带着明文 Token，必须让用户明确知道自己在导什么 */
function confirmExport(count, withToken) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    wrap.innerHTML =
      '<p class="hint" style="margin:0 0 10px">导出的 JSON 会带上：各份配置的仓库信息、' +
      '<b class="accent">访问令牌（明文）</b>，以及<b>每份配置各自的链接规则和自定义域名</b>；' +
      '复制格式与预览代理是全局设置，也会一并带上</p>' +
      '<p class="hint" style="margin:0 0 10px"><b>本地目录不会写入</b> —— 换台电脑原路径多半不存在，' +
      '导入后程序会引导你为本机重新绑定目录</p>' +
      '<p class="rule-desc" style="margin:0">本次共 ' + count + ' 份配置，其中 ' + withToken + ' 份带令牌' +
      '这个文件等于一把钥匙，请只放在你自己的机器或加密盘里，别发到群聊和公开仓库</p>';
    modal({
      title: '导出配置',
      node: wrap,
      buttons: [
        { label: '取消', onClick: () => { resolve(false); return true; } },
        { label: '仍然导出', danger: true, onClick: () => { resolve(true); return true; } }
      ],
      onClose: () => resolve(false)
    });
  });
}

async function exportProfiles() {
  if (!state.profiles.length) {
    warn('还没有归档配置，先在下面填一份并「验证并归档」');
    return;
  }
  const withToken = state.profiles.filter((p) => p.hasToken).length;
  const sure = await confirmExport(state.profiles.length, withToken);
  if (!sure) return;

  const btn = $('#btnProfExport');
  btn.disabled = true;
  try {
    const r = await state.exportProfiles();
    if (!r || r.canceled) return;
    if (!r.ok) {
      err(r.error || '导出失败');
      return;
    }
    ok('已导出 ' + r.count + ' 份配置（含 ' + (r.withToken || 0) + ' 份令牌）到 ' + r.filePath);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

/** 逐份跑可用性体检，结果渲染成一列卡片，每张都写清楚「哪里不可用、去哪儿改」 */
async function renderAvailability(results) {
  return results
    .map(({ p, r }) => {
      if (!r || r.missing) {
        return (
          '<div class="imp-item bad">' +
          '<span class="ii-tag bad">?</span>' +
          '<div class="ii-main"><div class="ii-name">' + escapeHtml(profileLabel(p)) + '</div>' +
          '<div class="ii-why">' + escapeHtml((r && r.error) || '体检失败，切到这份配置手动点「验证并归档」看看') + '</div></div>' +
          '</div>'
        );
      }
      const line = (title, part) => {
        if (!part) return '';
        const cls = part.ok ? 'ok' : 'bad';
        const mark = part.ok ? '✓' : '✗';
        return (
          '<div class="ii-why">' +
          '<span class="ii-tag ' + cls + '">' + mark + ' ' + escapeHtml(title) + '</span> ' +
          escapeHtml(part.message || '') +
          (!part.ok && part.fix ? '<br><span style="color:var(--warn)">→ ' + escapeHtml(part.fix) + '</span>' : '') +
          '</div>'
        );
      };
      return (
        '<div class="imp-item ' + (r.ok ? 'ok' : 'bad') + '">' +
        '<span class="ii-tag ' + (r.ok ? 'ok' : 'bad') + '">' + (r.ok ? '可用' : '待修') + '</span>' +
        '<div class="ii-main">' +
        '<div class="ii-name">' +
        escapeHtml(profileLabel(p)) +
        '<span class="hint" style="margin-left:8px;font-family:var(--mono)">' +
        escapeHtml((PLATFORM_NAME[r.platform] || 'GitHub') + ' · ' + (p.owner || '?') + '/' + (p.repo || '?')) +
        '</span></div>' +
        line('仓库信息', r.cloud) +
        line('本地目录', r.local) +
        '</div>' +
        '</div>'
      );
    })
    .join('');
}

async function importProfiles() {
  const btn = $('#btnProfImport');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '导入中…';

  let res = null;
  try {
    res = await state.importProfiles();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = old;
    err(e.message || String(e));
    return;
  }
  btn.disabled = false;
  btn.textContent = old;

  if (!res || res.canceled) return;
  if (!res.ok) {
    err(res.error || '导入失败');
    return;
  }

  const added = res.profiles || [];
  const skipped = res.skippedDetail || [];

  if (!added.length) {
    modal({
      title: '没有新增配置',
      html:
        '<p class="hint" style="margin:0 0 10px">文件里的配置本机都已经有了，没有导入新的</p>' +
        (skipped.length ? '<div class="imp-report">' + skipped.map(skipLine).join('') + '</div>' : ''),
      buttons: [{ label: '好', primary: true }]
    });
    fill();
    return;
  }

  // 体检：逐份查本地目录 + 云端仓库
  const box = document.createElement('div');
  box.className = 'imp-report';
  box.innerHTML =
    '<div class="imp-item"><div class="ii-main"><div class="ii-name">正在体检 ' + added.length + ' 份配置…</div>' +
    '<div class="ii-why">逐份检查本地目录在不在、云端仓库连不连得上</div></div></div>';
  const dlg = modal({ title: '导入完成 · 可用性体检', node: box, buttons: false });
  const foot = document.createElement('div');
  foot.className = 'modal-foot';
  foot.innerHTML = '<button class="btn btn-primary" disabled>体检中…</button>';
  dlg.box.appendChild(foot);

  const results = [];
  for (const p of added) {
    let r = null;
    try {
      r = await window.cloudpic.profile.check({ id: p.id });
    } catch (e) {
      r = { ok: false, error: e.message || String(e) };
    }
    results.push({ p: p, r: r });
  }

  const usable = results.filter((x) => x.r && x.r.ok).length;
  const needLocal = results.filter((x) => x.r && x.r.local && !x.r.local.ok).length;
  const needFix = results.length - usable;
  box.innerHTML =
    '<p class="hint" style="margin:0 0 10px">' +
    '导入 <b class="accent">' + added.length + '</b> 份，其中 <b class="accent">' + usable + '</b> 份可用' +
    (needFix ? '，<b style="color:var(--warn)">' + needFix + '</b> 份需要修一下' : '') +
    (skipped.length ? '；另有 ' + skipped.length + ' 份被跳过' : '') +
    (res.settingsApplied ? '<br>「文件链接」的全局设置（复制格式 / 预览代理）也一并恢复了' : '') +
    '</p>' +
    (needLocal
      ? '<p class="rule-desc" style="margin:0 0 10px">' +
        '<b class="accent">导入不含本地路径</b>：换台电脑原路径多半不存在，所以配置文件里没有它' +
        '下面的 <b>本地目录 ✗</b> 提示就是这么来的 —— 为这份配置在本机绑一个目录（' +
        '已有仓库用房「选择…」，想重新拉一份用「克隆到此处」），再点「验证并归档」即可' +
        '</p>'
      : '') +
    '<div class="imp-report">' +
    (await renderAvailability(results)) +
    (skipped.length ? skipped.map(skipLine).join('') : '') +
    '</div>' +
    (needFix
      ? '<p class="rule-desc" style="margin:10px 0 0">修的方式：用标题右边的「归档配置」下拉切到那一份，' +
        '按上面的提示改「仓库信息 / 本地目录」，改完点「验证并归档」' +
        '<span class="hint">Token 已经随配置文件一起导入，不用再手填；若某份确实没令牌，' +
        '说明导出时那份配置本身就没存</span></p>'
      : '');

  foot.innerHTML = '';
  const bClose = document.createElement('button');
  bClose.className = 'btn ' + (needFix ? 'btn-ghost' : 'btn-primary');
  bClose.textContent = '知道了';
  bClose.onclick = () => dlg.close();
  foot.appendChild(bClose);

  if (needFix) {
    const bFix = document.createElement('button');
    bFix.className = 'btn btn-primary';
    bFix.textContent = needLocal ? '去绑本地目录' : '去修第一份';
    bFix.onclick = async () => {
      dlg.close();
      const first = results.find((x) => x.r && !x.r.ok);
      if (first) await switchToProfile(first.p.id);
    };
    foot.appendChild(bFix);
  }

  fill();
}

/* ---------------------------------------------------------------- 验证并归档 */

/** 三块（仓库信息 / 本地目录 / 文件链接）分别校验，缺哪块就指哪块 */
async function archiveProfile() {
  const owner = $('#cfgOwner').value.trim();
  const repo = $('#cfgRepo').value.trim();
  const dir = $('#cfgLocalDir').value.trim();
  const ruleId = $('#cfgLinkRule').value;
  const rule = CPLinks.LINK_RULES.find((r) => r.id === ruleId);
  const custom = $('#cfgCustomDomain').value.trim();
  const typedToken = $('#cfgToken').value.trim();

  // 校验的是「正在编辑的那一份」，不是当前生效的那份
  const before = editTarget();
  const hasToken = before.mode === 'active' ? !!(state.cfg && state.cfg.hasToken) : !!(before.profile && before.profile.hasToken);

  if (!owner || !repo) {
    warn('「仓库信息」还没填完：请填写用户名和仓库名');
    $('#cfgOwner').focus();
    return;
  }
  if (!typedToken && !hasToken) {
    warn('「仓库信息」缺少访问令牌：在下面粘贴 Token，再点「验证并归档」');
    $('#cfgToken').focus();
    return;
  }
  if (!dir) {
    warn('「本地目录」还没绑定：云端仓库和本地目录是一份配置，缺一块不算归档');
    $('#cfgLocalDir').focus();
    return;
  }
  if (!rule) {
    warn('「文件链接」还没选链接规则');
    return;
  }
  if (ruleId === 'custom' && !custom) {
    warn('「文件链接」选了自定义域名，但没填域名 / 前缀');
    $('#cfgCustomDomain').focus();
    return;
  }

  const btn = $('#btnProfArchive');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '验证中…';

  const renderSteps = (chk) => {
    const line = (title, part) =>
      (part && part.ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') +
      '<b>' + escapeHtml(title) + '</b>：' +
      escapeHtml((part && part.message) || '未检查') +
      (part && !part.ok && part.fix ? '<br><span class="bad">　→ ' + escapeHtml(part.fix) + '</span>' : '');
    return [
      line('仓库信息', chk.cloud),
      line('本地目录', chk.local),
      '<span class="ok">✓</span> <b>文件链接</b>：规则「' + escapeHtml(rule.name) + '」'
    ].join('<br>');
  };

  try {
    // 先落盘（编辑别的配置时 save 会把它建出来 / 更新到它身上），再拿它的 id 去体检
    await save({ silent: true });
    const t = editTarget();
    const id = t.profile ? t.profile.id : '';
    if (!id) {
      err('没有可归档的配置，请先点「＋ 新建」');
      return;
    }
    const chk = await window.cloudpic.profile.check({ id: id });

    if (!chk.ok) {
      const wrap = document.createElement('div');
      wrap.innerHTML = renderSteps(chk) + '<br><span class="bad">三块里还有没通过的，先修好再归档</span>';
      modal({ title: '验证未通过', node: wrap, buttons: [{ label: '好', primary: true }] });
      return;
    }

    await state.verifyProfile(id, {
      userName: chk.cloud.userName || '',
      repo: chk.cloud.repoInfo || { fullName: (chk.cloud.owner || '') + '/' + (chk.cloud.repo || '') }
    });
    ok('三块全部通过，已归档：' + owner + '/' + repo);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    renderProfiles();
  }
}

/* ---------------------------------------------------------------- 自定义背景图 */

/**
 * 浅色模式的自定义背景图（深色永远星野，这是杰哥定的规矩）。
 * 选图 / 清除都走主进程：选中的图会被拷进配置目录 bg/ 里，
 * 配置里记的是副本路径 —— 原图挪走删掉都不影响。
 */
let autoSave = null;

async function fillBgPreview() {
  const box = $('#bgPreview');
  if (!box) return;
  const ui = (state.cfg && state.cfg.ui) || {};
  const path = String(ui.bgImage || '').trim();
  if (!path) {
    box.classList.add('empty');
    box.style.backgroundImage = '';
    box.title = '尚未设置自定义背景图';
    return;
  }
  box.classList.remove('empty');
  box.style.backgroundImage = 'url("' + window.cloudpic.localUrl(path) + '")';
  box.title = path;
}

async function pickBgImage() {
  const btn = $('#btnBgPick');
  btn.disabled = true;
  try {
    const out = await window.cloudpic.app.chooseBgImage();
    if (out && out.canceled) return;
    await state.refresh();
    fillBgPreview();
    ok('背景图已更新（浅色模式下生效）');
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
  }
}

async function clearBgImage() {
  try {
    await window.cloudpic.app.clearBgImage();
    await state.refresh();
    fillBgPreview();
    ok('已恢复默认浅色背景');
  } catch (e) {
    err(e.message || String(e));
  }
}

/** 滑块是 0.1 一档：数值取一位小数（避免 12.300000000000001 这种浮点噪声），
 *  显示时整数不带小数点 —— 12 而不是 12.0 */
function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
function fmtBlur(n) {
  const v = round1(n);
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 毛玻璃强度落盘（防抖：拖动过程中别每像素都写一次配置） */
const saveBlur = debounce(() => {
  state.patch({ ui: { bgBlur: round1(Number($('#cfgBgBlur').value) || 0) } }).catch((e) => err(e.message || String(e)));
}, 260);

/* ---------------------------------------------------------------- 外观 */

function currentTheme() {
  return ((state.cfg && state.cfg.ui && state.cfg.ui.theme) === 'light' ? 'light' : 'dark');
}

function fillThemeCards() {
  const cur = currentTheme();
  $$('#themeCards .theme-card').forEach((c) => c.classList.toggle('on', c.dataset.theme === cur));
}

function applyFontPreview(font) {
  const box = $('#fontSample');
  if (!box) return;
  box.style.fontFamily = stackFor(font);
}

/**
 * 字体清单只构建一次。
 *
 * 清单本身由主进程扫本机字体目录得来（app.js 在画界面之前已经拉好并塞进
 * appearance.js），所以这里列出来的就是「真装了的」——包括用户自己装的
 * 霞鹜文楷之类，不再局限于程序内置的那张候选表。
 */
let fontsBuilt = false;
function ensureFontOptions(cur) {
  const sel = $('#cfgFont');
  if (!sel) return;
  if (!fontsBuilt) {
    let html =
      '<option value="">系统默认（' + escapeHtml(PRIMARY_FONT_NAME) + ' → 微软雅黑 / Segoe UI）</option>';
    installedFontGroups().forEach((g) => {
      // 分节标题（中文 / 西文 / 等宽 …）：不再是「— 中文 —」那种括号包起来的样子，
      // 交给样式的 is-group 画上一条细线 + 小号字，看着更像一个分区
      html += '<option value="" disabled data-kind="group">' + escapeHtml(g.group) + '</option>';
      html += g.fonts
        .map((f) => '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>')
        .join('');
    });
    sel.innerHTML = html;
    fontsBuilt = true;
    const cnt = $('#fontCount');
    if (cnt) cnt.textContent = '本机检测到 ' + installFontCount() + ' 款已安装字体，选一款即可整界面生效';
  }
  const f = String(cur || '').trim();
  const has = Array.from(sel.options).some((o) => o.value === f && !o.disabled);
  if (f && !has) {
    const opt = document.createElement('option');
    opt.value = f;
    opt.textContent = f + '（当前）';
    sel.appendChild(opt);
  }
  sel.value = f;
  applyFontPreview(f);
}

async function setTheme(theme) {
  const t = theme === 'light' ? 'light' : 'dark';
  applyTheme(t);
  fillThemeCards();
  await state.patch({ ui: { theme: t } });
}

async function setFont(font) {
  const f = String(font || '').trim();
  applyFont(f);
  applyFontPreview(f);
  await state.patch({ ui: { font: f } });
  ok(f ? '界面字体已换成 ' + f : '界面字体已恢复系统默认（' + PRIMARY_FONT_NAME + ' → 微软雅黑）');
}

/* ---------------------------------------------------------------- 填充 */

function fillPlatform() {
  const t = rememberEditTarget();
  const plat = t.platform;
  const actPlat = activePlatform();
  const isCnb = plat === 'cnb';

  document.querySelectorAll('#cfgPlatform button').forEach((b) => {
    b.classList.toggle('active', b.dataset.platform === plat);
  });

  // 平台图层：左边那条主题色竖条靠 data-platform 决定，徽标文案与图标也跟着换
  const pane = $('#repoPane');
  if (pane) pane.dataset.platform = plat;
  const badgeIcon = $('#platBadgeIcon');
  if (badgeIcon) badgeIcon.innerHTML = brandIcon(plat, 14);
  const badge = $('#platBadgeText');
  if (badge) badge.textContent = PLATFORM_NAME[plat];

  // 「正在编辑」和「正在使用」是两件事，这里把状态摆明，别让用户以为已经切过去了
  const flag = $('#platState');
  if (flag) {
    flag.className =
      'plat-state' + (t.mode === 'active' ? ' on' : t.mode === 'new' ? ' new' : '');
    flag.textContent = t.mode === 'active' ? '当前使用中' : t.mode === 'new' ? '新建' : '仅编辑';
  }
  const setActive = $('#btnSetActive');
  // 只有「编辑的是另一份已存在的配置」时才有得可切；
  // 编辑当前生效那份、或还只是个「新建」落点时都不该出现
  if (setActive) setActive.hidden = t.mode !== 'profile';

  const hint = $('#platHint');
  if (hint) {
    if (t.mode === 'active') {
      hint.textContent =
        '正在编辑 ' + PLATFORM_NAME[plat] + ' 的配置 · 整程序都在用它';
    } else if (t.mode === 'new') {
      hint.textContent =
        PLATFORM_NAME[plat] + ' 还没有配置 · 填好仓库信息保存即可新建一份（不会顶掉当前的）';
    } else {
      hint.textContent =
        '正在编辑 ' + PLATFORM_NAME[plat] + ' 的配置 · 当前使用的是 ' + PLATFORM_NAME[actPlat];
    }
  }

  $('#tokenHelp').innerHTML = TOKEN_HELP[isCnb ? 'cnb' : 'github'];
  const api = $('#cfgApiBase');
  if (api) api.placeholder = isCnb ? 'https://api.cnb.cool' : 'https://api.github.com';
}

/**
 * 链接规则是「正在编辑的这一份」自己的（跟 owner / repo 同一组，见 store 的 PROFILE_FIELDS）。
 *
 * 之前读的是 state.cfg（当前生效那份），于是编辑另一份配置时表单显示的是别人的规则，
 * 保存还会顺手把别人那份冲掉；切到另一个平台时更明显 —— 平台专属的规则（jsdelivr
 * 只给 GitHub、cnb_raw 只给 CNB）在新平台的下拉里根本不存在，只能回落到「自动」，
 * 一保存用户的规则就没了。
 */
function fillLinkRules() {
  const t = editTarget();
  const own = t.profile || {};
  const platform = t.platform;
  const rules = CPLinks.LINK_RULES.filter((r) => r.platforms.indexOf(platform) >= 0);
  const sel = $('#cfgLinkRule');
  const current = own.linkRule || 'auto';
  sel.innerHTML = rules.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('');
  // 规则不在这个平台的列表里（手改过配置、或这份配置的平台被改过）才回落到「自动」显示；
  // 配置里存着的值不会被抹掉，只有用户真的保存才写回
  sel.value = rules.some((r) => r.id === current) ? current : 'auto';
  updateRuleDesc();
}

function updateRuleDesc() {
  const id = $('#cfgLinkRule').value;
  const rule = CPLinks.LINK_RULES.find((r) => r.id === id);
  $('#linkRuleDesc').textContent = rule ? rule.desc : '';
  $('#customDomainField').hidden = id !== 'custom';
  updateLinkPreview();
}

function updateLinkPreview() {
  const c = state.cfg || {};
  const sample = {
    platform: editTarget().platform,
    owner: $('#cfgOwner').value || c.owner || 'owner',
    repo: $('#cfgRepo').value || c.repo || 'repo',
    branch: $('#cfgBranch').value || c.branch || 'main',
    linkRule: $('#cfgLinkRule').value,
    customDomain: $('#cfgCustomDomain').value
  };
  const url = CPLinks.buildUrl(sample, 'images/2026/09/example.jpg');
  const fmt = $('#cfgLinkFormat').value || 'markdown';
  $('#linkPreview').innerHTML =
    '直链：<span class="accent">' + escapeHtml(url) + '</span><br>' +
    '复制出来的样子：' + escapeHtml(CPLinks.formatLink(url, fmt, 'example.jpg'));
}

/** 预览代理填了没、填了会请求成什么样，直接摆出来省得猜 */
function updateProxyDesc() {
  const box = $('#proxyDesc');
  if (!box) return;
  const raw = ($('#cfgProxyUrl').value || '').trim();
  if (!raw) {
    box.innerHTML =
      '留空的话，预览会直接请求仓库直链（GitHub raw 这类），国内经常加载不出来' +
      '填上自己的 CDN 之后，预览和缩略图都会改走它';
    return;
  }
  const base = CPLinks.normalizeBaseUrl(raw);
  const demo = CPLinks.buildProxyUrl({ proxyUrl: raw }, '111.avif');
  box.innerHTML =
    '预览将请求：<span class="accent">' + escapeHtml(demo) + '</span><br>' +
    '按「' + escapeHtml(base) + '/<仓库内相对路径>」拼接，例：仓库根目录的 111.avif → 上面那条' +
    (/\{path\}/.test(raw) ? '（用了 {path} 占位）' : '');
}

function fill() {
  const c = state.cfg || {};
  const sync = c.sync || {};
  const ui = c.ui || {};

  fillPlatform();

  /**
   * 「仓库信息 + 本地目录 + 文件链接（规则 / 自定义域名）」属于正在编辑的那一份；
   * 压缩、水印、同步、外观、链接格式、预览代理这些是全局的，永远读当前生效那份。
   */
  const t = editTarget();
  const repo =
    t.mode === 'active'
      ? { owner: c.owner, repo: c.repo, branch: c.branch, apiBase: c.apiBase, localDir: c.localDir, hasToken: c.hasToken, tokenMask: c.tokenMask }
      : {
          owner: (t.profile && t.profile.owner) || '',
          repo: (t.profile && t.profile.repo) || '',
          branch: (t.profile && t.profile.branch) || 'main',
          apiBase: (t.profile && t.profile.apiBase) || '',
          localDir: (t.profile && t.profile.localDir) || '',
          hasToken: !!(t.profile && t.profile.hasToken),
          tokenMask: (t.profile && t.profile.tokenMask) || ''
        };

  $('#cfgOwner').value = repo.owner || '';
  $('#cfgRepo').value = repo.repo || '';
  $('#cfgBranch').value = repo.branch || 'main';
  $('#cfgApiBase').value = repo.apiBase || '';
  $('#cfgToken').value = '';
  $('#cfgToken').placeholder = repo.hasToken ? '已保存：' + (repo.tokenMask || '********') + '（留空表示不修改）' : '粘贴 Token';
  $('#tokenHint').textContent = repo.hasToken ? '（已配置）' : '（未配置）';

  $('#cfgLocalDir').value = repo.localDir || '';
  $('#cfgAutoPull').checked = sync.autoPull !== false;
  $('#cfgSyncStrategy').value = sync.strategy || 'pull';

  $('#cfgCommitMessage').value = c.commitMessage || '';

  fillLinkRules();
  // 自定义域名跟链接规则是一对，跟着配置走；下面两行是全局项
  $('#cfgCustomDomain').value = (t.profile && t.profile.customDomain) || '';
  $('#cfgProxyUrl').value = c.proxyUrl || '';
  $('#cfgLinkFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
  $('#cfgLinkFormat').value = c.linkFormat || 'markdown';
  updateProxyDesc();

  // 外观（主题 / 字体 / 背景图 / 毛玻璃）
  fillThemeCards();
  ensureFontOptions(ui.font || '');
  fillBgPreview();
  const blur = ui.bgBlur == null ? 12 : Number(ui.bgBlur);
  $('#cfgBgBlur').value = blur;
  $('#cfgBgBlurVal').textContent = fmtBlur(blur);

  renderProfiles();
  updateLinkPreview();
  refreshGitStatus();
}

function collect() {
  const patch = {
    platform: editTarget().platform,
    owner: $('#cfgOwner').value.trim(),
    repo: $('#cfgRepo').value.trim(),
    branch: $('#cfgBranch').value.trim() || 'main',
    apiBase: $('#cfgApiBase').value.trim(),
    localDir: $('#cfgLocalDir').value.trim(),
    commitMessage: $('#cfgCommitMessage').value.trim() || 'chore: 通过 JIE 分发服务上传',
    linkRule: $('#cfgLinkRule').value,
    customDomain: $('#cfgCustomDomain').value.trim(),
    proxyUrl: $('#cfgProxyUrl').value.trim(),
    linkFormat: $('#cfgLinkFormat').value,
    sync: {
      autoPull: $('#cfgAutoPull').checked,
      strategy: $('#cfgSyncStrategy').value
    }
  };
  if (tokenTouched && $('#cfgToken').value.trim()) patch.token = $('#cfgToken').value.trim();
  return patch;
}

/* ---------------------------------------------------------------- Git 状态 */

async function refreshGitStatus() {
  const box = $('#gitStatus');
  const gv = await window.cloudpic.git.version();
  const lines = [];
  // 本机的 Git 状态是按「当前使用中」那份配置的本地目录算的（主进程只认它），
  // 正在编辑别的配置时先说清楚，免得用户以为看的是手上这份
  if (editTarget().mode !== 'active') {
    lines.push('<span class="hint">以下 Git 状态按「当前使用中」的配置显示</span>');
  }
  lines.push('Git：' + (gv && gv.version ? '<span class="ok">' + escapeHtml(gv.version) + '</span>' : '<span class="bad">未检测到，本地同步功能不可用</span>'));

  const cfg = state.cfg || {};
  if (!cfg.localDir) {
    lines.push('本地目录：未配置（只能浏览云端，速度较慢）');
  } else {
    const st = await window.cloudpic.git.status();
    if (!st.isRepo) {
      lines.push('本地目录：' + escapeHtml(cfg.localDir) + ' <span class="bad">不是 Git 仓库</span>');
      lines.push('提示：点上面的「克隆到此处」把仓库拉下来');
    } else {
      lines.push('本地目录：<span class="ok">' + escapeHtml(st.dir) + '</span>');
      lines.push('当前分支：' + escapeHtml(st.branch || '?') + '　HEAD：' + escapeHtml(st.head || '?'));
      lines.push('工作区：' + (st.dirty ? '<span class="bad">有 ' + st.changes + ' 处未提交改动</span>' : '<span class="ok">干净</span>'));
    }
  }
  box.innerHTML = lines.join('<br>');
}

/* ---------------------------------------------------------------- 操作 */

/** 一份配置里「属于这份配置」的字段（对应 store.js 的 PROFILE_FIELDS + Token） */
/**
 * 「属于某一份配置」的字段 —— 保存时要写进正在编辑的那份，而不是顶层。
 * 跟主进程 store.js 的 PROFILE_FIELDS 是一份名单，加字段两边都要动。
 */
const PER_PROFILE_KEYS = ['platform', 'owner', 'repo', 'branch', 'apiBase', 'localDir', 'linkRule', 'customDomain', 'token'];

/**
 * 保存。
 *
 * 关键点：写进「正在编辑的那一份」，而不是无条件写当前生效的那份 ——
 * 平台按钮只切编辑对象，用户完全可以一边用着 GitHub、一边把 CNB 那份填好。
 * 全局设置（同步 / 外观 / 链接格式 / 预览代理）不分配置，照旧写当前生效那份；
 * 压缩 / 水印也是全局项，但它们的表单在上传页的「图片设置」里（2026-09-24 迁走的），
 * 这里**不碰**这两个键 —— patch 是深合并，缺键不会冲掉上传页写进去的值。
 */
async function save(opts) {
  const patch = collect();
  const t = editTarget();
  // 「还没填仓库、先不建」这一种要单独压掉结尾的「已保存」提示，否则一次弹两条
  let justWarned = false;

  if (t.mode === 'active') {
    await state.patch(patch);
  } else {
    const conn = {};
    for (const k of PER_PROFILE_KEYS) {
      if (k === 'token') {
        if (patch.token) conn.token = patch.token;
        continue;
      }
      if (patch[k] !== undefined) conn[k] = patch[k];
    }
    conn.platform = t.platform;
    conn.branch = patch.branch || 'main';

    const globalPatch = Object.assign({}, patch);
    for (const k of PER_PROFILE_KEYS) delete globalPatch[k];
    await state.patch(globalPatch);

    if (t.mode === 'profile') {
      await state.updateProfile(t.profile.id, conn);
    } else if (patch.owner && patch.repo) {
      // 该平台还没有配置 —— 现在才真正建出来，并且不抢「当前使用」的位置
      await state.newProfile(Object.assign({ activate: false }, conn));
      const made = state.profiles
        .filter((p) => platOf(p.platform) === t.platform)
        .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
      editTargetId = made ? made.id : '';
    } else {
      // 连仓库都没填就别建了 —— 不然每次自动保存都往配置里塞一个空壳（还看不见）
      justWarned = true;
      if (!(opts && opts.silent)) {
        warn('填上「用户名」和「仓库名」再保存，才会为 ' + (PLATFORM_NAME[t.platform] || '') + ' 新建一份配置');
      }
    }
  }

  tokenTouched = false;
  $('#cfgToken').value = '';
  fill();
  if (!(opts && opts.silent) && !justWarned) {
    const now = editTarget();
    ok(
      now.mode === 'active'
        ? '设置已保存'
        : '已保存到「' + platLabel(now.profile) + '」，当前使用的仍是 ' + PLATFORM_NAME[activePlatform()]
    );
  }
  window.dispatchEvent(new CustomEvent('cloudpic:changed'));
}

async function test() {
  const btn = $('#btnTest');
  btn.disabled = true;
  btn.textContent = '测试中…';
  try {
    await save();
    const res = await window.cloudpic.cloud.verify();
    const lines = (res.steps || [])
      .map((s) => (s.ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + escapeHtml(s.name) + '：' + escapeHtml(s.message))
      .join('<br>');
    const wrap = document.createElement('div');
    wrap.innerHTML = lines + (res.ok ? '<br><br><span class="ok">一切正常，可以开始上传了</span>' : '');
    modal({ title: res.ok ? '连接正常' : '连接存在问题', node: wrap, buttons: [{ label: '好', primary: true }] });
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '测试连接';
  }
}

async function chooseDir() {
  const p = await window.cloudpic.dialog.chooseDir({ title: '选择本地仓库目录' });
  if (!p) return;
  $('#cfgLocalDir').value = p;
  await state.patch({ localDir: p });
  refreshGitStatus();
}

async function doClone() {
  const dir = $('#cfgLocalDir').value.trim();
  if (!dir) {
    warn('请先填写或选择本地目录');
    return;
  }
  const cfg = state.cfg || {};
  if (!cfg.owner || !cfg.repo) {
    err('请先填写用户名与仓库名并保存');
    return;
  }
  const btn = $('#btnClone');
  btn.disabled = true;
  btn.textContent = '克隆中…';
  try {
    await save();
    const r = await window.cloudpic.git.clone({ dir: dir });
    if (r.ok) {
      ok('克隆完成：' + dir);
      await state.refresh();
      fill();
    } else {
      err(r.message);
    }
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = '克隆到此处';
  }
}

/* ---------------------------------------------------------------- 绑定 */

export default {
  init() {
    // 平台按钮带上品牌标志（官方 SVG），比纯文字更好认
    document.querySelectorAll('#cfgPlatform button').forEach((b) => {
      const plat = b.dataset.platform;
      b.innerHTML = brandIcon(plat, 15) + '<span>' + escapeHtml(PLATFORM_NAME[plat] || plat) + '</span>';
      b.onclick = () => pickPlatform(plat);
    });

    // 平台按钮只管「编辑哪一份」，真要切生效配置走这里 / 右上角下拉
    const setActive = $('#btnSetActive');
    if (setActive) setActive.onclick = () => useEditingTarget();

    fill();

    // 归档配置下拉
    $('#profilePick').addEventListener('change', async () => {
      const v = $('#profilePick').value;
      if (v === '__new__') {
        await newProfile();
        fillProfilePick();
        return;
      }
      if (!v || v === '__draft__') return;
      if (v === (state.cfg && state.cfg.activeProfileId)) return;
      await switchToProfile(v);
    });

    $('#btnProfNew').onclick = () => newProfile();
    $('#btnProfExport').onclick = exportProfiles;
    $('#btnProfImport').onclick = importProfiles;

    $('#cfgToken').addEventListener('input', () => {
      tokenTouched = true;
    });
    $('#btnToggleToken').onclick = () => {
      const el = $('#cfgToken');
      el.type = el.type === 'password' ? 'text' : 'password';
      $('#btnToggleToken').textContent = el.type === 'password' ? '显示' : '隐藏';
    };
    $('#btnClearToken').onclick = async () => {
      const yes = await confirmDialog('清除 Token', '清除后需要重新填写才能上传 / 删除', '清除');
      if (!yes) return;
      await state.patch({ token: '' });
      tokenTouched = false;
      fill();
      ok('Token 已清除');
    };

    $('#btnChooseDir').onclick = chooseDir;
    $('#btnClone').onclick = doClone;

    $('#btnSave').onclick = () => save();
    $('#btnTest').onclick = test;
    $('#btnProfArchive').onclick = archiveProfile;

    // 归档列表：切换 / 改名 / 删除
    $('#profileList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      const row = e.target.closest('.pf-row');
      if (!row) return;
      const id = row.dataset.id;
      if (!btn) {
        if (!row.classList.contains('active')) switchToProfile(id);
        return;
      }
      const act = btn.dataset.act;
      if (act === 'use') switchToProfile(id);
      else if (act === 'rename') renameProfile(id);
      else if (act === 'del') removeProfile(id);
    });

    $('#btnResetConfig').onclick = async () => {
      const yes = await confirmDialog('恢复默认设置', '将清空所有本机配置（含 Token）。仓库里的文件不受影响', '恢复默认');
      if (!yes) return;
      await window.cloudpic.config.reset();
      await state.refresh();
      fill();
      ok('已恢复默认设置');
      window.dispatchEvent(new CustomEvent('cloudpic:changed'));
    };

    // 外观：主题卡片
    $('#themeCards').addEventListener('click', (e) => {
      const card = e.target.closest('.theme-card');
      if (!card) return;
      if (card.dataset.theme === currentTheme()) return;
      setTheme(card.dataset.theme).catch((err2) => err(err2.message || String(err2)));
    });
    // 外观：字体
    $('#cfgFont').addEventListener('change', () => {
      setFont($('#cfgFont').value).catch((err2) => err(err2.message || String(err2)));
    });
    // 外观：自定义背景图（仅浅色生效）
    $('#btnBgPick').onclick = pickBgImage;
    $('#btnBgClear').onclick = clearBgImage;

    const live = (sel, handler) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    };

    // 外观：毛玻璃强度。拖动时本地立刻重算整套玻璃状态（class + 模糊量），
    // 不等落盘往返 —— 否则滑块动了画面要慢半拍才跟上（杰哥实测点名的）。
    // 深色模式下同样可调，只是那一层暂时看不到效果。
    // （live 是上面刚声明的 const，用之前必须已经初始化，否则整段 init 会因为
    //  TDZ 抛错静默中断，后面所有绑定都挂不上 —— 踩过一次，别再挪到它上面）
    live('#cfgBgBlur', () => {
      const v = round1(Number($('#cfgBgBlur').value) || 0);
      $('#cfgBgBlurVal').textContent = fmtBlur(v);
      applyGlass({ ui: Object.assign({}, (state.cfg && state.cfg.ui) || {}, { bgBlur: v }) });
      saveBlur();
    });

    ['#cfgOwner', '#cfgRepo', '#cfgBranch', '#cfgCustomDomain'].forEach((s) => live(s, updateLinkPreview));
    live('#cfgProxyUrl', updateProxyDesc);
    $('#cfgLinkRule').addEventListener('change', () => {
      updateRuleDesc();
      updateLinkPreview();
    });
    $('#cfgLinkFormat').addEventListener('change', () => {
      updateLinkPreview();
      state.patch({ linkFormat: $('#cfgLinkFormat').value });
    });

    // 链接帮助里的外链
    $('#tokenHelp').addEventListener('click', (e) => {
      const a = e.target.closest('a[data-ext]');
      if (!a) return;
      e.preventDefault();
      window.cloudpic.shell.openExternal(a.dataset.ext);
    });

    // 输入后自动保存（防抖），避免用户忘记点保存。
    // 链接规则 / 自定义域名也在内 —— 它们是每份配置自己的，选了不保存就会「看着没生效」。
    autoSave = debounce(() => {
      save({ silent: true }).catch(() => {});
    }, 1400);
    ['#cfgOwner', '#cfgRepo', '#cfgBranch', '#cfgCommitMessage', '#cfgProxyUrl', '#cfgLinkRule', '#cfgCustomDomain'].forEach((s) => {
      const el = $(s);
      if (el) el.addEventListener('change', autoSave);
    });
  },

  onEnter() {
    fill();
  },

  onConfigChanged() {
    // 平台滑动过程中不重画，否则「滑出 → 换内容 → 滑入」会被打断
    if (slideLock) return;
    fill();
  }
};
