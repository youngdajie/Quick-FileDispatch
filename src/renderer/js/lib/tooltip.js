/**
 * 原生 title 提示的替身（全局装一次）。
 *
 * Chromium 给带 title 的元素画的那个系统小框在自绘界面里非常突兀：
 * 深色主题下黑底白字、出现在元素下方偏右、没有过渡。这里整个接管 ——
 * 悬停时先把 title 摘下来（原生就没机会弹），改画一个自绘的云朵气泡：
 * 圆角胶囊 + 小尾巴、宽度贴合文本、配色走主题变量、出现/消失带过渡。
 *
 * 状态机只有一条铁律：**title 的恢复只归 mouseout 管**（鼠标真正离开元素）。
 * 点击 / 滚动 / 缩放 / 失焦这些「鼠标还悬在元素上」的时机一律只收气泡、
 * 保持 title 摘除 —— 一旦提前还回去，原生黑框马上就会弹出来
 * （点一下顶栏的主题按钮、鼠标不动就能复现，露馅就是这么来的）。
 */

const SHOW_DELAY = 140; // 和系统弹提示的节奏对齐：快速划过不闪
const GAP = 9; // 气泡与元素的间距（尾巴露 3.5px，其余是呼吸空间）

let tipEl = null;
let showTimer = null;
let shown = null; // 正在显示气泡的宿主
let stolenEl = null; // 当前 title 被摘除的元素（气泡可能还没显示或已被收起）

/**
 * title 盯防：悬停（摘除）期间，外部代码如果又给这个元素赋了 title
 * （典型：点顶栏主题按钮 → 切主题 → updateChrome 重设按钮文案），
 * 必须立刻再摘掉 —— 否则在鼠标静止的窗口期里原生黑框就会弹出来。
 * observer 只挂当前这一个元素，开销可忽略。
 */
const titleWatch = new MutationObserver(() => {
  const node = stolenEl;
  if (!node || !node.hasAttribute('title')) return;
  node.dataset.qfdTip = node.getAttribute('title'); // 换成最新文案
  node.removeAttribute('title');
});

function watch(node) {
  titleWatch.disconnect();
  if (node) titleWatch.observe(node, { attributes: true, attributeFilter: ['title'] });
}

