/**
 * 压缩 Worker —— 跑在独立线程，配合多 Worker 池吃满多核 CPU
 * JPEG / WebP / PNG 用 OffscreenCanvas 的 Chromium 原生编解码器；
 * AVIF 走内置的 libavif（wasm）——因为 Chromium 只能解码 AVIF，不能编码
 * （canvas.convertToBlob({type:'image/avif'}) 会静默返回 PNG，别被骗了）。
 */

// 水印绘制是页面和 worker 共用的那一份（见 lib/watermark.js 顶部说明）——
// worker 是 classic worker，只能用 importScripts 引经典脚本，引不来 ES module。
importScripts('/js/lib/watermark.js');

const PASSTHROUGH_EXT = new Set(['gif', 'svg']);

const KEEP_MAP = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/png',
  avif: 'image/avif',
  tif: 'image/png',
  tiff: 'image/png',
  ico: 'image/png',
  jfif: 'image/jpeg'
};

function extOf(name) {
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
}

function extForType(type) {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/png') return 'png';
  if (type === 'image/avif') return 'avif';
  return 'bin';
}

/** 采样判断是否有透明像素 */
function detectAlpha(bitmap, w, h) {
  const sw = Math.min(96, w);
  const sh = Math.min(96, h);
  const c = new OffscreenCanvas(sw, sh);
  const ctx = c.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, sw, sh);
  const data = ctx.getImageData(0, 0, sw, sh).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/** 分步缩放，避免一次性大幅缩小时产生锯齿 */
function drawResized(ctx, bitmap, tw, th) {
  let cw = bitmap.width;
  let ch = bitmap.height;
  let src = bitmap;
  let tmp = null;
  while (cw > tw * 2 && ch > th * 2) {
    const nw = Math.max(tw, Math.round(cw / 2));
    const nh = Math.max(th, Math.round(ch / 2));
    const c = new OffscreenCanvas(nw, nh);
    const cx = c.getContext('2d');
    cx.imageSmoothingEnabled = true;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(src, 0, 0, nw, nh);
    if (tmp && tmp.close) tmp.close();
    tmp = new OffscreenCanvas(nw, nh);
    tmp.getContext('2d').drawImage(c, 0, 0);
    src = tmp;
    cw = nw;
    ch = nh;
  }
  ctx.drawImage(src, 0, 0, cw, ch, 0, 0, tw, th);
  if (tmp && tmp.close) tmp.close();
}

/* ------------------------------------------------------------- 水印 */

// 具体的绘制在 lib/watermark.js 里（页面预览用的是同一份实现），
// 这里只负责把它接到压缩流程上。
function paintWatermark(ctx, w, h, wm) {
  const WM = self.CPWatermark;
  if (!WM) return;              // 脚本没引上就安静跳过，别把整个压缩搞挂
  WM.draw(ctx, w, h, wm);
}

function resolveType(format, ext, hasAlpha) {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'webp') return 'image/webp';
  if (format === 'png') return 'image/png';
  if (format === 'avif') return 'image/avif';
  if (format === 'keep') return KEEP_MAP[ext] || 'image/jpeg';
  // auto
  if (hasAlpha) return 'image/webp';
  return 'image/jpeg';
}

/* ------------------------------------------------------------- AVIF(wasm) */

const AVIF_GLUE = '/vendor/avif/avif_enc.classic.js';
const AVIF_WASM = '/vendor/avif/avif_enc.wasm';

let avifPromise = null;
let avifError = null;

/** 懒加载 libavif；失败后记住错误，不反复重试 */
function loadAvif() {
  if (avifError) return Promise.reject(avifError);
  if (!avifPromise) {
    avifPromise = (async () => {
      importScripts(AVIF_GLUE);
      const factory = self.__avifFactory;
      if (typeof factory !== 'function') throw new Error('编码器脚本未就绪');
      const res = await fetch(AVIF_WASM);
      if (!res.ok) throw new Error('编码器资源缺失 HTTP ' + res.status);
      const wasmBinary = new Uint8Array(await res.arrayBuffer());
      const mod = await factory({ noInitialRun: true, wasmBinary });
      self.__avifFactory = undefined;
      return mod;
    })();
    avifPromise = avifPromise.catch((e) => {
      avifError = e;
      throw e;
    });
    avifPromise.catch(() => {});
  }
  return avifPromise;
}

/** embind 出来的结果可能是 ArrayBuffer、视图，也可能是堆上的视图，统一取出准确字节 */
function avifBytes(output) {
  if (!output) throw new Error('编码返回空');
  if (output instanceof ArrayBuffer) return new Uint8Array(output);
  if (ArrayBuffer.isView(output)) {
    return new Uint8Array(output.buffer, output.byteOffset, output.byteLength).slice();
  }
  if (output.buffer) return new Uint8Array(output.buffer);
  if (typeof output.length === 'number') return Uint8Array.from(output);
  throw new Error('编码结果格式无法识别');
}

async function encodeAvif(ctx, w, h, quality) {
  const mod = await loadAvif();
  const img = ctx.getImageData(0, 0, w, h);
  const out = mod.encode(new Uint8Array(img.data.buffer), w, h, {
    quality: Math.max(1, Math.min(100, Math.round(quality * 100))),
    qualityAlpha: -1,
    denoiseLevel: 0,
    tileColsLog2: 0,
    tileRowsLog2: 0,
    speed: 6,
    subsample: 1,
    chromaDeltaQ: false,
    sharpness: 0,
    tune: 0,
    enableSharpYUV: false,
    bitDepth: 8,
    lossless: false
  });
  const bytes = avifBytes(out);
  if (!bytes.length) throw new Error('编码结果为空');
  return new Blob([bytes], { type: 'image/avif' });
}

