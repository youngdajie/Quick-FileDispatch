/** 文件管理页：本地目录 / 云端仓库双源浏览，两边都能改名、移动、替换内容 */

import { bytesToBase64 } from '../lib/bytes.js';
import {
  $,
  err,
  ok,
  warn,
  toast,
  modal,
  confirmDialog,
  previewImage,
  contextMenu,
  escapeHtml,
  debounce,
  pulse,
  sklTiles,
  friendlyError
} from '../lib/dom.js';
import { fileIcon, isImageName } from '../lib/fileicons.js';
import { previewText } from '../lib/textview.js';
import { openMiniUpload } from '../lib/upload-mini.js';
import state from '../lib/state.js';

const CPLinks = window.CPLinks;
/** 后缀算不算「能当文本看」——和主进程云端的判断用的是同一份（UMD 共享） */
const CPHL = window.CPHighlight;
const PAGE = 120;

const svg = (d, w) =>
  '<svg viewBox="0 0 24 24" width="' + (w || 15) + '" height="' + (w || 15) +
  '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

const ICONS = {
  copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/>', 14),
  eye: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>', 14),
  rename: svg('<path d="M4 20h16"/><path d="M14.5 4.6l4 4L9 18H5v-4z"/>', 14),
  replace: svg('<path d="M4 12a8 8 0 0 1 13.4-5.9"/><path d="M20 12a8 8 0 0 1-13.4 5.9"/><path d="M17.5 3v3.6h-3.6"/><path d="M6.5 21v-3.6h3.6"/>', 14),
  trash: svg('<path d="M4 7h16"/><path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7"/><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12"/>', 14),
  open: svg('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/>', 14),
  /** 新建文件夹：文件夹 + 加号 */
  folderPlus: svg('<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/><path d="M12 11v5"/><path d="M9.5 13.5h5"/>', 14),
  path: svg('<path d="M4 6h6"/><path d="M4 12h10"/><path d="M4 18h7"/><path d="M16 15l3 3-3 3"/><path d="M21 18h-5"/>', 14),
  list: svg('<path d="M9 6h11"/><path d="M9 12h11"/><path d="M9 18h11"/><path d="M4 6h1"/><path d="M4 12h1"/><path d="M4 18h1"/>', 14),
  close: svg('<circle cx="12" cy="12" r="8.5"/><path d="M9 9l6 6"/><path d="M15 9l-6 6"/>', 14),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 5v6h-6"/>', 14),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.6"/>', 13),
  /** 云端：一朵云 */
  cloud: svg('<path d="M7 18h9.5a3.5 3.5 0 0 0 .3-7A5 5 0 0 0 7.2 9.6 3.7 3.7 0 0 0 7 18z"/>', 15),
  /** 本地：一台显示器 */
  monitor: svg('<rect x="3" y="4.5" width="18" height="12" rx="1.8"/><path d="M9 20h6"/><path d="M12 16.5V20"/>', 15),
  /** 本地 ↔ 云端：上下互换的双箭头，替掉以前那个 ⟷ 字符 */
  swap: svg('<path d="M8 4.5v13"/><path d="M4.6 7.9 8 4.5l3.4 3.4"/><path d="M16 19.5v-13"/><path d="M12.6 16.1 16 19.5l3.4-3.4"/>', 15),
  /** 上传到此文件夹：一个向上的箭头 */
  upload: svg('<path d="M12 16V5.5"/><path d="M8 9.5 12 5.5l4 4"/><path d="M4 18.5h16"/>', 15)
};

/**
 * 把操作按钮挪进右键菜单后，这里提供带图标的菜单项。
 * 菜单对齐的是「对这一个条目能做什么」，而不是原来的悬停工具条数组。
 */

const view = {
  source: 'local',
  dir: '',
  items: [],
  selected: new Set(),
  mode: 'grid',
  search: '',
  localReady: false,
  loading: false,
  shown: PAGE,
  git: null,
  /** 云端检测器的最近一次结论（cloud:detect 的返回） */
  cloud: null,
  hasTime: false,
  sortKey: 'name', // name | size | mtime
  sortDir: 1 // 1 升序，-1 降序
};

let replaceTarget = null;

/**
 * 框选拖完那一刻，浏览器还会补一个 click。
 * 那个 click 落在条目上时如果带着 Ctrl，就会把刚框进来的这一格又取消掉 ——
 * 所以拖完短暂闭麦，让这个尾巴 click 直接丢掉。
 */
let suppressClickUntil = 0;

/**
 * 当前生效的「仓库身份」。
 * 归档配置一切换，远端仓库 + 分支 + 本地目录是一起换的，
 * 用这个串比对就能知道「是不是换仓库了」。
 */
let lastIdentity = null;
function identityKey() {
  const c = state.cfg || {};
  return [c.platform, c.owner, c.repo, c.branch, c.localDir].join('|');
}

/* ---------------------------------------------------------------- 小工具 */

function isImg(it) {
  if (typeof it.isImage === 'boolean') return it.isImage;
  return isImageName(it.name || '');
}

/** 能不能当文本预览 / 编辑（HTML、JS、CSS、JSON、md、各种配置……） */
function isText(it) {
  if (!it || it.type === 'dir' || isImg(it)) return false;
  return !!(CPHL && CPHL.isTextName(it.name || it.path || ''));
}

