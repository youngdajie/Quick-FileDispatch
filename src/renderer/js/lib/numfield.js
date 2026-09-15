/**
 * 数字输入框增强
 *
 * 原生 `input[type=number]` 的上下角标在 Chromium 里是「悬停/聚焦才出现、
 * 位置贴边、样式跟系统走」的，跟本应用的深色扁平风格完全不搭。
 * 这里把它干掉，换成自绘的上下步进按钮（悬停或聚焦时淡入）。
 *
 * 渐进增强：原生 input 始终是唯一的值来源，
 * 步进按钮改完值会派发原生 input + change，
 * 所以既有的监听、自动保存、paintRange 之类都不受影响。
 */

const CHEV_UP =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M2.5 7.5 L6 4 L9.5 7.5" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

const CHEV_DOWN =
  '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true">' +
  '<path d="M2.5 4.5 L6 8 L9.5 4.5" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round"/></svg>';

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function bounds(input) {
  return {
    min: input.hasAttribute('min') ? num(input.getAttribute('min'), -Infinity) : -Infinity,
    max: input.hasAttribute('max') ? num(input.getAttribute('max'), Infinity) : Infinity
  };
}

function syncDisabled(input, steps) {
  const v = num(input.value, 0);
  const { min, max } = bounds(input);
  const up = steps.querySelector('[data-step="up"]');
  const down = steps.querySelector('[data-step="down"]');
  if (up) up.disabled = v >= max;
  if (down) down.disabled = v <= min;
}

/** 按 step 增减一格，并夹在 min/max 之间 */
function nudge(input, dir) {
  const stepAttr = input.getAttribute('step') || '1';
  const step = num(stepAttr, 1) || 1;
  const { min, max } = bounds(input);
  let v = num(input.value, 0) + dir * step;
  v = Math.min(max, Math.max(min, v));
  // 按 step 的小数位数输出，避免 0.1 + 0.2 这类浮点尾巴
  const dec = (String(stepAttr).split('.')[1] || '').length;
  input.value = dec ? v.toFixed(dec) : String(Math.round(v));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

export function enhanceNumber(input) {
  if (!input || input.dataset.nfDone === '1') return null;
  if (input.closest('.numfield')) return null;
  input.dataset.nfDone = '1';

  const wrap = document.createElement('div');
  wrap.className = 'numfield';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  const steps = document.createElement('div');
  steps.className = 'nf-steps';
  steps.innerHTML =
    '<button type="button" class="nf-btn" data-step="up" tabindex="-1" aria-label="增加">' +
    CHEV_UP +
    '</button>' +
    '<button type="button" class="nf-btn" data-step="down" tabindex="-1" aria-label="减少">' +
    CHEV_DOWN +
    '</button>';
  wrap.appendChild(steps);

  steps.addEventListener('click', (e) => {
    const b = e.target.closest('.nf-btn');
    if (!b || b.disabled) return;
    // 输入框外面套着 <label>，不拦一下会顺带触发 label 的默认行为
    e.preventDefault();
    e.stopPropagation();
    nudge(input, b.dataset.step === 'up' ? 1 : -1);
  });

  input.addEventListener('input', () => syncDisabled(input, steps));
  input.addEventListener('change', () => syncDisabled(input, steps));
  // 松手/回车后把空值兜成 0，免得面板上出现空白框
  input.addEventListener('blur', () => {
    if (input.value.trim() === '') {
      const { min } = bounds(input);
      const base = Number.isFinite(min) ? min : 0;
      input.value = String(base);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncDisabled(input, steps);
  });

  syncDisabled(input, steps);
  return wrap;
}

/** 扫描并增强整棵子树里的数字输入框，返回接管的数量 */
export function enhanceNumbers(root) {
  const scope = root || document;
  return Array.from(scope.querySelectorAll('input[type="number"]'))
    .map(enhanceNumber)
    .filter(Boolean).length;
}
