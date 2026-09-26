/**
 * 上传流程的共享实现。
 *
 * 主上传页（pages/upload.js）和「上传到此文件夹」mini 弹窗（lib/upload-mini.js）
 * **只有这一套上传流程**，两处的差异全部通过回调注入（各自怎么更新自己的列表）。
 *
 * 为什么必须共用，而不是各写一份：
 * 这两个入口对用户来说是**同一件事** —— 都是「把文件传到这个仓库」。
 * 流程上任何一处偏差都是 bug，而且是最难发现的那种（要两边都试一遍
 * 才看得出来）。实际踩过的：
 *   - 一边有实时进度条、另一边没有
 *   - 一边提示「本地目录已同步」、另一边默默跳过
 * 共享之后这类偏差从「靠人记得同步改」变成「结构上不可能发生」。
 *
 * 这里**不放任何 UI 文案和 DOM 结构**（除了必要的状态词）——
 * 那些恰恰是两处应该不同的部分。
 */

import { bytesToBase64 } from './bytes.js';
import {
  openProgressStream,
  describe as describeProgress,
  fmtBytes,
  fmtSpeed,
  fmtEta
} from './progress.js';
import { toast, warn } from './dom.js';
// 分批的算术在 upload-batch.js（纯计算、无 DOM，可被 Node 直接单测）
import { planBatches } from './upload-batch.js';

/* ============================================================ 分批 */

/* ============================================================ 进度 */

/**
 * 打开进度条并订阅后端进度事件。
 *
 * **分批时的关键**：后端每个批次都从 0% 报起，直接显示的话进度条会
 * 「0→100% → 0→100%」来回跳，看起来像卡了又重来。所以这里维护一个
 * base（本批之前已完成的字节），把「本批字节」换算成「全局字节」
 * 再算百分比 —— 进度条就单调递增。
 *
 * @param {{prog:string, bar:string, label:string, detail:string, pct:string}} ids
 * @param {number} grandTotal 全部文件的总字节（用于算全局百分比）
 * @returns {{end: () => void, setBase: (bytes:number, idx?:number, count?:number) => void}}
 */
export function startProgressBar(ids, grandTotal) {
  const el = (id) => (id ? document.getElementById(id) : null);
  const prog = el(ids.prog);
  const bar = el(ids.bar);
  const label = el(ids.label);
  const detail = el(ids.detail);
  const pct = el(ids.pct);

  /** 本批之前已完成的字节 */
  let base = 0;
  /** 批次标记（如 "2/4"），只有多批时才显示 */
  let batchTag = '';

  const paint = (percent, determinate, labelText, detailText) => {
    if (label && labelText !== undefined) label.textContent = labelText;
    if (detail && detailText !== undefined) detail.textContent = detailText;
    if (!bar) return;
    if (determinate) {
      bar.classList.remove('indeterminate');
      bar.style.width = Math.max(0, Math.min(100, percent)) + '%';
      if (pct) pct.textContent = Math.round(percent) + '%';
    } else {
      // 后端还没算出总量（git 正在枚举对象）→ 不确定态。
      // 硬画一个 0% 会让人以为卡住了。
      bar.classList.add('indeterminate');
      bar.style.width = '100%';
      if (pct) pct.textContent = '';
    }
  };

  if (!prog) {
    return { end: () => {}, setBase: () => {} };
  }

  prog.hidden = false;
  paint(0, true, '准备上传…', '');

  const stopStream = openProgressStream((ev) => {
    if (ev.task !== 'upload') return;
    const d = describeProgress(ev);

    // 多批时给阶段词加批次后缀，用户才知道「为什么又从头开始了」
    const labelText = batchTag ? d.label + ' · 第 ' + batchTag + ' 批' : d.label;

    if (grandTotal > 0 && ev.total > 0) {
      // 全局进度：本批已完成的基准 + 本批内的进度
      const globalBytes = Math.min(grandTotal, base + ev.bytes);
      const percent = (globalBytes / grandTotal) * 100;
      const parts = [fmtBytes(globalBytes) + ' / ' + fmtBytes(grandTotal)];
      const sp = fmtSpeed(ev.speed);
      if (sp) parts.push(sp);
      const eta = fmtEta(globalBytes, grandTotal, ev.speed);
      if (eta) parts.push(eta);
      paint(percent, true, labelText, parts.join(' · '));
      return;
    }

    // 拿不到总量（单文件、后端没算出 total）→ 交给原逻辑
    paint(d.determinate ? d.percent : 0, d.determinate, labelText, d.detail);
  });

  return {
    setBase(bytes, idx, count) {
      base = Number(bytes) || 0;
      batchTag = count > 1 && idx ? idx + '/' + count : '';
    },
    end() {
      stopStream();
      // 留一点时间让「已完成 100%」被看见
      setTimeout(() => {
        prog.hidden = true;
      }, 700);
    }
  };
}

/* ============================================================ 同步提示 */

/**
 * 把「本地目录同步」的结果告诉用户。
 *
 * 三种情况都要有反馈。特别是 **skipped**：用户在设置里关掉了「自动拉取」
 * 时，云端传上去了但本地目录不会更新 —— 用户接着去文件管理页找刚传的文件，
 * 找不到，以为上传失败了。不提示就等于让用户自己猜。
 *
 * （别的 skip 原因 —— 没绑本地目录、目录不是 git 仓库 —— 用户本来就知道，
 * 提示反而啰嗦，所以只挑「关了自动拉取」这一种说。）
 */
