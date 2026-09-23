//go:build windows

// Win32 窗口：无边框（页面铺满整个窗口）、自带单实例锁、按显示器 DPI 缩放最小尺寸。
//
// 无边框的配方（Windows 经典款）：
//   - 样式保留 WS_OVERLAPPEDWINDOW —— 贴边分屏、任务栏动画全靠它；
//   - WM_NCCALCSIZE 直接返回 0、客户区 = 整个窗口矩形（不缩！）——
//     非客户区一个像素都不留，DWM 就没地方画标题栏和系统边框（2.8.0-go
//     曾经「客户区往里缩一圈边框厚度」，结果那一圈被 DWM 画成了原生白框）；
//   - 最大化时窗口矩形比屏幕大一圈边框，这时反而要往里缩一圈，
//     否则四边的内容被裁掉。
//
// 边缘缩放不走非客户区命中测试：WebView2 的子窗口把命中测试全部吃掉，
// 页面铺满时宿主的 WM_NCHITTEST 根本轮不到。2.9.0 早期在三边留一圈
// 「缩放带」让宿主接（Tauri 思路），能缩，但带子露的是纯色底、页面边缘
// 的星野画不进去，看着像一条段落缝，被杰哥打回。现在由渲染层在边缘铺
// 隐形缩放条，mousedown 时调 win:resizeEdge，宿主轮询光标自己缩放
// （resize_windows.go）。
//
// 标题栏拖动：新运行时由 WebView2 的 IsNonClientRegionSupportEnabled
// 原生接管 -webkit-app-region；bridge.js 的 win:drag（WM_NCLBUTTONDOWN
// 那套）只给老运行时兜底。
package wvhost

import (
	"sync/atomic"
	"syscall"
	"unsafe"
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")

	procRegisterClassExW   = user32.NewProc("RegisterClassExW")
	procCreateWindowExW    = user32.NewProc("CreateWindowExW")
	procDefWindowProcW     = user32.NewProc("DefWindowProcW")
	procDestroyWindow      = user32.NewProc("DestroyWindow")
	procGetMessageW        = user32.NewProc("GetMessageW")
	procTranslateMessage   = user32.NewProc("TranslateMessage")
	procDispatchMessageW   = user32.NewProc("DispatchMessageW")
	procPostQuitMessage    = user32.NewProc("PostQuitMessage")
	procPostMessageW       = user32.NewProc("PostMessageW")
	procSendMessageW       = user32.NewProc("SendMessageW")
	procShowWindow         = user32.NewProc("ShowWindow")
	procIsZoomed           = user32.NewProc("IsZoomed")
	procIsIconic           = user32.NewProc("IsIconic")
	procSetForegroundWnd   = user32.NewProc("SetForegroundWindow")
	procGetClientRect      = user32.NewProc("GetClientRect")
	procGetWindowRect      = user32.NewProc("GetWindowRect")
	procGetSystemMetrics   = user32.NewProc("GetSystemMetrics")
	procGetDpiForWindow    = user32.NewProc("GetDpiForWindow")
	procSetProcessDpiAware = user32.NewProc("SetProcessDpiAwarenessContext")
	procSetWindowPos       = user32.NewProc("SetWindowPos")
	procGetCursorPos       = user32.NewProc("GetCursorPos")
	procReleaseCapture     = user32.NewProc("ReleaseCapture")
	procCreateMutexW       = syscall.NewLazyDLL("kernel32.dll").NewProc("CreateMutexW")
	procFindWindowW        = user32.NewProc("FindWindowW")
	procCreateIconFromRes  = user32.NewProc("CreateIconFromResourceEx")
	procLoadCursorW        = user32.NewProc("LoadCursorW")
	procGetLastError       = syscall.NewLazyDLL("kernel32.dll").NewProc("GetLastError")

	dwmapi = syscall.NewLazyDLL("dwmapi.dll")

	procDwmSetWindowAttr = dwmapi.NewProc("DwmSetWindowAttribute")
)

