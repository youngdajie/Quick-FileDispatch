/** 上传页 */

import { $, toast, err, ok, warn, modal, previewImage, escapeHtml, debounce, pulse, friendlyError } from '../lib/dom.js';
import state from '../lib/state.js';
import { CompressPool, defaultThreads, fileToArrayBuffer, buildFileName } from '../lib/compress.js';
// 前后对比（含 OUT_MIME / canCompare / openCompare）已提到共享模块，
// 主上传页与「上传到此文件夹」mini 弹窗共用一份
import { canCompare, openCompare } from '../lib/compare.js';

const CPLinks = window.CPLinks;

let pool = null;
let seq = 0;
const queue = [];
const nodes = new Map();
let running = false;
let processTimer = null;

/* ---------------------------------------------------------------- 队列数据结构 */

function newItem(file) {
  const name = file.name || `file-${Date.now()}`;
  return {
    id: ++seq,
    file: file,
    origName: name,
    origSize: file.size || 0,
    isImage: looksLikeImage(name, file.type),
    previewUrl: '',
    status: 'pending',
    outName: '',
    outBuffer: null,
    outSize: 0,
    passthrough: false,
    outW: 0,
    outH: 0,
    srcW: 0,
    srcH: 0,
    quality: 0,
    note: '',
    error: '',
    path: '',
    url: ''
  };
}

const IMG_RE = /\.(jpe?g|png|gif|webp|bmp|svg|avif|ico|tiff?|jfif)$/i;

function looksLikeImage(name, mime) {
  if (mime && mime.indexOf('image/') === 0) return true;
  return IMG_RE.test(name || '');
}

/* ---------------------------------------------------------------- 列表渲染 */

const STATUS_TEXT = {
  pending: '等待',
  compressing: '压缩中',
  ready: '就绪',
  uploading: '上传中',
  done: '已上传',
  error: '失败'
};

function statusClass(it) {
  if (it.status === 'done') return 'ok';
  if (it.status === 'error') return 'err';
  if (it.status === 'compressing' || it.status === 'uploading') return 'run';
  return '';
}

const REMOVE_SVG = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

