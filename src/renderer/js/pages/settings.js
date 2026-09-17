/** 设置页 */

import { $, $$, ok, err, warn, confirmDialog, modal, escapeHtml, debounce } from '../lib/dom.js';
import state from '../lib/state.js';
import {
  applyTheme,
  applyFont,
  stackFor,
  installedFontGroups,
  installFontCount,
  PRIMARY_FONT_NAME
} from '../lib/appearance.js';
import { brandIcon } from '../lib/brandicons.js';
import { openColorPicker, closeColorPicker, normalizeHex } from '../lib/colorpicker.js';

const CPLinks = window.CPLinks;
let tokenTouched = false;

/** 水印配色快捷项（#1296db 是默认） */
const WM_PRESETS = ['#1296db', '#ffffff', '#101722', '#ff4d4f', '#20c997', '#f5a623'];

const PLATFORM_NAME = { github: 'GitHub', cnb: 'CNB' };

const TOKEN_HELP = {
  github:
    'GitHub 需要 <b>Personal Access Token</b>（经典版或细粒度均可），至少勾选 <b>repo</b>（读写仓库内容）。' +
    '申请地址：<a href="#" data-ext="https://github.com/settings/tokens/new?scopes=repo&description=JIE-Dispatch">github.com/settings/tokens</a>。' +
    'Token 只保存在本机，用 Windows 系统级加密（DPAPI）存储，代码不会把它写到任何地方。',
  cnb:
    'CNB 需要 <b>访问令牌</b>，请在「个人设置 → 访问令牌」创建，并勾选 <b>repo-code</b>（仓库代码读写）等权限。' +
    '注意必须用<b>经典令牌</b>——MCP 令牌调不了 REST 接口（会一路 404）。' +
    '申请地址：<a href="#" data-ext="https://cnb.cool/profile/token">cnb.cool/profile/token</a>。' +
    'Token 只保存在本机，用 Windows 系统级加密存储。'
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SLIDE_OUT = 190;
const SLIDE_IN = 300;

/** 平台切换时先滑出、换内容、再滑入；滑动期间压掉自动重画，否则图层会闪 */
let slideLock = false;

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

function profileRow(p) {
  const plat = PLATFORM_NAME[p.platform] || 'GitHub';
  const repoPath = p.owner && p.repo ? p.owner + '/' + p.repo : '（未填写仓库）';
  const bits = [];
  if (p.verified) {
    bits.push('<span class="pf-badge ok">已归档</span>');
    if (p.repoInfo && p.repoInfo.private) bits.push('<span class="pf-badge">私有</span>');
    if (p.verifiedAt) bits.push('<span class="pf-sub">' + fmtDate(p.verifiedAt) + ' 验证</span>');
  } else {
    bits.push('<span class="pf-badge warn">待验证</span>');
  }
  if (!p.hasToken) bits.push('<span class="pf-badge danger">无 Token</span>');

  const dir = p.localDir
    ? '<span class="pf-dir" title="' + escapeHtml(p.localDir) + '">📁 ' + escapeHtml(p.localDir) + '</span>'
    : '<span class="pf-dir bad">未绑定本地目录</span>';

  return (
    '<div class="pf-row' + (p.isActive ? ' active' : '') + '" data-id="' + escapeHtml(p.id) + '">' +
    '<span class="pf-dot" aria-hidden="true"></span>' +
    '<div class="pf-main">' +
    '<div class="pf-line1">' +
    '<span class="pf-platform pf-' + escapeHtml(p.platform || 'github') + '">' + plat + '</span>' +
    '<span class="pf-name">' + escapeHtml(repoPath) + '</span>' +
    (p.name ? '<span class="pf-alias">' + escapeHtml(p.name) + '</span>' : '') +
    '</div>' +
    '<div class="pf-line2">' + dir + '<span class="pf-sep">·</span>' + bits.join('') + '</div>' +
    '</div>' +
    '<div class="pf-ops">' +
    (p.isActive
      ? '<span class="pf-cur">使用中</span>'
      : '<button type="button" class="btn btn-ghost btn-sm" data-act="use">切换</button>') +
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
  const opt = (v, t, dis) =>
    '<option value="' + escapeHtml(v) + '"' + (dis ? ' disabled' : '') + '>' + escapeHtml(t) + '</option>';

  let html = '';
  // 正在编辑一份还没归档的草稿：单独占一个只读项，免得下拉显示成
  // 「已经选中了别的配置」、和下面表单里填的内容对不上。
  if (state.isDraft) {
    html += opt('__draft__', '（新配置 · 尚未归档）', true);
    if (list.length) html += opt('__sep__', '──────────────', true);
  }
  if (!list.length) {
    if (!state.isDraft) html += opt('', '还没有归档配置', true);
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
    html += opt('__sep__', '──────────────', true);
  }
  html += opt('__new__', '＋ 新建一份空白配置…');
  sel.innerHTML = html;
  sel.value = state.isDraft ? '__draft__' : list.some((p) => p.id === cur) ? cur : list.length ? list[0].id : '__new__';
}

/** 新建一份空白配置（远端仓库 + 本地目录都清空，避免覆盖现有配置） */
async function newProfile() {
  const platform = (state.cfg && state.cfg.platform) || 'github';
  await state.newProfile({ platform: platform });
  ok('已新建一份空白配置 —— 填上仓库它就会出现在下面的列表里');
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
    '将从本机移除「' + profileLabel(p) + '」及其 Token。仓库里的文件不受影响。',
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
 * 切到某一份配置。平台不同就整块左右滑动 —— GitHub / CNB 是两张图层，
 * 往右滑是去 CNB，往左滑是回 GitHub，左边的主题色条跟着换。
 */
async function switchToProfile(id) {
  const target = state.profiles.find((x) => x.id === id);
  if (!target) return;
  if (target.id === (state.cfg && state.cfg.activeProfileId)) {
    fillPlatform();
    return;
  }
  const curPlat = (state.cfg && state.cfg.platform) || 'github';
  const nextPlat = target.platform || 'github';
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
    await state.activateProfile(id);
    fill();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    slideLock = false;
  }
  if (changed) playIn(back);
  ok(
    target.draft
      ? '已切到 ' + (PLATFORM_NAME[nextPlat] || '') + ' 的新配置 —— 填上仓库就会出现在下面的列表里'
      : '已切换到「' + profileLabel(target) + '」'
  );
}

/**
 * 切到某个平台：已有配置就整份切过去，没有就开一份空白的当落点。
 *
 * 这份空白是「草稿」（draft），不会出现在归档列表里 —— 以前它会直接列出来，
 * 显示成「（未填写仓库）· 待验证 · 无 Token」，切几次就多出几条，像是凭空冒出来的。
 * 用户把仓库名填上（= 明确保存了配置），它自然就从草稿变成一份正经配置。
 */
async function switchToPlatform(platform) {
  const curPlat = (state.cfg && state.cfg.platform) || 'github';
  if (platform === curPlat) {
    fillPlatform();
    return;
  }
  const target = state.profileFor(platform);
  if (target) {
    await switchToProfile(target.id);
    return;
  }
  const back = curPlat === 'cnb' && platform === 'github';
  slideLock = true;
  try {
    await save({ silent: true });
    playOut(back);
    await wait(SLIDE_OUT);
    await state.newProfile({ platform: platform });
    fill();
  } catch (e) {
    err(e.message || String(e));
  } finally {
    slideLock = false;
  }
  playIn(back);
  warn(
    '还没有 ' + PLATFORM_NAME[platform] + ' 的配置，已开一份空白的 —— 填上仓库它就会出现在列表里，' +
      '再点「验证并归档」标成可用'
  );
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
      '<b class="accent">访问令牌（明文）</b>，以及「文件链接」的全部设置' +
      '（链接规则 / 自定义域名 / 链接格式 / 预览代理）。</p>' +
      '<p class="hint" style="margin:0 0 10px"><b>本地目录不会写入</b> —— 换台电脑原路径多半不存在，' +
      '导入后程序会引导你为本机重新绑定目录。</p>' +
      '<p class="rule-desc" style="margin:0">本次共 ' + count + ' 份配置，其中 ' + withToken + ' 份带令牌。' +
      '这个文件等于一把钥匙，请只放在你自己的机器或加密盘里，别发到群聊和公开仓库。</p>';
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
        '<p class="hint" style="margin:0 0 10px">文件里的配置本机都已经有了，没有导入新的。</p>' +
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
    '。' +
    (skipped.length ? '另有 ' + skipped.length + ' 份被跳过。' : '') +
    (res.settingsApplied ? '<br>「文件链接」的设置也一并恢复了。' : '') +
    '</p>' +
    (needLocal
      ? '<p class="rule-desc" style="margin:0 0 10px">' +
        '<b class="accent">导入不含本地路径</b>：换台电脑原路径多半不存在，所以配置文件里没有它。' +
        '下面的 <b>本地目录 ✗</b> 提示就是这么来的 —— 为这份配置在本机绑一个目录（' +
        '已有仓库用房「选择…」，想重新拉一份用「克隆到此处」），再点「验证并归档」即可。' +
        '</p>'
      : '') +
    '<div class="imp-report">' +
    (await renderAvailability(results)) +
    (skipped.length ? skipped.map(skipLine).join('') : '') +
    '</div>' +
    (needFix
      ? '<p class="rule-desc" style="margin:10px 0 0">修的方式：用标题右边的「归档配置」下拉切到那一份，' +
        '按上面的提示改「仓库信息 / 本地目录」，改完点「验证并归档」。' +
        '<span class="hint">Token 已经随配置文件一起导入，不用再手填；若某份确实没令牌，' +
        '说明导出时那份配置本身就没存。</span></p>'
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

  if (!owner || !repo) {
    warn('「仓库信息」还没填完：请填写用户名和仓库名');
    $('#cfgOwner').focus();
    return;
  }
  if (!typedToken && !(state.cfg && state.cfg.hasToken)) {
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

  const id = (state.cfg && state.cfg.activeProfileId) || '';
  if (!id) {
    err('没有可归档的配置，请先点「＋ 新建」');
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
    await save({ silent: true });
    const chk = await window.cloudpic.profile.check({ id: id });

    if (!chk.ok) {
      const wrap = document.createElement('div');
      wrap.innerHTML = renderSteps(chk) + '<br><span class="bad">三块里还有没通过的，先修好再归档。</span>';
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

/* ---------------------------------------------------------------- 水印颜色 */

/** 自绘选择器的句柄；开着的时候拖色板要实时同步给它 */
let wmPicker = null;
let autoSave = null;

/**
 * 色块 / 隐藏的原生色值输入 / hex 文本框三处同步。
 * `#cfgWmColor` 仍然是唯一的数据源（collect() 只读它），
 * 只是从「原生 type=color」换成了隐藏输入，弹层改由自绘选择器负责。
 */
function setWmColor(hex) {
  const norm = normalizeHex(hex) || '#1296db';
  const valueEl = $('#cfgWmColor');
  if (valueEl) valueEl.value = norm;
  const textEl = $('#wmColorText');
  if (textEl) textEl.value = norm;
  const sw = $('#wmSwatch');
  if (sw) sw.style.setProperty('--sw', norm);
  $$('#wmPresets .wm-pre').forEach((b) => b.classList.toggle('on', b.dataset.color === norm));
  if (wmPicker) wmPicker.setColor(norm);
  return norm;
}

function openWmPicker() {
  const sw = $('#wmSwatch');
  if (!sw) return;
  if (wmPicker) {
    closeColorPicker();
    wmPicker = null;
    return;
  }
  wmPicker = openColorPicker({
    anchor: sw,
    color: $('#cfgWmColor').value || '#1296db',
    presets: WM_PRESETS,
    onChange: (hex) => {
      setWmColor(hex);
      if (autoSave) autoSave();
    },
    onClose: () => {
      wmPicker = null;
    }
  });
}

function renderWmPresets() {
  const box = $('#wmPresets');
  if (!box) return;
  box.innerHTML = WM_PRESETS.map(
    (c) =>
      '<button type="button" class="wm-pre" data-color="' + c + '" title="' + c + '" style="--sw:' + c + '"></button>'
  ).join('');
}

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
      html += '<option value="" disabled>— ' + escapeHtml(g.group) + ' —</option>';
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
  const c = state.cfg || {};
  const plat = (c.platform || 'github') === 'cnb' ? 'cnb' : 'github';
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
  const hint = $('#platHint');
  if (hint) {
    hint.textContent = isCnb
      ? '正在编辑 CNB 的配置 · 左侧竖条为 CNB 主题色'
      : '正在编辑 GitHub 的配置 · 左侧竖条为 GitHub 主题色';
  }

  $('#tokenHelp').innerHTML = TOKEN_HELP[isCnb ? 'cnb' : 'github'];
  const api = $('#cfgApiBase');
  if (api) api.placeholder = isCnb ? 'https://api.cnb.cool' : 'https://api.github.com';
}

function fillLinkRules() {
  const c = state.cfg || {};
  const platform = c.platform || 'github';
  const rules = CPLinks.LINK_RULES.filter((r) => r.platforms.indexOf(platform) >= 0);
  const sel = $('#cfgLinkRule');
  const current = c.linkRule || 'auto';
  sel.innerHTML = rules.map((r) => '<option value="' + r.id + '">' + r.name + '</option>').join('');
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
    platform: c.platform,
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
      '留空的话，预览会直接请求仓库直链（GitHub raw 这类），国内经常加载不出来。' +
      '填上自己的 CDN 之后，预览和缩略图都会改走它。';
    return;
  }
  const base = CPLinks.normalizeBaseUrl(raw);
  const demo = CPLinks.buildProxyUrl({ proxyUrl: raw }, '111.avif');
  box.innerHTML =
    '预览将请求：<span class="accent">' + escapeHtml(demo) + '</span><br>' +
    '按「' + escapeHtml(base) + '/<仓库内相对路径>」拼接，例：仓库根目录的 111.avif → 上面那条。' +
    (/\{path\}/.test(raw) ? '（用了 {path} 占位）' : '');
}

function fill() {
  const c = state.cfg || {};
  const cmp = c.compress || {};
  const wm = c.watermark || {};
  const sync = c.sync || {};
  const ui = c.ui || {};

  fillPlatform();
  $('#cfgOwner').value = c.owner || '';
  $('#cfgRepo').value = c.repo || '';
  $('#cfgBranch').value = c.branch || 'main';
  $('#cfgApiBase').value = c.apiBase || '';
  $('#cfgToken').value = '';
  $('#cfgToken').placeholder = c.hasToken ? '已保存：' + (c.tokenMask || '********') + '（留空表示不修改）' : '粘贴 Token';
  $('#tokenHint').textContent = c.hasToken ? '（已配置）' : '（未配置）';

  $('#cfgLocalDir').value = c.localDir || '';
  $('#cfgAutoPull').checked = sync.autoPull !== false;
  $('#cfgSyncStrategy').value = sync.strategy || 'pull';

  $('#cfgCommitMessage').value = c.commitMessage || '';

  fillLinkRules();
  $('#cfgCustomDomain').value = c.customDomain || '';
  $('#cfgProxyUrl').value = c.proxyUrl || '';
  $('#cfgLinkFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
  $('#cfgLinkFormat').value = c.linkFormat || 'markdown';
  updateProxyDesc();

  // 外观（主题 / 字体）
  fillThemeCards();
  ensureFontOptions(ui.font || '');

  $('#cfgCompressEnabled').checked = cmp.enabled !== false;
  $('#cfgQuality').value = cmp.quality || 80;
  $('#cfgQualityVal').textContent = String(cmp.quality || 80);
  $('#cfgFormat').value = cmp.format || 'auto';
  $('#cfgMaxWidth').value = cmp.maxWidth || 0;
  $('#cfgMaxHeight').value = cmp.maxHeight || 0;
  $('#cfgTargetSize').value = cmp.targetSizeKB || 0;
  $('#cfgConcurrency').value = c.concurrency || 0;
  $('#cfgSkipSmaller').checked = cmp.skipIfSmaller !== false;
  $('#cfgSkipBelow').value = cmp.skipBelowKB || 0;

  $('#cfgWmEnabled').checked = !!wm.enabled;
  $('#cfgWmText').value = wm.text || '';
  $('#cfgWmPosition').value = wm.position || 'bottom-right';
  $('#cfgWmOpacity').value = Math.round((wm.opacity == null ? 0.35 : wm.opacity) * 100);
  $('#cfgWmOpacityVal').textContent = ((wm.opacity == null ? 0.35 : wm.opacity)).toFixed(2);
  $('#cfgWmFontSize').value = wm.fontSize || 22;
  setWmColor(wm.color || '#1296db');

  renderProfiles();
  updateLinkPreview();
  refreshGitStatus();
}

function collect() {
  const activePlatform = document.querySelector('#cfgPlatform button.active');
  const patch = {
    platform: activePlatform ? activePlatform.dataset.platform : 'github',
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
    concurrency: Number($('#cfgConcurrency').value) || 0,
    compress: {
      enabled: $('#cfgCompressEnabled').checked,
      quality: Number($('#cfgQuality').value),
      format: $('#cfgFormat').value,
      maxWidth: Number($('#cfgMaxWidth').value) || 0,
      maxHeight: Number($('#cfgMaxHeight').value) || 0,
      targetSizeKB: Number($('#cfgTargetSize').value) || 0,
      skipIfSmaller: $('#cfgSkipSmaller').checked,
      skipBelowKB: Number($('#cfgSkipBelow').value) || 0
    },
    watermark: {
      enabled: $('#cfgWmEnabled').checked,
      text: $('#cfgWmText').value,
      position: $('#cfgWmPosition').value,
      opacity: Number($('#cfgWmOpacity').value) / 100,
      fontSize: Number($('#cfgWmFontSize').value) || 22,
      color: $('#cfgWmColor').value
    },
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

async function save(opts) {
  const patch = collect();
  await state.patch(patch);
  tokenTouched = false;
  $('#cfgToken').value = '';
  fill();
  if (!(opts && opts.silent)) ok('设置已保存');
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
    wrap.innerHTML = lines + (res.ok ? '<br><br><span class="ok">一切正常，可以开始上传了。</span>' : '');
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
      b.onclick = () => switchToPlatform(plat);
    });

    renderWmPresets();
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
      const yes = await confirmDialog('清除 Token', '清除后需要重新填写才能上传 / 删除。', '清除');
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
      const yes = await confirmDialog('恢复默认设置', '将清空所有本机配置（含 Token）。仓库里的文件不受影响。', '恢复默认');
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

    const live = (sel, handler) => {
      const el = $(sel);
      if (!el) return;
      el.addEventListener('input', handler);
      el.addEventListener('change', handler);
    };

    live('#cfgQuality', () => {
      $('#cfgQualityVal').textContent = $('#cfgQuality').value;
    });
    live('#cfgWmOpacity', () => {
      $('#cfgWmOpacityVal').textContent = (Number($('#cfgWmOpacity').value) / 100).toFixed(2);
    });
    // 色块点开自绘选择器（原生 type=color 的系统面板和界面完全不搭）
    $('#wmSwatch').onclick = (e) => {
      e.preventDefault();
      openWmPicker();
    };
    // hex 文本框：随时输入随时生效，非法值不写回（等用户补全）
    const applyHex = () => {
      const norm = normalizeHex($('#wmColorText').value);
      if (!norm) return;
      setWmColor(norm);
      if (autoSave) autoSave();
    };
    $('#wmColorText').addEventListener('input', applyHex);
    $('#wmColorText').addEventListener('blur', () => {
      const norm = normalizeHex($('#wmColorText').value);
      setWmColor(norm || $('#cfgWmColor').value);
    });
    $('#wmPresets').addEventListener('click', (e) => {
      const b = e.target.closest('.wm-pre');
      if (!b) return;
      setWmColor(b.dataset.color);
      if (autoSave) autoSave();
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

    // 输入后自动保存（防抖），避免用户忘记点保存
    autoSave = debounce(() => {
      save({ silent: true }).catch(() => {});
    }, 1400);
    ['#cfgOwner', '#cfgRepo', '#cfgBranch', '#cfgCommitMessage', '#cfgProxyUrl'].forEach((s) => {
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