function absLocalPath(rel) {
  const root = (state.cfg && state.cfg.localDir) || '';
  if (!root) return '';
  const sep = root.indexOf('\\') >= 0 ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + String(rel).replace(/\//g, sep);
}

/**
 * 远端文件的预览地址。
 * 配了代理就在最前面走代理（GitHub raw 国内经常拉不动），失败再退回原直链。
 */
function previewUrls(it) {
  return { primary: window.cloudpic.localUrl(absLocalPath(it.path)), fallback: '' };
}

function thumbSrc(it) {
  return previewUrls(it).primary;
}

function linkOf(it) {
  return CPLinks.buildUrl(state.cfg, it.path);
}

/**
 * 双击 / 菜单「预览」的统一入口：
 * 图片还是老样子走图片查看器，文本文件才进代码预览器（可编辑、可保存）。
 */
function openPreview(it) {
  if (!it) return;
  if (isImg(it)) {
    previewImage(thumbSrc(it), it.path, linkOf(it));
    return;
  }
  previewText({
    name: it.name || String(it.path).split('/').pop(),
    path: it.path,
    source: 'local',
    link: linkOf(it),
    onSaved: () => {
      load();
      window.dispatchEvent(new CustomEvent('cloudpic:changed'));
    }
  });
}

function dirOf(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

function baseOf(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  if (isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  );
}

function selectedFiles() {
  return view.items.filter((i) => view.selected.has(i.path) && i.type === 'file');
}

/* ---------------------------------------------------------------- 选中 */

/**
 * 选中只有三条路：勾复选框、右键、在空白处按住左键拖框。
 *
 * 以前是「整块 tile 点一下就选中」，于是每次想双击预览、双击进目录，都会先
 * 把它选上，回头还得手动取消 —— 这是这次重做最主要的动机。
 * 现在单击条目不再改变选中状态（Ctrl / Cmd + 单击保留，当桌面上的肌肉记忆）。
 */
function findItem(path) {
  return view.items.find((i) => i.path === path) || null;
}

/** 只刷新 class / aria，不重建 DOM —— 拖框选每移动一下都要跑，重建会卡 */
function syncTileChecks() {
  const grid = $('#mgGrid');
  if (grid) {
    grid.querySelectorAll('.tile').forEach((t) => {
      const on = view.selected.has(t.dataset.path);
      t.classList.toggle('selected', on);
      const c = t.querySelector('.tile-check');
      if (c) c.setAttribute('aria-checked', on ? 'true' : 'false');
    });
  }
  syncHeadCheck();
}

function setSelection(paths) {
  view.selected = new Set(paths);
  syncTileChecks();
  updateSelectionBar();
}

function toggleSelect(path) {
  if (view.selected.has(path)) view.selected.delete(path);
  else view.selected.add(path);
  syncTileChecks();
  updateSelectionBar();
}

function selectOnly(path) {
  setSelection([path]);
}

function clearSelection() {
  setSelection([]);
}

/** 当前可见（已渲染出来）的条目 */
function visibleItems() {
  return filtered().slice(0, view.shown);
}

/** 列表表头那个全选：未选 / 半选 / 全选 三态 */
function syncHeadCheck() {
  const el = $('#mgCheckAll');
  if (!el) return;
  const list = visibleItems();
  const n = list.filter((i) => view.selected.has(i.path)).length;
  const mark = !n || !list.length ? 'false' : n === list.length ? 'true' : 'mixed';
  el.setAttribute('aria-checked', mark);
}

/* ---------------------------------------------------------------- 框选 */

/**
 * 按住左键拖动 = 拉一个选框，碰到的条目都选上（OpenList 那种手感）。
 * 按住 Ctrl / Cmd 则是叠加到现有选区，而不是替换。
 *
 * 选框挂在 body 上用 position: fixed —— 全部按视口坐标算，
 * 不用去跟 .content 的滚动位置对账，滚动时也不会错位。
 *
 * fromTile 表示这框是从某个条目身上拉起来的（长按触发）。区别只有一个：
 * 空白处「点一下、不拖」要取消选择，条目上这么来一下不算「点了空白」，
 * 不该把用户辛苦勾的选区清掉。
 */
function startMarquee(e, fromTile) {
  const grid = $('#mgGrid');
  if (!grid) return;
  const additive = e.ctrlKey || e.metaKey;
  const base = additive ? new Set(view.selected) : new Set();
  const box = document.createElement('div');
  box.className = 'mg-marquee';
  document.body.appendChild(box);
  let moved = false;

  const hit = (x1, y1, x2, y2, out) => {
    const l = Math.min(x1, x2);
    const r = Math.max(x1, x2);
    const t = Math.min(y1, y2);
    const b = Math.max(y1, y2);
    grid.querySelectorAll('.tile').forEach((el) => {
      const q = el.getBoundingClientRect();
      if (q.right > l && q.left < r && q.bottom > t && q.top < b) out.add(el.dataset.path);
    });
  };

  /** 拖到上下边缘时自动滚，否则长目录拖不到底 */
  const autoScroll = (clientY) => {
    const c = $('.content');
    const r = c.getBoundingClientRect();
    if (clientY > r.bottom - 46) c.scrollTop += 16;
    else if (clientY < r.top + 46) c.scrollTop -= 16;
  };

  const move = (ev) => {
    const w = Math.abs(ev.clientX - e.clientX);
    const h = Math.abs(ev.clientY - e.clientY);
    // 只是点了一下空白，还没拖起来 —— 先不画选框，免得闪一下
    if (!moved && w < 4 && h < 4) return;
    moved = true;
    suppressClickUntil = Date.now() + 350;
    box.style.left = Math.min(e.clientX, ev.clientX) + 'px';
    box.style.top = Math.min(e.clientY, ev.clientY) + 'px';
    box.style.width = w + 'px';
    box.style.height = h + 'px';
    const next = new Set(base);
    hit(e.clientX, e.clientY, ev.clientX, ev.clientY, next);
    setSelection(next);
    autoScroll(ev.clientY);
  };

  const up = () => {
    document.removeEventListener('mousemove', move, true);
    document.removeEventListener('mouseup', up, true);
    box.remove();
    // 空白处「点一下、不拖」= 取消选择（Windows 资源管理器、OpenList 都这样）
    if (!moved && !additive && !fromTile) clearSelection();
  };

  document.addEventListener('mousemove', move, true);
  document.addEventListener('mouseup', up, true);
}

/* ---------------------------------------------------------------- 右键菜单 */

/** 复制单条链接（菜单里用，和工具栏的「复制链接」同一套格式） */
function copyLinkOf(it) {
  const fmt = ($('#mgFormat') && $('#mgFormat').value) || (state.cfg && state.cfg.linkFormat) || 'markdown';
  window.cloudpic.clipboard
    .write(CPLinks.formatLink(linkOf(it), fmt, it.name, isImg(it)))
    .then(() => ok('已复制链接'));
}

async function copyPaths(paths) {
  if (!paths || !paths.length) return;
  await window.cloudpic.clipboard.write(paths.join('\n'));
  ok('已复制 ' + paths.length + ' 条路径');
}

function currentFormatName() {
  const id = ($('#mgFormat') && $('#mgFormat').value) || (state.cfg && state.cfg.linkFormat) || 'markdown';
  const f = (CPLinks.LINK_FORMATS || []).find((x) => x.id === id);
  return f ? f.name : '';
}

/** 单个条目的菜单：以前悬停出现的那五个按钮，现在都在这里 */
function menuForItem(it) {
  if (it.type === 'dir') {
    return [
      { label: '打开', icon: ICONS.open, onClick: () => navigate(it.path) },
      { label: '复制仓库内路径', icon: ICONS.path, onClick: () => copyPaths([it.path]) }
    ];
  }
  return [
    { label: '复制链接', icon: ICONS.copy, hint: currentFormatName(), onClick: () => copyLinkOf(it) },
    {
      label: isText(it) ? '预览 / 编辑' : '预览',
      icon: ICONS.eye,
      disabled: !isImg(it) && !isText(it),
      onClick: () => openPreview(it)
    },
    { label: '复制仓库内路径', icon: ICONS.path, onClick: () => copyPaths([it.path]) },
    { sep: true },
    { label: '重命名 / 移动', icon: ICONS.rename, onClick: () => openRenameDialog([it]) },
    { label: '用新文件替换内容', icon: ICONS.replace, onClick: () => doReplace(it) },
    { sep: true },
    { label: '删除', icon: ICONS.trash, danger: true, onClick: () => removeOne([it]) }
  ];
}

/** 多选时的批量菜单，和底部那条批量工具条一一对应 */
function menuForSelection() {
  const files = selectedFiles();
  const n = view.selected.size;
  return [
    { label: '复制链接', icon: ICONS.copy, hint: files.length + ' 个文件', disabled: !files.length, onClick: copySelectedLinks },
    { label: '复制路径', icon: ICONS.path, disabled: !n, onClick: copySelectedPaths },
    { label: '导出清单', icon: ICONS.list, disabled: !files.length, onClick: exportSelected },
    { sep: true },
    {
      label: files.length > 1 ? '批量移动' : '重命名 / 移动',
      icon: ICONS.rename,
      disabled: !files.length,
      onClick: () => openRenameDialog(files)
    },
    { label: '用新文件替换内容', icon: ICONS.replace, disabled: files.length !== 1, onClick: () => doReplace(files[0]) },
    { sep: true },
    { label: '删除 ' + n + ' 项', icon: ICONS.trash, danger: true, disabled: !files.length, onClick: () => removeOne(selectedFiles()) },
    { label: '取消选择', icon: ICONS.close, onClick: clearSelection }
  ];
}

/** 空白处右键：对这些「整目录级」的动作 */
function blankMenuItems() {
  const list = visibleItems();
  const allOn = list.length > 0 && list.every((i) => view.selected.has(i.path));
  return [
    {
      // 直接往「当前目录」传文件，省掉「切到上传页 → 改目标目录」两步
      label: '上传到此文件夹',
      icon: ICONS.upload,
      hint: view.dir || '仓库根目录',
      onClick: () => openMiniUpload(view.dir, () => load())
    },
    {
      label: '新建文件夹',
      icon: ICONS.folderPlus,
      hint: view.dir || '仓库根目录',
      onClick: newFolder
    },
    { sep: true },
    {
      label: allOn ? '取消全选' : '全选当前目录',
      icon: ICONS.check,
      hint: list.length + ' 项',
      disabled: !list.length,
      onClick: () => setSelection(allOn ? [] : list.map((i) => i.path))
    },
    { label: '取消选择', icon: ICONS.close, disabled: !view.selected.size, onClick: clearSelection },
    { sep: true },
    { label: '刷新', icon: ICONS.refresh, onClick: () => load() }
  ];
}

/**
 * 在当前目录下新建一个空文件夹。
 *
 * 只动**本地**目录（和改名 / 删除同一路）—— 建完要在左侧点「提交并推送」
 * 才进仓库。而且 git 不跟踪空目录，所以要等里面放了文件才会出现在云端，
 * 弹窗里把这一点说清楚，免得用户以为没生效。
 */
function newFolder() {
  const box = document.createElement('div');
  box.innerHTML =
    '<label class="field"><span class="field-label">文件夹名</span>' +
    '<input type="text" id="mgNewDirName" placeholder="例如 photos" /></label>' +
    '<div class="callout" style="margin-bottom:0">' +
    '建在「' +
    escapeHtml(view.dir || '仓库根目录') +
    '」下，Git 不跟踪空文件夹，里面放了文件才会同步到云端' +
    '</div>';

  const handle = modal({
    title: '新建文件夹',
    node: box,
    buttons: [
      { label: '取消' },
      {
        label: '创建',
        primary: true,
        onClick: () => {
          createFolder(handle);
          return false; // 由 createFolder 决定关不关（名字不合法就留在弹窗里）
        }
      }
    ]
  });

  const input = $('#mgNewDirName', box);
  if (input) {
    setTimeout(() => input.focus(), 60);
    input.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      createFolder(handle);
    };
  }
}

async function createFolder(handle) {
  const name = (($('#mgNewDirName') || {}).value || '').trim();
  if (!name) {
    err('文件夹名不能为空');
    return;
  }
  if (/[\\/]/.test(name)) {
    err('文件夹名里不能带斜杠');
    return;
  }
  const path = view.dir ? view.dir + '/' + name : name;
  try {
    await window.cloudpic.fs.localMkdir({ path: path });
    if (handle) handle.close();
    ok('已在本地新建「' + name + '」');
    await load();
  } catch (e) {
    err((e && e.message) || '创建文件夹失败');
  }
}

/* ---------------------------------------------------------------- 数据加载 */

async function load() {
  if (view.loading) return;
  // 换了目录就把上一批缩略图 blob 回收掉；同目录刷新（提交后重载）保留缓存，
  // 不然每次刷新都要把一屏图重新解码一遍
  const dirKey = view.source + ':' + view.dir;
  if (load.__lastDir !== dirKey) {
    releaseThumbs();
    load.__lastDir = dirKey;
  }
  view.loading = true;
  view.selected.clear();
  updateSelectionBar();
  showSkeleton();
  // 容量条和列表数据没关系，先挂上去：列表就算读失败（比如这台机器没配 Token），
  // 它也该照常显示，不该跟着一起消失
  refreshCloudQuota();
  try {
    const cfg = state.cfg || {};
    if (!cfg.localDir) {
      view.items = [];
      view.loading = false;
      renderGrid(
        '<div class="big">还没绑定本地目录</div>' +
        '文件管理读的是本机这份目录：先去设置里把本地目录绑定上（配置向导最后一步就能选）' +
        '<div style="margin-top:14px"><button class="btn btn-primary btn-sm" id="btnGotoSettings">前往设置</button></div>'
      );
      const go = $('#btnGotoSettings');
      if (go) go.onclick = () => document.querySelector('.nav-item[data-page="settings"]').click();
      return;
    }

    const res = await window.cloudpic.cloud.list({ dir: view.dir, source: 'local' });
    view.items = res.items || [];
    view.localReady = !!res.localReady;
    view.shown = PAGE;
  } catch (e) {
    view.items = [];
    err(e.message || String(e));
    renderGrid(
      '<div class="big">读不到内容</div>' +
        escapeHtml(friendlyError(e.message)) +
        '<div style="margin-top:14px"><button class="btn btn-primary btn-sm" id="btnGotoSettings">前往设置</button></div>'
    );
    const go = $('#btnGotoSettings');
    if (go) go.onclick = () => document.querySelector('.nav-item[data-page="settings"]').click();
    view.loading = false;
    return;
  }
  view.loading = false;
  renderAll();
  loadSide();
  refreshStats();
}

/** 左侧只留「状态」+ 云端检测器：目录位置由面包屑负责，这里不再重复一遍 */
async function loadSide() {
  await refreshGitState();
  // 本地状态和云端比对并行不了：都要跑 git / 网络，串行更省事
  await refreshCloudDetect();
}

/**
 * 存储用量条。
 *
 * 数据来自 CNB 的 charge 接口 —— 注意那是**组织级**的（/{org}/-/charge/…），
 * 仓库维度的接口没公开，所以这里的数字是「这个账号下所有仓库」的合计，
 * tooltip 里会写明，免得被当成单个仓库的用量。
 */
async function refreshCloudQuota() {
  const box = $('#mgQuota');
  if (!box) return;
  const cfg = state.cfg || {};
  // 只有 CNB 有容量接口，其他平台整块不显示
  const plat = cfg.platform === 'cnb' ? 'cnb' : 'github';
  if (!cfg.owner || plat !== 'cnb') {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  try {
    const q = await window.cloudpic.cloud.quota();
    if (!q || !q.ok) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    const html = renderQuota(q);
    box.hidden = !html;
    box.innerHTML = html;
  } catch (e) {
    // 查不到就静静收起来 —— 侧栏的主体信息不该被一根容量条牵连
    box.hidden = true;
    box.innerHTML = '';
  }
}

/**
 * 容量条上方那条居中短波浪。
 *
 * 内联 SVG 而不是 CSS background：写在 CSS 里的 SVG 属于独立文档，
 * stroke 的 currentColor 取不到外层元素的颜色，只能硬编码色值 —— 那样换主题
 * 就断了。内联进来就跟着 .sq-wave 的 color 走。
 */
const SQ_WAVE =
  '<svg viewBox="0 0 44 6" width="44" height="6" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M2 3q5 -4.2 10 0t10 0t10 0t10 0"/></svg>';

function renderQuota(q) {
  const g = q.git || { used: 0, total: 0 };
  if (!g.total) return '';
  const pct = Math.max(0, Math.min(1, g.used / g.total));
  const pctTxt = (pct * 100).toFixed(pct < 0.001 ? 3 : pct < 0.1 ? 2 : 1) + '%';
  // 占比极小时给条留一丝可见宽度，否则一眼看去像是 0
  const w = pct > 0 ? Math.max(pct * 100, 1.5) : 0;
  const tone = pct >= 0.85 ? 'bad' : pct >= 0.6 ? 'warn' : '';
  const scope = q.scope === 'org' ? '「' + (q.owner || '当前账号') + '」名下所有仓库一起算' : '';
  return (
    '<div class="sq-wave" aria-hidden="true">' + SQ_WAVE + '</div>' +
    '<div class="sq-line" title="' +
    escapeHtml('仓库存储用量' + (scope ? '（' + scope + '）' : '')) +
    '"><span class="sq-label">存储用量</span>' +
    '<span class="sq-pct' + (tone ? ' ' + tone : '') + '">' + pctTxt + '</span></div>' +
    '<div class="sq-bar"><i class="' + tone + '" style="width:' + w.toFixed(2) + '%"></i></div>' +
    '<div class="sq-num">' + CPLinks.formatBytes(g.used) + ' / ' + CPLinks.formatBytes(g.total) + '</div>'
  );
}

async function refreshGitState() {
  const box = $('#mgGitState');
  if (!box) return;
  const cfg = state.cfg || {};
  if (!cfg.localDir) {
    view.git = null;
    box.hidden = false;
    box.innerHTML = '<span>未配置本地目录</span><br><span class="txt">只有云端浏览，速度取决于网络</span>';
    return;
  }
  try {
    const st = await window.cloudpic.git.status();
    view.git = st;
    if (!st.isRepo) {
      view.git = null;
      box.hidden = false;
      box.innerHTML =
        '<span class="bad">本地目录不是 Git 仓库</span><br><span class="txt">' + escapeHtml(cfg.localDir) + '</span>';
      return;
    }
    const dirty = !!st.dirty;
    // 只留「有未提交改动」这条独有信息。
    // 「本地与仓库已同步 / 分支 @ sha」跟下面「云端 · 本地检测器」说的是同一件事
    // （本地 sha 对云端 sha），并排摆着纯属重复；没有改动时整块不占地方。
    if (!dirty) {
      box.hidden = true;
      box.innerHTML = '';
      return;
    }
    box.hidden = false;
    box.innerHTML =
      '<span class="bad">本地有 ' + st.changes + ' 处未提交改动</span>' +
      '<br><button class="btn btn-primary btn-sm" id="btnMgPush">提交并推送</button>';
    const push = $('#btnMgPush');
    if (push) push.onclick = pushLocal;
  } catch (e) {
    view.git = null;
    box.hidden = false;
    box.innerHTML = '<span class="bad">状态读取失败</span>';
  }
}

/* ---------------------------------------------------------------- 云端检测器 */

/**
 * 云端检测器。
 *
 * 走云端接口上传 / 删除时，本地是「被顺带同步」的一方。但如果改动是从别处来的
 * —— 网页端直接提交、另一台电脑推的、同事合的 PR —— 本地这边是不知道的：
 * 界面看着一切正常，实际已经落后云端好几个提交，甚至两边都改了、分叉了。
 *
 * 这个检测器就是把这件事显式摆出来：拿本地 HEAD 和云端 HEAD 比，谁新谁旧、
 * 差几个提交，一眼可见，并给出一个能直接点的动作（拉取 / 推送）。
 * 它只读不写 —— 真正的拉与推都要用户点按钮。
 */

/** 自动检测节流：翻目录会连着触发 load()，5 秒内不重复打云端接口 */
const DETECT_INTERVAL = 5000;
let lastDetectAt = 0;

async function refreshCloudDetect(force) {
  const box = $('#mgCloudState');
  if (!box) return;
  const cfg = state.cfg || {};

  if (!cfg.owner || !cfg.repo) {
    view.cloud = null;
    box.innerHTML = '<span class="txt">未配置仓库</span>';
    return;
  }

  if (!force && view.cloud && Date.now() - lastDetectAt < DETECT_INTERVAL) {
    box.innerHTML = renderCloudDetect(view.cloud);
    bindCloudDetectActions();
    return;
  }

  box.innerHTML = '<span class="txt">正在检测本地与云端…</span>';
  let d = null;
  try {
    d = await window.cloudpic.cloud.detect();
  } catch (e) {
    view.cloud = null;
    box.innerHTML =
      '<span class="bad">检测失败</span><br><span class="txt">' + escapeHtml(friendlyError(e.message)) + '</span>';
    return;
  }
  lastDetectAt = Date.now();
  view.cloud = d;
  box.innerHTML = renderCloudDetect(d);
  bindCloudDetectActions();
}

/**
 * 本地 / 云端两条短 SHA。
 *
 * 以前是「本地 xxx ⟷ 云端 xxx」挤在一行，中文夹两个等宽串，还要靠一个全角
 * 箭头字符去表达方向，窄侧栏里读起来很费劲。现在改成上下两行：云端在上、
 * 本地在下（云端是「源」，本地是跟着它走的那个），中间用自绘的 SVG 双箭头
 * 连接，谁新谁旧一眼能对上。
 */
function renderCloudDetect(d) {
  if (!d) return '<span class="txt">未检测</span>';
  if (d.relation === 'unconfigured') return '<span class="txt">未配置仓库</span>';
  if (!d.ok) {
    return (
      '<span class="bad">云端不可达</span><br><span class="txt">' +
      escapeHtml((d.cloud && d.cloud.message) || '未知原因') +
      '</span>'
    );
  }

  // 哈希只显 7 位、不加外框（瘦身：以前是个带边框的药丸，两个框占掉半行），
  // 完整 commit 塞进 title —— 悬停会由自绘云朵气泡显示完整的 40 位 sha。
  // 没有完整值时不挂 title：空 title 会让气泡弹出一个空壳
  const shaSpan = (short, full, extra) => {
    const t = full ? ' title="' + escapeHtml(full) + '"' : '';
    return (
      '<span class="sha' + (extra ? ' ' + extra : '') + '"' + t + '>' + escapeHtml(short) + '</span>'
    );
  };

  const cloudShort = d.cloud.short || (d.cloud.ok ? '?' : '空');
  const cloudRow =
    '<div class="cd-row">' +
    '<span class="cd-ico cloud">' + ICONS.cloud + '</span>' +
    '<span class="cd-label">云端</span>' +
    shaSpan(cloudShort, d.cloud.sha || '') +
    '</div>';

  const localRow = d.local.isRepo
    ? '<div class="cd-row">' +
      '<span class="cd-ico local">' + ICONS.monitor + '</span>' +
      '<span class="cd-label">本地</span>' +
      shaSpan(d.local.short || '?', d.local.sha || '') +
      '</div>'
    : '<div class="cd-row">' +
      '<span class="cd-ico local off">' + ICONS.monitor + '</span>' +
      '<span class="cd-label">本地</span>' +
      '<span class="sha off">未克隆</span>' +
      '</div>';

  const rows =
    '<div class="cd-rows">' + cloudRow + '<div class="cd-link">' + ICONS.swap + '</div>' + localRow + '</div>';

  const MAP = {
    same: { cls: 'ok', text: '本地与云端一致', act: '' },
    'local-behind': { cls: 'bad', text: '云端更新 — 本地落后 ' + d.behind + ' 个提交', act: 'pull' },
    'local-ahead': { cls: 'bad', text: '本地更新 — 领先云端 ' + d.ahead + ' 个提交', act: 'push' },
    diverged: { cls: 'bad', text: '两边分叉：本地领先 ' + d.ahead + '、落后 ' + d.behind, act: '' },
    'no-local': { cls: '', text: '这台电脑还没克隆仓库，先克隆下来才能管理文件', act: '' },
    unknown: { cls: 'bad', text: '提交历史比不出来' + (d.cloud && d.cloud.message ? '：' + d.cloud.message : ''), act: '' }
  };
  const st = MAP[d.relation] || MAP.unknown;

  let html = rows + '<div class="cd-verdict ' + (st.cls || '') + '">' + escapeHtml(st.text) + '</div>';

  if (d.relation === 'local-behind') {
    html += '<button class="btn btn-primary btn-sm" id="btnMgCloudPull">拉取云端</button>';
  } else if (d.relation === 'local-ahead') {
    html += '<button class="btn btn-primary btn-sm" id="btnMgCloudPush">推送到云端</button>';
  } else if (d.relation === 'diverged') {
    html +=
      '<button class="btn btn-ghost btn-sm" id="btnMgCloudPull">先拉云端</button>' +
      '<button class="btn btn-ghost btn-sm" id="btnMgCloudPush">强推本地</button>';
  } else if (d.relation === 'no-local') {
    html += '<span class="txt">到「设置」绑定本地目录后可对比提交</span>';
  }
  return html;
}

function bindCloudDetectActions() {
  const pull = $('#btnMgCloudPull');
  if (pull) pull.onclick = cloudPull;
  const push = $('#btnMgCloudPush');
  if (push) push.onclick = cloudPush;
}

/** 云端新 → 把云端拉下来（复用设置里的同步策略：pull 或强制对齐） */
async function cloudPull() {
  const btn = $('#btnMgCloudPull');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '拉取中…';
  }
  try {
    const r = await window.cloudpic.cloud.pullCloud();
    if (r.skipped) warn(r.message);
    else if (r.ok) {
      ok('已拉取云端：' + r.message);
      await load();
    } else err(r.message);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    await refreshCloudDetect(true);
  }
}

/** 云端旧 → 把本地提交推上去（不改写历史，有人抢先提交时会失败并提示） */
async function cloudPush() {
  const btn = $('#btnMgCloudPush');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '推送中…';
  }
  try {
    const r = await window.cloudpic.cloud.pushLocal();
    if (r.ok) {
      ok(r.message || '已推送到云端');
      await load();
    } else err(r.message);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    await refreshCloudDetect(true);
  }
}

