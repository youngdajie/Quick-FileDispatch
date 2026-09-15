/** 设置页 */

import { $, $$, ok, err, warn, confirmDialog, modal, escapeHtml, debounce } from '../lib/dom.js';
import state from '../lib/state.js';

const CPLinks = window.CPLinks;
let tokenTouched = false;

/** 水印配色快捷项（#1296db 是默认） */
const WM_PRESETS = ['#1296db', '#ffffff', '#101722', '#ff4d4f', '#20c997', '#f5a623'];

const PLATFORM_NAME = { github: 'GitHub', gitee: 'Gitee' };

const TOKEN_HELP = {
  github:
    'GitHub 需要 <b>Personal Access Token</b>（经典版或细粒度均可），至少勾选 <b>repo</b>（读写仓库内容）。' +
    '申请地址：<a href="#" data-ext="https://github.com/settings/tokens/new?scopes=repo&description=JIE-Dispatch">github.com/settings/tokens</a>。' +
    'Token 只保存在本机，用 Windows 系统级加密（DPAPI）存储，代码不会把它写到任何地方。',
  gitee:
    'Gitee 需要 <b>私人令牌</b>，勾选 <b>projects</b>（仓库读写）权限。' +
    '申请地址：<a href="#" data-ext="https://gitee.com/profile/personal_access_tokens">gitee.com/profile/personal_access_tokens</a>。' +
    'Token 只保存在本机，用 Windows 系统级加密存储。'
};

/* ---------------------------------------------------------------- 归档配置 */

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
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

/**
 * 归档列表。排序：已归档在前（按验证时间倒序），待验证的沉底。
 * 面板只在「切平台 / 切配置 / 验证归档 / 删除 / 改名」后重建，
 * 不参与每次按键的刷新，免得正在填表时列表跳动。
 */
function renderProfiles() {
  const list = state.profiles.slice().sort((a, b) => {
    if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
    return (b.verifiedAt || b.createdAt || 0) - (a.verifiedAt || a.createdAt || 0);
  });
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
}

/** 新建一份空白配置（远端仓库 + 本地目录都清空，避免覆盖现有配置） */
async function newProfile() {
  const platform = (state.cfg && state.cfg.platform) || 'github';
  await state.newProfile({ platform: platform });
  ok('已新建一份空白配置，填好后点「验证并归档」');
}

async function useProfile(id) {
  await state.activateProfile(id);
  ok('已切换到该配置');
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
  const label = p.name || [p.owner, p.repo].filter(Boolean).join('/') || '这份配置';
  const yes = await confirmDialog(
    '删除配置',
    '将从本机移除「' + label + '」及其 Token。仓库里的文件不受影响。',
    '删除'
  );
  if (!yes) return;
  await state.removeProfile(id);
  ok('已删除');
}

/**
 * 验证并归档：先做「云端仓库 + 本地目录」的强制绑定校验，
 * 再跑一次真实连接测试，全部通过才把这份配置标记为可用。
 */
async function archiveProfile() {
  const owner = $('#cfgOwner').value.trim();
  const repo = $('#cfgRepo').value.trim();
  const dir = $('#cfgLocalDir').value.trim();
  if (!owner || !repo) {
    warn('请先填写用户名和仓库名');
    return;
  }
  if (!dir) {
    warn('云端仓库和本地目录是绑定的：请先在下面选择本地目录');
    $('#cfgLocalDir').focus();
    return;
  }
  const id = (state.cfg && state.cfg.activeProfileId) || '';
  if (!id) {
    err('没有可归档的配置，请先点「新建配置」');
    return;
  }

  const btn = $('#btnProfArchive');
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '验证中…';
  try {
    await save({ silent: true });
    const res = await window.cloudpic.cloud.verify();
    const lines = (res.steps || [])
      .map((s) => (s.ok ? '<span class="ok">✓</span> ' : '<span class="bad">✗</span> ') + escapeHtml(s.name) + '：' + escapeHtml(s.message))
      .join('<br>');

    if (!res.ok) {
      const wrap = document.createElement('div');
      wrap.innerHTML = lines + '<br><br><span class="bad">验证没通过，先修好再归档。</span>';
      modal({ title: '验证未通过', node: wrap, buttons: [{ label: '好', primary: true }] });
      return;
    }

    await state.verifyProfile(id, {
      userName: (res.user && (res.user.name || res.user.login)) || '',
      repo: res.repo || null
    });
    ok('已验证可用，已归档：' + owner + '/' + repo);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = old;
    renderProfiles();
  }
}

/* ---------------------------------------------------------------- 水印颜色 */

