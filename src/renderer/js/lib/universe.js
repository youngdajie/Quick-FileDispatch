/**
 * 深空背景（浅色 / 深色两套形态，共用一块画布）。
 *
 * 浅色 —— 缓慢漂移的点阵 + 近邻连线。浅色界面本来就平，加一层极淡的底纹做质感；
 *          顶栏 / 侧栏 / 卡片在浅色下带一点透明度，粒子从面板后面隐约透出来。
 *
 * 深色 —— 星野，逐行照着 www.yangjie.site 那份 dark.js 移植过来的。
 *          密度、速度基数、三种粒子（巨星 / 彗星 / 普通小星）的比例和明灭节奏
 *          都保持原样，**别在这里「顺手优化」**：观感对不上就是因为动的这些。
 *          唯一的改动是把坐标换成 dpr 缩放（高分屏上边缘才不糊），
 *          尺寸仍然按 CSS px 算，画出来和网页上一样大。
 *
 * 几条自我约束：
 *   - 两套形态互不叠加：浅色不画星，深色不画连线（连线在近黑底上会显脏）。
 *   - 浅色点阵的连线是 O(n²)，粒子数必须封顶；深色星野是 O(n)，按原版密度来。
 *   - 页面不可见、或系统开了「减弱动态效果」时不跑动画。
 *   - 帧率锁在 ~50fps：再高对背景来说看不出差别，只是白白耗电。
 */

const HOST_ID = 'universe';
const TAU = Math.PI * 2;

/* ------------------------------------------------ 浅色：漂移点阵 */

/** 多少 CSS px² 放一个粒子；数越大越稀 */
const AREA_PER_DOT = 15000;
const MAX_DOTS = 120;
const MIN_DOTS = 34;

/** 超过这个距离就不画线 */
const LINK_DIST = 118;
const LINK_DIST2 = LINK_DIST * LINK_DIST;
const LINK_ALPHA = 0.19;

const STEPS = 16;
const DOT_COLORS = [];
const LINE_COLORS = [];
for (let i = 0; i < STEPS; i++) {
  DOT_COLORS.push('rgba(35, 84, 145, ' + (((i + 1) / STEPS) * 0.86).toFixed(3) + ')');
  LINE_COLORS.push('rgba(47, 127, 214, ' + (((i + 1) / STEPS) * LINK_ALPHA).toFixed(3) + ')');
}

/* ------------------------------------------------ 深色：星野（照搬主页那份） */

/** 原版里的 t：所有速度都以它为基数 */
const SPEED = 0.05;

const GIANT_RGB = '180,184,240';
const STAR_RGB = '226,225,142';
const COMET_RGB = '226,225,224';

/* ------------------------------------------------ 运行时状态 */

let canvas = null;
let ctx = null;
let observer = null;

/** 'light' | 'dark' | 'off'（off = 主题还没落定，画布收起来不画） */
let mode = 'off';

/** 粒子坐标是 CSS px，画布按 dpr 放大后再 setTransform 缩放回来 */
let w = 0;
let h = 0;

/** 浅色用 */
let dots = [];

/** 深色用：原版就是把所有粒子塞一个数组里 */
let field = [];
/** 原版是「粒子构造完 50ms 之后才开始放彗星」，照搬，刚切到深色先是一片干净的星星 */
let noCometYet = true;

let running = false;
let raf = 0;
let lastTs = 0;
let resizeTimer = 0;

function themeNow() {
  const t = document.documentElement.dataset.theme;
  if (t === 'light') return 'light';
  if (t === 'dark') return 'dark';
  return 'off';
}

function reducedMotion() {
  return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
}

/* ------------------------------------------------ 浅色：生成与绘制 */

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

