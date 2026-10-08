/**
 * 设置页
 *
 * 2026-09-25 起「配置」不再常驻表单：仓库信息 / 本地目录 / 文件链接三块
 * 全部搬进弹窗向导（lib/config-wizard.js）。这一页只留四件事：
 *   ① 新建配置的入口（平台选择 + 向导）
 *   ② 全部配置的卡片列表（点卡片切生效，点「修改」进向导）
 *   ③ 全局设置：提交信息、外观（主题 / 字体 / 背景图 / 毛玻璃）
 *   ④ 危险操作
 *
 * 之所以砍掉常驻表单：它必须带一个「当前编辑的是哪一份」的状态，
 * 而那个状态和「当前生效的是哪一份」是两件事，二者一混，用户就会觉得
 * 「我只是点了一下卡片，表单怎么变了」。
 */

import { $, ok, err, warn, confirmDialog, modal, escapeHtml, debounce } from '../lib/dom.js';
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
import { brandIcon, BRAND_TILE } from '../lib/brandicons.js';
import { openConfigWizard } from '../lib/config-wizard.js';
import { analyzeImage, computeAdaptive } from '../lib/glass-adaptive.js';
// git-lfs 安装进度走 SSE（与上传进度同一条流，靠 task 字段区分）
import { openProgressStream } from '../lib/progress.js';

const CPLinks = window.CPLinks;

const PLATFORM_NAME = { github: 'GitHub', cnb: 'CNB' };

const platOf = (v) => (v === 'cnb' ? 'cnb' : 'github');
const activeProfileId = () => (state.cfg && state.cfg.activeProfileId) || '';

const profileLabel = (p) =>
  p.name || [p.owner, p.repo].filter(Boolean).join('/') || '未命名配置';

const platLabel = (p) =>
  !p ? '这份配置' : profileLabel(p) + '（' + (PLATFORM_NAME[platOf(p.platform)] || 'GitHub') + '）';

function fmtDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------------------------------------------------------------- 全部配置 */

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
  const plat = PLATFORM_NAME[platOf(p.platform)] || 'GitHub';
  const bits = [];
  if (p.verified) {
    bits.push('<span class="pf-badge ok">已归档</span>');
    if (p.repoInfo && p.repoInfo.private) bits.push('<span class="pf-badge">私有</span>');
    if (p.verifiedAt) bits.push('<span class="pf-sub">' + fmtDate(p.verifiedAt) + ' 验证</span>');
  } else {
    bits.push('<span class="pf-badge warn">待验证</span>');
  }
  if (!p.hasToken) bits.push('<span class="pf-badge danger">无 Token</span>');

  const ruleId = p.linkRule || 'auto';
  const rule = CPLinks.LINK_RULES.find((r) => r.id === ruleId);
  const ruleText =
    ruleId === 'auto'
      ? '链接：自动（' + (platOf(p.platform) === 'cnb' ? 'CNB 国内 CDN' : 'jsDelivr CDN') + '）'
      : '链接：' + ((rule && rule.name) || ruleId);

  const cloudVal = p.owner && p.repo ? p.owner + '/' + p.repo : '';
  const localVal = p.localDir || '';
  const cloudTitle = cloudVal || '未填写仓库';
  const localTitle = localVal || '未绑定本地目录';

  /* 正方形卡片：①左上角「当前」角标（选中时）②平台 ③「云端 ↕ 本地」小图
     ④别名 ⑤状态徽章行 ⑥链接规则 ⑦操作按钮沉底
     角标单独拎到 .pf-row 的直接子级：它要绝对定位贴左上角，
     留在 .pf-top 里就得跟着那行的居中和间距走 */
  return (
    '<div class="pf-row' + (p.isActive ? ' active' : '') + '" data-id="' + escapeHtml(p.id) + '">' +
    (p.isActive ? '<span class="pf-cur">当前</span>' : '') +
    '<div class="pf-top">' +
    '<span class="pf-platform pf-' + escapeHtml(p.platform || 'github') + '">' + plat + '</span>' +
    '</div>' +
    '<div class="pf-cd">' +
    '<div class="pf-cd-row' + (cloudVal ? '' : ' bad') + '">' +
    '<span class="pf-cd-ico cloud">' + CD_ICON.cloud + '</span>' +
    '<span class="pf-cd-label" title="' + escapeHtml(cloudTitle) + '">云端</span>' +
    '</div>' +
    '<div class="pf-cd-link">' + CD_ICON.swap + '</div>' +
    '<div class="pf-cd-row' + (localVal ? '' : ' bad') + '">' +
    '<span class="pf-cd-ico local">' + CD_ICON.monitor + '</span>' +
    '<span class="pf-cd-label" title="' + escapeHtml(localTitle) + '">本地</span>' +
    '</div>' +
    '</div>' +
    (p.name ? '<div class="pf-alias">' + escapeHtml(p.name) + '</div>' : '') +
    '<div class="pf-meta">' +
    '<div class="pf-badges">' + bits.join('') + '</div>' +
    '<span class="pf-rule">' + escapeHtml(ruleText) + '</span>' +
    '</div>' +
    '<div class="pf-ops">' +
    '<button type="button" class="btn btn-ghost btn-sm" data-act="edit" title="打开向导修改这份配置">修改</button>' +
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

function renderProfiles() {
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
}

/**
 * 点卡片本体 = 换「整程序在用哪一份」。现在没有常驻表单了，
 * 这个动作不会碰任何输入框；要改内容点卡片底部的「修改」。
 */
async function switchToProfile(id) {
  const target = state.profiles.find((x) => x.id === id);
  if (!target) return;
  if (target.id === activeProfileId()) return;
  try {
    await state.activateProfile(id);
    ok('已切换到「' + platLabel(target) + '」');
  } catch (e) {
    err(e.message || String(e));
  }
}

function editProfile(id) {
  const p = state.profiles.find((x) => x.id === id);
  if (!p) return;
  openConfigWizard({ profile: p, onDone: renderProfiles });
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
    '将从本机移除「' + profileLabel(p) + '」及其 Token 仓库里的文件不受影响',
    '删除'
  );
  if (!yes) return;
  await state.removeProfile(id);
  ok('已删除');
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
      '<b class="accent">访问令牌（明文）</b>，以及<b>每份配置各自的链接规则、自定义域名和默认复制格式</b></p>' +
      '<p class="hint" style="margin:0 0 10px"><b>本地目录不会写入</b> —— 换台电脑原路径多半不存在，' +
      '导入后程序会引导你为本机重新绑定目录</p>' +
      '<p class="rule-desc" style="margin:0">本次共 ' + count + ' 份配置，其中 ' + withToken + ' 份带令牌' +
      '这个文件等于一把钥匙，请只放在你自己的机器或加密盘里，别发到群聊和公开仓库</p>';
    modal({
      title: '导出配置',
      node: wrap,
      buttons: [
        { label: '取消', onClick: () => resolve(false) },
        {
          label: '选个位置导出',
          primary: true,
          onClick: () => {
            resolve(true);
            return true;
          }
        }
      ]
    });
  });
}

async function exportProfiles() {
  const list = state.profiles.filter((p) => p.owner && p.repo);
  if (!list.length) {
    warn('还没有可导出的配置');
    return;
  }
  const withToken = list.filter((p) => p.hasToken !== false).length;
  if (!(await confirmExport(list.length, withToken))) return;
  try {
    const r = await state.exportProfiles();
    if (r && r.canceled) return;
    if (r && r.ok) ok('已导出 ' + list.length + ' 份配置');
    else warn('导出没有完成');
  } catch (e) {
    err(e.message || String(e));
  }
}

async function importProfiles() {
  try {
    const res = await state.importProfiles();
    if (!res || res.canceled) return;
    if (!res.ok) {
      err(res.message || '导入失败');
      return;
    }
    const wrap = document.createElement('div');
    wrap.innerHTML =
      (res.added && res.added.length
        ? '<p class="hint" style="margin:0 0 10px">已导入 <b>' + res.added.length + '</b> 份配置（本地目录需要在本机重新绑定）</p>'
        : '<p class="hint" style="margin:0 0 10px">没有导入新的配置</p>') +
      (res.skipped && res.skipped.length
        ? '<p class="hint" style="margin:12px 0 6px">跳过 ' + res.skipped.length + ' 份：</p>' + res.skipped.map(skipLine).join('')
        : '');
    modal({ title: '导入结果', node: wrap, buttons: [{ label: '好', primary: true }] });
    renderProfiles();
  } catch (e) {
    err(e.message || String(e));
  }
}

/* ---------------------------------------------------------------- 外观 */

let autoSave = null;

