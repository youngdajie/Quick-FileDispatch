/**
 * 深空粒子背景（只在浅色主题下运行）。
 *
 * 浅色界面本来就平，加一层缓慢漂移的粒子 + 近邻连线做底，
 * 透过面板（浅色下顶栏 / 侧栏 / 卡片都带一点透明度）隐约看到，不抢内容。
 *
 * 几条自我约束：
 *   - 深色主题直接停掉 rAF 并把画布隐藏 —— 深色本身已经有层次，再叠粒子只会显脏。
 *   - 粒子数按窗口面积算并封顶，避免大屏上几百个点两两连线把主线程吃满
 *     （连线的复杂度是 O(n²)，粒子数翻倍代价翻四倍）。
 *   - 页面不可见、或系统开了「减弱动态效果」时不跑动画。
 */

const HOST_ID = 'universe';

/** 多少 CSS px² 放一个粒子；数越大越稀 */
const AREA_PER_DOT = 15000;
const MAX_DOTS = 120;
const MIN_DOTS = 34;

/** 超过这个距离就不画线 */
const LINK_DIST = 118;
const LINK_DIST2 = LINK_DIST * LINK_DIST;
const LINK_ALPHA = 0.19;

/** 预设色阶：每帧拼 rgba() 字符串太浪费，按透明度分档查表 */
const STEPS = 16;
const DOT_COLORS = [];
const LINE_COLORS = [];
for (let i = 0; i < STEPS; i++) {
  DOT_COLORS.push('rgba(35, 84, 145, ' + (((i + 1) / STEPS) * 0.86).toFixed(3) + ')');
  LINE_COLORS.push('rgba(47, 127, 214, ' + (((i + 1) / STEPS) * LINK_ALPHA).toFixed(3) + ')');
}

let canvas = null;
let ctx = null;
let observer = null;

/** 粒子坐标是 CSS px，画布按 dpr 放大后再 setTransform 缩放回来 */
let w = 0;
let h = 0;

let dots = [];
let running = false;
let raf = 0;
let lastTs = 0;
let resizeTimer = 0;

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

function isLight() {
  return document.documentElement.dataset.theme === 'light';
}

function makeDot() {
  return {
    x: Math.random() * w,
    y: Math.random() * h,
    vx: (Math.random() - 0.5) * 0.24,
    vy: (Math.random() - 0.5) * 0.24,
    r: 0.85 + Math.random() * 1.25,
    a: 0.34 + Math.random() * 0.52,
    // 呼吸相位：让每个点的明暗错开，整片看起来是活的
    tw: Math.random() * Math.PI * 2,
    tws: 0.005 + Math.random() * 0.011
  };
}

/** 按当前窗口尺寸补齐 / 裁掉粒子，并把越界的挪回画面内 */
function fitDots() {
  const want = Math.max(MIN_DOTS, Math.min(MAX_DOTS, Math.round((w * h) / AREA_PER_DOT)));
  while (dots.length < want) dots.push(makeDot());
  if (dots.length > want) dots.length = want;
  dots.forEach((p) => {
    if (p.x > w || p.y > h) {
      p.x = Math.random() * w;
      p.y = Math.random() * h;
    }
  });
}

function resize() {
  if (!canvas || !ctx) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  w = window.innerWidth;
  h = window.innerHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  fitDots();
}

function move() {
  for (let i = 0; i < dots.length; i++) {
    const p = dots[i];
    p.x += p.vx;
    p.y += p.vy;
    p.tw += p.tws;
    if (p.x < 0) p.x += w;
    else if (p.x > w) p.x -= w;
    if (p.y < 0) p.y += h;
    else if (p.y > h) p.y -= h;
  }
}

function draw() {
  ctx.clearRect(0, 0, w, h);

  // 先画线：让点压在线上，点才显得实
  ctx.lineWidth = 0.7;
  for (let i = 0; i < dots.length; i++) {
    const a = dots[i];
    for (let j = i + 1; j < dots.length; j++) {
      const b = dots[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const d2 = dx * dx + dy * dy;
      if (d2 > LINK_DIST2) continue;
      const t = 1 - Math.sqrt(d2) / LINK_DIST;
      ctx.strokeStyle = LINE_COLORS[Math.min(STEPS - 1, Math.floor(t * STEPS))];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }

  for (let i = 0; i < dots.length; i++) {
    const p = dots[i];
    // 0.62~1 之间呼吸，不让它闪得太明显
    const pulse = 0.62 + 0.38 * Math.sin(p.tw);
    const a = Math.max(0.04, Math.min(0.95, p.a * pulse));
    ctx.fillStyle = DOT_COLORS[Math.min(STEPS - 1, Math.floor(a * STEPS))];
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function frame(ts) {
  if (!running || document.hidden) {
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(frame);
  // 稳到 ~50fps：再高对背景来说看不出差别，只是白白耗电
  if (ts - lastTs < 20) return;
  lastTs = ts;
  move();
  draw();
}

function play() {
  if (raf) return;
  raf = requestAnimationFrame(frame);
}

function pause() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
  running = false;
}

/** 主题或尺寸变了之后，把「该不该跑」重新算一遍 */
function sync() {
  if (!canvas) return;
  const on = isLight();
  canvas.hidden = !on;
  if (!on) {
    pause();
    if (ctx) ctx.clearRect(0, 0, w, h);
    return;
  }
  if (!w || !h) resize();
  if (reducedMotion()) {
    // 系统要求减弱动态效果：给一张静态的底，动画一个都不跑
    pause();
    draw();
    return;
  }
  running = true;
  play();
}

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!canvas || !isLight()) return;
    resize();
    if (!running) draw();
  }, 160);
}

function onVisibility() {
  if (!canvas || !isLight()) return;
  if (document.hidden) {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  } else if (running && !raf) {
    lastTs = 0;
    raf = requestAnimationFrame(frame);
  }
}

/**
 * 挂上背景。幂等 —— 重复调用只会拿到同一份实例。
 * 主题由 MutationObserver 盯着，外面不用手动通知。
 */
export function initUniverse() {
  if (canvas) return;
  const el = document.getElementById(HOST_ID);
  if (!el || typeof el.getContext !== 'function') return;
  const c = el.getContext('2d');
  if (!c) return;

  canvas = el;
  ctx = c;

  observer = new MutationObserver(sync);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', onVisibility);

  sync();
}

/** 自检用：看一眼当前跑没跑、有多少粒子 */
export function universeState() {
  return {
    mounted: !!canvas,
    light: isLight(),
    running: running && !!raf,
    dots: dots.length,
    size: [w, h]
  };
}
