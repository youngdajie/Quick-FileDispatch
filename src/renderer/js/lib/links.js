/**
 * 共享工具：路径模板 / 链接规则 / 链接格式化
 * UMD 写法 —— 主进程用 require 加载，渲染层用 <script> 加载，逻辑只有一份
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CPLinks = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const LINK_RULES = [
    {
      id: 'auto',
      name: '自动（跟随平台默认）',
      desc: 'GitHub 用 raw.githubusercontent.com，Gitee 用 gitee.com/raw',
      platforms: ['github', 'gitee']
    },
    {
      id: 'github_raw',
      name: 'GitHub Raw',
      desc: 'raw.githubusercontent.com —— 最直接，但国内访问偶尔不稳',
      platforms: ['github']
    },
    {
      id: 'jsdelivr',
      name: 'jsDelivr CDN',
      desc: 'cdn.jsdelivr.net —— 全球加速，支持 GitHub 仓库，有缓存需等刷新',
      platforms: ['github']
    },
    {
      id: 'statically',
      name: 'Statically CDN',
      desc: 'cdn.statically.io —— 另一条免费 CDN 线路',
      platforms: ['github']
    },
    {
      id: 'githack',
      name: 'Raw Githack',
      desc: 'raw.githack.com —— 可返回正确的 Content-Type',
      platforms: ['github']
    },
    {
      id: 'ghpages',
      name: 'GitHub Pages',
      desc: '用户名.github.io —— 需要仓库开启 Pages 功能',
      platforms: ['github']
    },
    {
      id: 'gitee_raw',
      name: 'Gitee Raw',
      desc: 'gitee.com/{owner}/{repo}/raw/{branch} —— 国内直连快',
      platforms: ['gitee']
    },
    {
      id: 'custom',
      name: '自定义域名 / 对象存储',
      desc: '填你自己的 CDN、图床域名或 OSS 前缀，路径用 {path} 占位',
      platforms: ['github', 'gitee']
    }
  ];

  const LINK_FORMATS = [
    { id: 'url', name: '纯链接' },
    { id: 'markdown', name: 'Markdown' },
    { id: 'html', name: 'HTML' },
    { id: 'bbcode', name: 'BBCode' }
  ];

  /** 各平台的免费额度红线，程序本身不额外设限 */
  const FILE_LIMITS = {
    github: {
      name: 'GitHub',
      maxFile: 100 * 1024 * 1024,
      softFile: 25 * 1024 * 1024,
      maxRepo: 1024 * 1024 * 1024,
      note: '单文件 ≤ 100MB（Git Data API），仓库建议 ≤ 1GB'
    },
    gitee: {
      name: 'Gitee',
      maxFile: 50 * 1024 * 1024,
      softFile: 20 * 1024 * 1024,
      maxRepo: 500 * 1024 * 1024,
      note: '社区版单文件 ≤ 50MB、单仓库 ≤ 500MB、名下仓库合计 ≤ 5GB'
    }
  };

  function limitOf(platform) {
    return FILE_LIMITS[platform === 'gitee' ? 'gitee' : 'github'];
  }

  function normalizePath(p) {
    return String(p || '')
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  }

  function joinPath() {
    const parts = [];
    for (let i = 0; i < arguments.length; i++) {
      const p = normalizePath(arguments[i]);
      if (p) parts.push(p);
    }
    return parts.join('/');
  }

  function encodePath(p) {
    return normalizePath(p)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
  }

  /** 把用户填的域名补全协议、去掉结尾斜杠 */
  function normalizeBaseUrl(u) {
    let s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    return s.replace(/\/+$/, '');
  }

  /**
   * 预览代理直链：只按「仓库内相对路径」拼，不带 owner / repo / branch。
   * 例：proxyUrl 填 https://cdn.yangjie.site，文件是仓库 main 根目录的 111.avif
   *   -> https://cdn.yangjie.site/111.avif
   * 也支持 {path} 占位，想拼成 https://x.com/gh/owner/repo@main/{path} 也可以。
   * 没配置时返回空串，调用方自行回退到平台直链。
   */
  function buildProxyUrl(cfg, relPath) {
    const base = normalizeBaseUrl(cfg && cfg.proxyUrl);
    if (!base) return '';
    const p = encodePath(relPath);
    if (!p) return base + '/';
    if (base.indexOf('{path}') >= 0) return base.split('{path}').join(p);
    return base + '/' + p;
  }

  /** 生成图片直链 */
  function buildUrl(cfg, relPath) {
    const platform = cfg.platform === 'gitee' ? 'gitee' : 'github';
    const owner = cfg.owner || '';
    const repo = cfg.repo || '';
    const branch = cfg.branch || 'main';
    const p = encodePath(relPath);
    const rule = cfg.linkRule === 'auto' || !cfg.linkRule ? (platform === 'gitee' ? 'gitee_raw' : 'github_raw') : cfg.linkRule;

    switch (rule) {
      case 'jsdelivr':
        return `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${p}`;
      case 'statically':
        return `https://cdn.statically.io/gh/${owner}/${repo}/${branch}/${p}`;
      case 'githack':
        return `https://raw.githack.com/${owner}/${repo}/${branch}/${p}`;
      case 'ghpages':
        return `https://${owner}.github.io/${repo}/${p}`;
      case 'gitee_raw':
        return `https://gitee.com/${owner}/${repo}/raw/${branch}/${p}`;
      case 'github_raw':
        return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`;
      case 'custom': {
        let base = String(cfg.customDomain || '').trim().replace(/\/+$/, '');
        if (!base) return platform === 'gitee'
          ? `https://gitee.com/${owner}/${repo}/raw/${branch}/${p}`
          : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`;
        if (base.indexOf('{path}') >= 0) return base.split('{path}').join(p);
        return base + '/' + p;
      }
      default:
        return platform === 'gitee'
          ? `https://gitee.com/${owner}/${repo}/raw/${branch}/${p}`
          : `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`;
    }
  }

  /** 把直链包装成 Markdown / HTML / BBCode；非图片按普通链接处理 */
  function formatLink(url, format, altName, isImage) {
    const alt = String(altName || '').replace(/[[\]]/g, '');
    const img = isImage === undefined ? true : !!isImage;
    switch (format) {
      case 'markdown':
        return img ? `![${alt}](${url})` : `[${alt}](${url})`;
      case 'html':
        return img ? `<img src="${url}" alt="${alt}" />` : `<a href="${url}" target="_blank">${alt}</a>`;
      case 'bbcode':
        return img ? `[img]${url}[/img]` : `[url=${url}]${alt}[/url]`;
      default:
        return url;
    }
  }

  function formatBytes(n) {
    const num = Number(n) || 0;
    if (num < 1024) return num + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = num / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i++;
    }
    return (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + ' ' + units[i];
  }

  function extOf(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function baseNameOf(name) {
    return String(name || '').replace(/\.[^.]+$/, '');
  }

  function sanitizeName(name) {
    return String(name || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 180) || 'untitled';
  }

  return {
    LINK_RULES,
    LINK_FORMATS,
    FILE_LIMITS,
    limitOf,
    normalizePath,
    joinPath,
    encodePath,
    buildUrl,
    buildProxyUrl,
    normalizeBaseUrl,
    formatLink,
    formatBytes,
    extOf,
    baseNameOf,
    sanitizeName
  };
});
