/**
 * 上传分批的纯计算逻辑。
 *
 * **本模块不依赖任何 DOM / window** —— 它只做数学：给定一批文件，
 * 算出该分成几批、每批多大。这样它可以被 Node 直接跑测试
 * （本地测试脚手架，不入库），不用为了测几个算术去搭 DOM 桩。
 *
 * 界面相关的部分（进度条、提示）在 upload-run.js。
 */

/**
 * 后端 IPC 的请求体上限。
 *
 * **必须与 internal/webui/webui.go 的 maxIPCPayloadBytes 保持一致** ——
 * 那边改了这里就要跟着改，否则算出来的批大小会撞上限，
 * 用户等到最后才被拒绝。
 */
export const IPC_LIMIT = 512 * 1024 * 1024; // 512 MB

/**
 * 单批请求体的目标上限。
 *
 * 为什么不贴着 512MB 用：这里是**预估**（base64 长度按 4/3 算，还有
 * JSON 包装与转义），有误差。留 22% 余量，宁可多分一批，也不要撞上限
 * 白跑一次 —— 撞上限意味着用户已经等完整个上传时间才被拒绝，
 * 那是最糟的体验。
 */
export const SAFE_BODY = 400 * 1024 * 1024;

/** 请求体的固定开销（channel / payload / files 等字段名，外加一点余量）。 */
export const JSON_OVERHEAD = 200;

/**
 * 一个文件在请求体里占多少字节。
 *
 * base64 是「每 3 字节变 4 字符」，所以按 `4 * ceil(n/3)` 算 ——
 * ceil 处理的是末尾不足 3 字节时的 padding（`=` 也占一个字符）。
 * 再加上文件名与字段名的长度：带 hash 的长文件名这部分不能忽略。
 *
 * @param {number} size 文件字节数
 * @param {string} name 文件名（仓库内路径）
 * @returns {number} 该文件在请求体里占用的字节数
 */
export function bodyCost(size, name) {
  const n = Number(size) || 0;
  return Math.ceil(n / 3) * 4 + String(name || '').length + 30;
}

/**
 * 把待上传条目切成若干批，每批的请求体不超过 limit。
 *
 * 为什么需要：后端 IPC 有 512MB 的请求体上限（防止一个请求把内存吃光）。
 * 用户一次拖 10 个 200MB 进来就是 2GB，base64 后 2.7GB —— 会被直接拒绝。
 * 与其让用户看到「太大了，拆成几批再来」然后自己手动分组，不如这里自动分。
 *
 * **额外收益**：base64 转换也变成逐批进行，内存峰值从「全部文件的 1.33 倍」
 * 降到「单批的 1.33 倍」。10×200MB 场景下这是 2.7GB 和 267MB 的区别。
 *
 * 每个条目的 `outSize` 必须是**最终要传的大小**（压缩/水印之后的），
 * 而不是原文件大小 —— 否则算出来的批次会偏大。
 *
 * @param {Array<{outSize?: number, outName?: string}>} ready
 * @param {number} [limit] 单批请求体上限
 * @returns {Array<{items: Array, bytes: number, bodyBytes: number}>}
 */
export function planBatches(ready, limit = SAFE_BODY) {
  const out = [];
  let items = [];
  let bytes = 0;
  let bodyBytes = JSON_OVERHEAD;

  for (const it of ready) {
    const size = Number(it.outSize) || 0;
    const cost = bodyCost(size, it.outName);

    // 加不进去（且当前批已有东西）就先结掉当前批
    if (items.length && bodyBytes + cost > limit) {
      out.push({ items: items, bytes: bytes, bodyBytes: bodyBytes });
      items = [];
      bytes = 0;
      bodyBytes = JSON_OVERHEAD;
    }

    items.push(it);
    bytes += size;
    bodyBytes += cost;
  }
  if (items.length) out.push({ items: items, bytes: bytes, bodyBytes: bodyBytes });

  // 空队列也给一个空批，调用方不用特判
  return out.length ? out : [{ items: [], bytes: 0, bodyBytes: JSON_OVERHEAD }];
}

/**
 * 分批结果的摘要（给界面显示「将分 4 批上传，最大一批 267 MB」）。
 */
export function formatPlan(batches) {
  if (!batches.length) return '';
  const maxBody = batches.reduce((m, b) => Math.max(m, b.bodyBytes), 0);
  const total = batches.reduce((s, b) => s + b.bytes, 0);
  return {
    count: batches.length,
    totalBytes: total,
    maxBodyBytes: maxBody
  };
}
