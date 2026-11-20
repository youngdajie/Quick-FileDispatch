/** 应用入口：路由 + 顶栏状态 + 首次启动引导 */

import { $, err, toast, modal, paintRanges, paintRange } from './lib/dom.js';
import { enhanceAll } from './lib/cselect.js';
import { enhanceNumbers } from './lib/numfield.js';
import { installTooltips } from './lib/tooltip.js';
import * as fileIcons from './lib/fileicons.js';
import state from './lib/state.js';
import * as appearance from './lib/appearance.js';
import { initUniverse, universeState, paintNow, suspendUniverse, resumeUniverse } from './lib/universe.js';
import { openConfigWizard } from './lib/config-wizard.js';
import uploadPage from './pages/upload.js';
import managePage from './pages/manage.js';
import settingsPage from './pages/settings.js';
import aboutPage from './pages/about.js';

/**
 * 顶栏那个昼夜按钮的图标：露出来的永远是「点了会变成什么」。
 * 深色主题下显示太阳（点击转亮），浅色主题下显示月亮（点击转暗）。
 *
 * 只换图标，不做旋转 —— 那圈 590ms 的转圈纯属自娱自乐：揭幕本身已经把
 * 主题切换讲清楚了，再转一个图标只是让人多等半秒。
 */
function setThemeButtonIcon(light) {
  const button = $('#btnTheme');
  if (!button) return;
  button.querySelector('.theme-icon-sun')?.classList.toggle('is-current', !light);
  button.querySelector('.theme-icon-moon')?.classList.toggle('is-current', light);
  const label = light ? '切换到深色模式' : '切换到浅色模式';
  button.title = label;
  button.setAttribute('aria-label', label);
}

/*
 * 揭幕的时长与缓动写在 CSS 里（html.vt-expand / html.vt-shrink 那两条），
 * JS 只负责把圆心和最远半径写进 --vt-x / --vt-y / --vt-r。
 *
 * 为什么不在 JS 里 animate：见 app.css 同一段的注释 —— ready 之后挂动画
 * 会漏掉开头一帧「无裁剪」，看上去就是瞬间全屏。
 */

/**
 * 等到「下一帧画完」（两次 rAF）。
 *
 * 只在降级路径用：瞬时切色时，样式改完要等浏览器真的画过一帧，
 * 才好把 transition 放回去 —— 放开早了，颜色会从旧值慢慢爬过去。
 *
 * ⚠️ 千万别在 startViewTransition 的 update 回调里 await 它：过渡期间
 * rAF 是停的，await 下去新快照永远拍不出来，过渡会在 4 秒后以
 * 「DOM update timed out」整段作废（实测踩过，动画会直接消失）。
 */
function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

/**
 * 圆心取点击位置：白转黑从这一点铺开，黑转白从四周收回这一点。
 * 键盘触发（clientX/Y 都是 0）退到按钮中心，再退到视口中心 ——
 * 圆心落在左上角是这套动效最难看的一种失败态，三级兜底不能省。
 */
function revealOrigin(ev) {
  if (ev && (ev.clientX || ev.clientY)) return { x: ev.clientX, y: ev.clientY };
  const el = (ev && (ev.currentTarget || ev.target)) || document.getElementById('btnTheme');
  const r = el && el.getBoundingClientRect ? el.getBoundingClientRect() : null;
  if (r && r.width) return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
}

/**
 * 页面上当前显示的是哪一侧。
 *
 * 不能直接读 state.cfg.ui.theme：那个值可能是 'system'，而且要等 state 更新才变；
 * 揭幕期间连点、系统主题变化都要立刻读到新值，所以单独记一份。
 * 配置里存的「模式」和这里记的「显示值」是两件事 —— 混在一起的结果就是
 * 跟随系统时被 commitTheme 悄悄改写成 'dark'，之后再也不会跟着系统变。
 */
let shownTheme = 'dark';

