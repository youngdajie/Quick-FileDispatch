/**
 * 毛玻璃智能自适应算法
 *
 * ⚠️ 本算法有两份**必须保持一致**的副本：
 *     - src/renderer/js/lib/glass-adaptive.js —— 程序运行时用
 *     - tools/glass-adaptive.js               —— 独立 demo 用
 *       （demo 要能单独复制给别人打开，所以不做成反向依赖 src/）
 *    改完任何一份，请把内容拷到另一份：
 *        cp src/renderer/js/lib/glass-adaptive.js tools/glass-adaptive.js
 *
 * 设计原则：
 *   1. 算法做"决策"，不做"覆盖" —— 用户随时可以拖滑块关掉算法。
 *   2. 玻璃参数 + 文字参数一起算（不要分两步） —— 暗图加大白纱的同时
 *      加深文字颜色，两者联动才有"自然"的感觉。
 *   3. 不用 fixed thresholds，用连续曲线 —— 亮度从 0.4 到 0.6 平滑过渡。
 *
 * 算法核心：避免"发白/发灰/对比度不足"三大常见毛玻璃问题：
 *   - 发白：白纱太厚 + saturate(1.5) → 调整：根据原图亮度动态选 saturate
 *   - 发灰：saturate(1.0) + 厚白纱 → 调整：高对比图（夜景）保持薄白纱
 *   - 对比度不足：图片和文字颜色太接近 → 调整：色偏 + 亮度联合选文字颜色
 *
 * 三个对外函数：
 *   - analyzeImage(img) → 分析结果（亮度/饱和度/对比度/色偏）
 *   - computeAdaptive(analysis) → 推荐参数（玻璃/文字）
 *   - applyAdaptive(params) → 写入 CSS 变量
 *
 * 同时导出 inferTextStyle(params, analysis) 用于手动模式下的文字风格推断。
 */

// ============================================================
// 像素采样：多点 + 小窗口平均（对噪点更鲁棒）
// ============================================================

/**
 * 在 9 个网格点上各取 1px（图像缩到 9x9，平均后变一个像素）。
 * 比多点 + 平均更高效，且对 9x9 来说本身就隐含了局部平均。
 */
function sample9(img) {
  const c = document.createElement('canvas');
  // 缩小到 9x9：省内存 + 性能 + 抗噪
  c.width = 9; c.height = 9;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 9, 9);
  const d = g.getImageData(0, 0, 9, 9).data;
  const samples = [];
  for (let i = 0; i < d.length; i += 4) {
    samples.push({ r: d[i], g: d[i + 1], b: d[i + 2] });
  }
  return samples;
}

/**
 * 中心点 RGB（更小窗口 = 更细节）。
 * 用于"中心是脸/标志"等特殊场景的微调。
 */
function sampleCenter(img) {
  const c = document.createElement('canvas');
  c.width = 3; c.height = 3;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(img, 0, 0, 3, 3);
  const d = g.getImageData(0, 0, 3, 3).data;
  let r = 0, gC = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) {
    r += d[i]; gC += d[i + 1]; b += d[i + 2]; n++;
  }
  return { r: r / n, g: gC / n, b: b / n };
}

// ============================================================
// 指标计算
// ============================================================

/**
 * 感知亮度（Rec. 709）：
 *   Y = 0.2126 R + 0.7152 G + 0.0722 B
 * 比简单的 (R+G+B)/3 更接近人眼（绿色权重高）。
 */
function luminance({ r, g, b }) {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * HSV 饱和度：
 *   S = (max - min) / max  (max > 0)
 */
function saturation({ r, g, b }) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx === 0) return 0;
  return (mx - mn) / mx;
}

/**
 * 局部对比度（C = std(亮度)）：
 * 高对比 = 文字背景差异大，玻璃可以薄一点（保留层次）
 * 低对比 = 画面"一片糊"，玻璃要厚一点 + 加深文字
 */
function contrast(samples) {
  const lums = samples.map(luminance);
  const mean = lums.reduce((a, b) => a + b, 0) / lums.length;
  const variance = lums.reduce((s, l) => s + (l - mean) ** 2, 0) / lums.length;
  return Math.sqrt(variance);
}

/**
 * 色彩倾向（warm / cool / neutral / green）：
 * - R 主导 → 暖（橙/红/黄）
 * - B 主导 → 冷（蓝/青）
 * - G 主导 → 绿色（自然/植物）
 * - 几乎相等 → 中性（灰、白）
 */