function moveDots() {
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

function drawLight() {
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
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
}

/* ------------------------------------------------ 深色：生成与绘制 */

function rnd(min, max) {
  return Math.random() * (max - min) + min;
}

/** 原版的 m(t)：千分比命中。t=3 约 3% 是巨星，t=10 约 1% 是彗星 */
function chance(t) {
  return Math.floor(1000 * Math.random()) + 1 < 10 * t;
}

function makeParticle() {
  const p = {};

  p.reset = function () {
    p.giant = chance(3);
    p.comet = !p.giant && !noCometYet && chance(10);
    const c = p.comet ? 1 : 0;   // 原版写的是 (comet + 1 - 1)，就是取 0/1

    p.x = rnd(0, w - 10);
    p.y = rnd(0, h);
    p.r = rnd(1.1, 2.6);
    // 普通星朝右上慢慢漂；彗星在这个基础上再叠一段快得多的位移
    p.dx = rnd(SPEED, 6 * SPEED) + c * SPEED * rnd(50, 120) + 2 * SPEED;
    p.dy = -rnd(SPEED, 6 * SPEED) - c * SPEED * rnd(50, 120);

    // fadingOut 用 null / true / false 三态：只有 false 才表示「淡完了，该重来」
    p.fadingOut = null;
    p.fadingIn = true;
    p.opacity = 0;
    p.opacityTresh = rnd(0.2, 1 - 0.4 * c);
    p.do = rnd(0.0005, 0.002) + 0.001 * c;
  };

  p.fadeIn = function () {
    if (!p.fadingIn) return;
    p.fadingIn = !(p.opacity > p.opacityTresh);
    p.opacity += p.do;
  };

  p.fadeOut = function () {
    if (!p.fadingOut) return;
    p.fadingOut = !(p.opacity < 0);
    p.opacity -= p.do / 2;
    if (p.x > w || p.y < 0) {
      p.fadingOut = false;
      p.reset();
    }
  };

  p.move = function () {
    p.x += p.dx;
    p.y += p.dy;
    if (p.fadingOut === false) p.reset();
    // 飘到右边 1/4 或者越过顶边就开始淡出
    if (p.x > w - w / 4 || p.y < 0) p.fadingOut = true;
  };

  p.draw = function () {
    ctx.beginPath();
    if (p.giant) {
      // 巨星：稍微大一点的圆点，颜色偏冷紫
      ctx.fillStyle = 'rgba(' + GIANT_RGB + ',' + p.opacity + ')';
      ctx.arc(p.x, p.y, 2, 0, TAU, false);
    } else if (p.comet) {
      // 彗星：一个头 + 30 个方点拖尾。原版是在循环里边补路径边 fill，
      // 越靠后的拖尾被 fill 的次数越少，自然就淡了 —— 照搬，别改成渐变线。
      ctx.fillStyle = 'rgba(' + COMET_RGB + ',' + p.opacity + ')';
      ctx.arc(p.x, p.y, 1.5, 0, TAU, false);
      for (let k = 0; k < 30; k++) {
        ctx.fillStyle = 'rgba(' + COMET_RGB + ',' + (p.opacity - (p.opacity / 20) * k) + ')';
        ctx.rect(p.x - (p.dx / 4) * k, p.y - (p.dy / 4) * k - 2, 2, 2);
        ctx.fill();
      }
    } else {
      // 普通星：一个边长为 r 的方块
      ctx.fillStyle = 'rgba(' + STAR_RGB + ',' + p.opacity + ')';
      ctx.rect(p.x, p.y, p.r, p.r);
    }
    ctx.closePath();
    ctx.fill();
  };

  return p;
}

function buildField() {
  field = [];
  // 原版的密度：0.216 × 窗口宽度，跟高度无关
  const want = Math.floor(0.216 * w);
  for (let i = 0; i < want; i++) {
    const p = makeParticle();
    p.reset();
    field.push(p);
  }
  noCometYet = true;
  setTimeout(() => {
    noCometYet = false;
  }, 50);
}

function drawDark() {
  ctx.clearRect(0, 0, w, h);
  // 顺序跟原版一致：先走位，再明灭，最后画
  for (let i = 0; i < field.length; i++) {
    const p = field[i];
    p.move();
    p.fadeIn();
    p.fadeOut();
    p.draw();
  }
}

/* ------------------------------------------------ 共用的调度 */

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
  // 原版 resize 只管画布尺寸，粒子一颗都不动 —— 越界的自己会淡出重生。
  // 这里跟着来，免得窗口一小一大就把整片星空洗牌一次。
}

/** 换主题时把当前这套形态的粒子备齐，另一套直接丢掉 */
function buildFor() {
  if (mode === 'dark') {
    dots = [];
    buildField();
  } else if (mode === 'light') {
    field = [];
    dots = [];
    fitDots();
  }
}

function frame(ts) {
  if (!running || document.hidden) {
    raf = 0;
    return;
  }
  raf = requestAnimationFrame(frame);
  // 稳到 ~50fps
  if (ts - lastTs < 20) return;
  lastTs = ts;
  if (mode === 'dark') drawDark();
  else {
    moveDots();
    drawLight();
  }
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
  const next = themeNow();
  const changed = next !== mode;
  mode = next;
  canvas.hidden = mode === 'off';
  if (mode === 'off') {
    pause();
    if (ctx) ctx.clearRect(0, 0, w, h);
    return;
  }
  if (!w || !h) resize();
  if (changed) buildFor();
  if (reducedMotion()) {
    // 系统要求减弱动态效果：给一张静态的底，动画一个都不跑
    pause();
    if (mode === 'dark') drawDark();
    else drawLight();
    return;
  }
  running = true;
  play();
}

function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!canvas || mode === 'off') return;
    resize();
    if (!running) {
      if (mode === 'dark') drawDark();
      else drawLight();
    }
  }, 160);
}

function onVisibility() {
  if (!canvas || mode === 'off') return;
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

  // mode 先落定，sync() 里才不会把「本该建的地基」当成没变过而跳过
  mode = 'off';
  sync();
}

/** 自检用：看一眼当前跑没跑、是哪种形态、有多少粒子 */
export function universeState() {
  let giants = 0;
  let comets = 0;
  for (let i = 0; i < field.length; i++) {
    if (field[i].giant) giants++;
    if (field[i].comet) comets++;
  }
  return {
    mounted: !!canvas,
    mode: mode,
    light: mode === 'light',
    running: running && !!raf,
    dots: dots.length,
    stars: field.length,
    giants: giants,
    comets: comets,
    size: [w, h]
  };
}