async function refreshStats() {
  const bar = $('#mgStatusbar');
  const cfg = state.cfg || {};
  const fileCount = view.items.filter((i) => i.type === 'file').length;
  const dirCount = view.items.filter((i) => i.type === 'dir').length;
  const bytes = view.items.reduce((a, b) => a + (b.size || 0), 0);
  // 「本地目录」那枚 pill 去掉了：左边侧栏已经在讲本地目录的事，
  // 底栏再挂一遍是重复信息
  const pills = [
    '<span class="pill">当前目录 ' + dirCount + ' 个文件夹 / ' + fileCount + ' 个文件</span>',
    '<span class="pill">合计 ' + CPLinks.formatBytes(bytes) + '</span>'
  ];
  if (cfg.localDir) pills.push('<span class="pill">' + escapeHtml(cfg.localDir) + '</span>');
  bar.innerHTML = pills.join('') + '<span id="mgExtra" class="pill">统计中…</span>';
  try {
    const st = await window.cloudpic.cloud.stats({ source: 'local' });
    const extra = $('#mgExtra');
    if (extra) {
      extra.textContent =
        '整个仓库 ' + (st.files || 0) + ' 个文件 · ' + CPLinks.formatBytes(st.bytes || 0) + (st.truncated ? ' 以上' : '');
    }
  } catch (e) {
    const extra = $('#mgExtra');
    if (extra) extra.textContent = '';
  }
}