function ensureNode(it) {
  let el = nodes.get(it.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'q-item';
  el.dataset.id = String(it.id);
  el.style.setProperty('--i', String(Math.min(nodes.size, 18)));
  el.innerHTML =
    '<div class="q-thumb"></div>' +
    '<div class="q-info"><div class="q-name"></div><div class="q-meta"></div></div>' +
    '<div class="q-status"></div>' +
    '<button class="icon-btn sm" data-act="remove" title="移出队列">' + REMOVE_SVG + '</button>';
  el.querySelector('[data-act="remove"]').onclick = () => {
    if (running) return;
    removeItem(it.id);
  };
  $('#queueList').appendChild(el);
  nodes.set(it.id, el);
  return el;
}

function updateItem(it) {
  const el = ensureNode(it);
  const thumb = el.querySelector('.q-thumb');
  if (it.previewUrl) {
    thumb.style.backgroundImage = 'url("' + it.previewUrl + '")';
    thumb.textContent = '';
  } else if (!thumb.textContent) {
    thumb.textContent = (CPLinks.extOf(it.origName) || 'file').toUpperCase().slice(0, 4);
    thumb.classList.add('ext');
  }
  const nameEl = el.querySelector('.q-name');
  nameEl.textContent = it.outName || it.origName;
  nameEl.title = (it.path ? it.path + '  ·  ' : '') + (it.outName || it.origName);

  const parts = [CPLinks.formatBytes(it.origSize)];
  if (it.outSize && it.outSize !== it.origSize) {
    const saved = it.origSize - it.outSize;
    const pct = Math.round((saved / it.origSize) * 100);
    parts.push('→');
    parts.push('<span class="' + (saved > 0 ? 'good' : 'bad') + '">' + CPLinks.formatBytes(it.outSize) + '</span>');
    parts.push('<span class="' + (pct > 0 ? 'good' : 'bad') + '">' + (pct > 0 ? '-' + pct : '+' + Math.abs(pct)) + '%</span>');
  }
  if (it.outW) {
    if (it.srcW && (it.outW !== it.srcW || it.outH !== it.srcH)) parts.push(it.srcW + '×' + it.srcH + ' → ' + it.outW + '×' + it.outH);
    else parts.push(it.outW + '×' + it.outH);
  }
  if (it.quality && !it.passthrough) parts.push('q' + it.quality);
  if (it.note) parts.push(escapeHtml(it.note));
  el.querySelector('.q-meta').innerHTML = parts.join(' ');

  const st = el.querySelector('.q-status');
  st.className = 'q-status ' + statusClass(it);
  st.textContent = STATUS_TEXT[it.status] || it.status;
  st.title = it.error || '';
  return el;
}

function refreshTotals() {
  const orig = queue.reduce((a, b) => a + b.origSize, 0);
  const now = queue.reduce((a, b) => a + (b.outSize || b.origSize), 0);
  const prev = refreshTotals.__prev || { count: -1, new: '' };
  const cntEl = $('#queueCount');
  const newEl = $('#queueNew');
  const origEl = $('#queueOrig');
  const newTxt = CPLinks.formatBytes(now);

  cntEl.textContent = String(queue.length);
  origEl.textContent = CPLinks.formatBytes(orig);
  newEl.textContent = newTxt;
  if (String(prev.count) !== String(queue.length)) pulse(cntEl);
  if (prev.new && prev.new !== newTxt) pulse(newEl);
  refreshTotals.__prev = { count: queue.length, new: newTxt };

  const saved = orig - now;
  const tag = $('#queueSave');
  if (saved > 0 && queue.some((q) => q.outSize)) {
    tag.hidden = false;
    tag.textContent = '省下 ' + CPLinks.formatBytes(saved) + ' · ' + Math.round((saved / orig) * 100) + '%';
  } else {
    tag.hidden = true;
  }
  $('#queuePanel').hidden = queue.length === 0;
}

/* ---------------------------------------------------------------- 增删 */

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => !f.name || !/^\./.test(f.name));
  if (!files.length) {
    warn('没有拿到可用的文件');
    return [];
  }
  const added = [];
  for (const f of files) {
    const it = newItem(f);
    if (it.isImage) {
      try {
        it.previewUrl = URL.createObjectURL(f);
      } catch (e) {
        it.previewUrl = '';
      }
    }
    queue.push(it);
    added.push(it);
    updateItem(it);
  }
  refreshTotals();
  scheduleProcess();
  return added;
}

function removeItem(id) {
  const idx = queue.findIndex((q) => q.id === id);
  if (idx < 0) return;
  const it = queue.splice(idx, 1)[0];
  if (it.previewUrl) URL.revokeObjectURL(it.previewUrl);
  const el = nodes.get(id);
  if (el) el.remove();
  nodes.delete(id);
  refreshTotals();
}

function clearQueue() {
  while (queue.length) removeItem(queue[0].id);
  $('#resultPanel').hidden = true;
  $('#resultList').innerHTML = '';
}

/* ---------------------------------------------------------------- 压缩 */

function poolSize() {
  const c = Number(state.cfg && state.cfg.concurrency) || 0;
  return c > 0 ? Math.min(32, c) : defaultThreads();
}

function compressOptions() {
  const c = state.cfg || {};
  const cmp = c.compress || {};
  return {
    quality: Number($('#upQuality').value) || 80,
    maxWidth: Number(cmp.maxWidth) || 0,
    maxHeight: Number(cmp.maxHeight) || 0,
    format: $('#upFormat').value || 'auto',
    targetSizeKB: Number(cmp.targetSizeKB) || 0,
    skipIfSmaller: cmp.skipIfSmaller !== false,
    watermark: c.watermark || { enabled: false }
  };
}

