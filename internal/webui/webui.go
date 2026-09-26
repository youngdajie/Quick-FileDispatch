// Package webui 把渲染层和通道表拼成一个 http.Handler。
//
// Electron 版里，「静态资源怎么给渲染层」这件事由 Chromium 自己完成
// （loadFile / 自定义协议），主进程另外起一个 127.0.0.1 服务专门给
// 本地图片和远程缩略图（src/main/server.js，159 行）。
//
// Go 版把两件事合成一件：静态资源也从同一个 127.0.0.1 出，
// 于是渲染层那边的相对路径、绝对路径（/css/app.css、/js/app.js）全都不变。
package webui

import (
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/ipc"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/progress"
)

// bridgeTag 是注入点：垫片必须在所有渲染层脚本之前跑起来。
// 插在 </head> 前面而不是 </body> 前面，是因为渲染层有一堆 <script type="module">，
// 模块默认 defer；插在 </body> 虽然也来得及，但「垫片在最后」这件事以后很容易被
// 误改坏（有人加一个非 module 的脚本就炸），插在 head 里没有这个隐患。
const bridgeTag = `<script src="/bridge.js"></script>`

type handler struct {
	reg    *ipc.Registry
	static fs.FS
	bridge []byte
	// allows 判断某个绝对路径能不能被 /__local 读出来。
	// 传函数而不是字符串：切配置 / 绑新目录之后要立刻生效，不能缓存。
	allows func(abs string) bool
	// remote 抓远程仓库里的文件字节（私有仓库预览要用：Token 只留在后端）。
	// 为 nil 时 /__remote 直接 503 —— 那时还没配好仓库，属正常状态。
	remote func(rel string) ([]byte, string, error)
	files  http.Handler

	// progress 是上传进度的广播中心（SSE 推送源）。为 nil 时
	// /ipc/events 返回 503，前端会安静地退回「无进度条」模式。
	progress *progress.Hub

	// 未实现的通道只提醒一次，否则界面上点几下就是满屏重复日志
	notified sync.Map
}

// New 组装路由。
//
// allows 决定 /__local 能读哪些路径；remote 给 /__remote 提供内容。
// 两个都不能为 nil —— 前者是安全边界，后者缺失会让私有仓库的缩略图全部 404。
// hub 是上传进度中心，可以为 nil（自检 / 无界面场景）。
func New(reg *ipc.Registry, static fs.FS, bridge []byte,
	allows func(string) bool,
	remote func(rel string) ([]byte, string, error),
	hub *progress.Hub) http.Handler {
	// Go 自带的 MIME 表认不出 avif / wasm，不补的话浏览器会按
	// application/octet-stream 处理，wasm 直接不给实例化
	_ = mime.AddExtensionType(".avif", "image/avif")
	_ = mime.AddExtensionType(".wasm", "application/wasm")
	_ = mime.AddExtensionType(".webp", "image/webp")

	h := &handler{
		reg:      reg,
		static:   static,
		bridge:   bridge,
		allows:   allows,
		remote:   remote,
		progress: hub,
		files:    http.FileServerFS(static),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/ipc", h.ipc)
	mux.HandleFunc("/ipc/events", h.events)
	mux.HandleFunc("/bridge.js", h.bridgeJS)
	mux.HandleFunc("/__local", h.localFile)
	mux.HandleFunc("/__remote", h.remoteFile)
	mux.HandleFunc("/", h.front)
	return mux
}

/* ------------------------------------------------------------ SSE */

// events 是上传进度的 SSE 推送端点。
//
// 为什么用 SSE 而不是 WebSocket / 轮询：
//   - 进度是**单向**的（只有后端知道在传什么），SSE 天生匹配，
//     不需要 WebSocket 那套双向握手和帧协议；
//   - Go 标准库用 http.ResponseController.Flush 就能推，零第三方依赖
//     （本项目从 Electron 改成 Go 的初衷之一就是把依赖压到零）；
//   - 浏览器 EventSource 自带断线重连，前端不用写重连逻辑。
//
// 轮询也能做，但要么延迟大（500ms 一次还是卡），要么把服务端打满。
func (h *handler) events(w http.ResponseWriter, r *http.Request) {
	hub := h.progress
	if hub == nil {
		http.Error(w, "进度通道未启用", http.StatusServiceUnavailable)
		return
	}

	// SSE 的三个必要头。
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	// 给可能存在的反向代理看：不要缓冲这条响应，否则事件会被攒着不发。
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	rc := http.NewResponseController(w)
	// 先冲一次，让 EventSource 尽快进入 open 状态（否则前端会以为没连上）。
	if err := rc.Flush(); err != nil {
		return
	}

	ch, cancel := hub.Subscribe()
	defer cancel()

	// 心跳：每 20 秒发一行注释。没有它，中间任何一层（代理、系统防火墙）
	// 都可能因为「长时间无数据」把连接掐掉，表现为进度条时断时续。
	// 心跳用 SSE 的注释语法（以 : 开头），浏览器会忽略，不影响事件流。
	heartbeat := time.NewTicker(20 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			// 页面关了 / 刷新了 —— 必须走到这里，否则 Subscribe 的
			// 通道会一直挂着，每刷新一次漏一个。
			return

		case e, ok := <-ch:
			if !ok {
				return
			}
			if !writeSSE(w, rc, e) {
				return
			}

		case <-heartbeat.C:
			if _, err := io.WriteString(w, ": ping\n\n"); err != nil {
				return
			}
			if err := rc.Flush(); err != nil {
				return
			}
		}
	}
}

