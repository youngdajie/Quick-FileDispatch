/**
 * 自定义下拉菜单
 *
 * 原生 <select> 的弹出层是操作系统画的，样式完全不受控，放深色界面里很「网页」。
 * 这里的做法是渐进增强：
 *   - 原生 <select> 留在 DOM 里当唯一数据源（值、选项都从它读），只是视觉上藏起来；
 *   - 上面盖一个按钮 + 自绘面板；
 *   - 用户选完后写回原生 select 的 value，并派发原生 change 事件。
 * 这样所有已有的 addEventListener('change') 逻辑一行都不用改。
 *
 * 面板挂在 document.body 上（fixed 定位）：因为 .card 是 overflow:hidden，
 * 挂在原地会被裁掉。
 */

const CHECK =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

const CHEVRON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5l6 6 6-6"/></svg>';

let openCtx = null;

/** 同一时刻只允许一个面板开着 */
function closeOpen() {
  if (!openCtx) return;
  const { panel, btn, onDocDown, onKey, onScroll } = openCtx;
  panel.remove();
  btn.classList.remove('is-open');
  btn.setAttribute('aria-expanded', 'false');
  document.removeEventListener('mousedown', onDocDown, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('scroll', onScroll, true);
  window.removeEventListener('resize', onScroll, true);
  openCtx = null;
}

export function enhanceSelect(sel) {
  if (!sel || sel.dataset.csel === '1') return null;
  if (sel.multiple || sel.size > 1) return null;
  sel.dataset.csel = '1';

  const wrap = document.createElement('div');
  wrap.className = 'csel';
  if (sel.classList.contains('mini-select')) wrap.classList.add('csel-mini');
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('csel-native');
  sel.setAttribute('tabindex', '-1');

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'csel-btn';
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  btn.innerHTML = '<span class="csel-label"></span><span class="csel-arrow">' + CHEVRON + '</span>';
  wrap.appendChild(btn);

  const label = btn.querySelector('.csel-label');

  function sync() {
    const opt = sel.options[sel.selectedIndex];
    label.textContent = opt ? opt.textContent : '';
    label.classList.toggle('is-placeholder', !sel.value);
    btn.disabled = !!sel.disabled;
    wrap.classList.toggle('is-disabled', !!sel.disabled);
  }

  function buildPanel() {
    const panel = document.createElement('div');
    panel.className = 'csel-panel';
    panel.setAttribute('role', 'listbox');
    // 选项多的下拉（如本机字体清单，动辄五六十项）给个筛选框，
    // 否则只能靠滚轮一项项找，很难用
    let filter = null;
    if (sel.options.length > 20) {
      filter = document.createElement('input');
      filter.type = 'text';
      filter.className = 'csel-filter';
      filter.placeholder = '输入关键字筛选…';
      filter.setAttribute('autocomplete', 'off');
      filter.setAttribute('spellcheck', 'false');
      panel.appendChild(filter);
    }
    Array.from(sel.options).forEach((o, i) => {
      if (o.hidden) return;
      const item = document.createElement('button');
      item.type = 'button';
      /**
       * 选项可以在原生 select 上挂 data-kind，决定它在面板里长什么样：
       *   group  —— 分节标题（字体清单的「中文 / 西文 / 等宽」）
       *   note   —— 只读说明（如「新配置 · 尚未归档」）
       *   action —— 底部动作（如「＋ 新建一份空白配置…」），自动和上面分出一条线
       * 没挂就按老规矩：disabled 的当分节标题。
       *
       * 早先「和上面的选项分开」是靠往列表里塞一个内容为 ────── 的假选项，
       * 那行虚线在一堆配置名里非常突兀；现在交给样式画线（见 app.css 的 is-action）。
       */
      const kind = o.dataset.kind || (o.disabled ? 'group' : '');
      item.className = 'csel-opt' + (i === sel.selectedIndex ? ' is-sel' : '') + (kind ? ' is-' + kind : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === sel.selectedIndex ? 'true' : 'false');
      item.dataset.index = String(i);
      item.innerHTML =
        '<span class="csel-opt-txt">' + escapeText(o.textContent) + '</span>' +
        '<span class="csel-opt-check">' + CHECK + '</span>';
      if (o.disabled) item.disabled = true;
      panel.appendChild(item);
    });
    panel.__filter = filter;
    return panel;
  }

  function place(panel) {
    const r = btn.getBoundingClientRect();
    const filterH = panel.__filter ? panel.__filter.offsetHeight + 10 : 0;
    const maxH = 320;
    const h = Math.min(panel.scrollHeight + filterH + 10, maxH);
    const below = window.innerHeight - r.bottom - 12;
    const up = below < Math.min(h, 180) && r.top > Math.min(h, 180);
    const room = up ? r.top - 12 : below;
    // 面板永远不会超出视口：装不下就自己内部滚动，别让用户在屏幕外找选项
    panel.style.maxHeight = Math.max(150, Math.min(maxH, room)) + 'px';
    panel.style.left = Math.round(r.left) + 'px';
    panel.style.minWidth = Math.round(r.width) + 'px';
    panel.style.maxWidth = Math.round(Math.max(r.width, Math.min(360, window.innerWidth - r.left - 12))) + 'px';
    const realH = panel.offsetHeight;
    if (up) panel.style.top = Math.round(Math.max(8, r.top - realH - 6)) + 'px';
    else panel.style.top = Math.round(Math.min(window.innerHeight - realH - 8, r.bottom + 6)) + 'px';
  }

  function open() {
    if (btn.disabled) return;
    const wasOpen = openCtx && openCtx.sel === sel;
    closeOpen();
    if (wasOpen) return;

    const panel = buildPanel();
    document.body.appendChild(panel);
    place(panel);
    btn.classList.add('is-open');
    btn.setAttribute('aria-expanded', 'true');

    const onDocDown = (e) => {
      if (panel.contains(e.target) || btn.contains(e.target)) return;
      closeOpen();
    };
    const onKey = (e) => {
      // 焦点在筛选框里时不抢方向键（Enter / ↑↓ 由筛选框自己处理）
      if (panel.__filter && document.activeElement === panel.__filter && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeOpen();
        btn.focus({ preventScroll: true });
        return;
      }
      const items = Array.from(panel.querySelectorAll('.csel-opt:not([disabled]):not([hidden])'));
      if (!items.length) return;
      let cur = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (cur < 0) cur = e.key === 'ArrowDown' ? -1 : items.length;
        const next = e.key === 'ArrowDown' ? (cur + 1) % items.length : (cur - 1 + items.length) % items.length;
        items[next].focus({ preventScroll: false });
      } else if (e.key === 'Enter' || e.key === ' ') {
        if (cur < 0) return;
        e.preventDefault();
        items[cur].click();
      }
    };
    /**
     * 面板内部自己滚动（长列表）绝不能把面板关掉 —— 这里曾经用
     * 「window 捕获期 scroll 一律 close」的写法，结果滚轮一碰列表面板就消失，
     * 用户根本选不中。只有面板之外的滚动才该关。
     */
    const onScroll = (e) => {
      if (e && e.target && e.target.nodeType === 1 && panel.contains(e.target)) return;
      closeOpen();
    };

    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, true);

    openCtx = { sel, panel, btn, onDocDown, onKey, onScroll };

    panel.addEventListener('click', (e) => {
      const item = e.target.closest('.csel-opt');
      if (!item || item.disabled || item.hidden) return;
      const idx = Number(item.dataset.index);
      const target = sel.options[idx];
      if (!target) return;
      const changed = sel.value !== target.value;
      sel.value = target.value;
      sync();
      closeOpen();
      btn.focus({ preventScroll: true });
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    });

    if (panel.__filter) {
      const filter = panel.__filter;
      filter.addEventListener('input', () => {
        const q = filter.value.trim().toLowerCase();
        panel.querySelectorAll('.csel-opt').forEach((it) => {
          const txt = (it.querySelector('.csel-opt-txt') || {}).textContent || '';
          it.hidden = !!q && txt.toLowerCase().indexOf(q) < 0;
        });
        place(panel);
      });
      filter.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const first = panel.querySelector('.csel-opt:not([disabled]):not([hidden])');
          if (first) first.click();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          if (filter.value) {
            filter.value = '';
            panel.querySelectorAll('.csel-opt').forEach((it) => (it.hidden = false));
            place(panel);
          } else {
            closeOpen();
            btn.focus({ preventScroll: true });
          }
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          const first = panel.querySelector('.csel-opt:not([disabled]):not([hidden])');
          if (first) first.focus({ preventScroll: false });
        }
      });
      // 直接开打就能筛，不用先点一下
      setTimeout(() => {
        try {
          filter.focus({ preventScroll: true });
        } catch (e) {
          /* ignore */
        }
      }, 0);
    } else {
      const selected =
        panel.querySelector('.csel-opt.is-sel:not([disabled])') || panel.querySelector('.csel-opt:not([disabled])');
      // preventScroll：聚焦选中项会把这行滚进视野，进而触发 scroll → 面板被关掉
      if (selected) selected.focus({ preventScroll: true });
    }
  }

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    open();
  });
  btn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!openCtx || openCtx.sel !== sel) open();
    }
  });

  // 选项被程序换掉（innerHTML = ...）时重建
  const mo = new MutationObserver(() => sync());
  mo.observe(sel, { childList: true, subtree: true });

  // 程序直接赋值 sel.value 时同步显示
  const proto = window.HTMLSelectElement && HTMLSelectElement.prototype;
  const desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.get && desc.set) {
    Object.defineProperty(sel, 'value', {
      configurable: true,
      enumerable: true,
      get() {
        return desc.get.call(this);
      },
      set(v) {
        desc.set.call(this, v);
        sync();
      }
    });
  }

  sync();
  return { sync, open, close: closeOpen };
}

function escapeText(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

/** 把 root 里所有原生 select 升级成自绘下拉 */
export function enhanceAll(root) {
  const scope = root || document;
  const list = scope.querySelectorAll('select:not([data-csel])');
  const made = [];
  list.forEach((s) => {
    const h = enhanceSelect(s);
    if (h) made.push(s.id || s.className);
  });
  return made;
}

export function closeAll() {
  closeOpen();
}
