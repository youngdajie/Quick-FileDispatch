'use strict';

/**
 * 本地仓库文件浏览
 * 管理界面默认直接读本地（快），也可切换为读远程 API
 */

const fs = require('fs');
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

/** 列目录（相对 root），返回统一结构 */
function listDir(root, rel = '') {
  const abs = safeJoin(root, rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (!stat.isDirectory()) return [];
  const out = [];
  for (const name of fs.readdirSync(abs)) {
    if (name === '.git' || name === '.DS_Store' || name === 'Thumbs.db') continue;
    let st;
    try {
      st = fs.statSync(path.join(abs, name));
    } catch (e) {
      continue;
    }
    const relPath = [rel.replace(/^[/\\]+|[/\\]+$/g, ''), name].filter(Boolean).join('/');
    out.push({
      name,
      path: relPath,
      type: st.isDirectory() ? 'dir' : 'file',
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
      isImage: st.isDirectory() ? false : isImage(name)
    });
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh-Hans-CN');
  });
  return out;
}

/** 递归统计 */
function countDir(root, rel = '', depth = 0, acc = { files: 0, bytes: 0, images: 0 }) {
  if (depth > 8) return acc;
  const items = listDir(root, rel);
  for (const it of items) {
    if (it.type === 'dir') countDir(root, it.path, depth + 1, acc);
    else {
      acc.files += 1;
      acc.bytes += it.size;
      if (it.isImage) acc.images += 1;
    }
  }
  return acc;
}

/** 目录树（只到指定层级），用于管理页左侧树 */
function tree(root, rel = '', depth = 0, maxDepth = 2) {
  if (depth > maxDepth) return [];
  const items = listDir(root, rel);
  return items
    .filter((it) => it.type === 'dir')
    .map((it) => ({
      name: it.name,
      path: it.path,
      children: tree(root, it.path, depth + 1, maxDepth)
    }));
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