// writeSSE 按 SSE 格式写一条事件，写完立刻 Flush。
// 返回 false 表示连接已经断了，调用方该退出。
//
// 格式是 `data: <json>\n\n` —— json.Encoder 自带一个换行，
// 所以还需要补一个空行，否则浏览器不会派发这条事件（SSE 以空行分隔消息）。
func writeSSE(w io.Writer, rc *http.ResponseController, e progress.Event) bool {
	if _, err := io.WriteString(w, "data: "); err != nil {
		return false
	}
	enc := json.NewEncoder(w)
	if err := enc.Encode(e); err != nil {
		return false
	}
	if _, err := io.WriteString(w, "\n"); err != nil {
		return false
	}
	return rc.Flush() == nil
}

// front 处理静态资源；只有首页需要特殊对待（要注入垫片）。
func (h *handler) front(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/" || r.URL.Path == "/index.html" {
		h.index(w, r)
		return
	}
	// 开发期别让浏览器缓存住旧文件，不然改一行 JS 得手动强刷
	w.Header().Set("Cache-Control", "no-cache")
	h.files.ServeHTTP(w, r)
}

func (h *handler) index(w http.ResponseWriter, r *http.Request) {
	raw, err := fs.ReadFile(h.static, "index.html")
	if err != nil {
		http.Error(w, "找不到 index.html："+err.Error(), http.StatusInternalServerError)
		return
	}
	html := string(raw)
	if !strings.Contains(html, bridgeTag) {
		if i := strings.Index(html, "</head>"); i >= 0 {
			html = html[:i] + bridgeTag + "\n" + html[i:]
		} else {
			// 没有 </head> 就别猜位置了，宁可报出来
			http.Error(w, "index.html 里找不到 </head>，垫片注入点失效", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write([]byte(html))
}

func (h *handler) bridgeJS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	_, _ = w.Write(h.bridge)
}

/* ------------------------------------------------------------ IPC */

// maxIPCPayloadBytes：单个 IPC 请求体的上限（见 ipc 里的说明）。
const maxIPCPayloadBytes = 512 << 20 // 512MB

type ipcRequest struct {
	Channel string          `json:"channel"`
	Payload json.RawMessage `json:"payload"`
}

type ipcResponse struct {
	OK    bool   `json:"ok"`
	Data  any    `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
}

// ipc 是渲染层唯一的后端入口，对应 Electron 的 ipcRenderer.invoke。
//
// 一律回 HTTP 200：传输层成功不等于业务成功，失败放在 body 的 ok=false 里。
// 用状态码表达业务失败会让前端的 fetch 和业务错误缠在一起，
// 一个 500 分不清是「通道没实现」还是「服务崩了」。
func (h *handler) ipc(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "只接受 POST", http.StatusMethodNotAllowed)
		return
	}
	// 请求体封顶：没有上限的话，一个几十 MB 的文件（base64 后还要再大 33%）
	// 会以 JSON 的形式整块灌进来，解码时内存直接见底。
	// 上限取 512MB —— 比两个平台的单文件红线（CNB 200MB / GitHub 100MB）
	// 都留出富余，正常用撞不到，真撞到了也给一句人话而不是 OOM。
	r.Body = http.MaxBytesReader(w, r.Body, maxIPCPayloadBytes)

	var req ipcRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		msg := "请求体不是合法 JSON：" + err.Error()
		if err.Error() == "http: request body too large" {
			msg = "这次要传的东西太大了（超过 512MB），拆成几批再来"
		}
		h.writeJSON(w, ipcResponse{OK: false, Error: msg})
		return
	}
	if req.Channel == "" {
		h.writeJSON(w, ipcResponse{OK: false, Error: "缺 channel 字段"})
		return
	}

	data, err := h.reg.Dispatch(req.Channel, req.Payload)
	if err != nil {
		if ipc.IsNotImplemented(err) {
			h.notifyOnce(req.Channel)
		}
		h.writeJSON(w, ipcResponse{OK: false, Error: err.Error()})
		return
	}
	h.writeJSON(w, ipcResponse{OK: true, Data: data})
}

// notifyOnce 把「这个通道还没实现」打到 stderr，每个通道只打一次。
// 有它才看得见「界面上点了一下没反应」到底缺的是哪一条通道。
func (h *handler) notifyOnce(channel string) {
	if _, seen := h.notified.LoadOrStore(channel, true); seen {
		return
	}
	fmt.Fprintf(os.Stderr, "通道未实现（界面点了会报错，属预期）：%s\n", channel)
}

func (h *handler) writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		fmt.Fprintln(os.Stderr, "回写 JSON 失败："+err.Error())
	}
}

/* ------------------------------------------------------------ 本地文件直出 */

// localFile 对应渲染层的 cloudpic.localUrl(绝对路径) → /__local?p=...
//
// 渲染层跑在 WebView 里拿不到文件系统，图片预览 / 文本预览都要经这里读盘。
// 边界必须卡死：只允许读当前配置绑定的本地目录底下的文件 ——
// 这个服务监听在 127.0.0.1 上，本机任何程序都能访问，
// 不设边界的话它就变成了一个「读任意路径」的接口。
func (h *handler) localFile(w http.ResponseWriter, r *http.Request) {
	if h.allows == nil {
		http.Error(w, "还没有绑定本地目录", http.StatusForbidden)
		return
	}
	p := r.URL.Query().Get("p")
	if p == "" {
		http.Error(w, "缺 p 参数", http.StatusBadRequest)
		return
	}
	clean := filepath.Clean(filepath.FromSlash(p))
	if !filepath.IsAbs(clean) || !h.allows(clean) {
		http.Error(w, "越界了：只能读已放行的目录里的文件", http.StatusForbidden)
		return
	}
	f, err := os.Open(clean)
	if err != nil {
		http.Error(w, "打不开："+err.Error(), http.StatusNotFound)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.Error(w, "不是文件", http.StatusNotFound)
		return
	}
	w.Header().Set("Cache-Control", "no-cache")
	http.ServeContent(w, r, filepath.Base(clean), st.ModTime(), f)
}

/* ------------------------------------------------------------ 远程文件代理 */

// remoteFile 对应渲染层的 cloudpic.remoteUrl(相对路径) → /__remote?p=...
//
// 为什么不能让浏览器直接去取 raw 地址：私有仓库的直链带了签名会过期，
// 而带 Token 请求又不能把 Token 交给渲染层。所以由后端代取一次，
// Token 从头到尾不出进程 —— 这也是「预览代理」这件事唯一安全的做法。
//
// 带 ETag：列表里同一张图会被反复请求（滚动、切页、刷新），
// 没有 ETag 就要每次都真的去云端拉一遍。
func (h *handler) remoteFile(w http.ResponseWriter, r *http.Request) {
	if h.remote == nil {
		http.Error(w, "云端还没配置好", http.StatusServiceUnavailable)
		return
	}
	p := r.URL.Query().Get("p")
	if p == "" {
		http.Error(w, "缺 p 参数", http.StatusBadRequest)
		return
	}
	etag := `"` + hashLite(p) + `"`
	if r.Header.Get("If-None-Match") == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	body, contentType, err := h.remote(p)
	if err != nil {
		http.Error(w, "取不到远程文件："+err.Error(), http.StatusBadGateway)
		return
	}
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("ETag", etag)
	// 60 秒：文件可能被替换过，缓存太久会一直显示旧图
	w.Header().Set("Cache-Control", "public, max-age=60")
	w.Write(body)
}

// hashLite 是个非加密的短哈希，只用来给 ETag 当指纹。
// 用 djb2 而不是 sha256：这里要的不是防碰撞，只是「同一个路径同一个值」。
func hashLite(s string) string {
	var h uint32 = 5381
	for i := 0; i < len(s); i++ {
		h = ((h << 5) + h + uint32(s[i])) & 0xFFFFFFFF
	}
	return strconv.FormatUint(uint64(h), 36)
}

