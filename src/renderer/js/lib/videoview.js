/**
 * 内置视频播放器
 *
 * 为什么要有它：双击文件管理里的视频，以前落进「其余一律外链」那条分支，
 * 结果是浏览器新开一个标签页去播本地文件，而用户的预期是「像图片一样就地看」。
 * 这里把 /__local 直链（绝对路径经 cloudpic.localUrl 转过来）喂给 <video>，
 * 文件不出本机，关掉弹层就把句柄和音频输出一起放掉。
 *
 * 控件全部自绘、不用 controls 属性：原生那套在 WebView 里带着音量、全屏、
 * 下载三个按钮，和这个应用的观感对不上，用户也明确说过不要音量。
 *
 * 解不了的格式（mkv / avi / rmvb 这类）不进播放流程，直接给提示 +
 * 「在资源管理器中显示」，与其让 <video> 报一个空的 error 让人对着黑框发呆，
 * 不如把「换个播放器」这条唯一的出路摆到面前。
 */

import { modal, err, escapeHtml, friendlyError, paintRange, previewActions } from './dom.js';

/** Chromium（WebView2 内核）自己就能解的容器 */
const PLAYABLE_EXTS = ['mp4', 'm4v', 'webm', 'ogv', 'ogg', 'mov'];
/** 一样是视频，但浏览器解不了，只给提示，不假装能播 */
const UNSUPPORTED_EXTS = ['mkv', 'avi', 'rmvb', 'flv', 'wmv', 'mpg', 'mpeg', 'ts'];
/** 音频：常见那几个都在里面，浏览器自己能解 */
const PLAYABLE_AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus', 'weba'];
/** 音频里的老格式（wma / midi / ape 这些），和视频一样给提示，不硬塞给 <audio> */
const UNSUPPORTED_AUDIO_EXTS = ['wma', 'aif', 'aiff', 'alac', 'mid', 'midi', 'ape', 'au'];

/*
 * 播放 / 暂停图标：实心三角与双竖条，1:1 尺寸互换时视觉重量一致。
 * 和 fileicons 那套线条图标同一个图形语言（单色、currentColor、无描边干扰）。
 */
const ICON_PLAY =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<path d="M8.6 5.4a.8.8 0 0 1 1.22-.68l8.4 6.6a.8.8 0 0 1 0 1.36l-8.4 6.6A.8.8 0 0 1 8.6 18.6z" fill="currentColor"/></svg>';
const ICON_PAUSE =
  '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">' +
  '<rect x="6.8" y="5.4" width="3.7" height="13.2" rx="1.2" fill="currentColor"/>' +
  '<rect x="13.5" y="5.4" width="3.7" height="13.2" rx="1.2" fill="currentColor"/></svg>';

/** 音频没有画面，给一块封面占住视觉中心，控件放在它下面 */
const ICON_AUDIO =
  '<svg viewBox="0 0 24 24" width="72" height="72" fill="none" stroke="currentColor" ' +
  'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M9 17V4.8l10-2V15"/><circle cx="6.2" cy="17" r="2.8"/><circle cx="16.2" cy="15" r="2.8"/>' +
  '</svg>';

/** 音视频共用的一条控制条（播放/暂停 + 进度 + 时间，没有音量） */
const BAR_HTML =
  '<div class="vv-bar">' +
  '<button type="button" class="vv-btn vv-play" aria-label="播放">' +
  ICON_PLAY +
  '</button>' +
  '<input class="vv-seek" type="range" min="0" max="100" step="0.1" value="0" aria-label="播放进度" />' +
  '<span class="vv-clock"><span class="vv-cur">0:00</span><span class="vv-slash">/</span><span class="vv-dur">0:00</span></span>' +
  '</div>';

/** 播放器骨架：视频直接铺画面，音频放封面 + 不可见的 <audio> */
function playerHtml(kind) {
  if (kind === 'audio') {
    return (
      '<div class="vv-art">' + ICON_AUDIO + '</div>' +
      '<audio class="vv-media vv-audio" preload="metadata"></audio>' +
      BAR_HTML
    );
  }
  return '<video class="vv-media vv-video" preload="metadata" playsinline></video>' + BAR_HTML;
}