const (
	className = "QuickFileDispatch_GoWnd"

	wsOverlappedWindow = 0x00CF0000
	swShow             = 5
	swMinimize         = 6
	swMaximize         = 3
	swRestore          = 9

	wmDestroy       = 0x0002
	wmSize          = 0x0005
	wmClose         = 0x0010
	wmGetMinMaxInfo = 0x0024
	wmNcCalcSize    = 0x0083
	wmNcHitTest     = 0x0084
	wmNcActivate    = 0x0086
	wmDpiChanged    = 0x02E0
	wmNcLButtonDown = 0x00A1

	// WM_NCHITTEST 的返回值：客户区 + 八个方向的缩放代号
	htClient      = 1
	htCaption     = 2
	htLeft        = 10
	htRight       = 11
	htTop         = 12
	htTopLeft     = 13
	htTopRight    = 14
	htBottom      = 15
	htBottomLeft  = 16
	htBottomRight = 17

	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoZOrder     = 0x0004
	swpNoActivate   = 0x0010
	swpFrameChanged = 0x0020
	smCxFrame       = 32
	smCyFrame       = 33
	smCxPaddedBord  = 92

	// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2：窗口跟着显示器走，
	// 拖到高分屏上文字不发虚。SetProcessDpiAwarenessContext 的参数是个伪句柄。
	dpiAwareV2 = ^uintptr(3) // (HANDLE)-4

	errorAlreadyExists = 183
)

// gHwnd 是窗口句柄。UI 线程写，别的线程读（Win32 的窗口操作本身跨线程安全）。
var gHwnd atomic.Uintptr

// rect / point / minmaxinfo / wndClassExW / msg 都是 Win32 结构体的内存布局，
// 字段顺序错一个都是灾难 —— 对着 Windows SDK 的定义抄，别「优化」顺序。
type rect struct{ left, top, right, bottom int32 }

type point struct{ x, y int32 }

type minmaxinfo struct {
	ptReserved     point
	ptMaxSize      point
	ptMaxPosition  point
	ptMinTrackSize point
	ptMaxTrackSize point
}

type nccalcsizeParams struct {
	rgrc  [3]rect
	lppos uintptr
}

type wndClassExW struct {
	size, style   uint32
	lpfnWndProc   uintptr
	cbClsExtra    int32
	cbWndExtra    int32
	hInstance     syscall.Handle
	hIcon         uintptr
	hCursor       uintptr
	hbrBackground uintptr
	lpszMenuName  *uint16
	lpszClassName *uint16
	hIconSm       uintptr
}

type msg struct {
	hwnd    uintptr
	message uint32
	wParam  uintptr
	lParam  uintptr
	time    uint32
	pt      point
	private uint32 // DWORD lPrivate
}

var (
	minTrackW   int32 = 1080 // 与 Electron 版一致，DPI 换算在消息里做
	minTrackH   int32 = 680
	windowTitle       = "快捷文件分发服务@JIE"
)

// 窗口过程。staticProc 只做一层转发，真正的逻辑在闭包里，
// 这样不依赖任何包级可变状态也能拿到 Options。
// lParam 声明成 unsafe.Pointer：我们用到的消息里它都是指针，
// 指针化发生在系统边界，go vet 不会当「可疑的 unsafe 用法」报出来
var wndProcPtr = syscall.NewCallback(func(hwnd uintptr, msg uint32, w uintptr, l unsafe.Pointer) uintptr {
	return windowProc(hwnd, msg, w, l)
})

/* ------------------------------------------------------------ 小工具 */

var kernel32 = syscall.NewLazyDLL("kernel32.dll")
var procGetModuleHandleW = kernel32.NewProc("GetModuleHandleW")

func hInstance() syscall.Handle {
	h, _, _ := procGetModuleHandleW.Call(0)
	return syscall.Handle(h)
}

func showWindow(h, cmd uintptr) {
	procShowWindow.Call(h, cmd)
}

func clientRect(h uintptr) rect {
	var r rect
	procGetClientRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return r
}

func windowRect(h uintptr) rect {
	var r rect
	procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return r
}

