/** 轻量 DOM 与交互工具 */

export const $ = (sel, root) => (root || document).querySelector(sel);
export const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

export function debounce(fn, ms) {
  let t = null;
  return function () {
    const args = arguments;
    clearTimeout(t);
    t = setTimeout(() => fn.apply(null, args), ms || 200);
  };
}

/* ---------------------------------------------------------------- Toast */

/**
 * Electron 的 IPC 异常会把「调用哪个通道 + 错误类名」一起塞进 message，
 * 例如：Error invoking remote method 'cloud:list': ApiError: Token 无效或已过期。
 * 这些前缀对用户没有任何意义，统一剥掉，只留下人话那一段。
 */
const ERR_WRAPPER = [
  /^Error invoking remote method '[^']*':\s*/,
  /^Error occurred in handler for '[^']*':\s*/,
  /^[A-Za-z]+Error:\s*/,
  /^Error:\s*/
];

export function friendlyError(message) {
  let t = String(message == null ? '' : message);
  for (const re of ERR_WRAPPER) t = t.replace(re, '');
  t = t.trim();
  return t || '操作失败';
}

export function toast(message, type, ms) {
  const wrap = $('#toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.innerHTML = `<div class="msg">${escapeHtml(friendlyError(message))}</div>`;
  wrap.appendChild(el);
  const life = ms || (type === 'err' ? 6000 : 2800);
  setTimeout(() => {
    el.style.transition = 'opacity .2s, transform .2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(16px)';
    setTimeout(() => el.remove(), 220);
  }, life);
  return el;
}

export const ok = (m) => toast(m, 'ok');
export const err = (m) => toast(m, 'err');
export const warn = (m) => toast(m, 'warn');

/* ---------------------------------------------------------------- Modal */

/** 标题栏右上角的关闭叉。自绘 SVG，不用字体里的 ×（字形随机器变） */
const ICON_CLOSE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

/**
 * 通用弹层。
 *
 * opts:
 *   title      标题（字符串）
 *   wide       图片预览那样的宽版
 *   className  额外挂到 .modal 上的类名（文本编辑器用 'code' 撑大并换布局）
 *   actions    标题右侧的小按钮 [{ icon, label, title, className, onClick }]
 *              文本预览的「在浏览器打开」就走这里 —— 放标题栏才符合直觉，
 *              沉到底栏会和「保存 / 关闭」混在一起变成一排同权重的按钮
 *   closeX     是否在右上角放一个关闭叉（自绘）。文本预览那种没有底栏按钮、
 *              也不让点遮罩关的弹层需要它，否则用户只能按 Esc 才知道怎么退
 *   closeTitle 关闭叉的悬停提示，默认「关闭」
 *   html/node/text/buttons/onClose/dismissable 同以前
 */
export function modal(opts) {
  const o = opts || {};
  const wrap = $('#modalWrap');
  wrap.hidden = false;
  wrap.innerHTML = '';

  // close 要先定义：标题栏那个 ✕ 在拼 head 的时候就要用它。
  // 原来是拼完 body 才 const close = ...，放前面引用会撞上 TDZ。
  const close = () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
    if (o.onClose) o.onClose();
  };

  const box = document.createElement('div');
  box.className = 'modal' + (o.wide ? ' wide' : '') + (o.className ? ' ' + o.className : '');
  const head = document.createElement('div');
  head.className = 'modal-head';

  const title = document.createElement('span');
  title.className = 'mh-title';
  title.textContent = o.title || '';
  head.appendChild(title);

  if (Array.isArray(o.actions) && o.actions.length) {
    const acts = document.createElement('div');
    acts.className = 'mh-actions';
    o.actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mh-btn' + (a.className ? ' ' + a.className : '');
      if (a.title) btn.title = a.title;
      if (a.icon) {
        btn.innerHTML = a.icon + (a.label ? '<span>' + escapeHtml(a.label) + '</span>' : '');
      } else {
        btn.textContent = a.label || '';
      }
      btn.onclick = () => {
        if (a.onClick) a.onClick(btn);
      };
      acts.appendChild(btn);
    });
    head.appendChild(acts);
  }

  // 关闭叉放在 actions 之后 —— 也就是说，它永远在最右边（右上角）
  if (o.closeX) {
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'mh-close';
    x.title = o.closeTitle || '关闭';
    x.setAttribute('aria-label', x.title);
    x.innerHTML = ICON_CLOSE;
    x.onclick = close;
    head.appendChild(x);
  }

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (o.html) body.innerHTML = o.html;
  else if (o.node) body.appendChild(o.node);
  else body.textContent = o.text || '';

  box.appendChild(head);
  box.appendChild(body);

  if (o.buttons !== false) {
    const foot = document.createElement('div');
    foot.className = 'modal-foot';
    const list = o.buttons || [{ label: '知道了', primary: true }];
    list.forEach((b) => {
      const btn = document.createElement('button');
      btn.className = 'btn ' + (b.primary ? 'btn-primary' : b.danger ? 'btn-danger' : 'btn-ghost');
      btn.textContent = b.label;
      btn.onclick = () => {
        if (!b.onClick || b.onClick() !== false) close();
      };
      foot.appendChild(btn);
    });
    box.appendChild(foot);
  }

  wrap.appendChild(box);
  wrap.onclick = (e) => {
    if (e.target === wrap && o.dismissable !== false) close();
  };
  return { close, body, box, head, foot: $('.modal-foot', box) };
}

