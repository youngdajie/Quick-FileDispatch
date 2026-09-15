/** 把渲染层的异常统一打到控制台，便于自检与排查 */
window.addEventListener('error', (e) => {
  console.error('[window-error] ' + e.message + ' @ ' + e.filename + ':' + e.lineno);
});

window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  console.error('[unhandled-rejection] ' + (r && (r.stack || r.message) ? r.stack || r.message : String(r)));
});
