//go:build windows

// Run 与窗口操作：这是包对外的全部入口。
//
// main 调 Run 后就阻塞在消息循环里，直到窗口销毁；ipc 包的 win:* 通道
// 则从 HTTP 协程里调 Minimize / ToggleMaximize / CloseWin / BeginDrag。
// 这些函数只碰 HWND（ShowWindow / PostMessage / IsZoomed 跨线程安全），
// WebView2 的接口指针绝不从 UI 线程外摸。
package wvhost

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"
)

// Options 是开一个主窗口需要的全部信息。
type Options struct {
	URL         string // 首页地址（本地服务的 http://127.0.0.1:port/）
	UserDataDir string // WebView2 的浏览器数据目录（缓存 / Cookie 之类）
	Icon        []byte // .ico 文件内容，做窗口与任务栏图标
	Width       int    // 初始尺寸，逻辑像素（96dpi 基准）
	Height      int
	MinWidth    int // 最小尺寸，逻辑像素
	MinHeight   int
	// Background 是页面加载前的底色（A<<24 | R<<16 | G<<8 | B），
	// 与 Electron 版 backgroundColor 一致，深色主题启动不闪白。
	Background uint32
}

// Run 打开主窗口并阻塞到它关闭。必须在 main goroutine 调。
func Run(o Options) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// 伪句柄 (HANDLE)-4 = PER_MONITOR_AWARE_V2。要在建任何窗口之前调。
	if procSetProcessDpiAware.Find() == nil {
		procSetProcessDpiAware.Call(dpiAwareV2)
	}

	// WebView2 是 COM 组件，宿主线程必须是 STA。忘了这一步会得到
	// 0x800401F0（CO_E_NOTINITIALIZED），而且环境目录都建得出来，
	// 错误却在异步回调里才到 —— 特意记一笔，别再查一遍。
	hr, _, _ := procCoInitializeEx.Call(0, coInitApartmentThreaded)
	// S_OK(0) / S_FALSE(1) 都算成「已初始化」；RPC_E_CHANGED_MODE 说明
	// 线程已是 MTA（理论上不会发生，别去 uninitialize 也无妨）
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}

	if !acquireSingleInstance() {
		return nil // 已有实例，它的窗口已带到前台，本实例静默退场
	}

	if o.MinWidth > 0 {
		minTrackW = int32(o.MinWidth)
	}
	if o.MinHeight > 0 {
		minTrackH = int32(o.MinHeight)
	}

	cls, _ := syscall.UTF16PtrFromString(className)
	title, _ := syscall.UTF16PtrFromString(windowTitle)

	// 图标：32 给标题/任务栏，16 给窗口左上角小图标
	var hIcon, hIconSm uintptr
	if len(o.Icon) > 0 {
		hIcon = iconFromICO(o.Icon, 32)
		hIconSm = iconFromICO(o.Icon, 16)
	}
	cursor, _, _ := procLoadCursorW.Call(0, 32512) // IDC_ARROW

	wc := wndClassExW{
		size:          uint32(unsafe.Sizeof(wndClassExW{})),
		lpfnWndProc:   wndProcPtr,
		hInstance:     hInstance(),
		hIcon:         hIcon,
		hCursor:       cursor,
		lpszClassName: cls,
		hIconSm:       hIconSm,
	}
	if _, _, err := procRegisterClassExW.Call(uintptr(unsafe.Pointer(&wc))); err != nil && err != syscall.Errno(0) {
		return fmt.Errorf("注册窗口类失败：%v", err)
	}

	hwnd, _, err := procCreateWindowExW.Call(
		0,
		uintptr(unsafe.Pointer(cls)),
		uintptr(unsafe.Pointer(title)),
		wsOverlappedWindow,
		0x80000000, 0x80000000, // CW_USEDEFAULT：x/y 让系统挑
		uintptr(o.Width), uintptr(o.Height),
		0, 0, uintptr(hInstance()), 0)
	if hwnd == 0 {
		return fmt.Errorf("创建窗口失败：%v", err)
	}
	gHwnd.Store(hwnd)

	// 先显示窗口再创建 WebView2。官方样例就是这个顺序：DWM 要等窗口首次
	// 显示才会建重定向表面，藏在后台就创建合成链，控制器虽然建得起来，
	// 但画面永远上不了屏（窗口一直白屏）。
	showWindow(hwnd, swShow)

	if err := createWebView(o.UserDataDir, o.URL, o.Background); err != nil {
		return err
	}

	// 消息循环。WebView2 的就绪回调、窗口的全部交互都从这里分发。
	for {
		var m msg
		r, _, _ := procGetMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0)
		if r == 0 { // WM_QUIT
			break
		}
		if r == ^uintptr(0) { // -1 = 出错
			break
		}
		procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
		procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
	}
	return nil
}

/* ------------------------------------------------------------ 给 IPC 用的窗口操作 */

// Minimize 最小化窗口。
func Minimize() bool {
	if h := gHwnd.Load(); h != 0 {
		procShowWindow.Call(h, swMinimize)
		return true
	}
	return false
}

// ToggleMaximize 在「最大化 / 还原」之间切换，返回切换后的状态。
func ToggleMaximize() bool {
	h := gHwnd.Load()
	if h == 0 {
		return false
	}
	if z, _, _ := procIsZoomed.Call(h); z != 0 {
		procShowWindow.Call(h, swRestore)
		return false
	}
	procShowWindow.Call(h, swMaximize)
	return true
}

// CloseWin 请求关窗（走 WM_CLOSE，和点标题栏的关闭一样，会走 WM_DESTROY 清理）。
func CloseWin() bool {
	if h := gHwnd.Load(); h != 0 {
		procPostMessageW.Call(h, wmClose, 0, 0)
		return true
	}
	return false
}

// IsMaximized 当前是否最大化。
func IsMaximized() bool {
	if h := gHwnd.Load(); h != 0 {
		z, _, _ := procIsZoomed.Call(h)
		return z != 0
	}
	return false
}

// BeginDrag 由标题栏 mousedown 触发：骗系统「鼠标按在标题栏上」，
// 进入原生的拖动 / 双击最大化循环。渲染层自己没法拖无边框窗口
// （-webkit-app-region 是 Electron 专属），这条通道就是它的替身。
func BeginDrag() {
	h := gHwnd.Load()
	if h == 0 {
		return
	}
	if z, _, _ := procIsZoomed.Call(h); z != 0 {
		return // 最大化状态下不拖（Electron 的「拖下还原」体验先不做）
	}
	procReleaseCapture.Call()
	procSendMessageW.Call(h, wmNcLButtonDown, htCaption, 0)
}