export function confirmDialog(title, message, confirmLabel) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    modal({
      title,
      text: message,
      dismissable: false,
      buttons: [
        { label: '取消', onClick: () => finish(false) },
        {
          label: confirmLabel || '确定',
          danger: true,
          onClick: () => {
            finish(true);
            return true;
          }
        }
      ],
      onClose: () => finish(false)
    });
  });
}

/**
 * 图片预览。
 * link 给了就在标题栏挂一个「浏览器打开」—— 和文本预览保持同一套位置与图标，
 * 不然同一个页面上两种预览框的按钮一个在右上、一个没有，用起来要重新找。
 */
export function previewImage(src, name, link) {
  modal({
    title: name || '预览',
    wide: true,
    html: `<img src="${escapeHtml(src)}" alt="" />`,
    actions: link
      ? [
          {
            icon:
              '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
              'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
              '<path d="M13.5 4H20v6.5"/><path d="M20 4l-8.6 8.6"/>' +
              '<path d="M18.5 14v5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>',
            label: '浏览器打开',
            title: '用系统默认浏览器打开这个文件',
            onClick: () => window.cloudpic.shell.openExternal(link)
          }
        ]
      : [],
    buttons: [{ label: '关闭', primary: true }]
  });
}

/* ---------------------------------------------------------------- 右键菜单 */

let ctxOpen = null;

export function closeContextMenu() {
  if (!ctxOpen) return;
  const { el, onDocDown, onKey, onScroll } = ctxOpen;
  el.remove();
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onScroll, true);
  ctxOpen = null;
}

/**
 * 自绘右键菜单。
 *
 * items 里每一项：{ label, icon, hint, danger, disabled, onClick }，
 * 或者 { sep: true } 画一条分隔线；也可以传 '—' 字符串图省事。
 *
 * 挂在 document.body 上用 fixed 定位：文件管理的卡片和网格都带 overflow，
 * 挂在原地会被裁掉。坐标给 clientX / clientY（视口坐标）。
 */
export function contextMenu(opts) {
  const o = opts || {};
  closeContextMenu();

  const el = document.createElement('div');
  el.className = 'ctx-menu';
  el.setAttribute('role', 'menu');

  if (o.title) {
    const t = document.createElement('div');
    t.className = 'ctx-title';
    t.textContent = o.title;
    el.appendChild(t);
  }

  (o.items || []).forEach((it) => {
    if (!it || it.sep || it === '—') {
      const s = document.createElement('div');
      s.className = 'ctx-sep';
      el.appendChild(s);
      return;
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item' + (it.danger ? ' danger' : '');
    b.disabled = !!it.disabled;
    b.setAttribute('role', 'menuitem');
    b.innerHTML =
      '<span class="ctx-ico">' + (it.icon || '') + '</span>' +
      '<span class="ctx-label">' + escapeHtml(it.label) + '</span>' +
      (it.hint ? '<span class="ctx-hint">' + escapeHtml(it.hint) + '</span>' : '');
    b.onclick = () => {
      closeContextMenu();
      if (it.onClick) it.onClick();
    };
    el.appendChild(b);
  });

  // 先放到左上角外面量尺寸，再收进视口 —— 避免先闪一下再跳位置
  el.style.left = '-9999px';
  el.style.top = '0';
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  const x = Math.max(8, Math.min(o.x || 0, window.innerWidth - r.width - 10));
  const y = Math.max(8, Math.min(o.y || 0, window.innerHeight - r.height - 10));
  el.style.left = Math.round(x) + 'px';
  el.style.top = Math.round(y) + 'px';

  const onDocDown = (e) => {
    if (!el.contains(e.target)) closeContextMenu();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      closeContextMenu();
    }
  };
  const onScroll = () => closeContextMenu();

  document.addEventListener('mousedown', onDocDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('scroll', onScroll, true);
  window.addEventListener('resize', onScroll, true);

  ctxOpen = { el, onDocDown, onKey, onScroll };
  return { close: closeContextMenu, el };
}

/* ---------------------------------------------------------------- 动效小工具 */

/** 数值变化时让它「弹」一下，比静默替换更容易被注意到 */
export function pulse(el) {
  if (!el) return;
  el.classList.remove('pop');
  void el.offsetWidth;
  el.classList.add('pop');
  clearTimeout(el.__popT);
  el.__popT = setTimeout(() => el.classList.remove('pop'), 420);
}

/** 骨架屏：列表形态 */
export function sklRows(n) {
  let html = '<div class="skl-rows">';
  for (let i = 0; i < (n || 6); i++) {
    html +=
      '<div class="skl-row"><div class="skl sq"></div><div class="col">' +
      '<div class="skl ln"></div><div class="skl ln short"></div></div></div>';
  }
  return html + '</div>';
}

/** 骨架屏：网格形态 */
export function sklTiles(n) {
  let html = '<div class="skl-grid">';
  for (let i = 0; i < (n || 12); i++) {
    html +=
      '<div class="skl-tile"><div class="skl sq"></div><div class="skl ln"></div><div class="skl ln short"></div></div>';
  }
  return html + '</div>';
}

/* ---------------------------------------------------------------- 滑块 */

/**
 * range 的「已填充」部分没法用纯 CSS 跟着 value 走，
 * 所以把进度写进 --fill，由 CSS 画渐变轨道。
 */
export function paintRange(el) {
  if (!el || el.type !== 'range') return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value || 0);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)).toFixed(2) + '%');
}

export function paintRanges(root) {
  (root || document).querySelectorAll('input[type="range"]').forEach(paintRange);
}