function ensurePool() {
  const size = poolSize();
  if (!pool || pool.size !== size) {
    if (pool) pool.terminate();
    pool = new CompressPool(size);
  }
  return pool;
}

/** 设置变化时把「就绪」的文件退回待处理，让它们按新参数重算 */
function invalidate() {
  queue.forEach((it) => {
    if (it.status === 'done') return;
    it.outBuffer = null;
    it.outSize = 0;
    it.outW = 0;
    it.outH = 0;
    it.quality = 0;
    it.note = '';
    it.status = 'pending';
    updateItem(it);
  });
  refreshTotals();
}

function scheduleProcess(delay) {
  clearTimeout(processTimer);
  processTimer = setTimeout(() => {
    processPending().catch((e) => err('压缩失败：' + friendlyError(e && e.message)));
  }, delay == null ? 160 : delay);
}

async function processPending() {
  const targets = queue.filter((it) => it.status !== 'done' && !it.outBuffer);
  if (!targets.length) return;

  const useCompress = $('#upCompress').checked;
  const mode = $('#upRenameMode').value || 'keep';
  const prefix = $('#upPrefix').value || '';
  const hashLen = (state.cfg && state.cfg.rename && state.cfg.rename.hashLength) || 8;
  const opts = compressOptions();
  const lim = CPLinks.limitOf((state.cfg || {}).platform);
  const cpool = ensurePool();

  const prog = $('#upProgress');
  const bar = $('#upProgressBar');
  prog.hidden = false;
  let done = 0;
  const tick = () => {
    done += 1;
    bar.style.width = Math.round((done / targets.length) * 100) + '%';
    if (done >= targets.length) setTimeout(() => { prog.hidden = true; }, 420);
  };

  await Promise.all(
    targets.map(async (it) => {
      it.status = 'compressing';
      updateItem(it);
      try {
        const buf = await fileToArrayBuffer(it.file);
        const origExt = CPLinks.extOf(it.origName);

        if (buf.byteLength > lim.maxFile) {
          throw new Error(
            CPLinks.formatBytes(buf.byteLength) + ' 超过 ' + lim.name + ' 单文件上限（' + CPLinks.formatBytes(lim.maxFile) + '）'
          );
        }

        if (!useCompress || !it.isImage) {
          it.outBuffer = buf;
          it.outSize = buf.byteLength;
          it.passthrough = true;
          it.note = it.isImage ? '未压缩' : '非图片，原样上传';
          it.outName = await buildFileName(it.origName, mode, prefix, buf, origExt, hashLen);
        } else {
          const res = await cpool.run(it.origName, buf, opts);
          it.outBuffer = res.buffer;
          it.outSize = res.buffer.byteLength;
          it.passthrough = !!res.passthrough;
          it.outW = res.width || 0;
          it.outH = res.height || 0;
          it.srcW = res.srcWidth || res.width || 0;
          it.srcH = res.srcHeight || res.height || 0;
          it.quality = res.quality || 0;
          it.note = res.reason || '';
          const outExt = res.passthrough ? origExt : res.ext || origExt;
          it.outName = await buildFileName(it.origName, mode, prefix, res.buffer, outExt, hashLen);
        }
        if (it.outSize > lim.maxFile) {
          throw new Error('处理后仍有 ' + CPLinks.formatBytes(it.outSize) + '，超过平台单文件上限');
        }
        it.status = 'ready';
      } catch (e) {
        it.status = 'error';
        it.error = friendlyError(e.message || String(e));
        it.outSize = 0;
      }
      updateItem(it);
      refreshTotals();
      tick();
    })
  );
}

/* ---------------------------------------------------------------- 前后对比 */
// OUT_MIME / canCompare / openCompare 已提到 ../lib/compare.js（见文件顶部 import）。

/**
 * 点缩略图：能对比就拉对比，否则退回普通放大预览。
 * 队列和结果两处共用 —— 两边的判断条件本来就是一回事。
 */
