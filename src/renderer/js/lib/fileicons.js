/**
 * 文件类型图标
 *
 * 为什么不用「扩展名文字」：把 EDITORCONFIG 这种长扩展名塞进缩略图里，
 * 小尺寸下必然溢出到图标外面。改成按类型给一个矢量图标，
 * 颜色区分大类，图形区分小类，不再有任何字。
 */

/** 扩展名 -> 类型 */
const EXT_CATEGORY = {
  // 图片
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', avif: 'image',
  bmp: 'image', svg: 'image', ico: 'image', tif: 'image', tiff: 'image', jfif: 'image',
  heic: 'image', heif: 'image', raw: 'image', psd: 'image', ai: 'image', sketch: 'image', fig: 'image',

  // 视频
  mp4: 'video', mov: 'video', mkv: 'video', avi: 'video', webm: 'video', flv: 'video',
  wmv: 'video', m4v: 'video', mpg: 'video', mpeg: 'video', rmvb: 'video',

  // 音频
  mp3: 'audio', wav: 'audio', flac: 'audio', aac: 'audio', ogg: 'audio', m4a: 'audio',
  wma: 'audio', opus: 'audio', aiff: 'audio', mid: 'audio',

  // 压缩包
  zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive',
  bz2: 'archive', xz: 'archive', tgz: 'archive', zst: 'archive', cab: 'archive',

  // 代码
  js: 'code', mjs: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code',
  json: 'code', jsonc: 'code', html: 'code', htm: 'code', css: 'code', scss: 'code',
  less: 'code', sass: 'code', vue: 'code', svelte: 'code', py: 'code', java: 'code',
  c: 'code', h: 'code', cpp: 'code', cc: 'code', hpp: 'code', cs: 'code', go: 'code',
  rs: 'code', rb: 'code', php: 'code', swift: 'code', kt: 'code', dart: 'code',
  sh: 'code', bash: 'code', zsh: 'code', ps1: 'code', bat: 'code', cmd: 'code',
  yml: 'code', yaml: 'code', toml: 'code', ini: 'code', conf: 'code', cfg: 'code',
  xml: 'code', sql: 'code', editorconfig: 'code', env: 'code', gitignore: 'code',
  gitattributes: 'code', npmrc: 'code', eslintrc: 'code', prettierrc: 'code', lock: 'code',

  // 纯文本
  txt: 'text', md: 'text', markdown: 'text', log: 'text', rtf: 'text', rst: 'text', readme: 'text',

  // PDF
  pdf: 'pdf',

  // Office
  doc: 'word', docx: 'word', wps: 'word', odt: 'word',
  xls: 'excel', xlsx: 'excel', xlsm: 'excel', csv: 'excel', tsv: 'excel', et: 'excel', ods: 'excel',
  ppt: 'ppt', pptx: 'ppt', dps: 'ppt', odp: 'ppt',

  // 字体
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font', eot: 'font',

  // 电子书
  epub: 'ebook', mobi: 'ebook', azw: 'ebook', azw3: 'ebook',

  // 可执行 / 安装包
  exe: 'app', msi: 'app', dll: 'app', apk: 'app', dmg: 'app', deb: 'app',
  rpm: 'app', appimage: 'app', so: 'app', sys: 'app',

  // 数据库
  db: 'data', sqlite: 'data', sqlite3: 'data', mdb: 'data'
};

/**
 * 类型 -> 图标路径（24x24 viewBox，**实心**，靠 evenodd 挖出内部细节）
 *
 * 设计口径（2026-11-07 杰哥要求重做）：
 *   - 一律实心（fill），不再用细描边 —— 描边图标和图片缩略图并排时太轻、
 *     显得「小一号」，尤其在列表视图里像没长开
 *   - 圆角、圆润：主体容器 rx 都在 2.4~3，避免直角硬边
 *   - 内部细节用 fill-rule="evenodd" 挖洞表达，单色也能看清，不依赖背景色
 */