func windowProc(hwnd uintptr, m uint32, w uintptr, l unsafe.Pointer) uintptr {
	switch m {
	case wmNcCalcSize:
		if w != 0 {
			// 客户区 = 整个窗口矩形。不调 DefWindowProc（它会把标题栏那一条
			// 划走），Windows 就没有任何非客户区可画 —— 原生标题栏彻底消失。
			// 2.8.1-go 在这里「往里缩一圈边框厚度」，那圈留下的非客户区
			// 恰好被 DWM 画成了用户看到的原生白框，别再改回去。
			p := (*nccalcsizeParams)(l)
			if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
				// 最大化：系统把窗口矩形撑得比屏幕大一圈边框，
				// 往里缩一圈把它拉回来，否则四边内容被裁
				fx := frameThickness(true)
				fy := frameThickness(false)
				p.rgrc[0].left += fx
				p.rgrc[0].top += fy
				p.rgrc[0].right -= fx
				p.rgrc[0].bottom -= fy
			}
			return 0
		}
		// wParam=FALSE 也必须接住：CreateWindowExW 创建期发的是这一档，
		// 漏掉就落进 DefWindowProc，客户区存成「带框」的 —— 首帧就带着
		// 原生标题栏，要等最小化/还原触发重算才消失（2.8.1-go 实测）。
		// 返回 0 的语义就是「客户区 = lParam 指的那个窗口矩形」。
		return 0

	case wmNcActivate:
		// lParam 传 -1：告诉 DefWindowProc「别重画非客户区」。
		// 窗口首次激活时它默认要重画一次原生框，正好盖在自绘标题栏上；
		// 我们根本没有非客户区，这次重画纯属捣乱。
		r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(m), w, ^uintptr(0))
		return r

	case wmNcHitTest:
		// 页面铺满后，边缘命中测试基本都被 WebView2 子窗口吃掉，轮不到
		// 本窗口 —— 缩放改由页面缩放条 + win:resizeEdge 负责（resize_windows.go）。
		// 这份命中测试留着兜底：万一哪条系统路径直接问到本窗口，边缘照常回
		// 缩放代号，行为不至于倒退。最大化状态下不缩放。
		if z, _, _ := procIsZoomed.Call(hwnd); z != 0 {
			return htClient
		}
		lu := uintptr(l)
		x := int32(int16(lu & 0xFFFF))         // 屏幕坐标，LOWORD 有符号
		y := int32(int16((lu >> 16) & 0xFFFF)) // HIWORD 有符号
		r := windowRect(hwnd)
		bx := frameThickness(true)
		by := frameThickness(false)
		left := x < r.left+bx
		right := x >= r.right-bx
		bottom := y >= r.bottom-by
		switch {
		case left && bottom:
			return htBottomLeft
		case right && bottom:
			return htBottomRight
		case left:
			return htLeft
		case right:
			return htRight
		case bottom:
			return htBottom
		}
		return htClient

	case wmGetMinMaxInfo:
		// 最小尺寸按当前显示器的 DPI 换算（配置里写的是 96dpi 逻辑像素）
		mmi := (*minmaxinfo)(l)
		scale := dpiOf(hwnd)
		mmi.ptMinTrackSize.x = minTrackW * int32(scale) / 96
		mmi.ptMinTrackSize.y = minTrackH * int32(scale) / 96
		return 0

	case wmSize:
		if wv.ctrl != nil {
			fitToBounds(wv.ctrl)
		}
		return 0

	case wmDpiChanged:
		// 系统已经算好「这个 DPI 下窗口该多大」，照着摆就是
		r := (*rect)(l)
		procSetWindowPos.Call(hwnd, 0,
			uintptr(r.left), uintptr(r.top),
			uintptr(r.right-r.left), uintptr(r.bottom-r.top),
			swpNoZOrder|swpNoActivate)
		return 0

	case wmAppResize:
		// 页面缩放条发来的「开始缩放」（win:resizeEdge → PostMessage 到这）。
		// 内联跑轮询循环，一次只允许一个：拖动中途迟到的第二条直接丢弃。
		if resizeActive.CompareAndSwap(0, 1) {
			runResizeLoop(hwnd, w)
			resizeActive.Store(0)
		}
		return 0

	case wmClose:
		procDestroyWindow.Call(hwnd)
		return 0

	case wmDestroy:
		closeWebView()
		procPostQuitMessage.Call(0)
		return 0
	}
	r, _, _ := procDefWindowProcW.Call(hwnd, uintptr(m), w, uintptr(l))
	return r
}