function openThumbFor(id) {
  const it = queue.find((q) => String(q.id) === String(id));
  if (!it || !it.previewUrl) return false;
  if (canCompare(it)) openCompare(it);
  else previewImage(it.previewUrl);
  return true;
}

/* ---------------------------------------------------------------- 上传 */

function resultUrl(it) {
  return CPLinks.buildUrl(state.cfg, it.path);
}

async function doUpload() {
  if (!state.configured) {
    err('请先在「设置」里完成仓库与 Token 配置');
    return;
  }
  const ready = queue.filter((q) => q.outBuffer && q.status !== 'error' && q.status !== 'done');
  if (!ready.length) {
    err('队列里没有待上传的图片');
    return;
  }
  running = true;
  $('#btnUpload').disabled = true;
  ready.forEach((it) => {
    it.status = 'uploading';
    updateItem(it);
  });

  const files = ready.map((it) => {
    const u8 = new Uint8Array(it.outBuffer);
    it.outBuffer = null;
    return { name: it.outName, data: u8 };
  });
  const dir = CPLinks.normalizePath($('#upDir').value || '');

  try {
    const res = await window.cloudpic.cloud.upload({ files: files, dir: dir });
    const byName = new Map();
    (res.results || []).forEach((r) => byName.set(r.name, r));

    ready.forEach((it) => {
      const r = byName.get(it.outName);
      if (r && r.ok) {
        it.status = 'done';
        it.path = r.path;
        it.url = resultUrl(it);
        it.error = '';
      } else {
        it.status = 'error';
        it.error = (r && r.error) || '上传失败';
      }
      updateItem(it);
    });
    refreshTotals();
    renderResults();

    if (res.uploaded) ok('成功上传 ' + res.uploaded + ' 张' + (res.failed ? '，失败 ' + res.failed + ' 张' : ''));
    else err('上传失败，请查看下方结果里的错误信息');

    if (res.sync && !res.sync.skipped) {
      if (res.sync.ok) toast('本地目录已同步：' + res.sync.message, 'ok');
      else warn('云端已更新，但本地同步失败：' + res.sync.message);
    }
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));
  } catch (e) {
    ready.forEach((it) => {
      it.status = 'error';
      it.error = e.message || String(e);
      updateItem(it);
    });
    err(e.message || String(e));
  } finally {
    running = false;
    $('#btnUpload').disabled = false;
  }
}

/* ---------------------------------------------------------------- 结果面板 */

function fmtLabel(fmt) {
  if (fmt === 'url') return '链接';
  if (fmt === 'markdown') return 'Markdown';
  if (fmt === 'html') return 'HTML';
  return 'BBCode';
}

function renderResults() {
  const list = $('#resultList');
  const panel = $('#resultPanel');
  const done = queue.filter((q) => q.status === 'done' || q.status === 'error');
  if (!done.length) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const fmt = $('#resultFormat').value || (state.cfg && state.cfg.linkFormat) || 'markdown';
  list.innerHTML = done
    .map((it, idx) => {
      if (it.status === 'error') {
        return (
          '<div class="r-item fail" style="--i:' + Math.min(idx, 18) + '">' +
          '<div class="r-thumb"></div>' +
          '<div class="r-info"><div class="r-path">' + escapeHtml(it.outName || it.origName) + '</div>' +
          '<div class="r-err">' + escapeHtml(it.error) + '</div></div></div>'
        );
      }
      const link = CPLinks.formatLink(it.url, fmt, it.outName, it.isImage);
      const thumb = it.previewUrl
        ? '<div class="r-thumb" style="background-image:url(\'' + it.previewUrl + '\')"></div>'
        : '<div class="r-thumb ext">' + escapeHtml((CPLinks.extOf(it.outName) || 'file').toUpperCase().slice(0, 4)) + '</div>';
      return (
        '<div class="r-item" data-id="' + it.id + '" style="--i:' + Math.min(idx, 18) + '">' + thumb +
        '<div class="r-info"><div class="r-path">' + escapeHtml(it.path) + '</div>' +
        '<div class="r-link" title="' + escapeHtml(link) + '">' + escapeHtml(link) + '</div></div>' +
        '<div class="queue-actions">' +
        '<button class="btn btn-ghost btn-sm" data-act="copy-url" data-id="' + it.id + '">复制链接</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="copy-fmt" data-id="' + it.id + '">复制 ' + fmtLabel(fmt) + '</button>' +
        '<button class="btn btn-ghost btn-sm" data-act="view" data-id="' + it.id + '">打开</button>' +
        '</div></div>'
      );
    })
    .join('');
}

