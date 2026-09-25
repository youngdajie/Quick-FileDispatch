/**
 * 把文件内容交给主进程时用 base64，不要直接丢 Uint8Array。
 *
 * 坑在哪：这条 IPC 是 HTTP + JSON（Go 壳）。JSON.stringify(Uint8Array)
 * **不会**变成数组，而是变成 {"0":104,"1":105} 这种每字节一个键的对象 ——
 * 一个 50MB 的视频会展开成约 5000 万个数字键、近 400MB 的 JSON：
 * 主线程先卡死在字符串化上，后端再为 5000 万个键逐个 Atoi，内存直接见底。
 * 表现就是「上传失败」，而且文件大小一过几十 MB 必现。
 *
 * 这是 Electron 时代留下的写法：ipcRenderer.invoke 走结构化克隆，TypedArray
 * 原样紧凑传输；换成 JSON-over-HTTP 之后类型就保不住了。
 * base64 只多 33% 体积，而且后端 internal/ipc/cloud.go 的 decodeBytes
 * 本来就认字符串分支（注释里写着「大文件走 base64」）—— 两边对上即可。
 *
 * 用 FileReader 而不是 btoa(String.fromCharCode(...))：
 * 后者要把整个缓冲区拷成 JS 字符串再扫描，50MB 级别会明显卡住界面；
 * FileReader 在浏览器自己的线程里做，主线程不阻塞。
 */

/**
 * ArrayBuffer / Uint8Array → base64 字符串（不带 data: 前缀）。
 * 返回 Promise：读大文件是异步的，别在主线程里等。
 */
export function bytesToBase64(buf) {
  return new Promise((resolve, reject) => {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf || 0);
    if (!u8.length) {
      resolve('');
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      const s = String(fr.result || '');
      const i = s.indexOf(',');
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = () => reject(new Error('读取文件内容失败'));
    fr.readAsDataURL(new Blob([u8]));
  });
}

/** 已经读成 ArrayBuffer 的，顺手转成可直接塞进 IPC payload 的 base64 */
export async function payloadBytes(buf) {
  return bytesToBase64(buf);
}
