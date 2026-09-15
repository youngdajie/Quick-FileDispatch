'use strict';

/**
 * 本地静态服务
 * 为什么需要它：Electron 的 file:// 协议下 ES Module 与 Web Worker 会被同源策略拦住。
 * 起一个只监听 127.0.0.1 的微型服务，渲染层就能正常使用模块化 + 多线程压缩，
 * 同时也能把本地磁盘上的图片直接流式喂给界面预览。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8'
};

/** 允许通过 /__local 访问的根目录白名单 */
const allowedRoots = new Set([os.tmpdir()]);

function allowRoot(dir) {
  if (!dir) return;
  try {
    const r = path.resolve(dir).toLowerCase();
    allowedRoots.add(r);
    // 同时允许其父级，避免用户选到子目录时失效
  } catch (e) {
    /* ignore */
  }
}

function isAllowed(abs) {
  const p = path.resolve(abs).toLowerCase();
  for (const root of allowedRoots) {
    if (p === root || p.startsWith(root + path.sep)) return true;
  }
  return false;
}

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ 'Cache-Control': 'no-store' }, headers || {}));
  res.end(body);
}

function hashLite(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function startServer(rendererDir, options) {
  const opts = options || {};
  const server = http.createServer((req, res) => {
    let parsed;
    try {
      parsed = new URL(req.url, 'http://127.0.0.1');
    } catch (e) {
      return send(res, 400, 'bad request');
    }
    const pathname = decodeURIComponent(parsed.pathname);

    // ---- 远程仓库文件代理（私有仓库也能预览：Token 只在主进程使用）
    if (pathname === '/__remote') {
      const p = parsed.searchParams.get('p');
      if (!p) return send(res, 400, 'missing path');
      if (typeof opts.remoteProvider !== 'function') return send(res, 400, 'remote not ready');
      const cacheKey = p + '|' + req.headers['if-none-match'];
      Promise.resolve(opts.remoteProvider(p))
        .then((out) => {
          if (!out || !out.buffer) return send(res, 404, 'not found');
          const buf = out.buffer;
          const etag = '"' + buf.length + '-' + hashLite(p) + '"';
          if (req.headers['if-none-match'] === etag) {
            res.writeHead(304, { ETag: etag });
            return res.end();
          }
          res.writeHead(200, {
            'Content-Type': out.contentType || 'application/octet-stream',
            'Content-Length': buf.length,
            ETag: etag,
            'Cache-Control': 'public, max-age=60'
          });
          res.end(buf);
        })
        .catch((e) => {
          send(res, 502, 'remote fetch failed: ' + (e && e.message));
        });
      void cacheKey;
      return;
    }

    // ---- 本地文件直出（图片预览）
    if (pathname === '/__local' || pathname.startsWith('/__local/')) {
      let abs = parsed.searchParams.get('p');
      if (!abs && pathname.startsWith('/__local/')) {
        abs = pathname.slice('/__local/'.length);
      }
      if (!abs) return send(res, 400, 'missing path');
      if (!isAllowed(abs)) return send(res, 403, 'forbidden');
      return fs.stat(abs, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, 'not found');
        const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Content-Length': st.size,
          'Cache-Control': 'no-cache',
          'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(abs).pipe(res).on('error', () => res.end());
      });
    }

    // ---- 渲染层静态资源
    let rel = pathname === '/' ? '/index.html' : pathname;
    const target = path.normalize(path.join(rendererDir, rel));
    if (!target.startsWith(path.normalize(rendererDir))) return send(res, 403, 'forbidden');

    fs.stat(target, (err, st) => {
      if (err || !st.isFile()) return send(res, 404, 'not found');
      const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      fs.createReadStream(target).pipe(res).on('error', () => res.end());
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        url: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        allowRoot
      });
    });
  });
}

module.exports = { startServer, allowRoot };
