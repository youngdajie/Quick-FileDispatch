/**
 * 文本预览 / 编辑器
 *
 * 为什么不是「只读预览 + 另存为」：文件管理页本来就有「用新文件替换内容」，
 * 那个流程要人先在外面找到文件、再传进来，改一个错别字也得走全套。
 * 文本文件就地看、就地改、就地存回去，才是这个页面该有的手感。
 *
 * 三件事：
 *  1. 只读预览 —— 语法着色，和浏览器里的开发者工具看到的是一个观感；
 *  2. 就地编辑 —— 高亮层与输入层上下叠放（textarea 透明、pre 在背后），
 *     打字时着色跟着变，不用切模式；
 *  3. 保存 —— 本地走 fs:localWrite、云端走 cloud:replace，
 *     换行符与 BOM 按读进来时的样子原样写回（不然 Git 里就是满屏 diff）。
 */

import { modal, ok, err, warn, toast, confirmDialog, escapeHtml, friendlyError } from './dom.js';

const CPLinks = window.CPLinks;

const svg = (d, w) =>
  '<svg viewBox="0 0 24 24" width="' + (w || 14) + '" height="' + (w || 14) +
  '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';

const ICON_OPEN = svg('<path d="M13.5 4H20v6.5"/><path d="M20 4l-8.6 8.6"/><path d="M18.5 14v5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/>');
const ICON_EDIT = svg('<path d="M4 20h16"/><path d="M14.5 4.6l4 4L9 18H5v-4z"/>');

/** 超过这个体积就不给在框里改（着色器也是这个上限，两者必须一致） */
const MAX_EDIT = (window.CPHighlight && window.CPHighlight.MAX_HL) || 400000;

function hl() {
  return window.CPHighlight || null;
}

function makeBtn(parent, label, cls, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ' + cls;
  b.textContent = label;
  b.onclick = onClick;
  parent.appendChild(b);
  return b;
}

/**
 * 打开一个文本文件的预览/编辑窗口。
 *
 * opts: { name, path, source: 'local'|'remote', link, onSaved }
 */