async function fillBgPreview() {
  const box = $('#bgPreview');
  if (!box) return;
  const img = (state.cfg && state.cfg.ui && state.cfg.ui.bgImage) || '';
  if (!img) {
    box.classList.add('empty');
    box.style.backgroundImage = '';
    return;
  }
  box.classList.remove('empty');
  try {
    box.style.backgroundImage = 'url("' + window.cloudpic.localUrl(img) + '")';
  } catch (e) {
    box.style.backgroundImage = '';
    box.classList.add('empty');
  }
}

/**
 * 选 / 清背景图后必须 `state.refresh()` 一把：
 * 这两个接口直接改了配置目录里的文件，返回的虽是整份配置，但**渲染层的 state 还是旧的**
 * → 不刷新的话毛玻璃那层 `--glass-img` 不会重算，看着就是「设了没反应」。
 * refresh 会 emit，app.js 的 state.on 里接着跑 applyAppearance（主题 / 字体 / 毛玻璃）。
 */
async function pickBgImage() {
  try {
    // 选图 / 清除在 app 命名空间下（web/bridge.js），不是 config
    const r = await window.cloudpic.app.chooseBgImage();
    if (!r || r.canceled) return; // 取消是正常结果
    await state.refresh();
    await fillBgPreview();
    ok('背景图已设置（浅色模式下生效）');
  } catch (e) {
    err(e.message || String(e));
  }
}

async function clearBgImage() {
  try {
    await window.cloudpic.app.clearBgImage();
    await state.refresh();
    await fillBgPreview();
    ok('已清除背景图');
  } catch (e) {
    err(e.message || String(e));
  }
}

/** 滑块是 0.1 一档：取一位小数（避免 12.300000000000001 这种浮点噪声），
 *  显示时整数不带小数点 —— 12 而不是 12.0 */
function round1(n) {
  return Math.round((Number(n) || 0) * 10) / 10;
}
function fmtBlur(n) {
  return String(Math.round(Number(n) || 0));
}

/** 面板不透明度落盘（防抖：拖动过程中别每帧都写一次配置） */
const saveBlur = debounce(() => {
  const v = Math.round(Number($('#cfgBgBlur').value) || 0);
  state.patch({ ui: { bgBlur: v } }).catch((e) => err(e.message || String(e)));
}, 260);

function currentTheme() {
  return (state.cfg && state.cfg.ui && state.cfg.ui.theme) || 'dark';
}

function fillThemeCards() {
  const cur = currentTheme();
  document.querySelectorAll('.theme-card').forEach((c) => {
    c.classList.toggle('active', c.dataset.theme === cur);
  });
}

let fontsBuilt = false;