/* ---------------------------------------------------------------- 后缀判断 */

/** 取小写扩展名；没有点、或以点结尾时给空串 */
function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  if (i < 0 || i === s.length - 1) return '';
  return s.slice(i + 1).toLowerCase();
}

/** 浏览器能不能自己解这个视频 */
export function canPlayInBrowser(name) {
  return PLAYABLE_EXTS.indexOf(extOf(name)) >= 0;
}

/** 浏览器能不能自己解这个音频 */
export function canPlayAudioInBrowser(name) {
  return PLAYABLE_AUDIO_EXTS.indexOf(extOf(name)) >= 0;
}

/**
 * 是不是视频文件。
 *
 * 注意这里**包含**浏览器解不了的那些（mkv / avi …）：调用方靠它决定
 * 「别甩给浏览器，进内置播放器」，解不了的那一刻由播放器给出提示，
 * 如果这里只认能播的，mkv 双击后又会掉回外链那条老路。
 */
export function isVideoName(name) {
  const e = extOf(name);
  return PLAYABLE_EXTS.indexOf(e) >= 0 || UNSUPPORTED_EXTS.indexOf(e) >= 0;
}

/** 是不是音频文件。和视频同理：包含解不了的那些，由播放器自己给提示 */
export function isAudioName(name) {
  const e = extOf(name);
  return PLAYABLE_AUDIO_EXTS.indexOf(e) >= 0 || UNSUPPORTED_AUDIO_EXTS.indexOf(e) >= 0;
}

/* ---------------------------------------------------------------- 小工具 */