function el() {
  if (!tipEl) {
    // 容器本身不画任何东西（无背景/边框），气泡体和尾巴是里面的两层 ——
    // 尾巴用 z-index:-1 压在气泡体下面，只露出尖角，接缝处被气泡体的底色和边框盖住
    tipEl = document.createElement('div');
    tipEl.className = 'qfd-tip';
    tipEl.setAttribute('aria-hidden', 'true');
    tipEl.innerHTML = '<i class="qfd-tip-tail"></i><span class="qfd-tip-body"></span>';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/**
 * 取「气泡该对齐到哪里」的水平范围。
 *
 * 默认是整个元素；但像文件格的 `.tile-name` 这种块级元素占满整格、
 * 文本却很短（"img"），按元素居中气泡会飘到格子中间、对不上文字。
 * 这种时候改按文本实际范围对齐。
 *
 * 用 Range 选中内容节点再取 rect：单行文本拿到的就是文字本身的紧凑宽度，
 * 左边缘正好是文字起点。
 */
function anchorRect(el) {
  const box = el.getBoundingClientRect();
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    // 文本明显比元素窄（说明是「宽格短字」）才按文本；否则（图标、整行链接、
    // 文字占满）退回元素整体 —— 那本来就是居中正确的
    if (r.width > 0 && r.width < box.width * 0.9) {
      return { left: r.left, width: r.width };
    }
  } catch (e) {
    /* 无文本内容的节点拿不到范围，退回元素 */
  }
  return { left: box.left, width: box.width };
}

/** 定到宿主正上方居中；越界夹进视口，贴顶就翻到下面 */
function place(target) {
  const tip = el();
  // 用 offset* 而不是 getBoundingClientRect：后者会被入场动画的 scale 缩掉 2%
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  const r = target.getBoundingClientRect();
  const a = anchorRect(target);
  const cx = a.left + a.width / 2;
  let left = cx - w / 2;
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  // 尾巴跟着目标中心走：气泡被视口夹回来后，尾巴不能傻站在气泡中点，
  // 否则左/右边缘的元素（比如侧栏底部的「16 核」）会明显对不上
  const tailX = Math.max(16, Math.min(cx - left, w - 16));
  tip.style.setProperty('--tail-x', Math.round(tailX) + 'px');
  let top = r.top - h - GAP;
  const below = top < 6;
  if (below) top = r.bottom + GAP;
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(top) + 'px';
  tip.classList.toggle('below', below);
}

function showTip(target, text) {
  const tip = el();
  tip.querySelector('.qfd-tip-body').textContent = text;
  tip.classList.add('show');
  place(target);
}

function hideTip() {
  if (tipEl) tipEl.classList.remove('show');
}

function clearTimer() {
  if (showTimer) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

/** 收起气泡但**不**动 title —— 所有「鼠标可能还在原地」的场景都走这里 */
function collapse() {
  clearTimer();
  shown = null;
  hideTip();
}

/** 把 title 摘下来暂存（原生 tooltip 的触发源就是它） */
function stealTitle(target) {
  const t = target.getAttribute('title');
  if (t === null) return null;
  target.dataset.qfdTip = t;
  target.removeAttribute('title');
  return t;
}

function restoreTitle(target) {
  const t = target.dataset.qfdTip;
  if (t === undefined) return;
  delete target.dataset.qfdTip;
  // 元素若已被外部赋了新 title，就丢弃暂存的旧值，别把新文案冲掉
  if (!target.hasAttribute('title')) target.setAttribute('title', t);
}

/** 鼠标离开宿主（或离开窗口）：这时才把 title 还回去。
 *  只清理「自己人」的状态 —— 真实鼠标快速划过别的元素时，
 *  那些无关元素的 mouseout 绝不能误杀正在排队/显示中的气泡 */
function release(host) {
  if (stolenEl === host) {
    stolenEl = null;
    watch(null);
    clearTimer(); // 宿主自己还在排队的话，取消
  }
  if (shown === host) {
    hideTip();
    shown = null;
  }
  restoreTitle(host);
}

export function installTooltips() {
  document.addEventListener('mouseover', (e) => {
    let target = e.target instanceof Element ? e.target.closest('[title]') : null;
    if (!target) {
      // 没 title 但带 data-ext 的链接也接进来：先把地址补成 title（顺手补全了
      // 无障碍语义），再走标准摘除/恢复流程 —— 致敬卡、设置页的「申请地址」
      // 这类链接从此都有云朵提示
      const a = e.target instanceof Element ? e.target.closest('a[data-ext]') : null;
      if (a && a.dataset.ext) {
        a.setAttribute('title', a.dataset.ext);
        target = a;
      }
    }
    if (!target || target === stolenEl) return;
    // 换到新宿主：把上一个的 title 还回去（它可能正显示气泡，也可能只是被摘着）
    if (stolenEl) {
      restoreTitle(stolenEl);
      stolenEl = null;
    }
    collapse();
    const text = stealTitle(target);
    if (text === null) {
      watch(null);
      return;
    }
    stolenEl = target;
    watch(target);
    showTimer = setTimeout(() => {
      showTimer = null;
      if (stolenEl !== target) return;
      showTip(target, text);
      shown = target;
    }, SHOW_DELAY);
  });

  document.addEventListener('mouseout', (e) => {
    const from = e.target instanceof Element ? e.target.closest('[data-qfd-tip]') : null;
    if (!from) return;
    // 宿主内部子元素之间挪动不算离开
    if (e.relatedTarget instanceof Element && from.contains(e.relatedTarget)) return;
    release(from);
  });

  // 下面这些时刻鼠标多半还悬在元素上 —— 只收气泡，title 留在摘除状态
  document.addEventListener('mousedown', collapse);
  // 滚动 / 缩放 / 失焦同理；元素若真被滚走了，鼠标下一次移动会走 mouseout 还回去
  window.addEventListener('scroll', collapse, true);
  window.addEventListener('resize', collapse);
  window.addEventListener('blur', collapse);
}