function bindResultActions() {
  $('#resultList').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const it = queue.find((q) => String(q.id) === btn.dataset.id);
      if (!it) return;
      const fmt = $('#resultFormat').value || 'markdown';
      if (btn.dataset.act === 'view') {
        window.cloudpic.shell.openExternal(it.url);
        return;
      }
      const text = btn.dataset.act === 'copy-url' ? it.url : CPLinks.formatLink(it.url, fmt, it.outName, it.isImage);
      await window.cloudpic.clipboard.write(text);
      ok('已复制');
      return;
    }
    const t = e.target.closest('.r-thumb');
    if (t && t.style.backgroundImage) {
      const item = e.target.closest('.r-item');
      if (item && item.dataset.id) openThumbFor(item.dataset.id);
    }
  });
}

function allResultLinks() {
  const fmt = $('#resultFormat').value || 'markdown';
  return queue
    .filter((q) => q.status === 'done')
    .map((q) => CPLinks.formatLink(resultUrl(q), fmt, q.outName, q.isImage))
    .join('\n');
}

/* ---------------------------------------------------------------- 配置联动 */

/** 上传页顶部必须写清楚：这批文件到底会被推到哪里 */
function fillTarget() {
  const c = state.cfg || {};
  const okRepo = !!(c.owner && c.repo);
  const lim = CPLinks.limitOf(c.platform);

  $('#utPlatform').textContent = c.platform === 'cnb' ? 'CNB' : 'GITHUB';
  $('#utRepo').textContent = okRepo ? c.owner + '/' + c.repo + ' @ ' + (c.branch || 'main') : '未配置仓库';

  const box = $('#upTarget');
  // 左侧竖条与平台的 pill 都跟着平台主色走（GitHub 蓝 / CNB 橙红，见 app.css 的 [data-platform]）
  box.dataset.platform = c.platform === 'cnb' ? 'cnb' : 'github';
  const st = $('#utState');
  if (!okRepo) {
    box.classList.add('warn');
    st.className = 'ut-state bad';
    st.textContent = '尚未选择仓库';
  } else if (!c.hasToken) {
    box.classList.add('warn');
    st.className = 'ut-state bad';
    st.textContent = '缺少访问令牌';
  } else {
    box.classList.remove('warn');
    st.className = 'ut-state ok';
    st.textContent = '已就绪 · 单文件上限 ' + CPLinks.formatBytes(lim.maxFile);
  }
}

function fillOptions() {
  const c = state.cfg || {};
  const cmp = c.compress || {};
  const ren = c.rename || {};
  const lim = CPLinks.limitOf(c.platform);

  fillTarget();

  $('#upCompress').checked = cmp.enabled !== false;
  $('#upQuality').value = cmp.quality || 80;
  $('#upQualityVal').textContent = String(cmp.quality || 80);
  $('#upFormat').value = cmp.format || 'auto';
  $('#upRenameMode').value = ren.mode || 'keep';
  $('#upPrefix').value = ren.prefix || '';
  if (document.activeElement !== $('#upDir')) $('#upDir').value = c.lastUploadDir || '';

  $('#dzHint').textContent =
    '图片会被本地压缩，其他文件原样上传 · 单次不限数量 · ' + lim.name + ' ' + lim.note;
  $('#quotaChip').innerHTML = '<b>' + escapeHtml(lim.name) + '</b>' + escapeHtml(lim.note);
  $('#quotaChip').title = '程序本身不设上限，这几条是平台官方红线';
}