/* ---------------------------------------------------------------- 渲染 */

function filtered() {
  const kw = view.search.trim().toLowerCase();
  const list = kw ? view.items.filter((i) => i.name.toLowerCase().indexOf(kw) >= 0) : view.items.slice();
  const k = view.sortKey;
  const d = view.sortDir;
  list.sort((a, b) => {
    // 文件夹永远排在文件前面 —— 混在一起找东西太累
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    let r = 0;
    if (k === 'size') r = (a.size || 0) - (b.size || 0);
    else if (k === 'mtime') r = (a.mtime || 0) - (b.mtime || 0);
    if (!r) r = String(a.name).localeCompare(String(b.name), 'zh-Hans-CN');
    return r * d;
  });
  return list;
}

function renderBreadcrumb() {
  const parts = view.dir ? view.dir.split('/').filter(Boolean) : [];
  let acc = '';
  const html = ['<button class="bc-item" data-path="">仓库根目录</button>'];
  parts.forEach((p) => {
    acc = acc ? acc + '/' + p : p;
    html.push('<span class="bc-sep">/</span>');
    html.push(
      '<button class="bc-item" data-path="' + escapeHtml(acc) + '" title="' + escapeHtml(acc) + '">' + escapeHtml(p) + '</button>'
    );
  });
  $('#breadcrumb').innerHTML = html.join('');
}

