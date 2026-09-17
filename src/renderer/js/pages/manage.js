/** 文件管理页：本地目录 / 云端仓库双源浏览，两边都能改名、移动、替换内容 */

import {
  $,
  err,
  ok,
  warn,
  toast,
  modal,
  confirmDialog,
  previewImage,
  escapeHtml,
  debounce,
  pulse,
  sklTiles,
  friendlyError
} from '../lib/dom.js';
import { fileIcon, isImageName } from '../lib/fileicons.js';
import state from '../lib/state.js';

const CPLinks = window.CPLinks;
const PAGE = 120;

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a1 1 0 0 1 1-1h9"/></svg>',
  eye: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
  rename: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h16"/><path d="M14.5 4.6l4 4L9 18H5v-4z"/></svg>',
  replace: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 0 1 13.4-5.9"/><path d="M20 12a8 8 0 0 1-13.4 5.9"/><path d="M17.5 3v3.6h-3.6"/><path d="M6.5 21v-3.6h3.6"/></svg>',
  trash: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M9 7V5.2A1.2 1.2 0 0 1 10.2 4h3.6A1.2 1.2 0 0 1 15 5.2V7"/><path d="M6.5 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h6.2a1.6 1.6 0 0 0 1.6-1.5l.8-12"/></svg>'
};

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
  if (view.source === 'local') {
    return { primary: window.cloudpic.localUrl(absLocalPath(it.path)), fallback: '' };
  }
  const raw = window.cloudpic.remoteUrl(it.path);
  const proxy = CPLinks.buildProxyUrl(state.cfg, it.path);
  if (proxy) return { primary: proxy, fallback: raw };
  return { primary: it.downloadUrl || raw, fallback: raw };
}

function thumbSrc(it) {
  return previewUrls(it).primary;
}