const persistQuickOptions = debounce(() => {
  state.patch({
    lastUploadDir: CPLinks.normalizePath($('#upDir').value || ''),
    compress: {
      enabled: $('#upCompress').checked,
      quality: Number($('#upQuality').value),
      format: $('#upFormat').value
    },
    rename: {
      mode: $('#upRenameMode').value,
      prefix: $('#upPrefix').value
    }
  });
}, 500);

/* ---------------------------------------------------------------- 云端目录选择 */

/**
 * 目标目录不该靠手打。点「浏览云端…」直接列出现有目录，逐层点进去，
 * 选中的路径写回 #upDir —— 和手动输入完全等价（同一个 input）。
 */
let pickDir = '';

function dpCrumbs() {
  const box = $('#dpCrumbs');
  if (!box) return;
  const parts = pickDir ? pickDir.split('/').filter(Boolean) : [];
  const out = [
    '<button type="button" class="dir-crumb' + (parts.length ? '' : ' last') + '" data-dir="">仓库根目录</button>'
  ];
  let acc = '';
  parts.forEach((seg, i) => {
    acc = acc ? acc + '/' + seg : seg;
    out.push('<span class="dir-sep">/</span>');
    out.push(
      '<button type="button" class="dir-crumb' + (i === parts.length - 1 ? ' last' : '') +
        '" data-dir="' + escapeHtml(acc) + '">' + escapeHtml(seg) + '</button>'
    );
  });
  box.innerHTML = out.join('');
}

async function dpLoad(dir) {
  pickDir = CPLinks.normalizePath(dir || '');
  dpCrumbs();
  const body = $('#dpBody');
  const msg = $('#dpMsg');
  if (!body) return;
  body.innerHTML = '<div class="dir-pick-empty">读取中…</div>';
  if (msg) msg.textContent = '';
  try {
    // 优先用本地仓库列目录（和云端同步时是一致的，而且秒出）；
    // 本地没配/不是仓库时主进程会自动回退到远端接口。
    let res = await window.cloudpic.cloud.list({ dir: pickDir, source: 'local' });
    let dirs = (res.items || []).filter((i) => i.type === 'dir');

    // 本地这一层是空的，不代表云端也是空的（可能还没 pull）—— 再问一次远端兜底
    if (!dirs.length && res.source === 'local' && res.localReady) {
      try {
        const remote = await window.cloudpic.cloud.list({ dir: pickDir });
        const rdirs = (remote.items || []).filter((i) => i.type === 'dir');
        if (rdirs.length) {
          res = remote;
          dirs = rdirs;
        }
      } catch (e2) {
        /* 远端拿不到就按本地结果展示 */
      }
    }

    if (!dirs.length) {
      body.innerHTML =
        '<div class="dir-pick-empty">这个目录下没有子目录<br>直接点「选择此目录」就行，也可以先「新建子目录」</div>';
    } else {
      body.innerHTML = dirs
        .map((d) => {
          const rel = d.path || d.name;
          return (
            '<div class="dir-row" data-dir="' + escapeHtml(rel) + '">' +
            '<span class="dr-ico">📁</span>' +
            '<span class="dr-name">' + escapeHtml(d.name || rel) + '</span>' +
            '<span class="dr-go">进入 ›</span>' +
            '</div>'
          );
        })
        .join('');
    }
    if (msg) {
      msg.textContent =
        (res.source === 'local' ? '本地仓库' : '云端仓库') + ' · ' + (pickDir || '根目录') +
        ' · ' + dirs.length + ' 个子目录';
    }
  } catch (e) {
    body.innerHTML = '<div class="dir-pick-empty">' + escapeHtml(friendlyError(e && e.message)) + '</div>';
  }
}

