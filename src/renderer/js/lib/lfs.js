/**
 * 「用 LFS 对象存储」开关的共享逻辑。
 *
 * 为什么单独抽出来：主上传页和「上传到此文件夹」mini 弹窗是两套独立的
 * 界面代码，但**这是同一个概念** —— 两处都要按平台显隐、都要记住用户的
 * 选择、都要读出同一个值传给后端。各写一份必然漂移（一边改了另一边忘）。
 *
 * 关于「记住选择」：勾选状态存 localStorage，用户勾过一次之后，
 * 下次打开页面默认就是勾上的。理由是典型的用户旅程 —— 一个仓库要么
 * 一直用 LFS、要么一直不用，每次上传都重新勾一遍纯属折磨。
 */

/** localStorage 的键。主上传页和 mini 共用同一个 —— 在哪儿勾的都算数。 */
const LFS_KEY = 'qfd-use-lfs';

/** 读上次的勾选（默认不勾）。 */
export function lfsRemembered() {
  try {
    return localStorage.getItem(LFS_KEY) === '1';
  } catch (e) {
    return false; // 隐私模式读不了 localStorage
  }
}

/** 记住这次的勾选。 */
export function rememberLfs(on) {
  try {
    localStorage.setItem(LFS_KEY, on ? '1' : '0');
  } catch (e) {
    /* 存不了就算了，不影响功能 */
  }
}

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
 * 按当前平台与记住的状态同步界面。
 *
 * @param {object} cfg 当前配置（state.cfg）
 * @param {{row?: HTMLElement, box?: HTMLElement}} els 要同步的元素
 * @returns {boolean} 当前平台是否支持 LFS
 */
export function syncLfsUI(cfg, els) {
  const supported = isCNBPlatform(cfg);
  if (els && els.row) els.row.hidden = !supported;
  if (supported && els && els.box) {
    // 恢复记住的选择；已经是这个值就不动（避免打断用户正在操作的状态）
    const want = lfsRemembered();
    if (els.box.checked !== want) els.box.checked = want;
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