/** 秒 → 时钟串。一小时以内 m:ss，超过 h:mm:ss */
function fmtClock(sec) {
  const total = Number(sec);
  if (!isFinite(total) || total <= 0) return '0:00';
  const s = Math.floor(total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h > 0 ? h + ':' + p2(m) + ':' + p2(ss) : m + ':' + p2(ss);
}

/* ---------------------------------------------------------------- 播放器 */

/**
 * 就地预览一条媒体（视频或音频）。
 *
 * 两者共用一套自绘控件，播放/暂停、进度、时间；区别只在有没有画面：
 * 音频放一块封面，<audio> 元素自己不显示（显示也只会是个空控件）。
 *
 * opts:
 *   src        本地直链（cloudpic.localUrl 出来的 /__local?p=…）
 *   name       文件名，用作弹层标题
 *   localPath  本地绝对路径，「在资源管理器中显示」要用；没有就藏掉那个按钮
 *   link       文件链接，给了就在标题栏挂「复制链接 / 浏览器打开」
 *   format     复制链接用的格式（文件管理页那份设置，外层算好传进来）
 */
function previewMedia(kind, opts) {
  const o = opts || {};
  const name = String(o.name || (kind === 'audio' ? '音频' : '视频'));
  const src = String(o.src || '');
  const localPath = String(o.localPath || '');

  /** 媒体元素（video 或 audio）；进了失败态之后置 null */
  let video = null;
  let seekEl = null;
  let curEl = null;
  let durEl = null;
  let playBtn = null;
  /** 用户正按在进度条上：这段时间不允许 timeupdate 把滑块拽回去 */
  let dragging = false;

  const stage = document.createElement('div');
  stage.className = 'vv-stage' + (kind === 'audio' ? ' vv-audio-mode' : '');

  const playable = !!src && (kind === 'audio' ? canPlayAudioInBrowser(name) : canPlayInBrowser(name));
  if (playable) stage.innerHTML = playerHtml(kind);

  const m = modal({
    title: name,
    wide: true,
    // 图像类（视频）按内容比例自适应宽度，音频保持窄卡；
    // 两者的正文底色也不同：画面需要深色展台，音符封面用面板色
    className: kind === 'audio' ? 'audio-preview' : 'preview-auto video-preview',
    node: stage,
    // 和图片预览同一组按钮：按设置里的格式复制，或用浏览器打开
    actions: previewActions({ link: o.link, name, format: o.format }),
    buttons: [{ label: '关闭', primary: true }],
    onClose: teardown
  });

  if (playable) bindPlayer();
  else showFallback();

  /* ---------------------------------------------------------- 失败态 */

  /**
   * 解不了 / 读不出来：收起控件，只留一行说明和一个能落地的动作。
   * 先 releaseVideo() 再换内容，元素虽然会被换掉，但解码器和音频输出
   * 是浏览器进程里的资源，不显式停一次不会随 DOM 消失。
   */
  function showFallback() {
    releaseVideo();
    stage.classList.add('is-fail');
    stage.innerHTML =
      '<div class="vv-fail">' +
      '<div class="vv-fail-title">这个格式浏览器播放不了</div>' +
      '<div class="vv-fail-sub">' +
      escapeHtml(name) +
      (localPath ? ' 需要用系统里的播放器打开，可以到所在文件夹里双击它' : ' 需要先下载到本地，再用系统里的播放器打开') +
      '</div>' +
      (localPath ? '<button type="button" class="btn btn-primary btn-sm vv-reveal">在资源管理器中显示</button>' : '') +
      '</div>';
    const btn = stage.querySelector('.vv-reveal');
    if (btn) btn.onclick = revealInExplorer;
  }

  /** 在资源管理器里定位这个文件（选中态），比「打开所在目录」更准 */
  function revealInExplorer() {
    if (!localPath) return;
    Promise.resolve(window.cloudpic.shell.showItem(localPath)).catch((e) => err(friendlyError(e)));
  }

  /* ---------------------------------------------------------- 绑定 */

  function bindPlayer() {
    video = stage.querySelector('.vv-media');
    seekEl = stage.querySelector('.vv-seek');
    curEl = stage.querySelector('.vv-cur');
    durEl = stage.querySelector('.vv-dur');
    playBtn = stage.querySelector('.vv-play');
    if (!video || !seekEl || !playBtn) return;

    // src 走 property 而不是拼进 HTML：路径里可能带 & 和中文，
    // 拼字符串得转义两遍，赋值给属性由浏览器自己处理
    video.src = src;

    video.addEventListener('loadedmetadata', () => paintClock(video.currentTime, video.duration));
    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', paintPlayBtn);
    video.addEventListener('pause', paintPlayBtn);
    video.addEventListener('ended', paintPlayBtn);
    // 容器对、编码不对（比如 H.265 的 mp4）时只有这个事件会说话
    video.addEventListener('error', showFallback);
    // 点画面也能播 / 停，鼠标最自然的落点
    video.addEventListener('click', toggle);
    playBtn.onclick = toggle;

    seekEl.addEventListener('pointerdown', () => {
      // 拖动期间不 seek：每一帧都改 currentTime 会让解码器反复重定位，画面卡成幻灯片
      dragging = true;
    });
    seekEl.addEventListener('input', onSeekInput);
    // change 是 range 松手 / 键盘调整后的落点；window 上的 pointerup 兜住
    // 「在滑块外面松手」那种收不到 change 的情况
    seekEl.addEventListener('change', commitSeek);
    window.addEventListener('pointerup', onWindowPointerUp);

    document.addEventListener('keydown', onKey);

    paintRange(seekEl);
    paintClock(0, 0);
    paintPlayBtn();
  }

  /* ---------------------------------------------------------- 播放控制 */

  function toggle() {
    if (!video) return;
    if (video.paused) {
      const p = video.play();
      // 解码失败、或用户策略拦了播放：保持暂停态就行，error 事件会接手提示
      if (p && p.catch) p.catch(() => {});
    } else {
      video.pause();
    }
  }

  /** 相对快进 / 快退（秒）。结尾留一丝余量，别一不小心就跳成 ended */
  function nudge(sec) {
    if (!video) return;
    const d = video.duration;
    let t = video.currentTime + sec;
    if (isFinite(d) && d > 0) t = Math.min(t, Math.max(0, d - 0.05));
    else t = Math.max(0, t);
    video.currentTime = Math.max(0, t);
  }

  function paintPlayBtn() {
    if (!playBtn || !video) return;
    const playing = !video.paused && !video.ended;
    playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
    playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    playBtn.classList.toggle('is-playing', playing);
  }

  function paintClock(cur, dur) {
    if (!curEl || !durEl) return;
    curEl.textContent = fmtClock(cur);
    durEl.textContent = fmtClock(isFinite(dur) ? dur : 0);
  }

  /** 滑块位置 → 目标秒数 */
  function targetTime() {
    if (!video) return 0;
    const d = video.duration;
    if (!isFinite(d) || d <= 0) return 0;
    return (Number(seekEl.value || 0) / 100) * d;
  }

  function onTimeUpdate() {
    if (!video) return;
    if (dragging) {
      // 拖着的时候滑块归用户，这里只补时长（metadata 可能刚到）
      paintClock(targetTime(), video.duration);
      return;
    }
    const d = video.duration;
    const pct = isFinite(d) && d > 0 ? (video.currentTime / d) * 100 : 0;
    seekEl.value = String(Math.max(0, Math.min(100, pct)));
    paintRange(seekEl);
    paintClock(video.currentTime, d);
  }

  function onSeekInput() {
    if (!video) return;
    // 已填充的部分跟着手走，但**不**动 currentTime
    paintRange(seekEl);
    if (dragging) paintClock(targetTime(), video.duration);
  }

  /** 松手才落 currentTime，全程只在这一次真正 seek */
  function commitSeek() {
    if (!video) return;
    dragging = false;
    const t = targetTime();
    if (isFinite(t)) {
      try {
        video.currentTime = t;
      } catch (e) {
        // metadata 还没到：seek 会被浏览器忽略，下一次拖再落
      }
    }
    paintRange(seekEl);
    paintClock(t, video.duration);
  }

  function onWindowPointerUp() {
    if (dragging) commitSeek();
  }

  /**
   * 键盘：空格播放 / 暂停，左右 ±5 秒，Esc 关闭。
   *
   * Esc 本来想交给 modal，但 dom.js 的 modal 并没有处理 Esc（只有右键菜单和
   * 几个自绘面板自己监听），所以在这里补一条，关闭时随监听一起摘掉。
   */
  function onKey(e) {
    if (!e || e.altKey || e.ctrlKey || e.metaKey) return;
    const key = e.key;
    if (key === 'Escape') {
      e.preventDefault();
      m.close();
      return;
    }
    if (key === ' ' || key === 'Spacebar' || e.code === 'Space') {
      // 滑块聚焦时空格会被浏览器吞掉，这里统一接管
      e.preventDefault();
      toggle();
      return;
    }
    if (key === 'ArrowLeft') {
      e.preventDefault();
      nudge(-5);
      return;
    }
    if (key === 'ArrowRight') {
      e.preventDefault();
      nudge(5);
    }
  }

  /* ---------------------------------------------------------- 收尾 */

  /**
   * 把媒体元素彻底停下来并断开数据源。
   *
   * 只 pause() 不够：元素还挂在数据源上，文件句柄、解码器、音频输出都留着，
   * 连着预览几个文件，进程里的音频流会一直累积（表现为预览过的文件被占用、
   * 想重命名/删除时失败）。音频尤其明显，所以关闭时这条必须走。
   */
  function releaseVideo() {
    const v = video;
    video = null;
    if (!v) return;
    try {
      v.pause();
    } catch (e) {
      /* 已经没了就算了 */
    }
    v.removeAttribute('src');
    try {
      v.load(); // 空 src 上再 load() 才会真正释放解码器与音频输出
    } catch (e) {
      /* 同上 */
    }
  }

  function teardown() {
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('pointerup', onWindowPointerUp);
    releaseVideo();
  }

  return m;
}

/** 视频入口：保持原来的名字，manage.js 那边不用大改 */
export function previewVideo(opts) {
  return previewMedia('video', opts);
}

/** 音频入口：控件与视频完全同一套，只是换成 <audio> + 封面 */
export function previewAudio(opts) {
  return previewMedia('audio', opts);
}
