/**
 * 设置页
 *
 * 2026-09-25 起「配置」不再常驻表单：仓库信息 / 本地目录 / 文件链接三块
 * 全部搬进弹窗向导（lib/config-wizard.js）。这一页只留四件事：
 *   ① 新建配置的入口（平台选择 + 向导）
 *   ② 全部配置的卡片列表（点卡片切生效，点「修改」进向导）
 *   ③ 全局设置：提交信息、外观（主题 / 字体）
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
  stackFor,
  installedFontGroups,
  installFontCount,
  PRIMARY_FONT_NAME
} from '../lib/appearance.js';
import { brandIcon, BRAND_TILE } from '../lib/brandicons.js';
import { openConfigWizard } from '../lib/config-wizard.js';
// git-lfs 安装进度走 SSE（与上传进度同一条流，靠 task 字段区分）
import { openProgressStream } from '../lib/progress.js';

const CPLinks = window.CPLinks;

const PLATFORM_NAME = { github: 'GitHub', cnb: 'CNB' };

const platOf = (v) => (v === 'cnb' ? 'cnb' : 'github');
const activeProfileId = () => (state.cfg && state.cfg.activeProfileId) || '';

// Profile rows contain their own entrance animation. Keep the rendered list
// stable for theme and active-profile changes so that animation does not replay.
let renderedProfileSignature = null;

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
    '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14"/><path d="m15.5 5 3 3-3 3"/><path d="M19 16H5"/><path d="m8.5 13-3 3 3 3"/></svg>',
  edit:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  rename:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M4 17h16M4 12h6"/><path d="m16 5 4 4-4 4"/></svg>',
  del:
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>'
};

function profileRow(p) {
  const plat = PLATFORM_NAME[platOf(p.platform)] || 'GitHub';
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
  const detailTitle = [
    p.verified ? '已归档' : '待验证',
    p.repoInfo && p.repoInfo.private ? '私有仓库' : '',
    p.hasToken ? 'Token 已配置' : '缺少 Token',
    p.verifiedAt ? fmtDate(p.verifiedAt) + ' 验证' : '',
    ruleText
  ].filter(Boolean).join(' · ');
  const status = !p.hasToken
    ? { cls: 'danger', text: '缺少 Token' }
    : p.verified
      ? { cls: 'ok', text: '已验证' }
      : { cls: 'warn', text: '待验证' };

  /* 密集配置条：名称和平台优先，仓库 / 目录路径及次要状态通过 title 按需查看。 */
  return (
    '<div class="pf-row' + (p.isActive ? ' active' : '') + '" data-id="' + escapeHtml(p.id) + '">' +
    '<span class="pf-brand" style="--pf-brand-color:' + BRAND_TILE[platOf(p.platform)] + '" aria-hidden="true">' + brandIcon(platOf(p.platform), 15) + '</span>' +
    '<div class="pf-top">' +
    '<span class="pf-alias" title="' + escapeHtml(profileLabel(p)) + '">' + escapeHtml(profileLabel(p)) + '</span>' +
    '<span class="pf-state ' + status.cls + '" title="' + escapeHtml(detailTitle) + '"><i aria-hidden="true"></i>' + status.text + '</span>' +
    '<span class="pf-platform pf-' + escapeHtml(p.platform || 'github') + '">' + plat + '</span>' +
    '</div>' +
    '<div class="pf-cd">' +
    '<div class="pf-cd-row' + (cloudVal ? '' : ' bad') + '" title="' + escapeHtml(cloudTitle) + '">' +
    '<span class="pf-cd-ico cloud">' + CD_ICON.cloud + '</span>' +
    '<span class="pf-cd-label">云端</span>' +
    '</div>' +
    '<div class="pf-cd-link">' + CD_ICON.swap + '</div>' +
    '<div class="pf-cd-row' + (localVal ? '' : ' bad') + '" title="' + escapeHtml(localTitle) + '">' +
    '<span class="pf-cd-ico local">' + CD_ICON.monitor + '</span>' +
    '<span class="pf-cd-label">本地</span>' +
    '</div>' +
    '</div>' +
    '<div class="pf-ops">' +
    '<button type="button" class="pf-op" data-act="edit" aria-label="修改配置" title="修改配置">' + CD_ICON.edit + '</button>' +
    '<button type="button" class="pf-op" data-act="rename" aria-label="重命名配置" title="重命名配置">' + CD_ICON.rename + '</button>' +
    '<button type="button" class="pf-op danger" data-act="del" aria-label="删除配置" title="删除配置">' + CD_ICON.del + '</button>' +
    '</div>' +
    '</div>'
  );
}

function sortProfiles(a, b) {
  if (!!a.verified !== !!b.verified) return a.verified ? -1 : 1;
  return (b.verifiedAt || b.createdAt || 0) - (a.verifiedAt || a.createdAt || 0);
}

function profileSignature(list) {
  return JSON.stringify(list.map((p) => [
    p.id,
    p.platform,
    p.owner,
    p.repo,
    p.localDir,
    p.name,
    p.verified,
    p.repoInfo && p.repoInfo.private,
    p.verifiedAt,
    p.hasToken,
    p.linkRule
  ]));
}

function syncActiveProfileRows(box) {
  const activeId = activeProfileId();
  box.querySelectorAll('.pf-row').forEach((row) => {
    const active = row.dataset.id === activeId;
    row.classList.toggle('active', active);
  });
}

