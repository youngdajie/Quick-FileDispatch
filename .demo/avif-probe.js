'use strict';

/** 一次性探针：确认本机 Electron/Chromium 对 AVIF 的编解码能力 */

const { app, BrowserWindow } = require('electron');

const SCRIPT = `(async () => {
  const out = {};
  const c = new OffscreenCanvas(48, 48);
  const x = c.getContext('2d');
  x.fillStyle = '#3355ff';
  x.fillRect(0, 0, 48, 48);
  x.fillStyle = 'rgba(255,0,0,.5)';
  x.beginPath(); x.arc(24, 24, 14, 0, 7); x.fill();

  // 1) canvas 能否编码 avif
  try {
    const b = await c.convertToBlob({ type: 'image/avif', quality: 0.7 });
    out.encode = { type: b.type, size: b.size, ok: b.type === 'image/avif' && b.size > 0 };
  } catch (e) { out.encode = { ok: false, error: String(e && e.message || e) }; }

  // 2) 编码出来的能不能解码回来
  try {
    const b = await c.convertToBlob({ type: 'image/avif', quality: 0.7 });
    const bm = await createImageBitmap(b);
    out.decode = { ok: true, w: bm.width, h: bm.height };
  } catch (e) { out.decode = { ok: false, error: String(e && e.message || e) }; }

  // 3) WebCodecs 有没有 av01 编码器（备选路线）
  try {
    const s = await VideoEncoder.isConfigSupported({ codec: 'av01.0.04M.08', width: 48, height: 48 });
    out.webcodecs = { supported: !!s.supported };
  } catch (e) { out.webcodecs = { supported: false, error: String(e && e.message || e) }; }

  // 4) 对照组：webp / jpeg 肯定没问题
  try {
    const w = await c.convertToBlob({ type: 'image/webp', quality: 0.7 });
    out.webp = { type: w.type, size: w.size };
  } catch (e) { out.webp = { error: String(e && e.message || e) }; }

  return out;
})()`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 400,
    height: 300,
    webPreferences: { offscreen: true, sandbox: false }
  });
  try {
    await win.loadURL('data:text/html,<html><body>probe</body></html>');
    const res = await win.webContents.executeJavaScript(SCRIPT, true);
    console.log('AVIF_PROBE ' + JSON.stringify(res, null, 2));
  } catch (e) {
    console.log('AVIF_PROBE_FAILED ' + (e && e.message));
  }
  app.exit(0);
});
