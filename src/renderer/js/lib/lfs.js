/**
 * 「用 LFS 对象存储」开关的共享逻辑。
 *
 * 为什么单独抽出来：主上传页和「上传到此文件夹」mini 弹窗是两套独立的
 * 界面代码，但**这是同一个概念** —— 两处都要按平台显隐、都要弹同一句确认、
 * 都要读出同一个值传给后端。各写一份必然漂移（一边改了另一边忘）。
 *
 * 关于「默认不勾」：对象存储里的文件**无法被 jsdmirror 加速**（jsdmirror
 * 走的是仓库 raw 文件，穿透不到对象存储），直链下载也走对象存储。
 * 多数人默认要的是能配 CDN 的普通存储，所以这里**每次打开都默认不勾**，
 * 用户明确要用了才勾，勾的时候弹一句确认把代价讲清楚。
 *
 * 为什么不记住上次的选择：早前做过「记住选择」，结果用户勾过一次 LFS，
 * 之后就一直默认开着 —— 等到发现「这文件怎么 CDN 不生效」已经传了一堆。
 * 代价比「每次重新勾一下」大得多，所以去掉记忆。
 */

import { confirmDialog } from './dom.js';

/**
 * 当前平台是不是 CNB。
 *
 * 只有 CNB 有「对象存储」这个独立计费项（GitHub 走 Git Data API 直接建 blob）。
 * 所以 GitHub 下这个开关**不显示** —— 显示了也勾不动，纯困惑。
 */
export function isCNBPlatform(cfg) {
  return ((cfg && cfg.platform) || 'github') === 'cnb';
}

/**
 * 按当前平台同步界面。LFS **默认不勾**。
 *
 * @param {object} cfg 当前配置（state.cfg）
 * @param {{row?: HTMLElement, box?: HTMLElement}} els 要同步的元素
 * @returns {boolean} 当前平台是否支持 LFS
 */
export function syncLfsUI(cfg, els) {
  const supported = isCNBPlatform(cfg);
  if (els && els.row) els.row.hidden = !supported;
  if (supported && els && els.box) {
    els.box.checked = false;
  }
  return supported;
}

/**
 * 读当前是否要用 LFS。
 *
 * 非 CNB 平台**恒 false** —— 后端也会忽略，但前端先挡住更清楚：
 * 免得将来有人误把它传上去，在 GitHub 上白试一遍。
 */
export function lfsEnabled(cfg, box) {
  if (!isCNBPlatform(cfg)) return false;
  return !!(box && box.checked);
}

/**
 * 勾选 LFS 前的确认。
 *
 * 对象存储的文件有两个代价，用户勾选前得知道：
 *   1. **无法被 jsdmirror 加速** —— jsdmirror 走仓库 raw 文件，穿透不到对象存储
 *   2. 占用对象存储额度（和仓库存储是两笔账）
 *
 * @returns {Promise<boolean>} true = 确认继续（勾上）；false = 放弃（勾选回退）
 */
export async function confirmLfsEnable() {
  const ok = await confirmDialog(
    '用 LFS 对象存储？',
    '文件会存进 CNB 的对象存储（不占仓库额度）。\n\n' +
      '但要注意：对象存储里的文件无法被 jsdmirror 加速，直链下载走对象存储。\n' +
      '如果这些文件要配 CDN 加速，建议不要走 LFS。',
    '继续'
  );
  return ok;
}