async function encode(canvas, ctx, type, quality) {
  if (type === 'image/avif') return encodeAvif(ctx, canvas.width, canvas.height, quality);
  const opts = { type };
  if (type === 'image/jpeg' || type === 'image/webp') {
    opts.quality = Math.max(0.02, Math.min(1, quality));
  }
  return canvas.convertToBlob(opts);
}

async function process(buffer, name, opt) {
  const ext = extOf(name);
  const srcBlob = new Blob([buffer]);

  let bitmap;
  try {
    bitmap = await createImageBitmap(srcBlob);
  } catch (e) {
    return { passthrough: true, buffer, type: 'application/octet-stream', reason: '无法解码，按原文件上传' };
  }

  const srcW = bitmap.width;
  const srcH = bitmap.height;

  // GIF / SVG 交给原生格式，重新编码会丢掉动画与矢量特性
  if (PASSTHROUGH_EXT.has(ext)) {
    if (bitmap.close) bitmap.close();
    return {
      passthrough: true,
      buffer,
      type: ext === 'svg' ? 'image/svg+xml' : 'image/gif',
      width: srcW,
      height: srcH,
      reason: ext === 'gif' ? 'GIF 保留原始文件（避免丢失动画）' : 'SVG 保留原始文件（矢量格式）'
    };
  }

  const hasAlpha = ext === 'png' || ext === 'webp' || ext === 'avif' ? detectAlpha(bitmap, srcW, srcH) : false;

  // 尺寸
  let tw = srcW;
  let th = srcH;
  const mw = Number(opt.maxWidth) || 0;
  const mh = Number(opt.maxHeight) || 0;
  if (mw > 0 || mh > 0) {
    const ratio = Math.min(1, mw > 0 ? mw / srcW : 1, mh > 0 ? mh / srcH : 1);
    tw = Math.max(1, Math.round(srcW * ratio));
    th = Math.max(1, Math.round(srcH * ratio));
  }

  let type = resolveType(opt.format || 'auto', ext, hasAlpha);
  let note = '';
  if (type === 'image/avif') {
    try {
      await loadAvif();
    } catch (e) {
      // 编码器没装上也不能让整条上传链断掉，退回 WebP 并说明原因
      type = 'image/webp';
      note = 'AVIF 编码器不可用，已改用 WebP：' + ((e && e.message) || e);
    }
  }

  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d', { alpha: type !== 'image/jpeg' });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tw, th);
  }
  drawResized(ctx, bitmap, tw, th);
  if (bitmap.close) bitmap.close();

  if (opt.watermark && opt.watermark.enabled && opt.watermark.text) {
    paintWatermark(ctx, tw, th, opt.watermark);
  }

  let quality = Math.max(0.02, Math.min(1, (Number(opt.quality) || 80) / 100));
  let blob = await encode(canvas, ctx, type, quality);

  // 目标体积：二分逼近，找「不超过目标体积」前提下的最高质量
  const targetKB = Number(opt.targetSizeKB) || 0;
  const tunable = type === 'image/jpeg' || type === 'image/webp' || type === 'image/avif';
  if (targetKB > 0 && tunable) {
    const target = targetKB * 1024;
    if (blob.size > target) {
      // AVIF 一次编码比 JPEG/WebP 贵得多，迭代次数收一收，避免卡住
      const rounds = type === 'image/avif' ? 3 : 7;
      let lo = 0.03;
      let hi = quality;
      let best = null;
      for (let i = 0; i < rounds; i++) {
        const q = (lo + hi) / 2;
        const b = await encode(canvas, ctx, type, q);
        if (b.size <= target) {
          best = { b, q };
          if (b.size >= target * 0.88) break;
          lo = q;
        } else {
          hi = q;
        }
      }
      if (best) {
        blob = best.b;
        quality = best.q;
      } else {
        // 最小质量仍超标，就用最低质量
        blob = await encode(canvas, ctx, type, 0.03);
        quality = 0.03;
      }
    }
  }

  const out = await blob.arrayBuffer();
  const outType = blob.type || type;

  if (opt.skipIfSmaller && out.byteLength >= buffer.byteLength) {
    return {
      passthrough: true,
      buffer,
      type: srcBlob.type || 'application/octet-stream',
      width: srcW,
      height: srcH,
      reason: '压缩后反而更大，已保留原图',
      note
    };
  }

  return {
    passthrough: false,
    buffer: out,
    type: outType,
    ext: extForType(outType),
    width: tw,
    height: th,
    srcWidth: srcW,
    srcHeight: srcH,
    quality: Math.round(quality * 100),
    note
  };
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};
  const { id, name, options } = msg;
  try {
    const buffer = msg.buffer instanceof ArrayBuffer ? msg.buffer : new Uint8Array(msg.buffer).buffer;
    const res = await process(buffer, name, options || {});
    self.postMessage(Object.assign({ id, ok: true }, res), res.buffer instanceof ArrayBuffer ? [res.buffer] : []);
  } catch (err) {
    self.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
};