function colorBias(samples) {
  const avg = samples.reduce((acc, s) => ({
    r: acc.r + s.r, g: acc.g + s.g, b: acc.b + s.b,
  }), { r: 0, g: 0, b: 0 });
  const n = samples.length;
  avg.r /= n; avg.g /= n; avg.b /= n;
  // 计算 R-B 差：正 = 暖，负 = 冷
  const warmth = (avg.r - avg.b) / 255;
  if (warmth > 0.08) return 'warm';
  if (warmth < -0.08) return 'cool';
  // G 占比高（绿色）单独识别
  if (avg.g > avg.r * 1.1 && avg.g > avg.b * 1.1) return 'green';
  return 'neutral';
}

// ============================================================
// 公共 API
// ============================================================

/**
 * 分析一张图，返回多维特征。
 *
 * @param {HTMLImageElement} img
 * @returns {{
 *   lum: number,         // 0-1，整体亮度
 *   sat: number,         // 0-1，色彩饱和度
 *   contrast: number,    // 0-1+，局部对比度（标准差）
 *   colorBias: string,   // 'warm' | 'cool' | 'neutral' | 'green'
 *   center: {r,g,b},     // 中心点 RGB（用于更精细的判断）
 * }}
 */
export function analyzeImage(img) {
  let samples, center;
  try {
    samples = sample9(img);
    center = sampleCenter(img);
  } catch (e) {
    // 跨域或读不到像素（Canvas 污染） → 返回中性默认值
    return { lum: 0.5, sat: 0.3, contrast: 0.1, colorBias: 'neutral', center: { r: 128, g: 128, b: 128 } };
  }
  const lum = luminance(samples.reduce((acc, s) => ({
    r: acc.r + s.r, g: acc.g + s.g, b: acc.b + s.b,
  }), { r: 0, g: 0, b: 0 })) / samples.length;
  return {
    lum,
    sat: samples.reduce((acc, s) => acc + saturation(s), 0) / samples.length,
    contrast: contrast(samples),
    colorBias: colorBias(samples),
    center,
  };
}

/**
 * 根据分析结果计算推荐参数。
 *
 * 核心规则（详细原因见文档头）：
 *
 *   1. 偏暗图（lum < 0.4）：
 *      - 模糊度加强（16-20px） → 洗平噪点
 *      - 白纱浓度提高（0.6-0.7） → 让面板"光"起来
 *      - 饱和度降低（1.0-1.1） → 防止过度饱和发光
 *      - 文字加重 + 白色微光晕 → 暗背景下清晰
 *
 *   2. 偏亮图（lum > 0.7）：
 *      - 模糊度中等（10-14） → 不要太糊
 *      - 白纱薄（0.30-0.40） → 保持亮度
 *      - 饱和度提高（1.30-1.40） → 防止发白
 *      - 文字常规 + 深色 → 浅色下文字本来就清晰
 *
 *   3. 中等图（0.4 ≤ lum ≤ 0.7）：
 *      - 全部中等值
 *
 *   4. 高对比（contrast > 0.25，如夜景）：
 *      - 白纱不要厚（保留层次）
 *      - 模糊度弱一点（图片本身有结构，糊太多会丢细节）
 *
 *   5. 暖色图（colorBias = 'warm'）：
 *      - 白纱 +5%（暖色需要更厚的中和到中性灰白）
 *
 *   6. 冷色图（colorBias = 'cool'）：
 *      - 白纱 -5%（冷图偏蓝，中和后容易变灰）
 */
