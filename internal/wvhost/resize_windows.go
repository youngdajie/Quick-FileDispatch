//go:build windows

// 页面边缘缩放：渲染层在窗口四边 / 四角的「隐形缩放条」（bridge.js 注入）
// 上按下鼠标时，经 win:resizeEdge 通道把方向投到这里，宿主在 UI 线程
// 轮询光标位置自己改窗口矩形。
//
// 为什么不直接进系统缩放循环（SendMessage(WM_NCLBUTTONDOWN, HT*)）：
// 按下那一刻浏览器进程握着鼠标捕获，宿主的缩放循环收不到 WM_MOUSEMOVE，
// 窗口纹丝不动（2.9.0-go 实测）。也不抢 SetCapture：捕获被夺走后
// Chromium 永远等不到 WM_LBUTTONUP，页面会一直以为鼠标还按着，后患难清。
//
// 轮询把这两件事全绕开了：GetCursorPos 全局可查（拖出窗口外也跟得住），
// GetAsyncKeyState 直接看左键物理状态（不依赖任何窗口收到松手消息）。
// 页面只负责说一句「从哪个方向开始缩」，拖动过程一个字节都不用发。
package wvhost

import (
	"fmt"
	"os"
	"sync/atomic"
	"time"
	"unsafe"
)

// wvLog 排障日志：QFD_WVLOG=1 时往 stderr 打缩放链路的每一步。
// 平时零输出；「点了边缘没反应」这类问题靠它区分是没收到投递、
// 循环没进、还是进了循环没采样到位移。
var wvLog = os.Getenv("QFD_WVLOG") == "1"

func logf(format string, args ...any) {
	if wvLog {
		fmt.Fprintf(os.Stderr, "[resize] %s %s\n", time.Now().Format("15:04:05.000"),
			fmt.Sprintf(format, args...))
	}
}

var (
	procPeekMessageW     = user32.NewProc("PeekMessageW")
	procGetAsyncKeyState = user32.NewProc("GetAsyncKeyState")
	procSleep            = kernel32.NewProc("Sleep")
)

const (
	// WM_APP+1：HTTP 协程投给 UI 线程的「开始缩放」消息，wParam 是方向代号
	wmAppResize = 0x8000 + 1
	wmQuit      = 0x0012
	pmRemove    = 0x0001
	vkLButton   = 0x01
)

// 方向代号（wmAppResize 的 wParam）。
const (
	rzLeft = iota + 1
	rzRight
	rzTop
	rzBottom
	rzTopLeft
	rzTopRight
	rzBottomLeft
	rzBottomRight
)

// resizeActive 防重入：一次拖动没结束前，迟到的第二条投递直接丢弃。
var resizeActive atomic.Uint32

// ResizeEdge 由 ipc 的 win:resizeEdge 处理函数在 HTTP 协程里调。
// 方向合法就投递消息立即返回 —— 窗口操作不碰，缩放循环在 UI 线程跑。
func ResizeEdge(dir string) bool {
	var code uintptr
	switch dir {
	case "left":
		code = rzLeft
	case "right":
		code = rzRight
	case "top":
		code = rzTop
	case "bottom":
		code = rzBottom
	case "topleft":
		code = rzTopLeft
	case "topright":
		code = rzTopRight
	case "bottomleft":
		code = rzBottomLeft
	case "bottomright":
		code = rzBottomRight
	default:
		return false
	}
	h := gHwnd.Load()
	if h == 0 {
		return true // 没窗口（--headless / --check）：静默成功，别吓着调用方
	}
	if z, _, _ := procIsZoomed.Call(h); z != 0 {
		logf("收到 %q：最大化中，忽略", dir)
		return true // 最大化时不缩放（渲染层此时也把缩放条藏了）
	}
	logf("收到 %q → 投递 wmAppResize", dir)
	procPostMessageW.Call(h, wmAppResize, code, 0)
	return true
}

// runResizeLoop 在 UI 线程（wmAppResize 的处理里）内联跑：
// 泵消息 + 采样光标 + 改窗口矩形，松开左键或窗口被最小化即结束。
//
// 消息泵必须一直跑：WM_SIZE 分发不出去，fitToBounds 就不会执行，
// WebView2 的边界跟不上窗口，页面会「框缩了内容没缩」。
func runResizeLoop(hwnd uintptr, code uintptr) {
	var pt0 point
	var wr0 rect
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt0)))
	procGetWindowRect.Call(hwnd, uintptr(unsafe.Pointer(&wr0)))
	logf("循环开始 code=%d 锚点 pt=(%d,%d) rect=(%d,%d,%d,%d)",
		code, pt0.x, pt0.y, wr0.left, wr0.top, wr0.right, wr0.bottom)
	// 最小尺寸与 WM_GETMINMAXINFO 同一套数值（配置里是 96dpi 逻辑像素）
	scale := dpiOf(hwnd)
	minW := minTrackW * int32(scale) / 96
	minH := minTrackH * int32(scale) / 96

	for {
		// 1) 泵干消息队列（包括刚才 SetWindowPos 触发的 WM_SIZE）
		var m msg
		for {
			r, _, _ := procPeekMessageW.Call(uintptr(unsafe.Pointer(&m)), 0, 0, 0, pmRemove)
			if r == 0 {
				break
			}
			if m.message == wmQuit {
				procPostQuitMessage.Call(0)
				return
			}
			procTranslateMessage.Call(uintptr(unsafe.Pointer(&m)))
			procDispatchMessageW.Call(uintptr(unsafe.Pointer(&m)))
		}
		// 2) 松手 / 最小化 → 结束。GetAsyncKeyState 查的是物理按键状态，
		//    与鼠标捕获在谁手里无关
		if st, _, _ := procGetAsyncKeyState.Call(vkLButton); (st & 0x8000) == 0 {
			logf("循环结束：左键已松开")
			return
		}
		if ic, _, _ := procIsIconic.Call(hwnd); ic != 0 {
			logf("循环结束：窗口被最小化")
			return
		}
		// 3) 起始锚点 + 光标位移 → 目标矩形。最小尺寸在这里兜底，
		//    不让任何一条边被拖过对边（负宽高）
		var pt point
		procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
		dx, dy := pt.x-pt0.x, pt.y-pt0.y
		l, t, r, b := wr0.left, wr0.top, wr0.right, wr0.bottom
		if code == rzLeft || code == rzTopLeft || code == rzBottomLeft {
			l += dx
			if r-l < minW {
				l = r - minW
			}
		}
		if code == rzRight || code == rzTopRight || code == rzBottomRight {
			r += dx
			if r-l < minW {
				r = l + minW
			}
		}
		if code == rzTop || code == rzTopLeft || code == rzTopRight {
			t += dy
			if b-t < minH {
				t = b - minH
			}
		}
		if code == rzBottom || code == rzBottomLeft || code == rzBottomRight {
			b += dy
			if b-t < minH {
				b = t + minH
			}
		}
		procSetWindowPos.Call(hwnd, 0,
			uintptr(l), uintptr(t), uintptr(r-l), uintptr(b-t),
			swpNoZOrder|swpNoActivate)
		procSleep.Call(8) // ~125Hz 采样，肉眼完全连续
	}
}