const GLYPH = {
  // 文件夹：实心，圆角
  dir: '<path d="M3 7.4a3 3 0 0 1 3-3h3.3c.9 0 1.7.4 2.3 1l1.1 1.2c.4.5 1 .7 1.6.7h5.7a3 3 0 0 1 3 3v8.3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"/>',

  // 图片：实心圆角矩形，挖出太阳与山
  image:
    '<path fill-rule="evenodd" d="M4.8 3.4h14.4a2.7 2.7 0 0 1 2.7 2.7v11.8a2.7 2.7 0 0 1-2.7 2.7H4.8a2.7 2.7 0 0 1-2.7-2.7V6.1a2.7 2.7 0 0 1 2.7-2.7Zm2 3.4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Zm-2.6 11.1h15.6l-4.8-5.1a1.6 1.6 0 0 0-2.3 0l-3 3.2-1.6-1.7a1.6 1.6 0 0 0-2.3 0Z"/>',

  // 视频：实心圆角矩形，挖出播放三角
  video:
    '<path fill-rule="evenodd" d="M4.8 3.4h14.4a2.7 2.7 0 0 1 2.7 2.7v11.8a2.7 2.7 0 0 1-2.7 2.7H4.8a2.7 2.7 0 0 1-2.7-2.7V6.1a2.7 2.7 0 0 1 2.7-2.7Zm5 4.6v8l6.7-4Z"/>',

  /*
   * 音频：纯音符，不再套一个方块底。
   * 之前是「圆角方块 + 挖出音符」，整体是个长方形，杰哥说太冲、不好看。
   * 现在直接用双八分音符本体：两个圆符头 + 两根符杆 + 顶部斜横杠，
   * 全部实心、圆头，放在 24 格中间，不再有外框。
   */
  audio:
    '<circle cx="8.1" cy="17.3" r="3.05"/>' +
    '<circle cx="17.5" cy="14.4" r="3.05"/>' +
    '<path d="M10.8 17.3V6.3l9.5-1.9v9.8h-2.3V7.2l-4.9 1v8.9Z"/>',

  // 压缩包：实心方块，挖出拉链
  archive:
    '<path fill-rule="evenodd" d="M4.8 3.4h14.4a2.7 2.7 0 0 1 2.7 2.7v11.8a2.7 2.7 0 0 1-2.7 2.7H4.8a2.7 2.7 0 0 1-2.7-2.7V6.1a2.7 2.7 0 0 1 2.7-2.7ZM10.7 5.2v2.1h2.6V5.2Zm0 3.4v2.1h2.6V8.6Zm0 3.4v2.1h2.6v-2.1Zm-1.3 3.4h5.2v3.1h-5.2Z"/>',

  // 代码：实心方块，挖出 < >
  code:
    '<path fill-rule="evenodd" d="M4.8 3.4h14.4a2.7 2.7 0 0 1 2.7 2.7v11.8a2.7 2.7 0 0 1-2.7 2.7H4.8a2.7 2.7 0 0 1-2.7-2.7V6.1a2.7 2.7 0 0 1 2.7-2.7Zm4.6 4.5L5.2 12l4.2 4.1 1.5-1.5L8.3 12l2.6-2.6Zm5.2 0-1.5 1.5L15.7 12l-2.6 2.6 1.5 1.5L18.8 12Z"/>',

  // 文本：实心文件 + 折角 + 三条线
  text:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2ZM7.6 12h8.8v1.8H7.6Zm0 3.4h8.8v1.8H7.6Zm0 3.4h5.8v1.8H7.6Z"/>',

  // PDF：实心文件 + 折角 + 一个文档框
  pdf:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2Zm-5.8 6.3h8.8v5.4H7.6Z"/>',

  // Word：实心文件 + 折角 + 段落线（首条最长）
  word:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2ZM7.6 11.2h8.8V13H7.6Zm0 3.2h8.8v1.8H7.6Zm0 3.2h5.2v1.8H7.6Z"/>',

  // Excel：实心文件 + 折角 + 四格网格
  excel:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2ZM7.6 11h4v4h-4Zm5.2 0h4v4h-4Zm-5.2 5h4v3h-4Zm5.2 0h4v3h-4Z"/>',

  // PPT：实心文件 + 折角 + 一个圆
  ppt:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2Zm-2.4 5.7a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/>',

  // 字体：实心 A，中间挖洞
  font:
    '<path fill-rule="evenodd" d="M12 2.6 3.2 21.4h4.1l1.5-3.6h6.4l1.5 3.6h4.1L12 2.6Zm0 6.1 2.1 5.1h-4.2Z"/>',

  // 电子书：两页实心，中间自然留缝
  ebook:
    '<path d="M11 5.2C9.6 4 7.7 3.4 5.4 3.4c-.9 0-1.7.1-2.4.4v15.5c.7-.2 1.5-.3 2.4-.3 2.3 0 4.2.6 5.6 1.8V5.2Z"/>' +
    '<path d="M13 5.2c1.4-1.2 3.3-1.8 5.6-1.8.9 0 1.7.1 2.4.4v15.5c-.7-.2-1.5-.3-2.4-.3-2.3 0-4.2.6-5.6 1.8V5.2Z"/>',

  // 应用：实心圆角窗口，挖出标题栏和两个点
  app:
    '<path fill-rule="evenodd" d="M5.2 3.4h13.6a2.8 2.8 0 0 1 2.8 2.8v11.6a2.8 2.8 0 0 1-2.8 2.8H5.2a2.8 2.8 0 0 1-2.8-2.8V6.2a2.8 2.8 0 0 1 2.8-2.8Zm0 2.2a.6.6 0 0 0-.6.6v2h14.8v-2a.6.6 0 0 0-.6-.6ZM6.6 7.5a1 1 0 1 0 0 2 1 1 0 0 0 0-2Zm3 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>',

  // 数据库：三层实心圆柱
  data:
    '<path d="M12 2.6c-4.4 0-8 1.5-8 3.4s3.6 3.4 8 3.4 8-1.5 8-3.4-3.6-3.4-8-3.4Z"/>' +
    '<path d="M4 8.7v4.1c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V8.7c-1.7 1.4-4.6 2.2-8 2.2S5.7 10.1 4 8.7Z"/>' +
    '<path d="M4 15v2.9c0 1.9 3.6 3.4 8 3.4s8-1.5 8-3.4V15c-1.7 1.4-4.6 2.2-8 2.2S5.7 16.4 4 15Z"/>',

  // 兜底：实心文件 + 折角
  default:
    '<path fill-rule="evenodd" d="M6.4 2.6h7.3L19.4 8v11.4a2.4 2.4 0 0 1-2.4 2.4H6.4a2.4 2.4 0 0 1-2.4-2.4V5a2.4 2.4 0 0 1 2.4-2.4Zm7 1.9v4.2h4.2Z"/>'
};

export const CATEGORIES = Object.keys(GLYPH);

/** 取扩展名（小写，不带点） */
export function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  if (m) return m[1].toLowerCase();
  // 形如 .gitignore / .env 的点文件：整个名字就是「扩展名」
  const d = /^\.([a-z0-9]+)$/i.exec(String(name || ''));
  return d ? d[1].toLowerCase() : '';
}

/** 判断大类 */
export function categoryOf(name, isDir) {
  if (isDir) return 'dir';
  const e = extOf(name);
  return EXT_CATEGORY[e] || 'default';
}

export function isImageName(name) {
  return categoryOf(name, false) === 'image';
}

/** 生成图标 HTML —— 尺寸交给 CSS（.fi 的宽高），颜色由 .fi-<type> 决定 */
export function fileIcon(name, opts) {
  const cat = opts && opts.isDir ? 'dir' : categoryOf(name, false);
  return (
    '<span class="fi fi-' + cat + '" aria-hidden="true">' +
    // 实心风格：只给 fill，不给 stroke（描边会让图标在缩略图旁边显轻、显小）
    '<svg viewBox="0 0 24 24" fill="currentColor">' + (GLYPH[cat] || GLYPH.default) + '</svg>' +
    '</span>'
  );
}
