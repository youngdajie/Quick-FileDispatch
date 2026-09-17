/** 关于页：作者、技术栈、免费额度边界、致敬 PicX */

import { $, escapeHtml } from '../lib/dom.js';
import state from '../lib/state.js';

const APP = '快捷文件分发服务@JIE';
const AUTHOR = '小杰';
const SITE = 'https://www.yangjie.site';

const TECH = [
  ['Electron', '桌面外壳，把 Chromium 和 Node.js 一起打包进 Windows 应用'],
  ['Node.js', '主进程负责文件系统、Git 调用，以及和 GitHub / CNB 的接口通信'],
  ['Web Worker', '压缩跑在独立线程池里，线程数 = CPU 核心数，真正吃满多核算力'],
  ['OffscreenCanvas', '用 Chromium 自带的原生编解码器做缩放与重编码，不额外依赖任何二进制'],
  ['Canvas 2D', '水印、缩放、颜色填充'],
  ['Web Crypto', 'SHA-256 哈希化文件名'],
  ['GitHub REST v3', '仓库读取；批量上传与改名走 Git Data API，一次提交搞定整批文件'],
  ['CNB Open API', '腾讯云 CNB 的官方接口；读走 REST，写走 Git（公开接口没有创建提交的端点）'],
  ['Git CLI', '把仓库拉到本地，让本地目录与云端仓库始终对齐；CNB 的写入也由它完成'],
  ['safeStorage', 'Token 用 Windows DPAPI 系统级加密后落盘，不以明文保存'],
  ['本地 127.0.0.1 服务', '给渲染层提供模块化与本地文件直出，私有仓库的缩略图也由主进程代取']
];

function quotaTable() {
  return (
    '<table class="quota-table">' +
    '<thead><tr><th>项目</th><th>GitHub 免费账号</th><th>CNB 社区版（个人）</th></tr></thead>' +
    '<tbody>' +
    '<tr><td>仓库数量</td><td>不限（公开 / 私有随意）</td><td>公开不限，私有 5 个</td></tr>' +
    '<tr><td>单仓库容量</td><td>建议 ≤ 1 GB（超出会收到提醒）</td><td>仓库存储免费额度 100 GiB</td></tr>' +
    '<tr><td>单文件上限</td><td>100 MB（Git Data API）</td><td>200 MB</td></tr>' +
    '<tr><td>账号总容量</td><td>无硬性总容量，按仓库分别计算</td><td>Git 对象 100 GiB + 对象存储 100 GiB</td></tr>' +
    '<tr><td>单文件建议</td><td>≤ 25 MB 体验最稳</td><td>≤ 50 MB 体验最稳</td></tr>' +
    '<tr><td>国内直连</td><td>raw 域名时好时坏，可用 jsDelivr / raw.githack 等 CDN</td><td>直连快，也可用 JSDMirror 再加速</td></tr>' +
    '</tbody></table>'
  );
}

function render() {
  const info = state.info || {};
  const used = info.cpuCount || navigator.hardwareConcurrency || '-';
  const threads = Math.max(1, Math.min(16, navigator.hardwareConcurrency || 4));

  $('#aboutWrap').innerHTML =
    /* hero */
    '<div class="about-hero">' +
    '<div class="about-logo"><img src="/assets/logo.svg" alt="" /></div>' +
    '<div>' +
    '<h2>' + escapeHtml(APP) + '</h2>' +
    '<div class="ver">版本 ' + escapeHtml(info.version || '1.2') + ' · Windows 桌面版 · 本地压缩 + 云端分发</div>' +
    '<div class="author">作者：<b>' + escapeHtml(AUTHOR) + '</b>　·　' +
    '<a href="#" data-ext="' + SITE + '">' + escapeHtml(SITE.replace('https://', '')) + '</a></div>' +
    '</div>' +
    '</div>' +

    /* 这个程序在做什么 */
    '<section class="card">' +
    '<div class="card-head"><h2>这个程序在做什么</h2></div>' +
    '<div class="card-body" style="font-size:13px;color:var(--text-dim);line-height:2">' +
    '把免费的代码托管仓库当成文件仓库来用：图片在本机用多核 CPU 压缩好再推上去，其他文件原样上传，' +
    '仓库装得下的东西这里都能分发。' +
    '<ul style="margin:10px 0 0;padding-left:20px;line-height:2">' +
    '<li><b>不预设仓库和分支</b>——仓库名、分支自己填，分支默认 <span class="mono">main</span>，现在新建的仓库本来也就是它。</li>' +
    '<li><b>压缩用你的 CPU</b>——Worker 池 + OffscreenCanvas，多核并行，几十张图基本是点一下就完事，不再是 Web 版那种一张一张排队等。</li>' +
    '<li><b>不止是图片</b>——仓库能装什么，它就能管什么。只要不越过 CNB / GitHub 的配额，就不额外设限。</li>' +
    '<li><b>云端和本地是同一份东西</b>——仓库会拉到本地，管理界面直接读本地磁盘，所以翻起来是瞬时的；' +
    '两边都能改名、移动、替换内容，本地改完点一下「提交并推送」就能推回云端。</li>' +
    '<li><b>第一次打开有引导</b>——选平台、填仓库与令牌（现场验证）、映射本地目录，走完才让用，省得配置漏项。</li>' +
    '</ul>' +
    '</div>' +
    '</section>' +

    /* 技术栈 */
    '<section class="card">' +
    '<div class="card-head"><h2>用到了哪些技术</h2></div>' +
    '<div class="card-body">' +
    '<div class="tech-tags">' +
    TECH.map((t) => '<span class="tech-tag"><b>' + escapeHtml(t[0]) + '</b></span>').join('') +
    '</div>' +
    '<div style="margin-top:14px">' +
    '<dl class="kv">' +
    TECH.map((t) => '<dt>' + escapeHtml(t[0]) + '</dt><dd style="font-family:inherit;font-size:12.5px">' + escapeHtml(t[1]) + '</dd>').join('') +
    '</dl>' +
    '</div>' +
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
    '如果没有 <b>PicX</b>，大概不会有这个程序。<br>' +
    'PicX（<a href="#" data-ext="https://github.com/XPoet/picx">github.com/XPoet/picx</a>，作者 XPoet）' +
    '最早把「用 GitHub 仓库当图床」这件事做得足够简单、足够完整，' +
    '它对配置项的拆解、对链接规则的整理、对多级目录和批量操作的设计，都是这个项目直接借鉴的对象。<br>' +
    APP + ' 只是换了个思路——把同一件事放到本地，用原生性能重做一遍，并且顺手把「不只是图片」这件事补上。' +
    'PicX 的 AGPL-3.0 授权与它的作者，都值得被明确地写在这里。' +
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
    '<dt>Electron</dt><dd>' + escapeHtml(info.electron || '-') + '</dd>' +
    '<dt>Chromium</dt><dd>' + escapeHtml(info.chrome || '-') + '</dd>' +
    '<dt>Node.js</dt><dd>' + escapeHtml(info.node || '-') + '</dd>' +
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
    '本程序只读写你自己配置的仓库，不做任何数据上传或统计。' +
    '删除与替换操作会真实提交到你的仓库，请谨慎操作——不过 Git 有历史记录，误删是可以找回的。' +
    '使用第三方免费服务时，请遵守对应平台的服务条款，不要用它存放违规内容。' +
    '</div>' +
    '</section>';
}

export default {
  init() {
    render();
    $('#aboutWrap').addEventListener('click', (e) => {
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