function openDirPicker() {
  const input = $('#upDir');
  const start = CPLinks.normalizePath((input && input.value) || '');

  const wrap = document.createElement('div');
  wrap.className = 'dir-pick';
  wrap.innerHTML =
    '<div class="dir-pick-head">' +
    '<div class="dir-crumbs" id="dpCrumbs"></div>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpRefresh">刷新</button>' +
    '</div>' +
    '<div class="dir-pick-body" id="dpBody"></div>' +
    '<div class="dir-pick-foot">' +
    '<span class="dir-pick-msg" id="dpMsg"></span>' +
    '<span style="display:flex;gap:6px;flex:0 0 auto">' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpCancel">取消</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" id="dpNew">新建子目录</button>' +
    '<button type="button" class="btn btn-primary btn-sm" id="dpUse">选择此目录</button>' +
    '</span>' +
    '</div>';

  const dlg = modal({ title: '选择云端目录', node: wrap, buttons: false });

  const close = () => dlg.close();

  // 目录列表：点行进目录，点面包屑跳层
  $('#dpBody').addEventListener('click', (e) => {
    const row = e.target.closest('.dir-row');
    if (!row) return;
    dpLoad(row.dataset.dir);
  });
  $('#dpCrumbs').addEventListener('click', (e) => {
    const c = e.target.closest('.dir-crumb');
    if (!c) return;
    dpLoad(c.dataset.dir);
  });
  $('#dpRefresh').onclick = () => dpLoad(pickDir);
  $('#dpCancel').onclick = close;

  $('#dpUse').onclick = () => {
    if (input) {
      input.value = pickDir;
      persistQuickOptions();
    }
    close();
    ok(pickDir ? '目标目录：' + pickDir : '目标目录：仓库根目录');
  };

  // 新建子目录：在当前层下面建一个（其实就是把路径补全到 input，目录会随上传一起创建）
  $('#dpNew').onclick = () => {
    const body = $('#dpBody');
    if (!body || $('#dpNewName')) return;
    const box = document.createElement('div');
    box.style.cssText =
      'display:flex;gap:6px;padding:8px 10px;border-bottom:1px solid var(--border-soft);background:var(--panel)';
    box.innerHTML =
      '<input type="text" id="dpNewName" placeholder="新目录名，如 2026/09" style="flex:1" />' +
      '<button type="button" class="btn btn-ghost btn-sm" id="dpCreateCancel">取消</button>' +
      '<button type="button" class="btn btn-primary btn-sm" id="dpCreate">创建</button>';
    wrap.insertBefore(box, body);
    const nameEl = box.querySelector('#dpNewName');
    nameEl.focus();
    const cancel = () => box.remove();
    const create = () => {
      const name = CPLinks.normalizePath(nameEl.value || '');
      if (!name) {
        warn('请填一个目录名');
        return;
      }
      box.remove();
      const next = CPLinks.normalizePath((pickDir ? pickDir + '/' : '') + name);
      if (input) {
        input.value = next;
        persistQuickOptions();
      }
      close();
      ok('目标目录：' + next);
    };
    box.querySelector('#dpCreate').onclick = create;
    box.querySelector('#dpCreateCancel').onclick = cancel;
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') create();
      if (e.key === 'Escape') cancel();
    });
  };

  dpLoad(start);
}

/* ---------------------------------------------------------------- 拖拽与粘贴 */

function bindDrop() {
  const dz = $('#dropzone');
  /** 新手指引盖在上面时不要偷偷收文件 */
  const blocked = () => document.body.classList.contains('is-onboarding');
  let depth = 0;
  ['dragenter', 'dragover', 'dragleave', 'drop'].forEach((t) => {
    document.addEventListener(t, (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
  });
  document.addEventListener('dragenter', () => {
    if (blocked()) return;
    depth += 1;
    dz.classList.add('over');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) dz.classList.remove('over');
  });
  document.addEventListener('drop', (e) => {
    depth = 0;
    dz.classList.remove('over');
    if (blocked()) return;
    const dt = e.dataTransfer;
    if (dt && dt.files && dt.files.length) addFiles(dt.files);
  });

  dz.addEventListener('click', (e) => {
    if (blocked()) return;
    if (e.target.closest('button')) return;
    $('#fileInput').click();
  });
  $('#btnPick').onclick = (e) => {
    e.stopPropagation();
    if (blocked()) return;
    $('#fileInput').click();
  };
  $('#fileInput').onchange = (e) => {
    addFiles(e.target.files);
    e.target.value = '';
  };

  document.addEventListener('paste', (e) => {
    if (blocked()) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind !== 'file') continue;
      const f = it.getAsFile();
      if (!f) continue;
      if (!f.name) {
        const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        Object.defineProperty(f, 'name', { value: 'paste-' + Date.now() + '.' + ext });
      }
      files.push(f);
    }
    if (files.length) {
      e.preventDefault();
      addFiles(files);
      ok('已从剪贴板添加 ' + files.length + ' 张图片');
    }
  });
}