/**
 * 一个条目 = 一行/一块。DOM 结构是「平铺的子元素」，
 * 网格还是列表完全由 CSS 决定布局（列表模式改 flex-direction + 给列宽），
 * 这样两种视图共用同一套 DOM 和同一套事件，不用写两份渲染逻辑。
 *
 * 复选框从「一个 ✓ 字符」换成了自绘控件（.mg-check）：勾中态、半选态、
 * 深浅主题下都看得清；同时把原来的悬停工具条整块删掉 —— 五个按钮压在缩略图上
 * 既挡内容又容易误点，操作全搬到右键菜单里了。
 */
/* ---------------------------------------------------------------- 缩略图 */

/*
 * 大图不要直接把原图塞进 <img src>。
 *
 * 壁纸这类 4000×3000 的图，浏览器会把**整张**解码进内存（约 48 MB）再缩到
 * 一百多像素显示 —— 一屏 120 个 tile 就是 5 GB 级的解码峰值，切页和滚动
 * 必卡（杰哥的「壁纸收藏」就是这个情况）。
 *
 * 办法：进视口时才去取原图，用 createImageBitmap 的 resize 参数**在解码
 * 阶段就降采样**（Chromium 走的是按需解码，不会先铺满全尺寸），再转成一个
 * 小 blob 交给 <img>。
 *
 * 为什么不用后端生成缩略图：那要引图像库，而 go.mod 里「零第三方依赖」是
 * 写明的设计约束（安装包体积 + 国内模块代理的坑）。这里靠浏览器自己的能力
 * 就够了，一行依赖都不用加。
 */

/** 缩略图最长边。网格 tile 宽 146px 起，DPR 2x 下 320 足够清晰 */
const THUMB_MAX = 320;
/** 同时最多解码几张。一口气 120 张会把内存和 IO 都打满 */
const THUMB_CONCURRENCY = 4;

let thumbIO = null;
const thumbQueue = [];
let thumbBusy = 0;
/** 路径 → 已解码好的缩略图 blob URL。排序 / 筛选 / 加载更多时直接复用，不重复解码 */
const thumbCache = new Map();

function thumbObserver() {
  if (thumbIO) return thumbIO;
  thumbIO = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        thumbIO.unobserve(e.target);
        const img = e.target;
        if (!img.dataset.thumb || img.dataset.queued === '1') return;
        img.dataset.queued = '1';
        thumbQueue.push(img);
        pumpThumbs();
      });
    },
    // 提前 300px 就开始解码，滚到眼前时基本已经好了
    { rootMargin: '300px 0px', threshold: 0.01 }
  );
  return thumbIO;
}

/** 给当前所有待加载的缩略图挂上观察器（每次渲染后调） */
function observeThumbs() {
  const io = thumbObserver();
  // 每次都是整块 innerHTML 重建，旧元素已经从 DOM 里没了 —— 先断掉所有旧观察，
  // 否则那些已经没用的 img 会被 observer 一直引用着，切几次目录就积一堆
  io.disconnect();
  document.querySelectorAll('#mgGrid img[data-thumb]').forEach((img) => io.observe(img));
}

function pumpThumbs() {
  while (thumbBusy < THUMB_CONCURRENCY && thumbQueue.length) {
    const img = thumbQueue.shift();
    if (!img.isConnected) continue;
    thumbBusy++;
    decodeThumb(img).finally(() => {
      thumbBusy--;
      pumpThumbs();
    });
  }
}

async function decodeThumb(img) {
  const url = img.dataset.thumb;
  const path = img.dataset.path || url || '';
  delete img.dataset.thumb;
  delete img.dataset.queued;
  if (!url || !img.isConnected) return;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const blob = await resp.blob();
    const bmp = await createImageBitmap(blob, {
      resizeWidth: THUMB_MAX,
      resizeQuality: 'medium'
    });
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close(); // 位图用完立刻还给系统
    const out = await new Promise((res) => c.toBlob(res, 'image/webp', 0.82));
    if (!out || !img.isConnected) return;
    const objUrl = URL.createObjectURL(out);
    thumbCache.set(path, objUrl);
    img.src = objUrl;
    img.classList.add('thumb-loaded');
  } catch (e) {
    // 降采样这条路失败了就退回原图直出 —— 至少内容能显示出来，
    // 后续的加载失败兜底（attachImageFallback）继续管 error
    if (img.isConnected && url) img.src = url;
  }
}

/** 换目录时回收上一批 blob + 清缓存 */
function releaseThumbs() {
  thumbCache.forEach((u) => {
    try {
      URL.revokeObjectURL(u);
    } catch (e) {
      /* 已经释放过就算了 */
    }
  });
  thumbCache.clear();
  thumbQueue.length = 0;
}

function tileHtml(it, idx) {
  const sel = view.selected.has(it.path);
  const i = ' style="--i:' + Math.min(idx, 22) + '"';
  const isDir = it.type === 'dir';

  let thumb;
  const img = !isDir && isImg(it);
  if (img) {
    const u = previewUrls(it);
    const cached = thumbCache.get(it.path);
    const attrs =
      ' data-path="' +
      escapeHtml(it.path) +
      '"' +
      (u.fallback ? ' data-proxy="' + escapeHtml(u.fallback) + '"' : '') +
      ' data-icon="' +
      escapeHtml(fileIcon(it.name)) +
      '" alt=""';
    // 命中缓存就直接给 src（排序 / 筛选 / 加载更多时不重复解码）；
    // 否则只记 URL，交给缩略图引擎：进视口才 fetch + createImageBitmap 降采样
    // —— 不设 src，设了就等于让浏览器去解码整张原图（壁纸一张 48MB）。
    thumb = cached
      ? '<img src="' + escapeHtml(cached) + '"' + attrs + ' />'
      : '<img data-thumb="' + escapeHtml(u.primary) + '"' + attrs + ' />';
  } else {
    thumb = fileIcon(it.name, { isDir: isDir });
  }

  return (
    '<div class="tile' + (sel ? ' selected' : '') + '"' + i + ' data-path="' + escapeHtml(it.path) + '" data-type="' + it.type + '">' +
    '<button type="button" class="tile-check mg-check" data-act="check" role="checkbox" aria-checked="' +
    (sel ? 'true' : 'false') +
    '" tabindex="-1" title="选中（右键还可做更多）">' +
    ICONS.check +
    '</button>' +
    '<div class="tile-thumb">' + thumb + '</div>' +
    '<div class="tile-name" title="' + escapeHtml(it.path) + '">' + escapeHtml(it.name) + '</div>' +
    '<div class="tile-size">' + (isDir ? '文件夹' : CPLinks.formatBytes(it.size || 0)) + '</div>' +
    (view.hasTime ? '<div class="tile-time">' + (isDir ? '—' : fmtTime(it.mtime)) + '</div>' : '') +
    '</div>'
  );
}

/** 列表模式的表头：排序状态、修改时间列是否显示 */
function syncListHead() {
  const head = $('#mgListHead');
  if (!head) return;
  head.hidden = view.mode !== 'list';
  head.classList.toggle('no-time', !view.hasTime);
  head.querySelectorAll('[data-sort]').forEach((b) => {
    const on = b.dataset.sort === view.sortKey;
    b.classList.toggle('active', on);
    b.dataset.dir = on ? (view.sortDir === 1 ? 'asc' : 'desc') : '';
  });
}

function showSkeleton() {
  const grid = $('#mgGrid');
  const empty = $('#mgEmpty');
  const head = $('#mgListHead');
  if (head) head.hidden = true;
  empty.hidden = true;
  grid.innerHTML = sklTiles(12);
  grid.classList.remove('list-view');
}

/** 上次用的视图模式（记在配置的 ui.manageView 里）；没有就网格 */
function savedViewMode() {
  const ui = (state.cfg && state.cfg.ui) || {};
  return ui.manageView === 'list' ? 'list' : 'grid';
}

/**
 * 切视图模式。
 *
 * @param {string} mode 'grid' | 'list'
 * @param {boolean} persist 是否写回配置（只有用户亲手点才写；
 *   初始化时同步按钮状态不能写，否则每次进页面都多一次无意义的配置写入）
 * @param {boolean} paint 是否立即重绘（初始化时列表还没数据，重绘会闪一下空状态）
 */
function setViewMode(mode, persist, paint) {
  view.mode = mode === 'list' ? 'list' : 'grid';
  const g = $('#btnMgGrid');
  const l = $('#btnMgList');
  if (g) g.classList.toggle('active', view.mode === 'grid');
  if (l) l.classList.toggle('active', view.mode === 'list');
  if (persist) state.patch({ ui: { manageView: view.mode } });
  if (paint !== false) renderGrid();
}

