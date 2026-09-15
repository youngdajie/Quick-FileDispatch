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

export function modal(opts) {
  const o = opts || {};
  const wrap = $('#modalWrap');
  wrap.hidden = false;
  wrap.innerHTML = '';

  const box = document.createElement('div');
  box.className = 'modal' + (o.wide ? ' wide' : '');
  const head = document.createElement('div');
  head.className = 'modal-head';
  head.textContent = o.title || '';
  const body = document.createElement('div');
  body.className = 'modal-body';
  if (o.html) body.innerHTML = o.html;
  else if (o.node) body.appendChild(o.node);
  else body.textContent = o.text || '';

  box.appendChild(head);
  box.appendChild(body);

  const close = () => {
    wrap.hidden = true;
    wrap.innerHTML = '';
    if (o.onClose) o.onClose();
  };

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
  return { close, body, box };
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

export function previewImage(src, name) {
  modal({
    title: name || '预览',
    wide: true,
    html: `<img src="${escapeHtml(src)}" alt="" />`,
    buttons: [{ label: '关闭', primary: true }]
  });
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