/* ---------------------------------------------------------------- 导出 */

export default {
  init() {
    bindDrop();
    fillOptions();
    bindResultActions();

    $('#resultFormat').innerHTML = CPLinks.LINK_FORMATS.map((f) => '<option value="' + f.id + '">' + f.name + '</option>').join('');
    $('#resultFormat').value = (state.cfg && state.cfg.linkFormat) || 'markdown';
    $('#resultFormat').onchange = () => {
      renderResults();
      persistQuickOptions();
    };

    const toSettings = $('#btnUtSettings');
    if (toSettings) {
      toSettings.onclick = () => document.querySelector('.nav-item[data-page="settings"]').click();
    }

    $('#upQuality').oninput = () => {
      $('#upQualityVal').textContent = $('#upQuality').value;
    };

    ['#upQuality', '#upFormat', '#upRenameMode'].forEach((s) => {
      $(s).addEventListener('change', () => {
        invalidate();
        scheduleProcess(60);
        persistQuickOptions();
      });
    });
    $('#upCompress').addEventListener('change', () => {
      invalidate();
      scheduleProcess(60);
      persistQuickOptions();
    });
    $('#upPrefix').addEventListener('input', () => {
      invalidate();
      scheduleProcess(320);
      persistQuickOptions();
    });
    $('#upDir').addEventListener('input', persistQuickOptions);
    $('#btnUpDirPick').onclick = () => {
      if (!state.configured) {
        warn('还没配好仓库和 Token，先去设置里填一下才能列出云端目录');
        return;
      }
      openDirPicker();
    };

    $('#btnClearQueue').onclick = () => {
      if (running) return;
      clearQueue();
    };

    $('#btnUpload').onclick = async () => {
      if (running) return;
      await processPending();
      await doUpload();
    };

    $('#btnCopyAllResult').onclick = async () => {
      const txt = allResultLinks();
      if (!txt) {
        warn('还没有可复制的链接');
        return;
      }
      await window.cloudpic.clipboard.write(txt);
      ok('已复制 ' + queue.filter((q) => q.status === 'done').length + ' 条链接');
    };
    $('#btnExportResult').onclick = async () => {
      const txt = allResultLinks();
      if (!txt) {
        warn('还没有可导出的内容');
        return;
      }
      const r = await window.cloudpic.fs.exportText({ content: txt, defaultName: 'jie-links.txt' });
      if (r.ok) ok('已导出到 ' + r.filePath);
    };
    $('#btnCloseResult').onclick = () => {
      $('#resultPanel').hidden = true;
    };

    $('#queueList').addEventListener('click', (e) => {
      const thumb = e.target.closest('.q-thumb');
      if (!thumb) return;
      const item = e.target.closest('.q-item');
      if (item) openThumbFor(item.dataset.id);
    });

    // 无头自检的钩子：自检没法真跑一遍压缩，就自己捏一份「压缩结果」喂进来，
    // 验证对比弹层装不装得起来（见 main.js 的 ui 段）
    window.__cmp = { open: openCompare, can: canCompare };
  },

  onEnter() {
    fillOptions();
  },

  onConfigChanged() {
    fillOptions();
  }
};
