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

/** 类型 -> 图标路径（24x24 viewBox，描边用 currentColor） */
const GLYPH = {
  dir: '<path d="M3.2 7.6a2 2 0 0 1 2-2h3.3a2 2 0 0 1 1.5.7l1 1.2a2 2 0 0 0 1.5.7h5.3a2 2 0 0 1 2 2v6.6a2 2 0 0 1-2 2H5.2a2 2 0 0 1-2-2z"/>',
  image:
    '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4"/><circle cx="8.6" cy="9.8" r="1.5"/>' +
    '<path d="M3.6 17.2l4.7-4.3a1.5 1.5 0 0 1 2 0l3.2 2.9"/><path d="M13.6 14.6l1.8-1.6a1.5 1.5 0 0 1 2 0l3 2.7"/>',
  video: '<rect x="3.2" y="4.8" width="17.6" height="14.4" rx="2.4"/><path d="M10.2 9.4l4.6 2.6-4.6 2.6z"/>',
  audio:
    '<path d="M9.4 17.4V6.2l8.4-1.7v9.6"/><circle cx="6.9" cy="17.4" r="2.5"/><circle cx="15.3" cy="14.1" r="2.5"/>',
  archive:
    '<rect x="3.2" y="4.6" width="17.6" height="4" rx="1.4"/>' +
    '<path d="M5 8.6h14v10.2a1.6 1.6 0 0 1-1.6 1.6H6.6A1.6 1.6 0 0 1 5 18.8z"/>' +
    '<path d="M10.3 12.4h3.4"/><path d="M10.3 15.4h3.4"/>',
  code: '<path d="M9.2 8.2L4.6 12l4.6 3.8"/><path d="M14.8 8.2L19.4 12l-4.6 3.8"/>',
  text:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/><path d="M8.6 12.6h6.8"/><path d="M8.6 15.6h4.4"/>',
  pdf:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/>' +
    '<path d="M8.6 17c1.9-.5 3.4-2.2 4.3-4.4.6-1.5.2-2.4-.5-2.4-.9 0-.9 1.2-.5 2.9.5 2.3 1.7 3.8 3 3.9"/>',
  word:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/><path d="M8.4 11.6l1.4 4.8 1.7-3.3 1.7 3.3 1.4-4.8"/>',
  excel:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/><rect x="8.6" y="11.6" width="6.8" height="6"/>' +
    '<path d="M12 11.6v6"/><path d="M8.6 14.6h6.8"/>',
  ppt:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/><path d="M8.9 17.6v-6.2h2.3a1.9 1.9 0 0 1 0 3.8H8.9"/>',
  font: '<path d="M8.6 17.8L12 6.6l3.4 11.2"/><path d="M9.9 14.2h4.2"/>',
  ebook:
    '<path d="M4 5.4h5.4a2.6 2.6 0 0 1 2.6 2.6v10.6a2 2 0 0 0-2-2H4z"/>' +
    '<path d="M20 5.4h-5.4a2.6 2.6 0 0 0-2.6 2.6v10.6a2 2 0 0 1 2-2H20z"/>',
  app:
    '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2.4"/><path d="M3.4 9.4h17.2"/>' +
    '<circle cx="6.7" cy="7" r=".95" fill="currentColor" stroke="none"/>' +
    '<circle cx="9.5" cy="7" r=".95" fill="currentColor" stroke="none"/>',
  data:
    '<ellipse cx="12" cy="6.8" rx="7.2" ry="2.8"/>' +
    '<path d="M4.8 6.8v10.4c0 1.5 3.2 2.8 7.2 2.8s7.2-1.3 7.2-2.8V6.8"/>' +
    '<path d="M4.8 12c0 1.5 3.2 2.8 7.2 2.8s7.2-1.3 7.2-2.8"/>',
  default:
    '<path d="M6.6 3.8h6.6l4.6 4.6v11.8a1 1 0 0 1-1 1H6.6a1 1 0 0 1-1-1V4.8a1 1 0 0 1 1-1z"/>' +
    '<path d="M13.2 3.8v4.6h4.6"/>'
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
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" ' +
    'stroke-linecap="round" stroke-linejoin="round">' + (GLYPH[cat] || GLYPH.default) + '</svg>' +
    '</span>'
  );
}