/** #abc -> #aabbcc；非法值返回空串 */
function normalizeHex(s) {
  let t = String(s || '').trim();
  if (!t) return '';
  if (t[0] !== '#') t = '#' + t;
  if (/^#[0-9a-fA-F]{3}$/.test(t)) return ('#' + t[1] + t[1] + t[2] + t[2] + t[3] + t[3]).toLowerCase();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toLowerCase();
  return '';
}

/**
 * 色块 / 原生 color / hex 文本框三处同步。
 * 原生 color 始终持有「最后一个合法值」，collect() 只读它，
 * 所以用户在 hex 框里敲到一半的非法值不会污染配置。
 */
function setWmColor(hex) {
  const norm = normalizeHex(hex) || '#1296db';
  $('#cfgWmColor').value = norm;
  $('#wmColorText').value = norm;
  const sw = $('#wmSwatch');
  if (sw) sw.style.setProperty('--sw', norm);
  $$('#wmPresets .wm-pre').forEach((b) => b.classList.toggle('on', b.dataset.color === norm));
  return norm;
}

function renderWmPresets() {
  const box = $('#wmPresets');
  if (!box) return;
  box.innerHTML = WM_PRESETS.map(
    (c) =>
      '<button type="button" class="wm-pre" data-color="' + c + '" title="' + c + '" style="--sw:' + c + '"></button>'
  ).join('');
}

/* ---------------------------------------------------------------- 填充 */

function fillPlatform() {
  const c = state.cfg || {};
  const isGitee = (c.platform || 'github') === 'gitee';
  document.querySelectorAll('#cfgPlatform button').forEach((b) => {
    b.classList.toggle('active', b.dataset.platform === (c.platform || 'github'));
  });
  $('#tokenHelp').innerHTML = TOKEN_HELP[isGitee ? 'gitee' : 'github'];
  const api = $('#cfgApiBase');
  if (api) api.placeholder = isGitee ? 'https://gitee.com/api/v5' : 'https://api.github.com';
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

  $('#cfgPathTemplate').value = c.pathTemplate || '';
  $('#cfgCommitMessage').value = c.commitMessage || '';

  fillLinkRules();
  $('#cfgCustomDomain').value = c.customDomain || '';
  $('#cfgProxyUrl').value = c.proxyUrl || '';
  $('#cfgLinkFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
  $('#cfgLinkFormat').value = c.linkFormat || 'markdown';
  updateProxyDesc();

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
    pathTemplate: $('#cfgPathTemplate').value,
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
    const { modal } = await import('../lib/dom.js');
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
    renderWmPresets();
    fill();

    document.querySelectorAll('#cfgPlatform button').forEach((b) => {
      b.onclick = async () => {
        const platform = b.dataset.platform;
        const cur = (state.cfg && state.cfg.platform) || 'github';
        if (platform === cur) {
          fillPlatform();
          return;
        }
        try {
          // 先把当前表单落盘，免得切走丢数据（不弹提示，避免噪音）
          await save({ silent: true });
          const target = state.profileFor(platform);
          if (target) {
            // 该平台已有配置：整份切过去，下面的字段会随之整体刷新
            await state.activateProfile(target.id);
            ok('已切到 ' + PLATFORM_NAME[platform] + ' 的配置：' + target.label);
          } else {
            // 还没有该平台的配置：开一份空白配置当落点，表单随之清空
            await state.newProfile({ platform: platform });
            warn('还没有 ' + PLATFORM_NAME[platform] + ' 的配置，已开一份空白的，填好后点「验证并归档」');
          }
        } catch (e) {
          err(e.message || String(e));
          fillPlatform();
        }
      };
    });

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
    $('#btnProfNew').onclick = newProfile;
    $('#btnProfArchive').onclick = archiveProfile;

    // 归档列表：切换 / 改名 / 删除
    $('#profileList').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-act]');
      const row = e.target.closest('.pf-row');
      if (!row) return;
      const id = row.dataset.id;
      if (!btn) {
        if (!row.classList.contains('active')) useProfile(id);
        return;
      }
      const act = btn.dataset.act;
      if (act === 'use') useProfile(id);
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
    live('#cfgWmColor', () => {
      setWmColor($('#cfgWmColor').value);
    });
    // hex 文本框：随时输入随时生效，非法值不写回（等用户补全）
    const applyHex = () => {
      const norm = normalizeHex($('#wmColorText').value);
      if (!norm) return;
      setWmColor(norm);
      autoSave();
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
      autoSave();
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
    const autoSave = debounce(() => {
      save({ silent: true }).catch(() => {});
    }, 1400);
    ['#cfgOwner', '#cfgRepo', '#cfgBranch', '#cfgPathTemplate', '#cfgCommitMessage', '#cfgProxyUrl', '#cfgWmColor'].forEach((s) => {
      const el = $(s);
      el.addEventListener('change', autoSave);
    });
  },

  onEnter() {
    fill();
  },

  onConfigChanged() {
    fill();
  }
};
