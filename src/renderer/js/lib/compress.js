/**
 * 压缩调度：Worker 池 + 重命名 + 哈希
 * 线程数默认取 CPU 逻辑核心数，让压缩真正跑满多核
 */

const WORKER_URL = '/js/lib/compress.worker.js';

export function defaultThreads() {
  const n = (navigator.hardwareConcurrency || 4);
  return Math.max(1, Math.min(16, n));
}

export class CompressPool {
  constructor(size) {
    this.size = Math.max(1, size || defaultThreads());
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.seq = 0;
    this.pending = new Map();
    this._init();
  }

  _init() {
    for (let i = 0; i < this.size; i++) {
      const w = new Worker(WORKER_URL);
      w.onmessage = (e) => this._onMessage(w, e);
      w.onerror = (e) => {
        // 单个 worker 崩掉时，把它挂起的任务全部失败掉，避免卡死
        for (const [id, p] of Array.from(this.pending.entries())) {
          if (p.worker === w) {
            p.reject(new Error('压缩线程异常：' + (e.message || 'unknown')));
            this.pending.delete(id);
          }
        }
        this.idle = this.idle.filter((x) => x !== w);
      };
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  _onMessage(worker, e) {
    const data = e.data || {};
    const p = this.pending.get(data.id);
    if (!p) return;
    this.pending.delete(data.id);
    this.idle.push(worker);
    if (data.ok) p.resolve(data);
    else p.reject(new Error(data.error || '压缩失败'));
    this._pump();
  }

  _pump() {
    while (this.queue.length && this.idle.length) {
      const job = this.queue.shift();
      const worker = this.idle.shift();
      const id = ++this.seq;
      this.pending.set(id, { resolve: job.resolve, reject: job.reject, worker });
      worker.postMessage(
        { id, name: job.name, buffer: job.buffer, options: job.options },
        [job.buffer]
      );
    }
  }

  /** 提交一个任务：{ name, buffer: ArrayBuffer, options } */
  run(name, buffer, options) {
    return new Promise((resolve, reject) => {
      this.queue.push({ name, buffer, options, resolve, reject });
      this._pump();
    });
  }

  get busyCount() {
    return this.pending.size;
  }

  terminate() {
    this.workers.forEach((w) => w.terminate());
    this.workers = [];
    this.idle = [];
    this.pending.clear();
    this.queue = [];
  }
}

/* ---------------------------------------------------------------- 读取 */

export function fileToArrayBuffer(file) {
  if (file.arrayBuffer) return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = () => reject(fr.error || new Error('读取文件失败'));
    fr.readAsArrayBuffer(file);
  });
}

export function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}

/* ---------------------------------------------------------------- 哈希 */

/** SHA-256 前 n 位十六进制，用于「哈希化」文件名 */
export async function hashBuffer(buffer, length) {
  const len = length || 8;
  try {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    const hex = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return hex.slice(0, len);
  } catch (e) {
    // 兜底：非密码学哈希，够用
    const u8 = new Uint8Array(buffer);
    let h1 = 5381;
    let h2 = 52711;
    for (let i = 0; i < u8.length; i++) {
      h1 = ((h1 * 33) ^ u8[i]) >>> 0;
      h2 = ((h2 * 31) ^ u8[i]) >>> 0;
    }
    return (h1.toString(16) + h2.toString(16)).padStart(8, '0').slice(0, len);
  }
}

/* ---------------------------------------------------------------- 命名 */

export function splitExt(name) {
  const m = /^(.*?)(\.[a-z0-9]+)?$/i.exec(String(name || ''));
  return { base: (m && m[1]) || 'image', ext: (m && m[2]) || '' };
}

export function stampName(date) {
  const d = date || new Date();
  const p = (n, w) => String(n).padStart(w || 2, '0');
  return (
    String(d.getFullYear()) +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds()) +
    '-' +
    String(Math.floor(Math.random() * 1000)).padStart(3, '0')
  );
}

/**
 * 按配置生成最终文件名
 * @returns {Promise<string>} 带扩展名的文件名
 */
export async function buildFileName(originalName, mode, prefix, buffer, outExt, hashLen) {
  const { base, ext } = splitExt(originalName);
  const targetExt = outExt ? '.' + outExt : ext;
  const pre = prefix ? String(prefix) : '';
  let core;
  if (mode === 'hash') {
    const h = await hashBuffer(buffer, hashLen || 8);
    core = h;
  } else if (mode === 'timestamp') {
    core = stampName();
  } else {
    core = base.replace(/[\\/:*?"<>|]/g, '_');
  }
  // 已有前缀就不重复加
  if (pre && core.startsWith(pre)) return core + targetExt;
  return pre + core + targetExt;
}