function renderProfiles() {
  const list = state.archivedProfiles.slice().sort(sortProfiles);
  const box = $('#profileList');
  const empty = $('#profileEmpty');
  const count = $('#profCount');
  if (!box) return;
  const signature = profileSignature(list);
  if (signature !== renderedProfileSignature) {
    box.innerHTML = list.map(profileRow).join('');
    renderedProfileSignature = signature;
  }
  syncActiveProfileRows(box);
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

function currentTheme() {
  const ui = (state.cfg && state.cfg.ui) || {};
  return ui.theme === 'dark' || ui.theme === 'system' ? ui.theme : 'light';
}

/**
 * 主题卡片的选中态。
 *
 * 类名统一用 .on（CSS 里写的就是 .theme-card.on）；这里以前写成 .active，
 * 结果选中态一直是隐形的 —— 用户只能靠页面颜色猜自己选的哪一项。
 */
function fillThemeCards() {
  const cur = currentTheme();
  document.querySelectorAll('.theme-card').forEach((c) => {
    c.classList.toggle('on', c.dataset.theme === cur);
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
    // 只落「能解析成地址」的值：填到一半的 socks5://、127.0.0.1 写进去就是一个
    // 连不上的代理，用户下次打开还会以为是程序把值改坏了
    if (v !== (state.cfg.proxyUrl || '') && normalizeProxy(v) !== null) patch.proxyUrl = v;
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
  syncProxyAction();
}

/* ---------------- 网络代理 ----------------
   两个按钮合一：输入框空着就「扫描」，填了东西就「保存」。
   扫描走主进程（internal/netproxy.Detect）：先看一眼 Windows 系统代理，
   没开再去常见端口上问一句「你是 HTTP 还是 SOCKS5 代理」——
   用户不用自己去翻 Clash 面板抄端口。 */

const PROXY_SCHEMES = ['http', 'https', 'socks5', 'socks5h'];

/** 往输入框里填的规范值：带协议、只留 host:port。填错了返回 null */
function normalizeProxy(raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (v.indexOf('://') < 0) v = 'http://' + v; // Clash 面板上显示的就是 127.0.0.1:7890
  try {
    const u = new URL(v);
    const scheme = u.protocol.replace(':', '').toLowerCase();
    if (PROXY_SCHEMES.indexOf(scheme) < 0) return null;
    if (!u.hostname || !u.port) return null; // 没端口基本都是填错了
    return scheme + '://' + u.host;
  } catch (e) {
    return null;
  }
}

/** 按钮文字跟着输入框走：空 = 扫描，有值 = 保存 */
function syncProxyAction() {
  const input = $('#cfgProxy');
  const btn = $('#btnProxyAct');
  if (!input || !btn) return;
  const filled = !!input.value.trim();
  btn.textContent = filled ? '保存' : '扫描';
  btn.title = filled ? '保存代理地址' : '扫描本机正在运行的代理';
}

async function saveProxy(raw, quiet) {
  const v = normalizeProxy(raw);
  if (v === null) {
    warn('代理地址要带端口，如 127.0.0.1:7890 或 socks5://127.0.0.1:7891');
    return false;
  }
  const input = $('#cfgProxy');
  if (v === (state.cfg.proxyUrl || '')) {
    if (input) input.value = v;
    if (!quiet) ok('代理地址没有变化');
    return true;
  }
  await state.patch({ proxyUrl: v });
  // 写回规范值：不然防抖自动保存还拿着原始字符串，下一次比对又写一遍
  if (input) input.value = v;
  syncProxyAction();
  if (!quiet) ok('代理已保存，立即生效');
  return true;
}

async function detectProxy() {
  const input = $('#cfgProxy');
  const btn = $('#btnProxyAct');
  if (!input || !btn) return;
  btn.disabled = true;
  btn.classList.add('is-busy');
  btn.textContent = '扫描中';
  try {
    const r = await window.cloudpic.app.detectProxy();
    if (!r || !r.found || !r.url) {
      warn('没扫到本机代理，请手动填写地址');
      return;
    }
    input.value = r.url;
    await saveProxy(r.url, true);
    ok('已找到本机代理并保存：' + r.url);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.classList.remove('is-busy');
    syncProxyAction();
  }
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
    // 平台标识只展示可连接的平台；实际选择仍在新建向导第一步完成。
    // 图标尺寸照「全部配置」卡片里那枚走（15px 放在 29px 的色块里）——
    // 之前用 20px 顶在 22px 的块里，四边只剩 1px，看着就是撑满了
    const brand = $('#platBrand');
    if (brand) {
      brand.innerHTML = ['github', 'cnb']
        .map(
          (id) =>
            '<span class="plat-brand-item">' +
            '<span class="plat-brand-ico" style="background:' + BRAND_TILE[id] + '">' + brandIcon(id, 14) + '</span>' +
            escapeHtml(PLATFORM_NAME[id]) +
            '</span>'
        )
        .join('');
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

    // 代理：输入即存（防抖留一层兜底），右边那个按钮空着时扫描、有值时立即保存
    const proxyInput = $('#cfgProxy');
    proxyInput.addEventListener('input', () => {
      syncProxyAction();
      autoSave();
    });
    proxyInput.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || !proxyInput.value.trim()) return;
      ev.preventDefault();
      saveProxy(proxyInput.value).catch((e) => err(e.message || String(e)));
    });
    $('#btnProxyAct').onclick = () => {
      if (!proxyInput.value.trim()) {
        detectProxy();
        return;
      }
      saveProxy(proxyInput.value).catch((e) => err(e.message || String(e)));
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
    // git-lfs：状态查询 + 一键安装
    const lfsBtn = $('#btnLfsInstall');
    if (lfsBtn) lfsBtn.onclick = installLfs;
    refreshLfsStatus();

    // 危险操作：恢复默认设置
    $('#btnResetConfig').onclick = async () => {
      const yes = await confirmDialog(
        '恢复默认设置',
        '会清掉主题、字体与全局参数（归档的配置和 Token 保留）',
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