func frameThickness(horizontal bool) int32 {
	idx := uintptr(smCyFrame)
	if horizontal {
		idx = smCxFrame
	}
	frame, _, _ := procGetSystemMetrics.Call(idx)
	pad, _, _ := procGetSystemMetrics.Call(smCxPaddedBord)
	return int32(frame + pad)
}

func dpiOf(hwnd uintptr) uint32 {
	if procGetDpiForWindow.Find() == nil {
		if d, _, _ := procGetDpiForWindow.Call(hwnd); d != 0 {
			return uint32(d)
		}
	}
	return 96
}

/* ------------------------------------------------------------ 图标 */

// iconFromICO 从 .ico 字节里挑一张指定尺寸的图做 HICON。
//
// .ico = ICONDIR(6字节) + count 个 ICONDIRENTRY(16字节) + 各档位图像数据。
// 不用 LookupIconIdFromDirectoryEx —— 它返回的 id 对文件格式的语义
// 和资源格式不一样（读的是 nID 那两个字节的位重叠），自己挑更直白。
func iconFromICO(data []byte, size int) uintptr {
	if len(data) < 6 {
		return 0
	}
	count := int(uint16(data[4]) | uint16(data[5])<<8)
	best, bestOff, bestLen := -1, -1, 0
	for i := 0; i < count; i++ {
		off := 6 + i*16
		if off+16 > len(data) {
			break
		}
		w := int(data[off])
		if w == 0 {
			w = 256 // 0 表示 256
		}
		imgLen := int(uint32(data[off+8]) | uint32(data[off+9])<<8 |
			uint32(data[off+10])<<16 | uint32(data[off+11])<<24)
		imgOff := int(uint32(data[off+12]) | uint32(data[off+13])<<8 |
			uint32(data[off+14])<<16 | uint32(data[off+15])<<24)
		if imgOff+imgLen > len(data) {
			continue
		}
		if best < 0 {
			best, bestOff, bestLen = w, imgOff, imgLen
			continue
		}
		// 挑「不小于目标里最接近」的一档，保证缩小不糊
		if (w >= size && best < size) || (w >= size && w < best) || (w < size && w > best) {
			best, bestOff, bestLen = w, imgOff, imgLen
		}
	}
	if bestOff < 0 {
		return 0
	}
	h, _, _ := procCreateIconFromRes.Call(
		uintptr(unsafe.Pointer(&data[bestOff])), uintptr(bestLen),
		1, 0x00030000, uintptr(size), uintptr(size), 0)
	return h
}

/* ------------------------------------------------------------ 单实例 */

// acquireSingleInstance 拿到返回 true；已经有实例在跑返回 false（顺手把它的窗口叫到前台）。
func acquireSingleInstance() bool {
	name, _ := syscall.UTF16PtrFromString("Local\\QuickFileDispatch-Go-SingleInstance")
	procCreateMutexW.Call(0, 0, uintptr(unsafe.Pointer(name)))
	if code, _, _ := procGetLastError.Call(); code == errorAlreadyExists {
		if cls, _ := syscall.UTF16PtrFromString(className); cls != nil {
			if h, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(cls)), 0); h != 0 {
				if ic, _, _ := procIsIconic.Call(h); ic != 0 {
					procShowWindow.Call(h, swRestore)
				}
				procSetForegroundWnd.Call(h)
			}
		}
		return false
	}
	return true
}

/* ------------------------------------------------------------ COM 初始化 */

var (
	ole32              = syscall.NewLazyDLL("ole32.dll")
	procCoInitializeEx = ole32.NewProc("CoInitializeEx")
	procCoUninitialize = ole32.NewProc("CoUninitialize")
)

// COINIT_APARTMENTTHREADED：STA。WebView2 要求宿主线程是 STA
// （消息循环要泵 COM 消息），MTA 会导致控制器创建失败。
const coInitApartmentThreaded = 0x2
