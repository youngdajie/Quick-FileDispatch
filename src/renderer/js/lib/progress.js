/**
 * 上传进度订阅（SSE 客户端）。
 *
 * 后端的 /ipc/events 是一条 SSE 流，把上传过程实时推过来。这里只做三件事：
 *   1. 包一层 EventSource，把 JSON 解析掉；
 *   2. 提供几个格式化工具（字节 / 速度 / 剩余时间）；
 *   3. 失败了安静降级 —— 进度条是锦上添花，连不上不能让上传本身出问题。
 *
 * 为什么用 EventSource 而不是 fetch + ReadableStream：
 * EventSource 自带断线重连（浏览器行为，不用写代码），而且这里只需要
 * 单向接收。fetch 流要自己处理重连、分帧、粘包，代码量翻几倍。
 * 代价是它不能带自定义头 —— 我们也不需要（鉴权在本地环回，不经过网络）。
 */

/** 阶段 → 中文文案。与 internal/progress/hub.go 的常量一一对应。 */
const PHASE_TEXT = {
  prepare: '准备中',
  lfs: '准备 LFS',
  upload: '上传中',
  commit: '提交中',
  done: '已完成',
  error: '失败'
};

/** 取阶段的中文名（未知阶段原样返回，方便排查）。 */
export function phaseText(phase) {
  return PHASE_TEXT[phase] || phase || '';
}

/**
 * 打开进度流。
 *
 * @param {(ev: object) => void} onEvent 每条进度事件回调
 * @returns {() => void} 关闭函数（务必在离开页面 / 上传结束时调用）
 */
export function openProgressStream(onEvent) {
  let es;
  try {
    es = new EventSource('/ipc/events');
  } catch (e) {
    // 环境不支持 EventSource（理论上不会，WebView2 是 Chromium）
    return () => {};
  }

  es.onmessage = (e) => {
    let data;
    try {
      data = JSON.parse(e.data);
    } catch (err) {
      return; // 心跳注释行不会走到这里（注释不触发 message），真到了就丢弃
    }
    try {
      onEvent(data);
    } catch (err) {
      /* 回调自己出错不要连累流 */
    }
  };

  // 不写 onerror 的处理逻辑：EventSource 规范里网络断了会自动重连，
  // 自己再写一套重连反而会打架。服务端返回 503（未启用进度）时
  // 它也会一直重试，但那是本地环回，开销可以忽略。
  es.onerror = () => {};

  return () => {
    try {
      es.close();
    } catch (e) {
      /* ignore */
    }
  };
}

/** 字节 → 人读的字符串（复用 UMD 共享的 formatBytes，保证与别处一致）。 */
export function fmtBytes(n) {
  const CPLinks = window.CPLinks;
  if (CPLinks && typeof CPLinks.formatBytes === 'function') {
    return CPLinks.formatBytes(n);
  }
  // 兜底（CPLinks 没加载时）：1024 进制、两位小数
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i++;
  }
  return (x >= 10 ? x.toFixed(1) : x.toFixed(2)) + ' ' + units[i];
}

/** 速度 → "2.1 MB/s" */
export function fmtSpeed(bytesPerSec) {
  const v = Number(bytesPerSec) || 0;
  if (v <= 0) return '';
  return fmtBytes(v) + '/s';
}

/**
 * 剩余时间 → "约 12 秒" / "约 2 分 30 秒"。
 * total / done 任一为 0 时返回空串（无法估算）。
 */
export function fmtEta(done, total, speed) {
  const d = Number(done) || 0;
  const t = Number(total) || 0;
  const s = Number(speed) || 0;
  if (t <= 0 || d <= 0 || s <= 0 || d >= t) return '';
  const secs = Math.round((t - d) / s);
  if (secs < 1) return '即将完成';
  if (secs < 60) return '约 ' + secs + ' 秒';
  const m = Math.floor(secs / 60);
  const r = secs % 60;
  if (m < 60) return '约 ' + m + ' 分' + (r > 0 ? ' ' + r + ' 秒' : '');
  const h = Math.floor(m / 60);
  return '约 ' + h + ' 小时 ' + (m % 60) + ' 分';
}

/**
 * 把一条进度事件压成进度条要显示的两行文案。
 *
 * 第二行（细节）在信息不足时会**退化成空串**，而不是硬凑
 * 「0 B / 0 B · 0 B/s」那种一看就是程序没算出来的东西。
 */
export function describe(ev) {
  const pct = typeof ev.percent === 'number' ? ev.percent : -1;
  const head = phaseText(ev.phase);
  const parts = [];
  if (ev.total > 0) {
    parts.push(fmtBytes(ev.bytes) + ' / ' + fmtBytes(ev.total));
  } else if (ev.bytes > 0) {
    parts.push(fmtBytes(ev.bytes));
  }
  const sp = fmtSpeed(ev.speed);
  if (sp) parts.push(sp);
  const eta = fmtEta(ev.bytes, ev.total, ev.speed);
  if (eta) parts.push(eta);

  return {
    // 阶段文案优先用后端给的 message（如「正在安装 git-lfs…」）
    label: ev.message || head,
    // 百分比为负 = 后端没算出来，前端显示不确定态
    percent: pct,
    determinate: pct >= 0,
    detail: parts.join(' · ')
  };
}
