/** 关于页：作者、技术栈、免费额度边界、致敬 PicX */

import { $, escapeHtml } from '../lib/dom.js';
import state from '../lib/state.js';

const APP = '快捷文件分发服务@JIE';
const AUTHOR = '小杰';
const SITE = 'https://www.yangjie.site';
const REPO = 'https://cnb.cool/youngdajie/Quick-FileDispatch';
const BILI = 'https://space.bilibili.com/646325099';
const TG = 'https://t.me/youngdajie';
const MAIL = 'mailto:ok@yangjie.site';

/**
 * hero 行两个链接的前缀图标（14px）。
 * 线宽是照「小杰」两个加粗字的字重配的：14px 图标、24 视口、stroke 2.6 ≈ 1.5px 笔画，
 * 和 12.5px 粗体汉字并排看起来一样重，不会一个虚一个实。
 */
const ICON_GLOBE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/>' +
  '<path d="M12 3a15.3 15.3 0 0 1 0 18a15.3 15.3 0 0 1 0-18z"/></svg>';
const ICON_CODE =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M15.5 7 20 12l-4.5 5"/><path d="M8.5 7 4 12l4.5 5"/></svg>';

/** B 站：电视外框 + 两根天线 + 两个眼睛，和上面的描边风格一致 */
const ICON_BILI =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="7.5" width="18" height="12.5" rx="3.5"/>' +
  '<path d="M7 3.5 10 7.5"/><path d="M17 3.5 14 7.5"/>' +
  '<path d="M9.5 12.5v3"/><path d="M14.5 12.5v3"/></svg>';

/** Telegram：纸飞机 */
const ICON_TG =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M21 4 3 11l6 2.5L11.5 20l3-5.5L21 4z"/><path d="M21 4 9 13.5"/></svg>';

/** 电子邮件：信封 */
const ICON_MAIL =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="M3.6 7.2 12 13l8.4-5.8"/></svg>';

/** 链接之间的分隔点 */
const SEP = '<span class="asep" aria-hidden="true">·</span>';

/** 「展开看看」按钮的小箭头（展开时 CSS 把它转 180°） */
const ICON_CHEVRON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M6 9.5 12 15.5 18 9.5"/></svg>';

/**
 * hero 大图标（内联版 logo）。和 assets/logo.svg 同一份图形，但拆成两层：
 *   外层 rect（蓝色圆角方块）—— 静止；
 *   内层 <g class="hero-logo-mark">（罗盘图形）—— 点击时飞速旋转。
 * 用 <img> 做不到只转内层，所以这里内联；gradient 的 id 全局唯一免得撞车。
 */
const LOGO_SVG =
  '<svg class="hero-logo" viewBox="0 0 1024 1024" aria-hidden="true">' +
  '<defs><linearGradient id="qfdLogoG" x1="0" y1="0" x2="0.55" y2="1">' +
  '<stop offset="0%" stop-color="#4E9BEA"/><stop offset="100%" stop-color="#0B4A9C"/>' +
  '</linearGradient></defs>' +
  '<rect x="0" y="0" width="1024" height="1024" rx="256" fill="url(#qfdLogoG)"/>' +
  '<g class="hero-logo-mark">' +
  '<circle cx="512" cy="512" r="235.71" fill="#FFFFFF" opacity="0.55"/>' +
  '<line x1="647.59" y1="512" x2="935.44" y2="512" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="607.87" y1="607.87" x2="811.42" y2="811.42" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="512" y1="647.59" x2="512" y2="935.44" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="416.13" y1="607.87" x2="212.58" y2="811.42" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="376.41" y1="512" x2="88.56" y2="512" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="416.13" y1="416.13" x2="212.58" y2="212.58" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="512" y1="376.41" x2="512" y2="88.56" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<line x1="607.87" y1="416.13" x2="811.42" y2="212.58" stroke="#FFFFFF" stroke-width="54.23" stroke-linecap="round"/>' +
  '<circle cx="512" cy="512" r="319.15" fill="none" stroke="#FFFFFF" stroke-width="54.23"/>' +
  '<circle cx="512" cy="512" r="258.65" fill="none" stroke="#FFFFFF" stroke-width="54.23"/>' +
  '<line x1="512" y1="512" x2="745.62" y2="512" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="677.2" y2="677.2" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="512" y2="745.62" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="346.8" y2="677.2" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="278.38" y2="512" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="346.8" y2="346.8" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="512" y2="278.38" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<line x1="512" y1="512" x2="677.2" y2="346.8" stroke="#FFFFFF" stroke-width="47.98" stroke-linecap="round"/>' +
  '<circle cx="512" cy="512" r="100.12" fill="#FFFFFF"/>' +
  '<circle cx="512" cy="512" r="35.46" fill="#12508F"/>' +
  '</g></svg>';

