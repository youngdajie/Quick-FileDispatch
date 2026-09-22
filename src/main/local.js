'use strict';

/**
 * 本地仓库文件浏览
 * 管理界面默认直接读本地（快），也可切换为读远程 API
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const IMAGE_EXT = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg', '.avif', '.ico', '.tif', '.tiff', '.jfif'
]);

function isImage(name) {
  return IMAGE_EXT.has(path.extname(name).toLowerCase());
}

function safeJoin(root, rel) {
  const target = path.resolve(root, String(rel || '').replace(/^[/\\]+/, ''));
  const rootResolved = path.resolve(root);
  if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
    throw new Error('路径越界');
  }
  return target;
}

/**
 * 列目录（相对 root），返回统一结构。
 *
 * 用异步 IO：这些函数跑在主进程里，同步版本在仓库大的时候会把主进程整个占住，
 * 期间所有 IPC（包括界面上的点击）一起排队，看起来就是「点了没反应」。
 * 类型靠 readdir(withFileTypes) 直接拿到，只有文件才去 stat 取大小，
 * 比原来「每个条目都 stat 一次」少一半系统调用。
 */
async function listDir(root, rel = '') {
  const abs = safeJoin(root, rel);
  let entries;
  try {
    const st = await fsp.stat(abs);
    if (!st.isDirectory()) return [];
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    return [];
  }

  const names = [];
  const kinds = [];
  for (const ent of entries) {
    const name = ent.name;
    if (name === '.git' || name === '.DS_Store' || name === 'Thumbs.db') continue;
    names.push(name);
    kinds.push(ent.isDirectory() ? 'dir' : 'file');
  }

  // 大小 / 时间必须 stat 才有：按小批次并发，既不串行等、也不一次性打出上千个请求
  const stats = new Array(names.length).fill(null);
  const CHUNK = 32;
  for (let i = 0; i < names.length; i += CHUNK) {
    const slice = names.slice(i, i + CHUNK);
    await Promise.all(
      slice.map(async (name, k) => {
        try {
          stats[i + k] = await fsp.stat(path.join(abs, name));
        } catch (e) {
          /* 读不到就当没有这个条目 */
        }
      })
    );
  }

  const out = [];
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const st = stats[i];
    if (!st) continue;
    const relPath = [rel.replace(/^[/\\]+|[/\\]+$/g, ''), name].filter(Boolean).join('/');
    out.push({
      name,
      path: relPath,
      type: kinds[i],
      size: kinds[i] === 'dir' ? 0 : st.size,
      mtime: st.mtimeMs,
      isImage: kinds[i] === 'dir' ? false : isImage(name)
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return out;
}

/** 递归统计 */
async function countDir(root, rel = '', depth = 0, acc = null) {
  const state = acc || { files: 0, bytes: 0, images: 0 };
  if (depth > 8) return state;
  const items = await listDir(root, rel);
  for (const it of items) {
    if (it.type === 'dir') await countDir(root, it.path, depth + 1, state);
    else {
      state.files += 1;
      state.bytes += it.size;
      if (it.isImage) state.images += 1;
    }
  }
  return state;
}

/** 目录树（只到指定层级），用于管理页左侧树 */
async function tree(root, rel = '', depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return [];
  const items = await listDir(root, rel);
  const dirs = items.filter((it) => it.type === 'dir');
  const out = [];
  for (const it of dirs) {
    out.push({
      name: it.name,
      path: it.path,
      children: await tree(root, it.path, depth + 1, maxDepth)
    });
  }
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
  return p;
}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch (e) {
    return false;
  }
}

module.exports = { listDir, countDir, tree, safeJoin, ensureDir, exists, isImage, IMAGE_EXT };