export function computeAdaptive(a) {
  const { lum, contrast: ctr, colorBias: bias } = a;

  // 1. 模糊度（0-24px）：暗图糊，明图薄
  let blur;
  if (lum < 0.3) blur = 20;
  else if (lum < 0.5) blur = 16;
  else if (lum < 0.7) blur = 12;
  else blur = 10;
  // 高对比图：再弱一点（保留图片结构感）
  if (ctr > 0.25) blur = Math.max(blur - 3, 8);

  // 2. 白纱浓度（0-1）：决定面板"亮度"，暗图要厚
  let tint;
  if (lum < 0.3) tint = 0.70;
  else if (lum < 0.5) tint = 0.60;
  else if (lum < 0.7) tint = 0.45;
  else tint = 0.35;
  // 高对比图：薄一点保留层次
  if (ctr > 0.25) tint = Math.max(tint - 0.10, 0.30);
  // 色偏校正
  if (bias === 'warm') tint = Math.min(tint + 0.05, 0.85);
  if (bias === 'cool') tint = Math.max(tint - 0.05, 0.25);

  // 3. 饱和度增强（CSS saturate() 1.0 = 不变）
  //    暗图：低饱和，避免暗色被洗亮
  //    亮图：高饱和，防止发白
  let saturate;
  if (lum < 0.4) saturate = 1.05;
  else if (lum < 0.7) saturate = 1.20;
  else saturate = 1.35;

  // 4. 文字颜色：始终用深色（白纱压后画面偏白）
  //    但根据原图亮度微调（暗原图 → 更深 + 阴影；亮原图 → 中深）
  let textColor, textShadow, fontWeight;
  if (lum < 0.4) {
    // 原图暗：白纱不足以压到全白 → 文字加重 + 加白色微光晕
    textColor = '#0a1322';
    textShadow = '0 1px 1.5px rgba(255,255,255,0.5), 0 0 8px rgba(255,255,255,0.25)';
    fontWeight = 600;
  } else if (lum < 0.7) {
    textColor = '#16202e';
    textShadow = 'none';
    fontWeight = 500;
  } else {
    // 原图亮：白纱后画面接近白 → 文字深 + 粗细正常
    textColor = '#0d1726';
    textShadow = 'none';
    fontWeight = 400;
  }
  // 字距：暗背景下字距略宽，让字呼吸（提高可读性）
  const textTracking = lum < 0.5 ? 0.2 : 0;

  // 四舍五入到合理精度
  return {
    blur: Math.round(blur * 2) / 2,
    tint: Math.round(tint * 100) / 100,
    saturate: Math.round(saturate * 100) / 100,
    textColor,
    textShadow,
    textTracking,
    fontWeight,
  };
}

/**
 * 把参数应用到 CSS 变量。
 *
 * 变量分两组：
 *   - 玻璃参数：--blur / --tint / --saturate（CSS 实时消费）
 *   - 文字参数：--text-color / --text-weight / --text-shadow / --text-tracking
 *
 * 调用方必须已经确保文档上有目标元素（这里是 :root）。
 */
export function applyAdaptive(p) {
  const root = document.documentElement;
  root.style.setProperty('--blur', p.blur + 'px');
  root.style.setProperty('--tint', String(p.tint));
  root.style.setProperty('--saturate', String(p.saturate));
  root.style.setProperty('--text-color', p.textColor);
  root.style.setProperty('--text-weight', String(p.fontWeight));
  root.style.setProperty('--text-shadow', p.textShadow);
  root.style.setProperty('--text-tracking', String(p.textTracking));
}

/**
 * 给 input[type=range] 设置 --fill CSS 变量，让已填充部分显示进度色。
 * 与 dom.js 的 paintRange 同源，独立出来方便 demo 直接 import。
 */
export function paintRange(el) {
  if (!el || el.type !== 'range') return;
  const min = Number(el.min || 0);
  const max = Number(el.max || 100);
  const v = Number(el.value || 0);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--fill', Math.max(0, Math.min(100, pct)).toFixed(2) + '%');
}

/**
 * 手动模式下：根据滑块值 + 原图分析推断文字样式。
 *
 * 为什么需要：用户拖滑块时关掉算法，但玻璃参数（blur/tint）由用户决定后，
 * 文字颜色不应该跟着不变 —— tint 提高（白纱更厚 → 画面更白）时文字
 * 应该更深，否则会发糊。
 *
 * 启发式：以 tint 为主驱动，lum 辅助判断
 */
export function inferTextStyle(p, analysis) {
  if (!analysis) {
    return {
      textColor: '#16202e',
      textShadow: 'none',
      textTracking: 0,
      fontWeight: p.fontWeight || 400,
    };
  }
  const { lum } = analysis;
  // 用白纱浓度决定文字深浅：白纱越厚 → 文字越深
  // 临界点 0.45 是经验值：薄纱（<0.45）下文字常规；厚纱（>=0.45）下文字加深
  let textColor, textShadow, fontWeight;
  if (p.tint >= 0.55 || lum < 0.4) {
    textColor = '#0a1322';
    textShadow = '0 1px 1.5px rgba(255,255,255,0.5), 0 0 8px rgba(255,255,255,0.25)';
    fontWeight = p.fontWeight || 600;
  } else if (p.tint >= 0.40 || lum < 0.7) {
    textColor = '#16202e';
    textShadow = 'none';
    fontWeight = p.fontWeight || 500;
  } else {
    textColor = '#0d1726';
    textShadow = 'none';
    fontWeight = p.fontWeight || 400;
  }
  const textTracking = lum < 0.5 ? 0.2 : 0;
  return { textColor, textShadow, textTracking, fontWeight };
}