/** 字体下拉：只列本机真装了的（枚举一次就够，之后靠缓存） */
function ensureFontOptions(cur) {
  const sel = $('#cfgFont');
  if (!sel) return;
  if (!fontsBuilt) {
    const groups = installedFontGroups();
    let html = '';
    groups.forEach((g) => {
      if (!g.fonts.length) return;
      html += '<optgroup label="' + escapeHtml(g.name) + '">';
      g.fonts.forEach((f) => {
        html += '<option value="' + escapeHtml(f) + '">' + escapeHtml(f) + '</option>';
      });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
    fontsBuilt = true;
    const cnt = $('#fontCount');
    if (cnt) {
      const n = installFontCount();
      cnt.textContent = n ? '本机已装 ' + n + ' 个可用字体' : '本机装了哪些就列哪些';
    }
  }
  const has = Array.from(sel.options).some((o) => o.value === cur);
  sel.value = has ? cur : PRIMARY_FONT_NAME;
}

async function setTheme(theme) {
  await state.patch({ ui: { theme: theme } });
  // applyTheme 收的是主题名（'dark' / 'light'），不是整个 cfg ——
  // 早先传了整个对象，indexOf 匹配不上就一路回落 dark，看着就是「点了没反应」
  applyTheme((state.cfg && state.cfg.ui && state.cfg.ui.theme) || theme);
  fillThemeCards();
}

async function setFont(font) {
  await state.patch({ ui: { font: font } });
  applyFont(font);
}

/** 全局项：改动即存（提交信息、网络代理） */
function globalAutoSave() {
  const patch = {};
  const msg = $('#cfgCommitMessage');
  if (msg) {
    const v = msg.value.trim();
    if (v !== (state.cfg.commitMessage || '')) patch.commitMessage = v;
  }
  const proxy = $('#cfgProxy');
  if (proxy) {
    const v = proxy.value.trim();
    if (v !== (state.cfg.proxyUrl || '')) patch.proxyUrl = v;
  }
  if (Object.keys(patch).length) {
    state.patch(patch).catch((e) => err(e.message || String(e)));
  }
}

/** 把「不随配置变」的控件同步一遍 */
function fillGlobal() {
  const c = state.cfg || {};
  const ui = c.ui || {};
  fillThemeCards();
  ensureFontOptions(ui.font || PRIMARY_FONT_NAME);
  const msg = $('#cfgCommitMessage');
  if (msg) msg.value = c.commitMessage || '';
  // 代理：正在输入时别回写，否则光标会跳到末尾
  const proxy = $('#cfgProxy');
  if (proxy && document.activeElement !== proxy) proxy.value = c.proxyUrl || '';
  // 0-100 的「面板不透明度」（老配置的 0-24 强度值由 store 那边迁移过）
  const blur = ui.bgBlur == null ? 50 : Number(ui.bgBlur);
  const slider = $('#cfgBgBlur');
  if (slider) slider.value = blur;
  const blurVal = $('#cfgBgBlurVal');
  if (blurVal) blurVal.textContent = fmtBlur(blur);
  fillBgPreview();
}

/* ---------------- 智能调整（adaptive glass） ----------------
   用户主动触发：拿当前 bgImage，调算法，把推荐值显示在按钮下方。
   完全不改现状 —— 必须用户再点「应用」才落盘。 */

const BIAS_NAME = { warm: '暖', cool: '冷', green: '绿', neutral: '中性' };

/** 分析当前背景图 + 显示推荐值 */
async function runAdaptive() {
  const hint = $('#cfgAdaptiveHint');
  const result = $('#adaptiveResult');
  hint.textContent = '分析中…';
  result.hidden = true;

  const img = (state.cfg && state.cfg.ui && state.cfg.ui.bgImage) || '';
  if (!img) {
    hint.textContent = '还没选背景图，先「选择图片…」';
    return;
  }
  // 用主进程代理 URL 加载（私有目录 /__local 才能读）
  const url = window.cloudpic.localUrl(img);
  const image = new Image();
  image.crossOrigin = 'anonymous';
  image.onload = () => {
    const a = analyzeImage(image);
    const p = computeAdaptive(a);
    $('#arLum').textContent = a.lum.toFixed(2);
    $('#arSat').textContent = a.sat.toFixed(2);
    $('#arContrast').textContent = a.contrast.toFixed(2);
    $('#arBias').textContent = BIAS_NAME[a.colorBias] || a.colorBias;
    $('#arBlur').textContent = p.blur + 'px';
    $('#arWeight').textContent = String(p.fontWeight);
    hint.textContent = '分析完成';
    result.hidden = false;
    $('#adaptiveOk').textContent = '';
    // 暂存到 dataset，apply 时读
    result.dataset.recommendedBlur = String(p.blur);
  };
  image.onerror = () => {
    hint.textContent = '加载图片失败，请检查图片是否还在原位置';
    result.hidden = true;
  };
  image.src = url;
}

/** 应用推荐 blur：动滑块 + 触发现有 onBlur（落盘 + 重算玻璃） */
async function applyAdaptiveBlur() {
  const result = $('#adaptiveResult');
  const recommended = result.dataset.recommendedBlur;
  if (!recommended) return;
  const v = Number(recommended);
  const slider = $('#cfgBgBlur');
  const valEl = $('#cfgBgBlurVal');
  if (slider) {
    slider.value = v;
    // 触发现有 input 事件 → onBlur → applyGlass + saveBlur
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (valEl) valEl.textContent = fmtBlur(v);
  $('#adaptiveOk').textContent = '已应用，再拖滑块可继续微调';
}

/* ---------------- git-lfs 状态与安装 ---------------- */

/**
 * 刷新 git-lfs 状态。
 *
 * 查询**不触发下载**（后端只是看本地有没有），所以可以在页面初始化时
 * 顺手调一次 —— 不会因为用户打开设置页就产生 6MB 流量。
 */
async function refreshLfsStatus() {
  const dot = $('#lfsDot');
  const text = $('#lfsText');
  const btn = $('#btnLfsInstall');
  if (!text) return;
  try {
    const st = await window.cloudpic.app.lfsStatus();
    if (st && st.available) {
      dot.className = 'lfs-dot ok';
      const ver = st.version ? ' v' + st.version : '';
      const from = st.managed ? '程序安装' : '系统已有';
      text.textContent = '已就绪' + ver + ' · ' + from;
      btn.hidden = true;
    } else {
      dot.className = 'lfs-dot bad';
      text.textContent = '未安装 —— 上传时勾选 LFS 会自动装，也可以现在装';
      btn.hidden = false;
    }
  } catch (e) {
    dot.className = 'lfs-dot bad';
    text.textContent = '状态检查失败：' + (e.message || String(e));
    btn.hidden = false;
  }
}

/**
 * 安装 git-lfs。
 *
 * 安装过程要下 6MB，必须有反馈 —— 进度从 /ipc/events 的 SSE 流来
 * （事件 task 为 lfs-install）。这里只订阅、不改别的。
 */
async function installLfs() {
  const dot = $('#lfsDot');
  const text = $('#lfsText');
  const btn = $('#btnLfsInstall');
  if (btn) btn.disabled = true;
  if (dot) dot.className = 'lfs-dot busy';
  if (text) text.textContent = '正在安装…';

  const stop = openProgressStream((ev) => {
    if (ev && ev.task === 'lfs-install' && ev.message && text) {
      text.textContent = ev.message;
    }
  });

  try {
    await window.cloudpic.app.lfsInstall();
    ok('git-lfs 安装完成');
    await refreshLfsStatus();
  } catch (e) {
    err(e.message || String(e));
    await refreshLfsStatus();
  } finally {
    stop();
    if (btn) btn.disabled = false;
  }
}

/* ---------------------------------------------------------------- 页面 */

export default {
  init() {
    // 平台展示：官方 SVG + 各自品牌色。这两个平台是「程序支持什么」，
    // 不是一个开关 —— 选哪个平台是新建向导第一步的事
    const brand = $('#platBrand');
    if (brand) {
      brand.innerHTML = ['github', 'cnb']
        .map(
          (id) =>
            '<span class="plat-brand-item">' +
            '<span class="plat-brand-ico" style="background:' + BRAND_TILE[id] + '">' + brandIcon(id, 20) + '</span>' +
            escapeHtml(PLATFORM_NAME[id]) +
            '</span>'
        )
        .join('<span class="plat-brand-x">×</span>');
    }

    $('#btnProfNew').onclick = () => {
      openConfigWizard({ platform: platOf((state.cfg || {}).platform), onDone: renderProfiles });
    };
    $('#btnProfExport').onclick = exportProfiles;
    $('#btnProfImport').onclick = importProfiles;

    // 全部配置：点卡片切生效；底部按钮 = 进向导 / 改名 / 删除
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
      if (act === 'edit') editProfile(id);
      else if (act === 'rename') renameProfile(id);
      else if (act === 'del') removeProfile(id);
    });

    // 提交信息（全局项，改动即存）
    autoSave = debounce(globalAutoSave, 500);
    $('#cfgCommitMessage').addEventListener('input', autoSave);
    $('#cfgProxy').addEventListener('input', autoSave);

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

    // 外观：智能调整背景图参数
    $('#btnBgAdaptive').onclick = runAdaptive;
    $('#btnApplyBlur').onclick = applyAdaptiveBlur;

    // git-lfs：状态查询 + 一键安装
    const lfsBtn = $('#btnLfsInstall');
    if (lfsBtn) lfsBtn.onclick = installLfs;
    refreshLfsStatus();

    // 外观：毛玻璃强度。拖动时本地立刻重算整套玻璃状态，不等落盘往返
    const blurInput = $('#cfgBgBlur');
    const onBlur = () => {
      const v = round1(Number(blurInput.value) || 0);
      const valEl = $('#cfgBgBlurVal');
      if (valEl) valEl.textContent = fmtBlur(v);
      applyGlass({ ui: Object.assign({}, (state.cfg && state.cfg.ui) || {}, { bgBlur: v }) });
      saveBlur();
    };
    blurInput.addEventListener('input', onBlur);
    blurInput.addEventListener('change', onBlur);

    // 危险操作：恢复默认设置
    $('#btnResetConfig').onclick = async () => {
      const yes = await confirmDialog(
        '恢复默认设置',
        '会清掉主题、字体、背景图与全局参数（归档的配置和 Token 保留）',
        '恢复默认'
      );
      if (!yes) return;
      try {
        await window.cloudpic.config.reset();
        await state.refresh();
        fillGlobal();
        renderProfiles();
        ok('已恢复默认设置');
        window.dispatchEvent(new CustomEvent('cloudpic:changed'));
      } catch (e) {
        err(e.message || String(e));
      }
    };
  },

  onEnter() {
    fillGlobal();
    renderProfiles();
  },

  onConfigChanged() {
    fillGlobal();
    renderProfiles();
  }
};