/**
 * 技术栈。分三段拼，因为头和尾**跟着运行时走**。
 *
 * 起因：这一页原先把「Electron / Node.js」写死在表里。项目在 2.8.0 之后分出一支
 * 用 Go 重写的版本（CNB 的 go 分支），到 3.0.0 起转正为唯一主线，Electron 版则
 * 定格在 v2.8.0 不再更新；两侧共用这份渲染层 —— 再写成死表，就会出现
 * 「Go 版程序自称基于 Electron」这种自相矛盾。
 *
 * 判据取 app.info() 的字段，不猜环境：Go 版给 go（后端运行时）、electron 留空；
 * Electron 版给 electron / node。渲染层一个字都不用为版本分叉。
 */
function isGoShell(info) {
  return !!((info && info.go) || !(info && info.electron));
}

/** 外壳 + 负责「进程外那些事」的那一层 */
function shellTech(info) {
  return isGoShell(info)
    ? [
        ['Go', '桌面外壳 后端编译成单个 exe，不随包携带任何运行时，所以安装包只有十几 MB'],
        ['WebView2', '复用系统里的 Chromium 内核来画界面，不再把 Chromium 打进安装包'],
        ['127.0.0.1 本地服务', '后端本身就是它：只监听回环地址，界面和它之间走 HTTP，天然不对外暴露']
      ]
    : [
        ['Electron', '桌面外壳，把 Chromium 和 Node.js 一起打包进 Windows 应用'],
        ['Node.js', '主进程负责文件系统、Git 调用，以及和 GitHub / CNB 的接口通信'],
        ['本地 127.0.0.1 服务', '给渲染层提供模块化与本地文件直出，私有仓库的缩略图也由主进程代取']
      ];
}

/** 两版共用的部分：这部分在渲染层，换外壳不影响 */
const CORE_TECH = [
  ['Web Worker', '压缩跑在独立线程池里，线程数 = CPU 核心数，真正吃满多核算力'],
  ['OffscreenCanvas', '用 Chromium 自带的原生编解码器做缩放与重编码，不额外依赖任何二进制'],
  ['Canvas 2D', '水印、缩放、颜色填充'],
  ['Web Crypto', 'SHA-256 哈希化文件名'],
  ['GitHub REST v3', '仓库读取；批量上传与改名走 Git Data API，一次提交搞定整批文件'],
  ['CNB Open API', '腾讯云 CNB 的官方接口；读走 REST，写走 Git（公开接口没有创建提交的端点）'],
  ['Git CLI', '把仓库拉到本地，让本地目录与云端仓库始终对齐；CNB 的写入也由它完成']
];

/** Token 加密那一格：机制两版一样（都是 Windows DPAPI），名字跟着外壳走 */
function tailTech(info) {
  return [
    isGoShell(info)
      ? ['DPAPI', 'Token 用 Windows DPAPI 系统级加密后落盘，不以明文保存']
      : ['safeStorage', 'Token 用 Windows DPAPI 系统级加密后落盘，不以明文保存']
  ];
}

function tech(info) {
  return shellTech(info).concat(CORE_TECH, tailTech(info));
}