function linkOf(it) {
  return CPLinks.buildUrl(state.cfg, it.path);
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

/* ---------------------------------------------------------------- 数据加载 */

async function load() {
  if (view.loading) return;
  view.loading = true;
  view.selected.clear();
  updateSelectionBar();
  showSkeleton();
  try {
    const cfg = state.cfg || {};
    const wantLocal = view.source === 'local';
    if (wantLocal && !cfg.localDir) {
      view.source = 'remote';
      syncSourceSeg();
      warn('尚未配置本地目录，已切换到云端浏览');
    }

    const res = await window.cloudpic.cloud.list({ dir: view.dir, source: view.source });
    view.items = res.items || [];
    view.localReady = !!res.localReady;
    view.shown = PAGE;

    if (wantLocal && res.source === 'remote') {
      view.source = 'remote';
      syncSourceSeg();
      warn('本地目录不可用（不存在或不是 Git 仓库），已切换到云端浏览');
    }
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

/** 左侧只保留「仓库根目录」+ 当前路径 + 状态 + 云端检测器，不再铺目录树 */
async function loadSide() {
  const root = $('#mgRootNode');
  root.classList.toggle('active', view.dir === '');
  $('#mgCurPath').textContent = view.dir || '仓库根目录';
  await refreshGitState();
  // 本地状态和云端比对并行不了：都要跑 git / 网络，串行更省事
  await refreshCloudDetect();
}

async function refreshGitState() {
  const box = $('#mgGitState');
  if (!box) return;
  const cfg = state.cfg || {};
  if (!cfg.localDir) {
    view.git = null;
    box.innerHTML = '<span>未配置本地目录</span><br><span class="txt">只有云端浏览，速度取决于网络</span>';
    return;
  }
  try {
    const st = await window.cloudpic.git.status();
    view.git = st;
    if (!st.isRepo) {
      view.git = null;
      box.innerHTML =
        '<span class="bad">本地目录不是 Git 仓库</span><br><span class="txt">' + escapeHtml(cfg.localDir) + '</span>';
      return;
    }
    const dirty = !!st.dirty;
    box.innerHTML =
      (dirty
        ? '<span class="bad">本地有 ' + st.changes + ' 处未提交改动</span>'
        : '<span class="ok">本地与仓库已同步</span>') +
      '<br><span class="txt">' + escapeHtml(st.branch || '?') + ' @ ' + escapeHtml(st.head || '?') + '</span>' +
      (dirty ? '<br><button class="btn btn-primary btn-sm" id="btnMgPush">提交并推送</button>' : '');
    const push = $('#btnMgPush');
    if (push) push.onclick = pushLocal;
  } catch (e) {
    view.git = null;
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

/** 两个短 SHA 并排摆出来，再配一行结论 + 动作按钮 */
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

  const localCell = d.local.isRepo
    ? '本地 <span class="sha" title="' + escapeHtml(d.local.sha || '') + '">' + escapeHtml(d.local.short || '?') + '</span>'
    : '本地 <span class="sha">未克隆</span>';
  const cloudShort = d.cloud.short || (d.cloud.ok ? '?' : '空');
  const cloudCell =
    '云端 <span class="sha" title="' + escapeHtml(d.cloud.sha || '') + '">' + escapeHtml(cloudShort) + '</span>';
  const shaLine = '<div>' + localCell + '<span class="arrow">⟷</span>' + cloudCell + '</div>';

  const MAP = {
    same: { cls: 'ok', text: '本地与云端一致', act: '' },
    'local-behind': { cls: 'bad', text: '云端更新 — 本地落后 ' + d.behind + ' 个提交', act: 'pull' },
    'local-ahead': { cls: 'bad', text: '本地更新 — 领先云端 ' + d.ahead + ' 个提交', act: 'push' },
    diverged: { cls: 'bad', text: '两边分叉：本地领先 ' + d.ahead + '、落后 ' + d.behind, act: '' },
    'no-local': { cls: '', text: '这台电脑还没克隆仓库，只能浏览云端', act: '' },
    unknown: { cls: 'bad', text: '提交历史比不出来' + (d.cloud && d.cloud.message ? '：' + d.cloud.message : ''), act: '' }
  };
  const st = MAP[d.relation] || MAP.unknown;

  let html = shaLine + '<div class="' + (st.cls || '') + '">' + escapeHtml(st.text) + '</div>';

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
  const pills = [
    '<span class="pill">' + (view.source === 'local' ? '本地目录' : '云端仓库') + '</span>',
    '<span class="pill">当前目录 ' + dirCount + ' 个文件夹 / ' + fileCount + ' 个文件</span>',
    '<span class="pill">合计 ' + CPLinks.formatBytes(bytes) + '</span>'
  ];
  if (cfg.localDir) pills.push('<span class="pill">' + escapeHtml(cfg.localDir) + '</span>');
  bar.innerHTML = pills.join('') + '<span id="mgExtra" class="pill">统计中…</span>';
  try {
    const st = await window.cloudpic.cloud.stats({ source: view.source });
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
 */
function tileHtml(it, idx) {
  const sel = view.selected.has(it.path) ? ' selected' : '';
  const i = ' style="--i:' + Math.min(idx, 22) + '"';
  const isDir = it.type === 'dir';

  let thumb;
  const img = !isDir && isImg(it);
  if (img) {
    const u = previewUrls(it);
    thumb =
      '<img loading="lazy" src="' +
      escapeHtml(u.primary) +
      '"' +
      (u.fallback ? ' data-proxy="' + escapeHtml(u.fallback) + '"' : '') +
      ' data-icon="' +
      escapeHtml(fileIcon(it.name)) +
      '" alt="" />';
  } else {
    thumb = fileIcon(it.name, { isDir: isDir });
  }

  const ops = isDir
    ? ''
    : '<div class="tile-ops">' +
      '<button data-act="copy" title="复制链接">' + ICONS.copy + '</button>' +
      '<button data-act="preview" title="预览">' + ICONS.eye + '</button>' +
      '<button data-act="rename" title="重命名 / 移动">' + ICONS.rename + '</button>' +
      '<button data-act="replace" title="用新文件替换内容">' + ICONS.replace + '</button>' +
      '<button data-act="delete" class="danger" title="删除">' + ICONS.trash + '</button>' +
      '</div>';

  return (
    '<div class="tile' + sel + '"' + i + ' data-path="' + escapeHtml(it.path) + '" data-type="' + it.type + '">' +
    '<div class="tile-check">✓</div>' +
    '<div class="tile-thumb">' + thumb + '</div>' +
    '<div class="tile-name" title="' + escapeHtml(it.path) + '">' + escapeHtml(it.name) + '</div>' +
    '<div class="tile-size">' + (isDir ? '文件夹' : CPLinks.formatBytes(it.size || 0)) + '</div>' +
    (view.hasTime ? '<div class="tile-time">' + (isDir ? '—' : fmtTime(it.mtime)) + '</div>' : '') +
    ops +
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

function syncSourceSeg() {
  document.querySelectorAll('#sourceSeg button').forEach((b) => {
    b.classList.toggle('active', b.dataset.source === view.source);
  });
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
  const r = await window.cloudpic.fs.exportText({ content: txt, defaultName: 'jie-filelist.txt' });
  if (r.ok) ok('已导出到 ' + r.filePath);
}

/* ---------------------------------------------------------------- 改名 / 移动 */

function openRenameDialog(targets) {
  const multi = targets.length > 1;
  const first = targets[0];
  const box = document.createElement('div');
  box.innerHTML =
    '<p class="rule-desc" style="margin:0 0 12px">' +
    (multi
      ? '把选中的 <b>' + targets.length + '</b> 个文件移动到同一个目录；留空即仓库根目录。'
      : '改目录 = 移动，改文件名 = 重命名，两个一起改也可以。') +
    '</p>' +
    '<label class="field"><span class="field-label">目录 <span class="hint">相对仓库根目录</span></span>' +
    '<input type="text" id="mgEditDir" placeholder="留空 = 仓库根目录" value="' +
    escapeHtml(multi ? view.dir : dirOf(first.path)) +
    '" /></label>' +
    (multi
      ? ''
      : '<label class="field"><span class="field-label">文件名</span>' +
        '<input type="text" id="mgEditName" value="' + escapeHtml(baseOf(first.path)) + '" /></label>') +
    '<div class="callout" style="margin-bottom:0">' +
    (view.source === 'local'
      ? '本地目录会直接改名；改完后记得在左侧点「提交并推送」把改动同步到云端。'
      : ((state.cfg || {}).platform === 'cnb'
          ? 'CNB 的写入通过本地 Git 提交推送完成，整批只产生一次提交。'
          : '云端会重新写一份内容并删除旧路径，整批只产生一次提交，是原子的')) +
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
  if (view.source === 'local') await renameLocal(items, handle);
  else await renameRemote(items, handle);
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

async function renameRemote(items, handle) {
  try {
    const res = await window.cloudpic.cloud.move({ items: items });
    const list = res.results || [];
    const okN = list.filter((r) => r.ok).length;
    const failed = list.filter((r) => !r.ok);
    if (okN) {
      if (handle) handle.close();
      ok('已移动 / 改名 ' + okN + ' 项');
    }
    if (failed.length) err(failed[0].error || '操作失败');
    if (!list.length && res.message) err(res.message);
    if (res.sync && !res.sync.skipped) {
      if (res.sync.ok) toast('本地目录已同步', 'ok');
      else warn('云端已更新，但本地同步失败：' + res.sync.message);
    }
    view.selected.clear();
    await load();
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
  } catch (e) {
    err(e.message || String(e));
  }
}

/* ---------------------------------------------------------------- 替换内容 */

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
      (view.source === 'local'
        ? '本地文件会被直接覆盖，改动需要通过「提交并推送」同步到云端。'
        : '云端会写入一次新提交，旧内容仍可在 Git 历史里找回。'),
    '确认替换'
  );
  if (!yes) return;

  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    if (view.source === 'local') {
      await window.cloudpic.fs.localWrite({ path: target.path, data: bytes });
      ok('已在本地替换 ' + target.name);
      toast('本地文件已改好，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
    } else {
      const res = await window.cloudpic.cloud.replace({ path: target.path, data: bytes });
      if (res && res.ok) ok('已替换 ' + target.path);
      else {
        err((res && res.message) || '替换失败');
        return;
      }
      if (res.sync && !res.sync.skipped) {
        if (res.sync.ok) toast('本地目录已同步', 'ok');
        else warn('云端已更新，但本地同步失败：' + res.sync.message);
      }
    }
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
      (view.source === 'local'
        ? '本地文件会被删除，需要「提交并推送」才会同步到云端。'
        : '云端会写入一次删除提交，无法撤销（Git 历史里仍可找回）。'),
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
    if (view.source === 'local') {
      const res = await window.cloudpic.fs.localDelete({ paths: paths });
      const list = res.results || [];
      const okN = list.filter((r) => r.ok).length;
      if (okN) {
        ok('已在本地删除 ' + okN + ' 个文件');
        toast('本地文件已删除，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
      }
      const failed = list.filter((r) => !r.ok);
      if (failed.length) err(failed[0].error || '部分删除失败');
    } else {
      const res = await window.cloudpic.cloud.remove({ paths: paths });
      const list = res.results || [];
      const okN = list.filter((r) => r.ok).length;
      if (okN) ok('已删除 ' + okN + ' 个文件');
      const failed = list.filter((r) => !r.ok);
      if (failed.length) err('有 ' + failed.length + ' 个删除失败：' + failed[0].error);
      if (res.sync && !res.sync.skipped) {
        if (res.sync.ok) toast('本地目录已同步', 'ok');
        else warn('本地同步失败：' + res.sync.message);
      }
    }
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
  document.querySelectorAll('#sourceSeg button').forEach((b) => {
    b.onclick = () => {
      if (view.source === b.dataset.source) return;
      view.source = b.dataset.source;
      view.dir = '';
      syncSourceSeg();
      load();
    };
  });

  $('#breadcrumb').addEventListener('click', (e) => {
    const b = e.target.closest('.bc-item');
    if (b) navigate(b.dataset.path);
  });

  $('#mgRootNode').onclick = () => navigate('');

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
  $('#btnMgRefresh').onclick = () => load();
  $('#btnMgPull').onclick = pullLatest;
  const detectBtn = $('#btnMgDetect');
  if (detectBtn) detectBtn.onclick = () => refreshCloudDetect(true);

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

  $('#btnMgGrid').onclick = () => {
    view.mode = 'grid';
    $('#btnMgGrid').classList.add('active');
    $('#btnMgList').classList.remove('active');
    renderGrid();
  };
  $('#btnMgList').onclick = () => {
    view.mode = 'list';
    $('#btnMgList').classList.add('active');
    $('#btnMgGrid').classList.remove('active');
    renderGrid();
  };

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

  // 滚动懒渲染
  $('.content').addEventListener('scroll', () => {
    const c = $('.content');
    if (c.scrollTop + c.clientHeight > c.scrollHeight - 260) {
      const total = filtered().length;
      if (view.shown < total) {
        view.shown += PAGE;
        renderGrid();
      }
    }
  });

  const grid = $('#mgGrid');
  grid.addEventListener('click', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    const path = tile.dataset.path;
    const it = view.items.find((i) => i.path === path);

    const opBtn = e.target.closest('.tile-ops button');
    if (opBtn) {
      e.stopPropagation();
      if (!it) return;
      const act = opBtn.dataset.act;
      if (act === 'copy') {
        const fmt = $('#mgFormat').value || 'markdown';
        window.cloudpic.clipboard
          .write(CPLinks.formatLink(linkOf(it), fmt, it.name, isImg(it)))
          .then(() => ok('已复制链接'));
      } else if (act === 'preview') {
        previewImage(thumbSrc(it), it.path);
      } else if (act === 'rename') {
        openRenameDialog([it]);
      } else if (act === 'replace') {
        doReplace(it);
      } else if (act === 'delete') {
        removeOne([it]);
      }
      return;
    }

    if (path === undefined) return;
    if (view.selected.has(path)) view.selected.delete(path);
    else view.selected.add(path);
    tile.classList.toggle('selected', view.selected.has(path));
    updateSelectionBar();
  });

  grid.addEventListener('dblclick', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile || e.target.closest('.tile-ops')) return;
    const it = view.items.find((i) => i.path === tile.dataset.path);
    if (!it) return;
    if (it.type === 'dir') navigate(it.path);
    else if (isImg(it)) previewImage(thumbSrc(it), it.path);
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
    syncSourceSeg();
  },

  onEnter() {
    const cfg = state.cfg || {};
    if (cfg.localDir) {
      window.cloudpic.git.status().then((s) => {
        view.source = s.isRepo ? 'local' : 'remote';
        syncSourceSeg();
        load();
      });
    } else {
      view.source = 'remote';
      syncSourceSeg();
      load();
    }
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
      view.source = state.cfg && state.cfg.localDir ? 'local' : 'remote';
      // 换了仓库，检测器的结论作废，重来一次
      view.cloud = null;
      lastDetectAt = 0;
      syncSourceSeg();
      navigate('');
    }
  },

  refresh() {
    load();
  }
};