function renderGrid(placeholder) {
  const grid = $('#mgGrid');
  const empty = $('#mgEmpty');
  const head = $('#mgListHead');
  if (placeholder) {
    grid.innerHTML = '';
    if (head) head.hidden = true;
    empty.hidden = false;
    empty.innerHTML = placeholder;
    return;
  }
  const list = filtered();
  view.hasTime = list.some((i) => !!i.mtime);
  if (!list.length) {
    grid.innerHTML = '';
    if (head) head.hidden = true;
    empty.hidden = false;
    empty.innerHTML = view.dir
      ? '<div class="big">这个目录还是空的</div>到「上传」页拖几个文件进来，或者换个目录看看'
      : '<div class="big">仓库还是空的</div>到「上传」页拖几个文件进来就会出现在这里';
    return;
  }
  empty.hidden = true;
  const slice = list.slice(0, view.shown);
  grid.innerHTML = slice.map((it, idx) => tileHtml(it, idx)).join('');
  grid.classList.toggle('list-view', view.mode === 'list');
  syncListHead();
  syncHeadCheck();
  observeThumbs();
}

function attachImageFallback() {
  const grid = $('#mgGrid');
  if (grid.dataset.fallbackBound) return;
  grid.dataset.fallbackBound = '1';
  // 图片有两种「加载不出来」：直链挂了退回代理；代理也挂了就别再显示破图，退回类型图标
  grid.addEventListener(
    'error',
    (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      const proxy = img.dataset.proxy;
      if (proxy && img.src !== proxy && !img.dataset.failed) {
        img.dataset.failed = '1';
        img.src = proxy;
        return;
      }
      if (!img.dataset.iconDone) {
        img.dataset.iconDone = '1';
        const span = document.createElement('span');
        span.className = 'thumb-fallback';
        span.innerHTML = img.dataset.icon || '';
        img.replaceWith(span);
      }
    },
    true
  );
}

function renderAll() {
  renderBreadcrumb();
  renderGrid();
  attachImageFallback();
}

function updateSelectionBar() {
  const bar = $('#mgSelection');
  const n = view.selected.size;
  const el = $('#mgSelCount');
  if (el.textContent !== String(n)) pulse(el);
  el.textContent = String(n);
  bar.hidden = n === 0;
  const files = selectedFiles();
  const multi = files.length > 1;
  const rename = $('#btnMgRename');
  if (rename) rename.textContent = multi ? '批量移动' : '重命名 / 移动';
  const rep = $('#btnMgReplace');
  if (rep) rep.disabled = files.length !== 1;
}

/* ---------------------------------------------------------------- 导航 */

function navigate(dir) {
  view.dir = CPLinks.normalizePath(dir || '');
  load();
}

/* ---------------------------------------------------------------- 复制 / 导出 */

async function copySelectedLinks() {
  const fmt = $('#mgFormat').value || (state.cfg && state.cfg.linkFormat) || 'markdown';
  const sel = selectedFiles();
  if (!sel.length) {
    warn('请先选择文件');
    return;
  }
  const txt = sel.map((i) => CPLinks.formatLink(linkOf(i), fmt, i.name, isImg(i))).join('\n');
  await window.cloudpic.clipboard.write(txt);
  ok('已复制 ' + sel.length + ' 条链接');
}

async function copySelectedPaths() {
  const sel = Array.from(view.selected);
  if (!sel.length) {
    warn('请先选择内容');
    return;
  }
  await window.cloudpic.clipboard.write(sel.join('\n'));
  ok('已复制 ' + sel.length + ' 条路径');
}

async function exportSelected() {
  const fmt = $('#mgFormat').value || 'markdown';
  const sel = selectedFiles();
  if (!sel.length) {
    warn('请先选择文件');
    return;
  }
  const txt = sel
    .map((i) => CPLinks.formatLink(linkOf(i), fmt, i.name, isImg(i)) + '\t' + CPLinks.formatBytes(i.size || 0))
    .join('\n');
  const r = await window.cloudpic.fs.exportText({ content: txt, defaultName: 'Quick-FileDispatch-filelist.txt' });
  if (r.ok) ok('已导出到 ' + r.filePath);
}

/* ---------------------------------------------------------------- 改名 / 移动 */

/**
 * 路径选择器能不能用，以及本地这棵目录树可不可信。
 *
 * 底图是本地克隆，所以起码得有个 Git 仓库，才谈得上「看着目录挑」。
 *
 * 同步状态不当作开关：本地落后 / 分叉时照样能挑，只是把话说在前面 ——
 * 你选的这个目录在云端可能还没建，记得先同步再提交。原因有两个：
 *   1. 只盯着 relation === 'same' 会让「提交历史比不出来」的情况（自定义 API
 *      地址，检测器自己都会提示这种）永远用不上这个功能；
 *   2. 目的本来就是让用户别手打路径，一个纯粹的便利功能不该卡在网络状态上。
 */
function dirPickState() {
  const cfg = state.cfg || {};
  if (!cfg.localDir) return { ok: false, synced: false, why: '没配本地目录，只能手打相对路径' };
  if (!view.git) return { ok: false, synced: false, why: '本地目录不是 Git 仓库，只能手打相对路径' };

  const c = view.cloud;
  if (!c || !c.ok) return { ok: true, synced: false, why: '还没读到云端提交' };
  if (view.git.dirty) return { ok: true, synced: false, why: '本地有未提交改动' };
  if (c.relation === 'same') return { ok: true, synced: true, why: '' };

  const MAP = {
    'local-behind': '本地落后云端 ' + c.behind + ' 个提交',
    'local-ahead': '本地领先云端 ' + c.ahead + ' 个提交',
    diverged: '本地与云端分叉',
    'no-local': '这台电脑还没克隆仓库'
  };
  return { ok: true, synced: false, why: MAP[c.relation] || '本地与云端还没对上' };
}

/** 目录选择面板的临时状态（只活在「重命名 / 移动」这个弹层里） */
let dp = { open: false, dir: '' };

function openRenameDialog(targets) {
  const multi = targets.length > 1;
  const first = targets[0];
  const startDir = multi ? view.dir : dirOf(first.path);
  const pk = dirPickState();
  dp = { open: false, dir: '' };

  const box = document.createElement('div');
  box.innerHTML =
    '<p class="rule-desc" style="margin:0 0 12px">' +
    (multi
      ? '把选中的 <b>' + targets.length + '</b> 个文件移动到同一个目录；留空即仓库根目录'
      : '改目录 = 移动，改文件名 = 重命名，两个一起改也可以') +
    '</p>' +
    // 这里用 div 而不是 label：label 里塞按钮会让点按钮顺带触发 label 的默认行为
    '<div class="field"><span class="field-label">目录 <span class="hint">相对仓库根目录</span></span>' +
    '<span class="dir-row">' +
    '<input type="text" id="mgEditDir" placeholder="留空 = 仓库根目录" value="' +
    escapeHtml(startDir) +
    '" />' +
    (pk.ok ? '<button type="button" class="btn btn-ghost" id="mgDirPickBtn">浏览…</button>' : '') +
    '</span>' +
    '<span class="dir-local' + (pk.ok && pk.synced ? '' : ' off') + '">' +
    '<span class="dl-ico">' + ICONS.monitor + '</span><span class="dl-txt" id="mgDirLocalTxt"></span>' +
    '</span>' +
    '</div>' +
    (multi
      ? ''
      : '<label class="field"><span class="field-label">文件名</span>' +
        '<input type="text" id="mgEditName" value="' + escapeHtml(baseOf(first.path)) + '" /></label>') +
    '<div id="mgDirPick"></div>' +
    '<div class="callout" style="margin-bottom:0">' +
    '本地目录会直接改名；改完后记得在左侧点「提交并推送」把改动同步到云端' +
    '</div>';

  const handle = modal({
    title: multi ? '批量移动' : '重命名 / 移动',
    node: box,
    buttons: [
      { label: '取消' },
      {
        label: '确定',
        primary: true,
        onClick: () => {
          runRename(targets, multi, handle);
          return false;
        }
      }
    ]
  });

  const dirInput = $('#mgEditDir');
  if (dirInput) dirInput.addEventListener('input', dpSyncHint);
  const pickBtn = $('#mgDirPickBtn');
  if (pickBtn) pickBtn.onclick = dpToggle;
  dpSyncHint();
}

/**
 * 输入框里的相对路径 → 底下那行提示。
 *
 * 这行是这次改动的重点：以前只有一个「目录」输入框，得自己把
 * `2026/毕业照/合影` 这种相对路径默写出来，还得记住大小写和斜杠方向。
 * 现在把它翻译成磁盘上真实的绝对路径摆出来，用户一眼能确认落点对不对。
 * 本地和云端没完全对齐时，把差异缀在后面（换暖色），别让人以为万事大吉。
 */