export function previewText(opts) {
  const o = opts || {};
  const rel = o.path || '';
  const name = o.name || rel.split('/').pop() || '预览';
  const source = o.source === 'local' ? 'local' : 'remote';
  const link = o.link || '';
  const H = hl();
  const lang = H ? H.langOf(name) : '';
  const langLabel = H ? H.labelOf(lang) : '';

  const st = {
    text: '',
    base: '',
    bom: false,
    eol: 'lf',
    encoding: 'utf-8',
    loaded: false,
    editable: false,
    editing: false,
    dirty: false,
    busy: false
  };

  let ta = null; // textarea（编辑态）
  let codeEl = null; // 着色层里的 <code>
  let preEl = null; // 着色层容器
  let paintTick = 0;

  const body = document.createElement('div');
  body.className = 'tv-body';

  const m = modal({
    title: name,
    className: 'code',
    dismissable: false,
    buttons: false,
    // 这层既没有底栏按钮、也不让点遮罩关 —— 右上角必须给个明确的退出口，
    // 否则用户得猜到还能按 Esc
    closeX: true,
    node: body,
    actions: [
      link
        ? { icon: ICON_OPEN, label: '浏览器打开', title: '用系统默认浏览器打开这个文件', className: 'mh-open', onClick: openExternal }
        : null,
      { icon: ICON_EDIT, label: '编辑', title: '就地编辑并保存', className: 'mh-edit', onClick: () => setEditing(true) }
    ].filter(Boolean)
  });

  const foot = document.createElement('div');
  foot.className = 'modal-foot tv-foot';
  m.box.appendChild(foot);

  const openBtn = m.head.querySelector('.mh-open');
  const editBtn = m.head.querySelector('.mh-edit');

  /* ---------------------------------------------------------- 头部 */

  function renderHead() {
    const t = m.head.querySelector('.mh-title');
    t.innerHTML =
      '<span class="tv-name">' + escapeHtml(name) + '</span>' +
      (langLabel ? '<span class="tv-lang">' + escapeHtml(langLabel) + '</span>' : '') +
      (encBadge() ? '<span class="tv-enc">' + escapeHtml(encBadge()) + '</span>' : '') +
      (st.dirty ? '<span class="tv-dirty">未保存</span>' : '');
    if (editBtn) editBtn.hidden = !(st.loaded && st.editable) || st.editing;
    if (openBtn) openBtn.hidden = !link;
  }

  /** 非 UTF-8 的文件在标题上挂个记号，别让用户以为是自己看花了眼 */
  function encBadge() {
    if (st.encoding === 'gb18030') return 'GBK';
    if (st.encoding === 'unknown') return '未知编码';
    return '';
  }

  /* ---------------------------------------------------------- 底栏 */

  function renderFoot() {
    foot.innerHTML = '';
    const hint = document.createElement('span');
    hint.className = 'tv-hint';
    hint.textContent = st.editing ? 'Ctrl + S 保存 · Tab 缩进两格' : st.loaded ? sizeHint() : '';
    foot.appendChild(hint);
    const sp = document.createElement('span');
    sp.className = 'tv-spacer';
    foot.appendChild(sp);

    if (st.editing) {
      makeBtn(foot, '取消编辑', 'btn-ghost', () => setEditing(false, true));
      const save = makeBtn(foot, st.busy ? '保存中…' : '保存', 'btn-primary', doSave);
      save.disabled = st.busy;
    } else {
      if (st.loaded && st.editable) makeBtn(foot, '编辑', 'btn-ghost', () => setEditing(true));
      makeBtn(foot, '关闭', 'btn-primary', () => closeModal());
    }
  }

  function sizeHint() {
    const size = CPLinks ? CPLinks.formatBytes(st.size || 0) : (st.size || 0) + ' B';
    const eol = st.eol === 'crlf' ? 'CRLF' : 'LF';
    // 只读要给理由：编码不对和体积超限是两回事，用户看到的信息得对得上
    const why = st.editable
      ? ' · 可编辑'
      : st.encoding !== 'utf-8'
        ? ' · 只读：非 UTF-8 编码'
        : ' · 只读：超过编辑上限';
    const enc = encBadge() ? ' · ' + encBadge() : '';
    return size + ' · ' + eol + (st.bom ? ' · 带 BOM' : '') + enc + why;
  }

  /* ---------------------------------------------------------- 关闭 */

  function closeModal() {
    if (st.dirty) {
      confirmDialog('有未保存的修改', '关闭之后这次改的内容就没了', '放弃修改').then((yes) => {
        if (yes) {
          st.dirty = false;
          m.close();
        }
      });
      return;
    }
    m.close();
  }

  function openExternal() {
    if (!link) {
      warn('这个文件没有可用的外链');
      return;
    }
    Promise.resolve(window.cloudpic.shell.openExternal(link)).catch((e) => err(friendlyError(e)));
  }

  /* ---------------------------------------------------------- 渲染 */

  function showLoading() {
    body.innerHTML = '<div class="tv-msg"><span class="tv-spin" aria-hidden="true"></span>正在读取文件…</div>';
    renderHead();
    renderFoot();
  }

  function showBlocked(res) {
    const r = (res && res.reason) || '';
    const copy = {
      binary: ['这是二进制文件，没法按文本看', '后缀看着像文本，但内容里有空字节 —— 图片、压缩包、可执行文件都属于这一类'],
      utf16: ['这个文件的编码暂时不支持', '内容像是 UTF-16（Windows 记事本另存为「Unicode」就会这样），换个编码另存为 UTF-8 再看'],
      tooLarge: [
        '文件太大，不在这里打开',
        '体积 ' + (CPLinks ? CPLinks.formatBytes(res.size) : res.size + ' B') +
          '，超过 ' + (CPLinks ? CPLinks.formatBytes(res.limit) : res.limit + ' B') + ' 的预览上限'
      ]
    }[r] || ['读不出这个文件', '返回的数据里没有可显示的文本内容'];

    body.innerHTML =
      '<div class="tv-msg blocked">' +
      '<div class="tv-msg-title">' + escapeHtml(copy[0]) + '</div>' +
      '<div class="tv-msg-sub">' + escapeHtml(copy[1]) + '</div>' +
      (link ? '<button class="btn btn-primary btn-sm" id="tvOpenFallback">在浏览器里打开</button>' : '') +
      '</div>';
    const fb = body.querySelector('#tvOpenFallback');
    if (fb) fb.onclick = openExternal;
  }

  /** 只读：一段着色后的 <pre> */
  function renderView(keepScroll) {
    const top = keepScroll && preEl ? preEl.scrollTop : 0;
    body.innerHTML = '<pre class="tv-pre code-font"><code class="tv-code"></code></pre>';
    preEl = body.querySelector('.tv-pre');
    codeEl = body.querySelector('.tv-code');
    paint();
    preEl.scrollTop = top;
    ta = null;
  }

  /** 编辑：着色层在背后、透明输入层在前面，两者字体度量完全一致才能对齐 */
  function renderEdit() {
    // 切模式不该改变你看的位置：先把只读态的视野记下来
    const top = preEl ? preEl.scrollTop : 0;
    const left = preEl ? preEl.scrollLeft : 0;

    body.innerHTML =
      '<div class="tv-pane">' +
      '<pre class="tv-pre code-font" aria-hidden="true"><code class="tv-code"></code></pre>' +
      '<textarea class="tv-ta code-font" wrap="off" spellcheck="false" aria-label="文件内容"></textarea>' +
      '</div>';
    preEl = body.querySelector('.tv-pre');
    codeEl = body.querySelector('.tv-code');
    ta = body.querySelector('.tv-ta');
    // 输入层任何时候都不能有底色 / 字色：文字是透明的，看得见的是背后那层高亮。
    // 全局的 `textarea:focus` 会给输入框糊上不透明底 + 描边，正好把高亮层盖死，
    // 表现就是「点进编辑一片空白」。CSS 里已按特异性压住了，这里再补一道内联样式 ——
    // 这条不变式值得冗余，它挂掉的时候界面是完全没法用的。
    ta.style.background = 'transparent';
    ta.style.color = 'transparent';
    ta.style.border = '0';
    ta.style.boxShadow = 'none';
    paint();
    ta.value = st.text;
    bindTa();

    // 光标必须先归零再 focus。
    //
    // 给 textarea 赋 value 会把选区丢到**末尾**，此时直接 focus()，浏览器为了
    // 「让光标进入视野」会把输入框一路滚到最后一行 —— 用户看到的就是
    // 「点一下编辑，文本唰地滑到了文件结尾」。先把光标放到开头，focus 就
    // 不会再滚动；随后再把视野放回原来的位置。
    ta.selectionStart = ta.selectionEnd = 0;
    ta.scrollTop = 0;
    ta.scrollLeft = 0;
    ta.focus();

    // 视野回到只读时的位置，光标落在视野首行行首 —— 你看的是哪儿，就从哪儿改
    const caret = charAtLineStart(top);
    if (caret > 0) ta.setSelectionRange(caret, caret);
    ta.scrollTop = top;
    ta.scrollLeft = left;
    syncScroll();
  }

  /**
   * 把「滚动位置」换算成「字符偏移」：取视野顶部那一行的行首。
   *
   * scrollTop 的 0 点在内容盒顶，所以要先减掉 padding-top 才是行号的基准；
   * 顶部那段 padding 还在视野里时，一律算第 0 行。
   */
  function charAtLineStart(top) {
    if (!ta || !(top > 0)) return 0;
    const cs = getComputedStyle(ta);
    const lh = parseFloat(cs.lineHeight);
    if (!(lh > 0)) return 0;
    const pad = parseFloat(cs.paddingTop) || 0;
    const line = Math.max(0, Math.floor(Math.max(0, top - pad) / lh));
    if (line <= 0) return 0;
    const lines = st.text.split('\n');
    if (line >= lines.length) return st.text.length;
    let pos = 0;
    for (let i = 0; i < line; i++) pos += lines[i].length + 1;
    return pos;
  }

  function paint() {
    if (!codeEl) return;
    const html = H ? H.highlight(st.text, lang) : escapeHtml(st.text);
    // 末尾补一个换行 —— 不是画蛇添足，是两层能对齐的必需品。
    //
    // 块级 <pre> 会忽略**最后一个**换行符（CSS 的规矩：块末尾的空行不产生行盒），
    // 而 <textarea> 必须为它留出一行 —— 否则光标就没法停在最后一行。
    // 于是一模一样的文本，pre 排 461 行、textarea 排 462 行，内容高度正好差
    // 一个行高（这个文件上实测 21.25px）。
    //
    // 滚动是 textarea 主导、pre 跟从（syncScroll 方向单一）。滚到底时 ta 能到
    // 9296，pre 的上限只有 9274，被自己的高度卡住 —— 表现就是「点最下面那几行，
    // 光标比看到的偏一行」。补上这个换行，两层的内容高度就一致了。
    //
    // 只读态复用同一个 paint()，于是只读 / 编辑来回切也不会跳。
    codeEl.innerHTML = html + '\n';
  }

  function schedulePaint() {
    if (paintTick) return;
    paintTick = requestAnimationFrame(() => {
      paintTick = 0;
      paint();
      syncScroll();
    });
  }

  function syncScroll() {
    if (!ta || !preEl) return;
    preEl.scrollTop = ta.scrollTop;
    preEl.scrollLeft = ta.scrollLeft;
  }

  function bindTa() {
    ta.addEventListener('input', () => {
      st.text = ta.value;
      const d = st.text !== st.base;
      if (d !== st.dirty) {
        st.dirty = d;
        renderHead();
      }
      schedulePaint();
    });
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        insertAtCursor('  ', e.shiftKey);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && String(e.key).toLowerCase() === 's') {
        e.preventDefault();
        doSave();
      }
    });
  }

  function insertAtCursor(text, outdent) {
    if (!ta) return;
    const s = ta.selectionStart;
    const e = ta.selectionEnd;
    // 有跨行选中时按 Tab 就是整块缩进 / 反缩进，否则只插两个空格
    if (e > s && ta.value.slice(s, e).indexOf('\n') >= 0) {
      const before = ta.value.slice(0, s);
      const sel = ta.value.slice(s, e);
      const after = ta.value.slice(e);
      const lineStart = before.lastIndexOf('\n') + 1;
      const head = before.slice(0, lineStart);
      const tail = before.slice(lineStart) + sel;
      const lines = tail.split('\n').map((l) => (outdent ? l.replace(/^ {1,2}/, '') : '  ' + l));
      const next = head + lines.join('\n') + after;
      ta.value = next;
      ta.selectionStart = s;
      ta.selectionEnd = e + (next.length - st.text.length);
    } else {
      const next = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.value = next;
      ta.selectionStart = ta.selectionEnd = s + text.length;
    }
    st.text = ta.value;
    st.dirty = st.text !== st.base;
    renderHead();
    schedulePaint();
  }

  function setEditing(on, revert) {
    if (on) {
      if (st.editing || !st.loaded || !st.editable) return;
      st.editing = true;
      renderEdit();
      renderHead();
      renderFoot();
      return;
    }
    if (!st.editing) return;
    if (revert && st.dirty) {
      confirmDialog('放弃这次的修改？', '文件会回到你打开它时的样子', '放弃修改').then((yes) => {
        if (!yes) return;
        st.text = st.base;
        st.dirty = false;
        st.editing = false;
        renderView(true);
        renderHead();
        renderFoot();
      });
      return;
    }
    st.editing = false;
    renderView(true);
    renderHead();
    renderFoot();
  }

  /* ---------------------------------------------------------- 读 / 写 */

  function encode(text) {
    let s = text;
    if (st.eol === 'crlf') s = s.replace(/\n/g, '\r\n');
    const bytes = new TextEncoder().encode(s);
    if (!st.bom) return bytes;
    const out = new Uint8Array(bytes.length + 3);
    out.set([0xef, 0xbb, 0xbf], 0);
    out.set(bytes, 3);
    return out;
  }

  async function doSave() {
    if (st.busy || !ta) return;
    st.text = ta.value;
    if (st.text === st.base) {
      toast('内容没有变化');
      return;
    }
    st.busy = true;
    renderFoot();
    try {
      const data = encode(st.text);
      if (source === 'local') {
        await window.cloudpic.fs.localWrite({ path: rel, data });
        ok('已保存到本地：' + rel);
        toast('改动还在本地，点左侧「提交并推送」才会同步到云端', 'warn', 6000);
      } else {
        const res = await window.cloudpic.cloud.replace({ path: rel, data });
        if (!res || !res.ok) throw new Error((res && res.message) || '保存失败');
        ok('已保存到云端：' + rel);
        if (res.sync && !res.sync.skipped) {
          if (res.sync.ok) toast('本地目录已同步', 'ok');
          else warn('云端已更新，但本地同步失败：' + res.sync.message);
        }
      }
      st.base = st.text;
      st.size = data.length;
      st.dirty = false;
      renderHead();
      if (o.onSaved) o.onSaved();
    } catch (e) {
      err(friendlyError(e.message || e));
    } finally {
      st.busy = false;
      renderFoot();
    }
  }

  async function load() {
    showLoading();
    try {
      const res = await window.cloudpic.cloud.readText({ path: rel, source });
      if (!res || !res.ok) {
        showBlocked(res);
        renderHead();
        renderFoot();
        return;
      }
      st.text = res.text;
      st.base = res.text;
      st.bom = !!res.bom;
      st.eol = res.eol || 'lf';
      st.encoding = res.encoding || 'utf-8';
      st.size = res.size || 0;
      st.loaded = true;
      // 非 UTF-8 的文件不给编辑：TextEncoder 只会编 UTF-8，改写回去等于换掉整个文件的编码
      st.editable = res.editable !== false && res.text.length <= MAX_EDIT;
      renderView(false);
      renderHead();
      renderFoot();
    } catch (e) {
      body.innerHTML =
        '<div class="tv-msg blocked"><div class="tv-msg-title">读取失败</div>' +
        '<div class="tv-msg-sub">' + escapeHtml(friendlyError(e.message || e)) + '</div></div>';
      renderHead();
      renderFoot();
    }
  }

  load();
  return m;
}