/** 运行环境：同样是「跟着运行时走」的几张表，别把 Electron 那一行留给 Go 版 */
function envRows(info) {
  const ua = navigator.userAgent || '';
  const engine = ((ua.match(/Edg\/([\d.]+)/) || ua.match(/Chrome\/([\d.]+)/) || [])[1]) || '';
  return isGoShell(info)
    ? [
        ['桌面外壳', info.shell || 'WebView2'],
        ['Go 运行时', info.go || '-'],
        ['渲染引擎', (engine ? 'Chromium ' + engine : '-') + '（系统自带）']
      ]
    : [
        ['Electron', info.electron || '-'],
        ['Chromium', info.chrome || '-'],
        ['Node.js', info.node || '-']
      ];
}

function quotaTable() {
  return (
    '<table class="quota-table">' +
    '<thead><tr><th>项目</th><th>GitHub 免费账号</th><th>CNB 社区版（个人）</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>仓库数量</td><td>不限（公开 / 私有随意）</td><td>公开不限，私有 5 个</td></tr>' +
    '<tr><td>单仓库容量</td><td>建议 ≤ 1 GB（超出会收到提醒）</td><td>仓库存储免费额度 100 GB</td></tr>' +
    '<tr><td>单文件上限</td><td>100 MB（Git Data API）</td><td>200 MB</td></tr>' +
    '<tr><td>账号总容量</td><td>无硬性总容量，按仓库分别计算</td><td>Git 对象 100 GB + 对象存储 100 GB</td></tr>' +
    '<tr><td>单文件建议</td><td>≤ 25 MB 体验最稳</td><td>≤ 50 MB 体验最稳</td></tr>' +
    '<tr><td>国内直连</td><td>raw 域名时好时坏，可用 jsDelivr / raw.githack 等 CDN</td><td>直连快，也可用 JSDMirror 再加速</td></tr>' +
    '</tbody></table>'
  );
}

/* 当前展开的技术条目下标（-1 = 全折叠）。render 会重建 DOM，所以每次重画都重置 */
let techOpen = -1;

/**
 * 点技术标签：展开该项说明；再点同一个收起。
 * 卡片每次整块重建而不是只换文字 —— 这样入场动画每次都能重新触发。
 */
function toggleTech(idx) {
  const fold = $('#techFold');
  const card = $('#techFoldCard');
  if (!fold || !card) return;
  const info = state.info || {};
  const TECH = tech(info);
  const tags = document.querySelectorAll('#aboutWrap .tech-tag');

  if (techOpen === idx) {
    techOpen = -1;
    fold.classList.remove('open');
    tags.forEach((el) => el.classList.remove('active'));
    return;
  }
  const t = TECH[idx];
  if (!t) return;
  techOpen = idx;
  tags.forEach((el, i) => el.classList.toggle('active', i === idx));
  card.innerHTML = '<b>' + escapeHtml(t[0]) + '</b>' + escapeHtml(t[1]);
  fold.classList.add('open');
}