function dpSyncHint() {
  const el = $('#mgDirLocalTxt');
  if (!el) return;
  const pk = dirPickState();
  const input = $('#mgEditDir');
  const dir = CPLinks.normalizePath((input && input.value) || '');
  const line = el.parentElement;
  if (line) line.classList.toggle('off', !pk.ok || !pk.synced);

  if (!pk.ok) {
    el.innerHTML = '<span class="dl-note">' + escapeHtml(pk.why) + '</span>';
    return;
  }
  // 路径本身用常规色，只有「没对上」那句才染暖色 —— 整行都变黄反而看不清路径
  el.innerHTML =
    '<span class="dl-path">' + escapeHtml(absLocalPath(dir)) + '</span>' +
    (pk.synced ? '' : ' <span class="dl-note">（' + escapeHtml(pk.why) + '，选完记得同步）</span>');
}

async function dpToggle() {
  const box = $('#mgDirPick');
  if (!box) return;
  if (dp.open) {
    dpClose();
    return;
  }
  const input = $('#mgEditDir');
  dp.open = true;
  dp.dir = CPLinks.normalizePath((input && input.value) || '');
  box.innerHTML = '<div class="dirpick"><div class="dirpick-empty">正在读本地目录…</div></div>';
  await dpRender();
}

function dpClose() {
  dp.open = false;
  const box = $('#mgDirPick');
  if (box) box.innerHTML = '';
}

/** 画出面板：面包屑 + 当前目录的子文件夹 */
async function dpRender() {
  const box = $('#mgDirPick');
  if (!box || !dp.open) return;
  const dir = dp.dir;

  let dirs = [];
  let failed = '';
  try {
    const res = await window.cloudpic.cloud.list({ dir: dir, source: 'local' });
    dirs = (res.items || []).filter((i) => i.type === 'dir');
    dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  } catch (e) {
    failed = e.message || String(e);
  }
  // 读盘期间用户又翻到别处了 → 这次结果作废，别把旧目录的内容画上去
  if (!dp.open || dp.dir !== dir) return;

  const segs = dir.split('/').filter(Boolean);
  let crumb =
    '<button type="button" data-go=""' + (segs.length ? '' : ' class="last"') + '>仓库根目录</button>';
  let acc = '';
  segs.forEach((s, i) => {
    acc = acc ? acc + '/' + s : s;
    const last = i === segs.length - 1;
    crumb +=
      '<span class="sep">/</span>' +
      '<button type="button" data-go="' + escapeHtml(acc) + '"' + (last ? ' class="last"' : '') + '>' +
      escapeHtml(s) +
      '</button>';
  });

  const rows = dirs.length
    ? dirs
        .map(
          (d) =>
            '<div class="dirpick-row" data-go="' + escapeHtml(d.path) + '">' +
            '<span class="fi dp-dir">' + fileIcon(d.name, { isDir: true }) + '</span>' +
            '<span class="nm">' + escapeHtml(d.name) + '</span>' +
            '<button type="button" class="btn btn-ghost pick" data-pick="' + escapeHtml(d.path) + '">选它</button>' +
            '</div>'
        )
        .join('')
    : '<div class="dirpick-empty">' +
      (failed ? escapeHtml(friendlyError(failed)) : '这个目录下没有子文件夹') +
      '</div>';

  box.innerHTML =
    '<div class="dirpick">' +
    '<div class="dirpick-bar">' +
    '<span class="dirpick-crumb">' + crumb + '</span>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="mgDirPickUp"' +
    (dir ? '' : ' disabled') +
    '>上级</button>' +
    '</div>' +
    '<div class="dirpick-list">' + rows + '</div>' +
    '<div class="dirpick-foot">' +
    '<span>点目录进下一层，「选它」直接采用</span>' +
    '<button type="button" class="btn btn-primary btn-sm" id="mgDirPickHere">选当前文件夹</button>' +
    '</div>' +
    '</div>';

  box.querySelectorAll('[data-go]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      if (ev.target.closest('[data-pick]')) return;
      dp.dir = el.dataset.go || '';
      dpRender();
    });
  });
  box.querySelectorAll('[data-pick]').forEach((el) => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      dpChoose(el.dataset.pick || '');
    });
  });
  const up = $('#mgDirPickUp');
  if (up) {
    up.onclick = () => {
      const parts = dp.dir.split('/').filter(Boolean);
      parts.pop();
      dp.dir = parts.join('/');
      dpRender();
    };
  }
  const here = $('#mgDirPickHere');
  if (here) here.onclick = () => dpChoose(dp.dir);
}

/** 采用某个目录：写回输入框、刷新本地路径提示、收起面板 */
function dpChoose(dir) {
  const input = $('#mgEditDir');
  if (input) input.value = dir || '';
  dpClose();
  dpSyncHint();
}

async function runRename(targets, multi, handle) {
  const dir = CPLinks.normalizePath($('#mgEditDir').value || '');
  const items = [];
  for (const t of targets) {
    const name = multi ? t.name : ($('#mgEditName').value || '').trim();
    if (!name) {
      err('文件名不能为空');
      return;
    }
    if (/[\\/]/.test(name)) {
      err('文件名里不能带斜杠，目录请填在上面的输入框里');
      return;
    }
    items.push({ from: t.path, to: dir ? dir + '/' + name : name });
  }
  if (items.every((it) => it.from === it.to)) {
    warn('路径没有变化');
    return;
  }
  if (items.some((it) => it.from === it.to)) {
    err('部分文件的目标路径和原路径相同，请改名或换目录');
    return;
  }
  await renameLocal(items, handle);
}

async function renameLocal(items, handle) {
  let done = 0;
  const failures = [];
  for (const it of items) {
    try {
      await window.cloudpic.fs.localRename(it);
      done += 1;
    } catch (e) {
      failures.push(it.from + '：' + (e.message || String(e)));
    }
  }
  if (done) {
    if (handle) handle.close();
    ok('已在本地完成 ' + done + ' 项改动');
    toast('本地文件已改好，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
    view.selected.clear();
    await load();
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
  }
  if (failures.length) err(failures[0] + (failures.length > 1 ? '（另有 ' + (failures.length - 1) + ' 项失败）' : ''));
}

function doReplace(target) {
  if (!target) {
    warn('请先选择一个文件');
    return;
  }
  replaceTarget = target;
  const input = $('#mgReplaceInput');
  input.value = '';
  input.click();
}

async function applyReplace(target, file) {
  const yes = await confirmDialog(
    '替换文件内容',
    '用本地文件覆盖：\n\n' +
      file.name +
      '（' +
      CPLinks.formatBytes(file.size) +
      '）\n↓\n' +
      target.path +
      '\n\n' +
      '本地文件会被直接覆盖，改动需要通过「提交并推送」同步到云端',
    '确认替换'
  );
  if (!yes) return;

  try {
    const buf = await file.arrayBuffer();
    const data = await bytesToBase64(buf);
    await window.cloudpic.fs.localWrite({ path: target.path, data: data });
    ok('已在本地替换 ' + target.name);
    toast('本地文件已改好，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
    await load();
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
  } catch (e) {
    err(e.message || String(e));
  }
}

/* ---------------------------------------------------------------- 删除 */

async function removeOne(sel) {
  if (!sel.length) return;
  const paths = sel.map((i) => i.path);
  const yes = await confirmDialog(
    '确认删除',
    '将删除 ' + sel.length + ' 个文件：\n\n' +
      paths.slice(0, 8).join('\n') +
      (paths.length > 8 ? '\n… 以及另外 ' + (paths.length - 8) + ' 个' : '') +
      '\n\n' +
      '本地文件会被删除，需要「提交并推送」才会同步到云端',
    '确认删除'
  );
  if (!yes) return;

  const btn = $('#btnMgDelete');
  const old = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '删除中…';
  }
  try {
    const res = await window.cloudpic.fs.localDelete({ paths: paths });
    const list = res.results || [];
    const okN = list.filter((r) => r.ok).length;
    if (okN) {
      ok('已在本地删除 ' + okN + ' 个文件');
      toast('本地文件已删除，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
    }
    const failed = list.filter((r) => !r.ok);
    if (failed.length) err(failed[0].error || '部分删除失败');
    view.selected.clear();
    await load();
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
  } catch (e) {
    err(e.message || String(e));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old || '删除';
    }
  }
}

/* ---------------------------------------------------------------- 同步 */

async function pushLocal() {
  const btn = $('#btnMgPush');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '推送中…';
  }
  try {
    const r = await window.cloudpic.git.commit({});
    if (r.ok) {
      ok(r.message || '已推送到云端');
      await load();
    } else err(r.message);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '提交并推送';
    }
  }
}

async function pullLatest() {
  const btn = $('#btnMgPull');
  btn.classList.add('active');
  try {
    const r = await window.cloudpic.git.pull();
    if (r.skipped) warn(r.message);
    else if (r.ok) {
      ok('已同步：' + r.message);
      await load();
    } else err(r.message);
  } catch (e) {
    err(e.message || String(e));
  } finally {
    btn.classList.remove('active');
  }
}