/**
 * 配置里现在记着的是哪一侧（可能是 'system'）—— 顶栏按钮据此判断「还要不要写盘」。
 *
 * 放模块级是因为它有两个写入方：揭幕落盘成功之后写，以及任何一次配置回灌
 * （applyConfigEverywhere，比如在设置页选主题）。只让揭幕那条路写，会和配置
 * 悄悄脱节。
 */
let savedCfgTheme = 'dark';

function themeIsLight() {
  return shownTheme === 'light';
}

/* ---------------------------------------------------------------- 启动画面 */

/** 最短停留：再好看也不该让人干等，1 秒内必须让开 */
const BOOT_MIN_MS = 820;
const bootStartedAt = performance.now();
let bootDismissed = false;

/**
 * 收起启动画面。
 *
 * 界面（尤其是首屏的缩略图和字体）往往已经渲染好了，但 splash 上那几段
 * 动画才播到一半 —— 等到最短停留时间再淡出，节奏才是稳的，不会「闪一下」。
 * force 用于启动失败：那时要立刻让开，把错误露出来。
 */
function dismissBootSplash(force) {
  if (bootDismissed) return;
  bootDismissed = true;
  const el = document.getElementById('bootSplash');
  if (!el) return;
  if (force) {
    el.remove();
    return;
  }
  const run = () => {
    el.classList.add('is-out');
    const app = document.getElementById('appRoot');
    if (app) app.classList.add('app-enter');
    setTimeout(() => {
      if (el.parentNode) el.remove();
    }, 640);
  };
  const wait = Math.max(0, BOOT_MIN_MS - (performance.now() - bootStartedAt));
  setTimeout(run, wait);
}

const PAGES = {
  upload: uploadPage,
  manage: managePage,
  settings: settingsPage,
  about: aboutPage
};

let current = 'upload';
let updateActionRunning = false;
/** 揭幕进行中：挡住连点（同一页只能有一个 view transition） */
let revealing = false;
/** 揭幕期间落回来的配置变更：记一笔，等动画结束再统一应用 */
let deferredAppearance = false;

/**
 * 内容区的滚动分流：短页面铺满、不滚；真长起来的内容照常滚。
 *
 * 为什么不靠纯 CSS：短页面在内容区底下总会多算 5px 上下的 scrollHeight ——
 * 遍历内容区所有后代都没元素越界（offenders 为空），说明那几像素不属于任何元素，
 * 是滚动容器自己的计算。min-height / height / flex / grid / overflow / 负 margin /
 * 收 padding 全试过，按不住。所以按「溢出量」分流：十几像素以内的一律当
 * 「本该铺满」，把滚动关掉 —— 就多那几像素，裁掉也看不见。
 *
 * ⚠️ 内容**变化时也要重算**：上传页的「图片设置」是可以展开的，展开后页面长高，
 * 这里要跟着把滚动放开，否则鼠标滚不动、设置项够不着（就是漏了这一点出的问题）。
 */
/**
 * 量一次并决定要不要滚。
 *
 * ⚠️ 只在**值真的变化**时才写 style —— 这是必须的：
 * 写 overflowY 会让滚动条出现/消失，进而改变 clientHeight，
 * 而 ResizeObserver 正盯着这块；每次无条件改写就形成
 * 「改 → 触发 RO → 再改」的自激循环，浏览器直接报
 *   ResizeObserver loop completed with undelivered notifications
 * （2026-10-10 实测，就是这个原因）。
 */
function applyFit() {
  const content = $('#content');
  if (!content) return;
  /*
   * 「上传选项」展开期间不许关滚动。
   *
   * 展开时 pages/upload.js 会在 .upload-options-shell 后面插一块滚动占位
   * （.up-scroll-pad），就是为了让 scrollHeight 够把 shell 顶到内容区顶部。
   * 但占位高度 = clientHeight - shellHeight - 40，窗口矮、shell 又高的时候
   * 它会被压到 0，这时 slack 可能落进下面那 20px 的「短页面」判据里 ——
   * 一旦判成 hidden，收起前内容区就彻底滚不动，scrollTo 变成空操作
   * （QA 实测：空队列时 scrollTop 恒为 0）。所以展开期间直接放行。
   *
   * 这里只在值真的不同时才写 style，理由和下面那段完全一样（防 RO 自激）。
   */
  if (content.classList.contains('up-scroll-open')) {
    if (content.style.overflowY !== 'auto') content.style.overflowY = 'auto';
    return;
  }
  if (content.style.overflowY !== '') content.style.overflowY = '';
  const slack = content.scrollHeight - content.clientHeight;
  const want = (slack > 0 && slack < 20) ? 'hidden' : '';
  if (content.style.overflowY !== want) {
    content.style.overflowY = want;
  }
  if (want === 'hidden') content.scrollTop = 0;
}