function render() {
  techOpen = -1;
  const info = state.info || {};
  const used = info.cpuCount || navigator.hardwareConcurrency || '-';
  const threads = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));
  const TECH = tech(info);

  $('#aboutWrap').innerHTML =
    /* hero：居中大图标 + 主色渐变底，参考「关于手机」的排法；
       作者一行、两个链接另起一行 */
    '<div class="about-hero">' +
    '<div class="about-logo" title="点一下试试">' + LOGO_SVG + '</div>' +
    '<h2>' + escapeHtml(APP) + '</h2>' +
    '<div class="ver">版本 ' + escapeHtml(info.version || '-') + ' · Windows 桌面版</div>' +
    '<div class="author">作者：<b>' + escapeHtml(AUTHOR) + '</b></div>' +
    '<div class="author-links">' +
    '<a href="#" data-ext="' + SITE + '" class="author-link" title="' + escapeHtml(SITE) + '">' + ICON_GLOBE +
    escapeHtml(SITE.replace('https://', '')) + '</a>' + SEP +
    '<a href="#" data-ext="' + REPO + '" class="author-link" title="' + escapeHtml(REPO) + '">' + ICON_CODE +
    '项目地址</a>' + SEP +
    '<a href="#" data-ext="' + BILI + '" class="author-link" title="' + escapeHtml(BILI) + '">' + ICON_BILI +
    'B 站</a>' + SEP +
    '<a href="#" data-ext="' + TG + '" class="author-link" title="' + escapeHtml(TG) + '">' + ICON_TG +
    'Telegram</a>' + SEP +
    '<a href="#" data-ext="' + MAIL + '" class="author-link" title="' + escapeHtml(MAIL.replace('mailto:', '')) + '">' + ICON_MAIL +
    '电子邮件</a>' +
    '</div>' +
    '</div>' +

    /* 这个程序在做什么 */
    '<section class="card">' +
    '<div class="card-head"><h2>这个程序在做什么</h2></div>' +
    '<div class="card-body" style="font-size:13px;color:var(--text-dim);line-height:2">' +
    '把免费的代码托管仓库当成文件仓库来用：图片在本机用多核 CPU 压缩好再推上去，其他文件原样上传，' +
    '仓库装得下的东西这里都能分发' +
    '<p style="margin:11px 0 2px;color:var(--text-dim)">这程序主要是自用，也会给我妹用——细节上多磨一磨，用起来就事半功倍</p>' +
    '<button type="button" class="about-fold-toggle" id="aboutFoldToggle" aria-expanded="false">' +
    '<span class="aft-text">展开看看都支持什么</span>' + ICON_CHEVRON +
    '</button>' +
    '<div class="about-fold" id="aboutFold"><div class="about-fold-clip">' +
    '<ul class="about-list">' +
    '<li><b>不预设仓库和分支</b>——仓库名、分支自己填，分支默认 <span class="mono">main</span>，现在新建的仓库本来也就是它</li>' +
    '<li><b>压缩用你的 CPU</b>——Worker 池 + OffscreenCanvas，多核并行，几十张图基本是点一下就完事，不再是 Web 版那种一张一张排队等</li>' +
    '<li><b>不止是图片</b>——仓库能装什么，它就能管什么 只要不越过 CNB / GitHub 的配额，就不额外设限</li>' +
    '<li><b>云端和本地是同一份东西</b>——仓库会拉到本地，管理界面直接读本地磁盘，所以翻起来是瞬时的；' +
    '两边都能改名、移动、替换内容，本地改完点一下「提交并推送」就能推回云端</li>' +
    '<li><b>第一次打开有引导</b>——选平台、填仓库与令牌（现场验证）、映射本地目录，一步步带过；不想走就按右上角 ❌ 退出，之后在「设置」页能重看</li>' +
    '</ul>' +
    '</div></div>' +
    '</div>' +
    '</section>' +

    /* 技术栈：标签是按钮，说明默认折叠，点哪个看哪个 */
    '<section class="card">' +
    '<div class="card-head"><h2>用到了哪些技术</h2><p>点一下标签，在下面看它是干什么的</p></div>' +
    '<div class="card-body">' +
    '<div class="tech-tags">' +
    TECH.map((t, i) => '<button type="button" class="tech-tag" data-tech="' + i + '">' + escapeHtml(t[0]) + '</button>').join('') +
    '</div>' +
    '<div class="tech-fold" id="techFold"><div class="tech-fold-clip"><div class="tech-fold-card" id="techFoldCard"></div></div></div>' +
    '</div>' +
    '</section>' +

    /* 配额 */
    '<section class="card">' +
    '<div class="card-head"><h2>免费额度边界</h2>' +
    '<p>程序本身不设限，但仓库是别人的服务，这几条是官方红线，越过去会推不上去</p></div>' +
    '<div class="card-body" style="padding:0">' + quotaTable() + '</div>' +
    '</section>' +

    /* 致敬 */
    '<section class="card">' +
    '<div class="card-head"><h2>致敬</h2></div>' +
    '<div class="card-body">' +
    '<div class="tribute">' +
    '如果没有 <b>PicX</b>，大概不会有这个程序<br>' +
    'PicX（<a href="#" data-ext="https://github.com/XPoet/picx">GitHub</a>，作者 XPoet）' +
    '最早把「用 GitHub 仓库当图床」这件事做得足够简单、足够完整，' +
    '它对配置项的拆解、对链接规则的整理、对多级目录和批量操作的设计，都是这个项目直接借鉴的对象<br>' +
    APP + ' 只是换了个思路——把同一件事放到本地，用原生性能重做一遍，并且顺手把「不只是图片」这件事补上' +
    'PicX 的 AGPL-3.0 授权与它的作者，都值得被明确地写在这里' +
    '</div>' +
    '</div>' +
    '</section>' +

    /* 环境 */
    '<section class="card">' +
    '<div class="card-head"><h2>运行环境</h2></div>' +
    '<div class="card-body">' +
    '<dl class="kv">' +
    '<dt>软件版本</dt><dd>' + escapeHtml(APP + ' ' + (info.version || '-')) + '</dd>' +
    '<dt>作者</dt><dd>' + escapeHtml(AUTHOR) + '（' + escapeHtml(SITE) + '）</dd>' +
    envRows(info)
      .map((r) => '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(String(r[1])) + '</dd>')
      .join('') +
    '<dt>操作系统</dt><dd>' + escapeHtml(info.platform || '-') + '</dd>' +
    '<dt>CPU 逻辑核心</dt><dd>' + escapeHtml(String(used)) + ' 核（默认启用 ' + threads + ' 个压缩线程）</dd>' +
    '<dt>配置文件</dt><dd>' + escapeHtml(info.configFile || '-') + '</dd>' +
    '<dt>数据目录</dt><dd>' + escapeHtml(info.userData || '-') + '</dd>' +
    '</dl>' +
    '</div>' +
    '</section>' +

    /* 快捷键 */
    '<section class="card">' +
    '<div class="card-head"><h2>快捷键与小技巧</h2></div>' +
    '<div class="card-body" style="font-size:13px;color:var(--text-dim);line-height:2.2">' +
    '<div><kbd>Ctrl</kbd> + <kbd>V</kbd>　把剪贴板里的截图直接塞进上传队列</div>' +
    '<div>拖拽　从资源管理器拖一堆文件到窗口任意位置即可</div>' +
    '<div>双击　在文件管理里进入文件夹，或放大看图片</div>' +
    '<div>单击　选中文件（可多选），然后在顶部批量复制链接 / 导出 / 改名 / 删除</div>' +
    '<div>文件右下角按钮　单文件的复制链接、预览、重命名 / 移动、替换内容、删除</div>' +
    '<div>左侧状态区　本地改过文件后会亮出「提交并推送」，点一下同步到云端</div>' +
    '<div><kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd>　打开开发者工具，排查问题用</div>' +
    '</div>' +
    '</section>' +

    /* 说明 */
    '<section class="card">' +
    '<div class="card-head"><h2>说明</h2></div>' +
    '<div class="card-body" style="font-size:12.5px;color:var(--muted);line-height:2">' +
    '本程序只读写你自己配置的仓库，不做任何数据上传或统计' +
    '删除与替换操作会真实提交到你的仓库，请谨慎操作——不过 Git 有历史记录，误删是可以找回的' +
    '使用第三方免费服务时，请遵守对应平台的服务条款，不要用它存放违规内容' +
    '</div>' +
    '</section>';
}

export default {
  init() {
    render();
    $('#aboutWrap').addEventListener('click', (e) => {
      const tag = e.target.closest('.tech-tag');
      if (tag) {
        toggleTech(Number(tag.dataset.tech));
        return;
      }
      const foldBtn = e.target.closest('#aboutFoldToggle');
      if (foldBtn) {
        const open = $('#aboutFold').classList.toggle('open');
        foldBtn.classList.toggle('open', open);
        foldBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
        foldBtn.querySelector('.aft-text').textContent = open ? '收起' : '展开看看都支持什么';
        return;
      }
      const logo = e.target.closest('.about-logo');
      if (logo) {
        // 彩蛋：点图标，罗盘图形飞速转三圈（蓝方块不动）。
        // 先摘类再强制重排一次 —— 连点也能重新播动画；播完清掉标记
        logo.classList.remove('spin');
        void logo.offsetWidth;
        logo.classList.add('spin');
        logo.addEventListener('animationend', () => logo.classList.remove('spin'), { once: true });
        return;
      }
      const a = e.target.closest('a[data-ext]');
      if (!a) return;
      e.preventDefault();
      window.cloudpic.shell.openExternal(a.dataset.ext);
    });
  },
  onEnter() {
    render();
  }
};