/* ---------------------------------------------------------------- 事件 */

function bind() {
  const detectBtn = $('#btnMgDetect');
  if (detectBtn) detectBtn.onclick = () => refreshCloudDetect(true);
  $('#breadcrumb').addEventListener('click', (e) => {
    const b = e.target.closest('.bc-item');
    if (b) navigate(b.dataset.path);
  });

  $('#mgSearch').addEventListener(
    'input',
    debounce(() => {
      view.search = $('#mgSearch').value;
      view.shown = PAGE;
      renderGrid();
    }, 200)
  );

  $('#btnMgUp').onclick = () => {
    const parts = view.dir.split('/').filter(Boolean);
    parts.pop();
    navigate(parts.join('/'));
  };

  /*
   * 在资源管理器里打开**当前目录**（不是本地根目录）。
   * 按钮原来挂在顶栏，那会儿拿不到「当前在哪个目录」，只能开根 ——
   * 挪到这里之后按 view.dir 精确打开，人在三级目录里点它，开的就是三级目录。
   * 后端会做防穿越校验，目标还不存在时逐级往上退到最近的存在目录。
   */
  $('#btnMgOpenLocal').onclick = async () => {
    const cfg = state.cfg || {};
    if (!cfg.localDir) {
      warn('还没配置本地目录，先到设置页选一个');
      return;
    }
    if (view.source === 'remote') {
      warn('当前是「仅云端浏览」，这一份没有对应的本地目录');
      return;
    }
    try {
      await window.cloudpic.shell.openLocalDir(view.dir || '');
    } catch (e) {
      err(e.message || String(e));
    }
  };
  $('#btnMgRefresh').onclick = () => load();
  $('#btnMgPull').onclick = pullLatest;

  const head = $('#mgListHead');
  if (head) {
    head.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sort]');
      if (!b) return;
      const k = b.dataset.sort;
      if (view.sortKey === k) view.sortDir = -view.sortDir;
      else {
        view.sortKey = k;
        view.sortDir = 1;
      }
      view.shown = PAGE;
      renderGrid();
    });
  }

  $('#btnMgGrid').onclick = () => setViewMode('grid', true);
  $('#btnMgList').onclick = () => setViewMode('list', true);
  // 用上次记下的视图模式 —— 别再每次重启都退回网格。
  // paint=false：这时列表还没 load，重绘只会闪一下空状态
  setViewMode(savedViewMode(), false, false);

  $('#btnMgCopyLinks').onclick = copySelectedLinks;
  $('#btnMgCopyPath').onclick = copySelectedPaths;
  $('#btnMgExport').onclick = exportSelected;
  $('#btnMgDelete').onclick = () => removeOne(selectedFiles());
  $('#btnMgRename').onclick = () => {
    const sel = selectedFiles();
    if (!sel.length) {
      warn('请先选择文件');
      return;
    }
    openRenameDialog(sel);
  };
  $('#btnMgReplace').onclick = () => {
    const sel = selectedFiles();
    if (sel.length !== 1) {
      warn('一次只能替换一个文件的内容');
      return;
    }
    doReplace(sel[0]);
  };
  $('#btnMgClearSel').onclick = () => {
    view.selected.clear();
    renderGrid();
    updateSelectionBar();
  };

  $('#mgFormat').addEventListener('change', () => {
    state.patch({ linkFormat: $('#mgFormat').value });
  });

  // 滚动懒渲染。
  // 容器是 .mg-main **不是** .content —— 管理页把自己撑满并 overflow:hidden，
  // 滚动发生在内部的 .mg-main 里。早先监听 .content，那个 scroll 永远不触发
  // （.content 在这页根本不滚），列表就卡死在第一批 120 个 —— 杰哥 230 张
  // 只看到 120 张，就是这个。
  const scroller = $('.mg-main');
  if (scroller) {
    scroller.addEventListener('scroll', () => {
      if (scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 260) {
        const total = filtered().length;
        if (view.shown < total) {
          view.shown += PAGE;
          renderGrid();
        }
      }
    });
  }

  const grid = $('#mgGrid');
  const main = $('.mg-main');

  // 单击：只有点在复选框上才算「选中」，点条目本身不再改变选中状态
  grid.addEventListener('click', (e) => {
    // 刚拖完框选，这个 click 是鼠标松手的尾巴，别拿来改选中
    if (Date.now() < suppressClickUntil) return;
    const tile = e.target.closest('.tile');
    if (!tile) return;
    if (e.target.closest('.tile-check')) {
      toggleSelect(tile.dataset.path);
      return;
    }
    // Ctrl / Cmd + 单击：桌面上的肌肉记忆，留一条快速多选的路
    if (e.ctrlKey || e.metaKey) toggleSelect(tile.dataset.path);
  });

  // 表头的全选
  const checkAll = $('#mgCheckAll');
  if (checkAll) {
    checkAll.onclick = () => {
      const list = visibleItems();
      const allOn = list.length > 0 && list.every((i) => view.selected.has(i.path));
      setSelection(allOn ? [] : list.map((i) => i.path));
    };
  }

  /**
   * 按住左键拖动 → 框选。
   *
   * 以前只认空白处，条目身上按下去什么都不发生 —— 想框一片夹着文件的区域，
   * 得绕开每一个格子找缝下笔，很难用。现在条目上也能起手，但不能像空白处
   * 那样「按下去立刻开框」：那样单击、双击全被抢走。折中是延迟判定 ——
   * 按住不动超过 180ms，或者拖出 4px，才认定这是框选。
   */
  const HOLD_MS = 180;
  const DRAG_PX = 4;

  const beginMarquee = (e, fromTile) => {
    e.preventDefault();
    startMarquee(e, fromTile);
  };

  main.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    if (e.target.closest('.mg-listhead')) return;
    // 复选框自己处理点击。它就在角上，把它也算进拖拽起点反而点不准
    if (e.target.closest('.tile-check')) return;

    if (!e.target.closest('.tile')) {
      beginMarquee(e, false);
      return;
    }

    const sx = e.clientX;
    const sy = e.clientY;
    let fired = false;
    let timer = 0;

    function onMove(ev) {
      if (Math.abs(ev.clientX - sx) > DRAG_PX || Math.abs(ev.clientY - sy) > DRAG_PX) fire();
    }
    function stop() {
      clearTimeout(timer);
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', stop, true);
    }
    function fire() {
      if (fired) return;
      fired = true;
      stop();
      beginMarquee(e, true);
    }

    timer = setTimeout(fire, HOLD_MS);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', stop, true);
  });

  // 右键：条目上给该条目的菜单，空白处给整目录的菜单
  main.addEventListener('contextmenu', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) {
      e.preventDefault();
      contextMenu({
        x: e.clientX,
        y: e.clientY,
        title: view.dir || '仓库根目录',
        items: blankMenuItems()
      });
      return;
    }
    e.preventDefault();
    const it = findItem(tile.dataset.path);
    if (!it) return;
    // 右键的这项不在选区里 → 只选它；已经在选区里 → 保留整批，方便接着做批量操作
    if (!view.selected.has(it.path)) selectOnly(it.path);
    const multi = view.selected.size > 1;
    contextMenu({
      x: e.clientX,
      y: e.clientY,
      title: multi ? '已选 ' + view.selected.size + ' 项' : it.path,
      items: multi ? menuForSelection() : menuForItem(it)
    });
  });

  grid.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const it = findItem(tile.dataset.path);
    if (!it) return;
    if (it.type === 'dir') navigate(it.path);
    else if (isImg(it) || isText(it)) openPreview(it);
    else window.cloudpic.shell.openExternal(linkOf(it));
  });

  const rep = $('#mgReplaceInput');
  rep.addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    const target = replaceTarget;
    replaceTarget = null;
    if (!f || !target) return;
    await applyReplace(target, f);
  });
}

/* ---------------------------------------------------------------- 对外 */

export default {
  init() {
    $('#mgFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
    $('#mgFormat').value = (state.cfg && state.cfg.linkFormat) || 'markdown';
    $('#btnMgGrid').classList.add('active');
    bind();
  },

  onEnter() {
    load();
  },

  onConfigChanged() {
    $('#mgFormat').value = (state.cfg && state.cfg.linkFormat) || 'markdown';

    // 切换归档配置会同时换掉远端仓库和本地目录，管理页里缓存的列表已经失效，
    // 必须回到根目录重载。用「仓库身份串」比对，避免只改链接规则也触发重载。
    const key = identityKey();
    if (lastIdentity === null) {
      lastIdentity = key;
    } else if (key !== lastIdentity) {
      lastIdentity = key;
      navigate('');
    }
  },

  refresh() {
    load();
  }
};