export function notifySync(sync) {
  if (!sync) return;
  if (sync.skipped) {
    if (sync.message && sync.message.indexOf('未启用') >= 0) {
      toast('已上传到云端。本地目录未同步（设置里关掉了自动拉取）', 'warn');
    }
    return;
  }
  if (sync.ok) toast('本地目录已同步：' + sync.message, 'ok');
  else warn('云端已更新，但本地同步失败：' + sync.message);
}

/* ============================================================ 主流程 */

/**
 * 执行一次上传 —— 两个上传入口**唯一的**上传路径。
 *
 * 做完整条链路：分批 → 逐批转 base64 → 开进度 → 调接口 → 结果映射到条目
 * → 同步提示 → 广播「仓库变了」。
 *
 * **分批是串行的**，不是并发：每批独立提交（CNB 走 git push 就是一次提交），
 * 并发推同一个分支会互相打架。而且进度条也只有在串行时才有意义。
 *
 * @param {object} o
 * @param {Array}   o.ready       待上传条目（须有 outBuffer / outName / outSize）
 * @param {string}  o.dir         仓库内目标目录
 * @param {boolean} o.useLFS      是否走 LFS 对象存储
 * @param {object} [o.progressIds] 进度条元素 id（不传则不显示进度条）
 * @param {(it, r:{ok:boolean,path?:string,error?:string}) => void} o.onItem
 * @param {() => void} [o.onSummary] 每批结束后刷新统计
 * @param {(items:Array, idx:number, count:number) => void} [o.onBatch]
 *        一批开始前的回调（调用方用它把该批条目标成「上传中」）
 * @returns {Promise<object>} 汇总结果
 */
export async function runUpload(o) {
  const { ready, dir, useLFS, progressIds, onItem, onSummary, onBatch } = o;

  const batches = planBatches(ready);
  const grandTotal = batches.reduce((s, b) => s + b.bytes, 0);

  const pb = progressIds ? startProgressBar(progressIds, grandTotal) : { end: () => {}, setBase: () => {} };

  let uploaded = 0;
  let failed = 0;
  let lastSync = null;
  let stoppedAt = -1; // 因传输失败中断的批次下标

  try {
    let doneBytes = 0;

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      if (batch.items.length === 0) continue;

      // 切到这一批：进度基准 = 之前所有批次的字节
      pb.setBase(doneBytes, i + 1, batches.length);
      if (onBatch) onBatch(batch.items, i + 1, batches.length);

      // 只转这一批的 base64 —— 内存峰值由此降到「单批」而非「全部」
      const files = [];
      for (const it of batch.items) {
        const data = await bytesToBase64(it.outBuffer);
        it.outBuffer = null; // 立刻释放原始 buffer
        files.push({ name: it.outName, data: data });
      }

      let res;
      try {
        res = await window.cloudpic.cloud.upload({
          files: files,
          dir: dir,
          useLFS: !!useLFS
        });
      } catch (e) {
        // 传输层失败（网络断、认证过期、超时）：后续批次不传了 ——
        // 接着传也只会同样失败，还让用户多等。
        stoppedAt = i;
        const msg = e.message || String(e);
        for (const it of batch.items) onItem(it, { ok: false, error: msg });
        if (onSummary) onSummary();
        throw e;
      }

      // 业务结果（某个文件太大等）：只影响这一批，继续传后面的
      const byName = new Map();
      (res.results || []).forEach((r) => byName.set(r.name, r));
      for (const it of batch.items) {
        const r = byName.get(it.outName);
        if (r && r.ok) {
          uploaded++;
          onItem(it, { ok: true, path: r.path });
        } else {
          failed++;
          onItem(it, { ok: false, error: (r && r.error) || '上传失败' });
        }
      }
      if (res.sync) lastSync = res.sync;
      doneBytes += batch.bytes;
      if (onSummary) onSummary();

      // 一批传完，把进度基准推到这一批的末尾，进度条紧接着走下一批
      pb.setBase(doneBytes, i + 1, batches.length);
    }

    // 所有批都跑完了才算「无可续传」
    stoppedAt = batches.length;

    notifySync(lastSync);
    window.dispatchEvent(new CustomEvent('cloudpic:changed'));

    return {
      ok: uploaded > 0,
      uploaded: uploaded,
      failed: failed,
      sync: lastSync,
      batches: batches.length,
      stoppedAt: stoppedAt
    };
  } finally {
    // 一定收尾 —— 中途抛错也要关掉 SSE 订阅，
    // 不然每失败一次就漏一个订阅（服务端那个通道要等页面关才回收）。
    pb.end();
  }
}

/**
 * 生成上传结果的提示语 —— 两个入口的措辞必须一致。
 *
 * @param {object} res runUpload 的返回
 * @param {string} unit '张'（上传页说「张」）| '个'（mini 说「个」）
 */
export function uploadResultMessage(res, unit) {
  const batchNote = res.batches > 1 ? '（分 ' + res.batches + ' 批）' : '';

  if (res.uploaded) {
    return {
      ok: true,
      text:
        '成功上传 ' + res.uploaded + ' ' + unit +
        (res.failed ? '，失败 ' + res.failed + ' ' + unit : '') +
        batchNote
    };
  }
  return { ok: false, text: '上传失败，请查看结果里的错误信息' + batchNote };
}
