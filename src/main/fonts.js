'use strict';

/**
 * 本机已安装字体枚举（Windows）。
 *
 * 为什么要有它：界面字体的下拉原先只认一份**写死的候选表**（appearance.js 里的
 * FONT_CANDIDATES，全是 Windows 自带的那几十款）。用户自己装的字体 —— 比如
 * 霞鹜文楷 —— 就算装好了也永远不出现，因为程序压根没去问过系统。
 *
 * 这里直接扫字体目录（系统 + 当前用户），再解析每个字体文件里的 `name` 表，
 * 把真正的「家族名」读出来：装着什么就列什么。
 *
 * 之所以自己解析而不是查注册表：注册表里存的是**全名**（"LXGW WenKai Regular"），
 * 拿去写 CSS font-family 是不对的（要的是家族名 "LXGW WenKai"）；
 * 而且 en / zh 两套名字在注册表里是混着的。name 表里 nameID=1/16 就是家族名，
 * nameID=16（Typographic Family）没有样式后缀，是最干净的。
 */

const fs = require('fs');
const path = require('path');

const isWin = process.platform === 'win32';

/* ---------------------------------------------------------------- 目录 */

/** 字体文件所在目录：系统字体 + 「仅为当前用户安装」的字体（用户装的通常落在后者） */
function fontDirs() {
  const dirs = [];
  const win = process.env.WINDIR || 'C:\\Windows';
  dirs.push(path.join(win, 'Fonts'));
  if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'));

  return dirs.filter((d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch (e) {
      return false;
    }
  });
}

const FONT_EXT = new Set(['.ttf', '.otf', '.ttc', '.otc']);

function fontFiles() {
  const out = [];
  for (const dir of fontDirs()) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      continue;
    }
    for (const n of names) {
      if (FONT_EXT.has(path.extname(n).toLowerCase())) out.push(path.join(dir, n));
    }
  }
  return out;
}

/* ---------------------------------------------------------------- 解析 */

function readAt(fd, offset, length) {
  if (offset < 0 || length <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(length);
  let n = 0;
  try {
    n = fs.readSync(fd, buf, 0, length, offset);
  } catch (e) {
    return Buffer.alloc(0);
  }
  return n === length ? buf : buf.slice(0, n);
}

/** name 表里那几个「样式后缀」，只在没有 Typographic Family 时才需要剥掉 */
const STYLE_TAIL =
  /\s+(Regular|Bold|Italic|Oblique|Light|Medium|Black|Thin|Book|Roman|Heavy|SemiBold|Semibold|DemiBold|ExtraLight|Extralight|ExtraBold|ExtraBlack|UltraLight|UltraBold|Condensed|Narrow|BoldItalic|BoldOblique)$/;

function decodeString(buf, platformID, start, len) {
  if (platformID === 3 || platformID === 0) {
    // Windows / Unicode：UTF-16BE
    let s = '';
    for (let i = 0; i + 1 < len; i += 2) s += String.fromCharCode(buf.readUInt16BE(start + i));
    return s;
  }
  if (platformID === 1) {
    // Mac：够用就行，字体家族名基本是 ASCII / MacRoman 前段
    return buf.toString('latin1', start, start + len);
  }
  return '';
}

function parseNameTable(buf) {
  if (buf.length < 6) return [];
  const count = buf.readUInt16BE(2);
  const stringOffset = buf.readUInt16BE(4);
  if (!count || count > 4096) return [];

  const en = {}; // nameID -> string
  const zh = {};

  for (let i = 0; i < count; i++) {
    const o = 6 + i * 12;
    if (o + 12 > buf.length) break;
    const platformID = buf.readUInt16BE(o);
    const languageID = buf.readUInt16BE(o + 4);
    const nameID = buf.readUInt16BE(o + 6);
    const len = buf.readUInt16BE(o + 8);
    const off = buf.readUInt16BE(o + 10);
    if (nameID !== 1 && nameID !== 16) continue;
    if (!len) continue;
    const start = stringOffset + off;
    if (start + len > buf.length) continue;

    const s = decodeString(buf, platformID, start, len).replace(/\u0000/g, '').trim();
    if (!s) continue;

    // 0x0409 = en-US；0x0804/0x0404/0x0c04 = zh-CN / zh-TW / zh-HK
    const isZh = languageID === 0x0804 || languageID === 0x0404 || languageID === 0x0c04;
    const bucket = isZh ? zh : en;
    // 先到先得，但 nameID 16 比 1 权威，后面统一优先取 16
    if (!bucket[nameID]) bucket[nameID] = s;
  }

  const pick = (b) => {
    if (b[16]) return b[16]; // Typographic Family：没有样式后缀
    if (b[1]) return b[1].replace(STYLE_TAIL, '').trim() || b[1];
    return '';
  };

  const e = pick(en);
  const z = pick(zh);
  const out = [];
  if (e) out.push(e);
  if (z && z !== e) out.push(z);
  return out;
}

/** 从「某个字体在文件里的起点」读出它的家族名（多试两种 offset 基准，TTC 里两者不同） */
function familiesAt(fd, base) {
  const head = readAt(fd, base, 12);
  if (head.length < 12) return [];
  const numTables = head.readUInt16BE(4);
  if (!numTables || numTables > 1024) return [];

  const dir = readAt(fd, base + 12, numTables * 16);
  if (dir.length < numTables * 16) return [];

  let nameOff = 0;
  let nameLen = 0;
  for (let i = 0; i < numTables; i++) {
    const o = i * 16;
    if (dir.toString('latin1', o, o + 4) !== 'name') continue;
    nameOff = dir.readUInt32BE(o + 8);
    nameLen = dir.readUInt32BE(o + 12);
    break;
  }
  if (!nameOff || !nameLen || nameLen > 16 * 1024 * 1024) return [];

  // TTC 里表偏移相对文件头，单字体里相对字体头；两种都试一下
  const tries = base ? [nameOff, base + nameOff] : [nameOff];
  for (const at of tries) {
    const tbl = readAt(fd, at, Math.min(nameLen, 4 * 1024 * 1024));
    const got = parseNameTable(tbl);
    if (got.length) return got;
  }
  return [];
}

/** 一个字体文件里的所有家族名（.ttc 是字体集合，一个文件里可能有好几款） */
function familiesInFile(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, 16);
    if (head.length < 4) return [];

    // 字体集合：'ttcf' + version + numFonts + offsets[]
    if (head.toString('latin1', 0, 4) === 'ttcf') {
      const num = head.length >= 12 ? head.readUInt32BE(8) : 0;
      if (!num || num > 256) return [];
      const offs = readAt(fd, 12, num * 4);
      const out = [];
      for (let i = 0; i + 4 <= offs.length; i += 4) {
        out.push(...familiesAt(fd, offs.readUInt32BE(i)));
      }
      return out;
    }
    return familiesAt(fd, 0);
  } catch (e) {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (e) {
        /* ignore */
      }
    }
  }
}

/* ---------------------------------------------------------------- 对外 */

let cache = null;

/**
 * 本机所有字体的家族名（去重、排序）。
 * 非 Windows 直接返回空数组 —— 调用方会退回候选表那条老路。
 */
function listFamilies() {
  if (cache) return cache;
  if (!isWin) {
    cache = [];
    return cache;
  }

  const seen = new Set();
  const out = [];
  for (const file of fontFiles()) {
    for (const fam of familiesInFile(file)) {
      const k = fam.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(fam);
    }
  }
  out.sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
  cache = out;
  return cache;
}

module.exports = { listFamilies, fontDirs };