/**
 * 量一次不够 —— 切页后布局往往还在动（字体、缩略图、折叠动画 0.34s），
 * 当下量到的还没到最终高度。所以要等一下按「稳定后」的高度再量一次，
 * 否则会出现「明明该滚却滚不动」或者相反的情况。
 */
function fitContentScroll() {
  applyFit();
  setTimeout(applyFit, 450);
}

/** 页面里任何一次点击之后也复核一遍：展开 / 收起这类动作都会改变高度 */
document.addEventListener('click', () => setTimeout(applyFit, 500), true);

/** 盯住当前页面：长高/变矮（展开、收起、列表加载完）都重新分流一次 */
let contentRO = null;
function watchActivePage() {
  const content = $('#content');
  const page = content && content.querySelector('.page.active');
  if (!page || typeof ResizeObserver === 'undefined') return;
  if (contentRO) contentRO.disconnect();
  // 回调里用 rAF 挪到下一帧再处理：RO 回调中同步改布局同样容易触发上面那个循环
  contentRO = new ResizeObserver(() => requestAnimationFrame(applyFit));
  contentRO.observe(page);
}

function go(name) {
  if (!PAGES[name]) return;
  const first = current !== name;
  current = name;

  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === name));
  document.querySelectorAll('.page').forEach((p) => p.classList.toggle('active', p.id === 'page-' + name));
  $('#content').scrollTop = 0;
  // 短页面在内容区底下总会多算 5px 上下的 scrollHeight —— 遍历内容区里所有后代，
  // 没有任何元素越界（offenders 为空），说明这几像素不属于任何元素，是滚动容器
  // 自己的计算。CSS 那边试过 min-height / height / flex / grid / overflow /
  // 负 margin / 收 padding，全都按不住它。
  //
  // 所以这里按「溢出量」分流：十几像素以内的一律当「本该铺满」，直接把滚动关掉
  // （内容只多出那几像素，裁掉也看不见）；真需要滚的长页面（溢出成百上千）不碰。
  // 用 rAF 等一帧再量，这时布局已经稳定。
  requestAnimationFrame(() => { fitContentScroll(); watchActivePage(); });

  if (first && PAGES[name].onEnter) {
    try {
      PAGES[name].onEnter();
    } catch (e) {
      err(e.message || String(e));
    }
  }
  // 页面里的滑块可能刚被 onConfigChanged 改过值，切页时顺手重画填充进度
  paintRanges($('#page-' + name));
}

function updateChrome() {
  const info = state.info || {};
  $('#cpuBadge').textContent = (info.cpuCount || navigator.hardwareConcurrency || '-') + ' 核';
  $('#cpuBadge').title = '压缩线程池按 CPU 核心数并行';
  if (!updateActionRunning) $('#verBadgeText').textContent = 'v' + (info.version || '1.2');

  // 顶栏的昼夜按钮跟着配置走。state 每次变更都会回到这儿，
  // 所以在设置页里点主题卡片，顶栏图标也会跟着换，不会两边对不上。
  const btnTheme = $('#btnTheme');
  if (btnTheme) {
    setThemeButtonIcon(themeIsLight());
  }
}

const formatUpdateSize = (bytes) => (bytes > 0 ? (bytes / 1048576).toFixed(1) + ' MB' : '—');
const RELEASES_URL = 'https://cnb.cool/youngdajie/Quick-FileDispatch/-/releases';

function confirmUpdate(result) {
  return new Promise((resolve) => {
    let decided = false;
    const finish = (yes) => {
      if (decided) return;
      decided = true;
      resolve(yes);
    };
    modal({
      title: '发现新版本 ' + result.latest,
      text: '当前 ' + result.current + ' → 最新 ' + result.latest + '\n' +
        '确认后会下载安装包并自动安装，程序会退出再重新启动。\n\n' +
        '安装期间程序暂时无法使用。',
      actions: [{
        label: '版本说明',
        title: '打开 CNB 版本发布页',
        onClick: () => window.cloudpic.shell.openExternal(RELEASES_URL)
      }],
      buttons: [
        { label: '稍后', onClick: () => finish(false) },
        { label: '下载并重启', primary: true, onClick: () => finish(true) }
      ],
      onClose: () => finish(false)
    });
  });
}

async function waitForUpdateDownload() {
  const label = $('#verBadgeText');
  await new Promise((resolve, reject) => {
    let polling = false;
    const timer = setInterval(async () => {
      if (polling) return;
      polling = true;
      try {
        const progress = await window.cloudpic.update.progress();
        if (progress.status === 'downloading') {
          const pct = progress.total > 0 ? Math.round((progress.got / progress.total) * 100) + '%' : '';
          label.textContent = '下载 ' + pct;
          $('#verBadge').title = '正在下载：' + formatUpdateSize(progress.got) + ' / ' + formatUpdateSize(progress.total);
        } else if (progress.status === 'ready') {
          clearInterval(timer);
          label.textContent = '安装中…';
          $('#verBadge').title = '下载完成，正在安装更新';
          await window.cloudpic.update.install();
          resolve();
        } else if (progress.status === 'error') {
          clearInterval(timer);
          reject(new Error(progress.error || '下载失败'));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      } finally {
        polling = false;
      }
    }, 400);
  });
}

async function checkForUpdates() {
  const badge = $('#verBadge');
  const label = $('#verBadgeText');
  if (!badge || updateActionRunning) return;
  updateActionRunning = true;
  badge.disabled = true;
  badge.classList.add('is-busy');
  badge.title = '正在检查更新';
  label.textContent = '检查中…';
  try {
    const result = await window.cloudpic.update.check();
    if (!result.hasUpdate) {
      toast('当前已是最新版（v' + (result.current || (state.info && state.info.version) || '-') + '）', 'ok');
      return;
    }
    const confirmed = await confirmUpdate(result);
    if (!confirmed) return;
    badge.title = '正在下载更新';
    label.textContent = '下载中…';
    await window.cloudpic.update.download({ url: result.url, name: result.assetName, ver: result.latest });
    await waitForUpdateDownload();
  } catch (error) {
    err(error.message || String(error));
  } finally {
    updateActionRunning = false;
    badge.disabled = false;
    badge.classList.remove('is-busy');
    label.textContent = 'v' + ((state.info && state.info.version) || '1.2');
    badge.title = '检查软件更新';
  }
}

/**
 * 一份配置落到界面上的全部动作。
 *
 * 单独抽出来是因为它有第二个调用点：揭幕动画期间落回来的 emit 要先押后
 * （动画窗口里跑这套重活就是掉帧），等动画结束再补一次。
 */
function applyConfigEverywhere(cfg) {
  // 配置落回来了：显示值以它为准（'system' 在这里解析成具体哪一侧）
  shownTheme = appearance.resolveTheme(((cfg && cfg.ui) || {}).theme);
  // 「已落盘的主题」也跟着配置走。不跟的话，在设置页改主题（走的是同一份配置）
  // 之后顶栏按钮会拿着旧的已落盘值做判重，点一下只换皮不写盘 —— 配置记的还是
  // 设置页选的那一侧，看着像「点了没用」。
  savedCfgTheme = ((cfg && cfg.ui) || {}).theme || savedCfgTheme;
  appearance.applyAppearance(cfg);
  updateChrome();
  Object.keys(PAGES).forEach((k) => {
    if (PAGES[k].onConfigChanged) {
      try {
        PAGES[k].onConfigChanged();
      } catch (e) {
        /* ignore */
      }
    }
  });
  paintRanges();
}

function bindChrome() {
  document.querySelectorAll('.nav-item').forEach((b) => {
    b.onclick = () => {
      go(b.dataset.page);
    };
  });

  $('#verBadge').onclick = checkForUpdates;

  /*
   * 昼夜切换：圆形揭幕（View Transition API，同 BewlyCat 的 toggleDark）。
   *
   * 旧做法是「点一下 → 给 <html> 挂 .theme-instant 掐掉全站 transition →
   * 颜色啪地切过去」，颜色确实是瞬间换的，但那一瞬间没有任何过渡，
   * 观感就是硬切一下；再叠上各页 onConfigChanged，
   * 正好撞在同一个时间点上，看着就是卡。
   *
   * 现在分三层：
   *   1) 视觉：新主题从一个圆里扩散出来盖掉旧主题。两帧快照由浏览器合成，
   *      clip-path 动画走 WAAPI，不触发页面逐元素重算 —— 这才是「丝滑」的来源。
   *   2) 快照：update 回调里同步换色（带 .theme-instant 掐过渡，否则新快照会
   *      拍到过渡起点的旧颜色），星野也当场补画一帧。
   *   3) 落盘：动画结束后才写配置 —— 写盘回来的 emit 会再跑一遍全站外观和
   *      各页回调，那批活放在动画窗口里就是掉帧，放动画之后没人看得见。
   */
  const btnTheme = $('#btnTheme');
  let themeQueued = null; // 待落盘的主题
  let themeWriting = false;
  // 启动时的落盘基准：和 shownTheme 一样按配置解析，别假定默认是深色
  savedCfgTheme = (((state.cfg && state.cfg.ui) || {}).theme) || (themeIsLight() ? 'light' : 'dark');

  function freezeTransitions(on) {
    document.documentElement.classList.toggle('theme-instant', !!on);
  }

  /**
   * 当场换色：只改显示值与 DOM，不碰配置。
   *
   * 配置里那句 ui.theme 有可能是 'system'，改它等于把「跟随系统」降级成
   * 一次性钦定 —— 系统再变就没人听了。
   */
  function commitTheme(t) {
    shownTheme = t;
    const cfg = state.cfg || {};
    const preview = Object.assign({}, cfg, {
      ui: Object.assign({}, cfg.ui || {}, { theme: t })
    });
    freezeTransitions(true);
    // 整套外观一起算：快照拍的时候就得是最终颜色与字体，漏了会在揭幕落定时闪一下
    appearance.applyAppearance(preview);
    // 星野平时等 rAF 才画第一帧，这里同步补上，否则深色快照是一块空底
    paintNow();
    // 补完这一帧就把星野停住：动画期间它每帧都在画几百个粒子，
    // 和快照重绘抢同一个线程，掉帧就掉在揭幕上
    suspendUniverse();
    setThemeButtonIcon(t === 'light');
  }

  async function flushTheme() {
    if (themeWriting || themeQueued === null || themeQueued === savedCfgTheme) return;
    themeWriting = true;
    const t = themeQueued;
    try {
      await state.patch({ ui: { theme: t } });
      savedCfgTheme = t;
    } catch (e) {
      err(e.message || String(e));
    } finally {
      themeWriting = false;
      // 连点期间主题又变了 → 补写最后一次（中间的都会被合并掉）
      if (themeQueued !== savedCfgTheme) flushTheme();
    }
  }

  function saveTheme(t) {
    themeQueued = t;
    flushTheme();
  }

  /** 降级路径（没有 View Transition / 关了动效）：瞬时切色，两帧后放开过渡与星野 */
  function releaseInstantSoon() {
    nextPaint().then(() => {
      freezeTransitions(false);
      resumeUniverse();
      // 这一串连点到此落定（颜色早在 commitTheme 里同步换好了），清掉目标，
      // 免得下一次点击还拿着一个过期的「终点」去算反色
      targetTheme = null;
    });
  }

  /**
   * 切到某个主题（'dark' | 'light'）。
   *
   * persist 为真才写配置：用户点顶栏按钮时写；跟随系统时系统改了主题，
   * 配置里仍然是 'system'，不能把它改写成具体某一侧。
   *
   * 方向与作用于哪一层：
   *   白 → 黑：动 new 层，clip 从 0 到 R（新主题从圆心铺开）
   *   黑 → 白：动 old 层，clip 从 R 到 0（旧主题收回圆心，露出下面的新主题）
   * 后者不能动 new —— 那会变成「白圆缩小、四周还是黑」，与直觉相反。
   */
  function paintThemeSwitch(next, ev, persist) {
    if (revealing) return; // 连点：等这一圈走完再说，别互相打断
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (typeof document.startViewTransition !== 'function' || reduced) {
      commitTheme(next);
      releaseInstantSoon();
      if (persist) saveTheme(next);
      return;
    }

    const o = revealOrigin(ev);
    // 半径要盖到最远那个角，写死 innerWidth 在对角方向会露边
    const radius = Math.hypot(
      Math.max(o.x, window.innerWidth - o.x),
      Math.max(o.y, window.innerHeight - o.y)
    );

    const expanding = next === 'dark';
    const root = document.documentElement;
    // 圆心、半径、方向都必须在 startViewTransition **之前**写好：
    // 伪元素一创建就按这些值起手，晚一步又是漏帧
    root.style.setProperty('--vt-x', o.x + 'px');
    root.style.setProperty('--vt-y', o.y + 'px');
    root.style.setProperty('--vt-r', Math.round(radius) + 'px');
    root.classList.toggle('vt-expand', expanding);
    root.classList.toggle('vt-shrink', !expanding);

    revealing = true;
    const seq = ++vtSeq;
    let vt;
    try {
      // 回调必须同步改完并返回：过渡期间 rAF 是停的，这里一旦 await，
      // 新快照永远拍不出来，过渡会在 4 秒后以「DOM update timed out」整段作废
      vt = document.startViewTransition(() => {
        commitTheme(next);
      });
    } catch (e) {
      revealing = false;
      root.classList.remove('vt-expand', 'vt-shrink');
      freezeTransitions(false);
      resumeUniverse();
      targetTheme = null; // 这一轮没起来，连点目标作废，下次从屏幕上的主题重新算
      if (persist) saveTheme(next);
      return;
    }

    vt.ready
      .then(() => {
        // 快照已经拍完，可以把过渡放开了；揭幕是 CSS 动画，不受它影响
        freezeTransitions(false);
      })
      .catch(() => {
        // 过渡被跳过 / 打断：快照已经是新主题，放开过渡就行
        freezeTransitions(false);
      });

    vt.finished
      .catch(() => {})
      .finally(() => {
        revealing = false;
        resumeUniverse();
        freezeTransitions(false);
        // 让快照先销毁，下一拍再摘掉方向类，免得和销毁撞在同一帧。
        // 带 seq 判断：连点时下一轮已经开始，不能把它的层序一起摘了
        setTimeout(() => {
          if (seq === vtSeq) root.classList.remove('vt-expand', 'vt-shrink');
        }, 0);
        if (persist) saveTheme(next);
        if (deferredAppearance) {
          deferredAppearance = false;
          applyConfigEverywhere(state.cfg);
        }
        // 连点攒下来的目标：这一圈走完了再补一次；已经到位就不用再动
        const queued = pendingTheme;
        pendingTheme = null;
        if (queued && queued !== shownTheme) {
          paintThemeSwitch(queued, null, true);
        }
        // 处理完 pendingTheme 才清目标：这一串连点已经落定，下一串从屏幕上的
        // 主题重新起算（清早了，补跑的那一轮会被下一次点击当成「没目标」）
        targetTheme = null;
      });
  }

  /** 揭幕进行中又点了按钮：不打断这一圈，只记下最终该去哪 */
  let pendingTheme = null;
  /**
   * 「这一串连点最终要去的地方」。
   *
   * 为什么不能用 pendingTheme / shownTheme 当基数：
   * 第一轮的 commitTheme() 是在 ViewTransition 的 update 回调里跑的，同一 tick
   * 内连点时 shownTheme 还停在旧值上 —— 第 2、3 次点击于是都把目标又算回原方向，
   * 三连点最后反而停在原主题（QA 实测：同 tick 三连点停浅色，还白跑了两圈过渡）。
   * 单独记一份「期望终点」，连点才真的等于翻三次。
   * 每一轮落定后清成 null（见 vt.finished / releaseInstantSoon），
   * 这样新一轮永远从屏幕上的实际主题起算。
   */
  let targetTheme = null;
  /** 揭幕的「第几轮」：上一轮延迟摘 vt-shrink 的回调不能把下一轮的层序也摘了 */
  let vtSeq = 0;

  btnTheme.onclick = (ev) => {
    // 跟随系统时点一下 = 离开自动、钦定为当前的反色。
    // 基数取「这一串连点正在路上的目标」而不是屏幕上的主题：连点三下就等于翻三次，
    // 结果停在深色，而不是三次都算出「浅色」把自己绕回去。
    const base = targetTheme || shownTheme;
    const next = base === 'light' ? 'dark' : 'light';
    targetTheme = next;
    if (revealing) {
      // 手速再快也不打断正在播的那一圈：界面按自己的节奏走完，
      // 点击也不丢 —— 记到最后一次的目标，这一圈结束后接着往那儿走
      pendingTheme = next;
      return;
    }
    pendingTheme = null;
    paintThemeSwitch(next, ev, true);
  };

  /*
   * 跟随系统：配置里是 'system' 时，系统换主题就跟着换。
   * 没有点击位置，圆心用 revealOrigin 的兜底（按钮中心）—— 和点按钮的效果一致。
   * 这里不写配置：用户选的是「跟随」，不是选边。
   */
  const sysTheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onSystemTheme = () => {
    const mode = (state.cfg && state.cfg.ui && state.cfg.ui.theme) || 'light';
    if (mode !== 'system') return;
    const want = appearance.resolveTheme('system');
    // 比的是「页面上现在显示的是哪一侧」，不是 themeIsLight()：
    // change 事件到达时 matchMedia 已经是新值了，拿它去解析配置只会和 want 相等，
    // 于是每次都判定「已经切过了」直接返回 —— 这就是跟随系统一直不生效的原因
    const shown = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
    if (want === shown) return;
    // 正播着揭幕就先不动：这时硬改主题会让快照和实时页面错位
    if (revealing) return;
    // 系统那边换了模式就直接换，不做揭幕：用户并没有在这里点任何东西，
    // 突然放一圈动画只会让人以为程序在自己乱动
    commitTheme(want);
    releaseInstantSoon();
  };
  if (sysTheme) {
    if (sysTheme.addEventListener) sysTheme.addEventListener('change', onSystemTheme);
    else if (sysTheme.addListener) sysTheme.addListener(onSystemTheme); // 老内核
  }

  bindWindowControls();
}

/** 无边框窗口的自绘「最小化 / 最大化 / 关闭」按钮 */
function bindWindowControls() {
  const win = window.cloudpic && window.cloudpic.win;
  if (!win) return;

  $('#btnWinMin').onclick = () => win.minimize();
  $('#btnWinClose').onclick = () => win.close();
  $('#btnWinMax').onclick = async () => {
    await win.maximize();
  };

  const applyMax = (v) => document.body.classList.toggle('is-maximized', !!v);

  win.isMaximized().then(applyMax).catch(() => {});
  if (typeof win.onMaximized === 'function') win.onMaximized(applyMax);
}

/**
 * 关掉浏览器的表单自动填充。
 *
 * 「桌面程序」里最露馅的一刻：点进一个之前填过的输入框，Edge 弹一个
 * 「已保存的内容」下拉，或者自动补一坨黄底蓝字 —— 一秒回到网页。
 *
 * 两层都堵上：
 *   1. 给所有 input/textarea 打 autocomplete="off"（拦下拉保存框）
 *   2. 用 MutationObserver 盯着动态插进来的输入框（重命名弹层、向导），
 *      插一个补一个
 *
 * 黄底蓝字那一层在 app.css 里用 -webkit-autofill 的 box-shadow 盖掉。
 */
function installAutofillKiller() {
  const kill = (root) => {
    (root || document).querySelectorAll('input, textarea').forEach((el) => {
      el.setAttribute('autocomplete', 'off');
    });
  };
  kill(document);
  const mo = new MutationObserver((muts) => {
    muts.forEach((m) => {
      m.addedNodes.forEach((n) => {
        if (n.nodeType === 1) {
          if (n.matches && n.matches('input, textarea')) n.setAttribute('autocomplete', 'off');
          if (n.querySelectorAll) kill(n);
        }
      });
    });
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

async function boot() {
  await state.init();
  /**
   * 本机字体清单要在第一次画界面之前拿到：设置页的字体下拉、以及「系统默认」
   * 实际会落到哪款字体，都取决于它。晚一步拿就会先列一版旧候选再补一版真的，
   * 用户正好开着设置页就能看见下拉自己变一次。
   */
  await appearance.loadInstalledFonts();
  // 主题和字体必须在其它页面 init 之前落下去，否则会先按默认深色画一帧再跳色
  shownTheme = appearance.resolveTheme(((state.cfg && state.cfg.ui) || {}).theme);
  appearance.applyAppearance(state.cfg);
  updateChrome();

  // 粒子背景挂上就不用管了：它自己盯着 <html data-theme> 决定跑不跑
  initUniverse();

  // 接管原生 title 提示（黑框系统小窗太突兀），换成自绘的云朵气泡
  installTooltips();

  // 关掉浏览器的表单自动填充（保存的下拉框 / 黄底蓝字都是 Web 味）
  installAutofillKiller();

  bindChrome();
  Object.keys(PAGES).forEach((k) => {
    try {
      PAGES[k].init();
    } catch (e) {
      console.error('[init]', k, e);
    }
  });

  state.on((cfg) => {
    if (revealing) {
      deferredAppearance = true;
      return;
    }
    applyConfigEverywhere(cfg);
  });

  // 滑块拖动时实时更新已填充进度
  document.addEventListener('input', (e) => {
    if (e.target && e.target.type === 'range') paintRange(e.target);
  });

  // 原生 select 统一升级成自绘下拉（选项都是静态写在 index.html 里的，初始化一次就够）
  enhanceAll();
  // 数字输入框：干掉原生上下角标，换成自绘步进
  enhanceNumbers();
  paintRanges();

  // 无头自检用的调试钩子（--selftest 会在页面里读它）
  window.__fi = fileIcons;
  window.__nf = { enhanceNumbers };
  window.__state = state;
  window.__appearance = appearance;
  window.__universe = universeState;

  window.addEventListener('cloudpic:changed', () => {
    state.refresh();
  });

  go('upload');

  // 导航侧栏常驻；桌面工作区不因空闲状态改变布局。

  // 首次安装（还没有任何仓库信息，也从没走完向导）直接把「新建配置」弹出来。
  // 引导已经并进配置向导了：只有一套步骤条，不再有两个几乎一样的浮层。
  const firstRun = !state.cfg.onboarded && !state.cfg.owner && !state.cfg.repo;
  if (firstRun) openConfigWizard({ firstRun: true });

  // 界面到这就算落位了（引导浮层也挂好了），让启动画面开始退场
  dismissBootSplash();
}

/**
 * 侧栏闲置自动收起。
 *
 * 收起状态挂在 body 的 .side-hidden 上，具体动作由 CSS 做（transform 平移出屏）——
 * 用 transform 而不是改宽度/display，是因为它不参与布局，右边的 .content
 * 不会跟着跳。
 */
boot().catch((e) => {
  console.error(e);
  dismissBootSplash(true); // 启动失败：先让开，别把错误挡在启动画面后面
  document.body.innerHTML =
    '<div style="padding:40px;color:#ff8f97;font-family:monospace">启动失败：' + (e && e.message) + '</div>';
});
