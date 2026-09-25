//go:build windows

// Package dialog 提供 Windows 原生的文件 / 目录选择对话框。
//
// 为什么不用前端的 <input type="file">：它没有 webkitdirectory 之外的新建目录能力，
// 而且选中的是相对虚拟路径；而 Electron 版用的是原生对话框（dialog:chooseDir），
// 用户看到的东西应该一致。
//
// 选文件夹用 IFileOpenDialog + FOS_PICKFOLDERS（现代对话框），不用老掉牙的
// SHBrowseForFolderW。换掉它的三个原因，都是实测踩出来的：
//  1. 老接口不认宿主窗口 —— 对话框开在主窗口**背后**，用户以为点了没反应，
//     于是反复点，一次点出一堆窗口；
//  2. 老接口那个树形对话框又小又挤，找几层嵌套目录要横向拖滚动条；
//  3. 新接口支持 SetFolder 指定初始目录，老接口要设置初始目录得写回调。
//
// IFileDialog 的代价是要自己搭 COM 的 vtable 调用 —— 本文件里那点 comCall 就够，
// 一个「选文件夹」不值得为它引入第三方库。
package dialog

import (
	"errors"
	"fmt"
	"runtime"
	"sync/atomic"
	"syscall"
	"unicode/utf16"
	"unsafe"
)

var (
	ole32    = syscall.NewLazyDLL("ole32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procCoInitializeEx  = ole32.NewProc("CoInitializeEx")
	procCoUninitialize  = ole32.NewProc("CoUninitialize")
	procCoCreateInst    = ole32.NewProc("CoCreateInstance")
	procCoTaskMemFree   = ole32.NewProc("CoTaskMemFree")
	procSHCreateItem    = shell32.NewProc("SHCreateItemFromParsingName")
	procGetActiveWindow = user32.NewProc("GetActiveWindow")
	procGetLastError    = kernel32.NewProc("GetLastError")
)

// coInitApartmentThreaded：COM 单线程套间。
const coInitApartmentThreaded = 0x2

// clsctxInprocServer：进程内组件。
const clsctxInprocServer = 0x1

// ownerHwnd 是主窗口句柄，由 main 启动后写进来（见 SetOwner）。
//
// 有它对话框才「属于」本窗口：开在窗口上面、挡住窗口的点击（模态）。
var ownerHwnd atomic.Uintptr

// dirOpening 挡住重复点击：同一时刻只允许一个目录对话框。
// 前端连点几下会连发几次 IPC，没这道闸就是「点一次弹一个」。
var dirOpening atomic.Bool

// SetOwner 由 main 在窗口建好后调用。
func SetOwner(hwnd uintptr) {
	ownerHwnd.Store(hwnd)
}

func ownerOrActive() uintptr {
	if h := ownerHwnd.Load(); h != 0 {
		return h
	}
	h, _, _ := procGetActiveWindow.Call()
	return h
}

/* ---------------------------------------------------------------- COM 小工具 */

// guid 就是 Win32 的 GUID（16 字节：4 + 2 + 2 + 8）。
type guid struct {
	d1 uint32
	d2 uint16
	d3 uint16
	d4 [8]byte
}

var (
	// {DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7}
	clsidFileOpenDialog = guid{0xDC1C5A9C, 0xE88A, 0x4DDE, [8]byte{0xA5, 0xA1, 0x60, 0xF8, 0x2A, 0x20, 0xAE, 0xF7}}
	// {D57C7288-D4AD-4768-BE02-9D969532D960}
	iidFileOpenDialog = guid{0xD57C7288, 0xD4AD, 0x4768, [8]byte{0xBE, 0x02, 0x9D, 0x96, 0x95, 0x32, 0xD9, 0x60}}
	// {43826D1E-E718-42EE-BC55-A1E261C37BFE}
	iidShellItem = guid{0x43826D1E, 0xE718, 0x42EE, [8]byte{0xBC, 0x55, 0xA1, 0xE2, 0x61, 0xC3, 0x7B, 0xFE}}
)

// comCall 调 COM 接口的第 slot 个虚函数（0/1/2 是 QueryInterface/AddRef/Release）。
//
// 接口指针指向的是「虚表指针」，虚表里按顺序排着函数指针 ——
// 这就是 C++ 对象在内存里的样子，也是能在纯 Go 里调 COM 的全部秘密。
func comCall(p uintptr, slot int, args ...uintptr) uintptr {
	if p == 0 {
		return 0
	}
	vtbl := *(*uintptr)(unsafe.Pointer(p))
	fn := *(*uintptr)(unsafe.Pointer(vtbl + uintptr(slot)*unsafe.Sizeof(uintptr(0))))
	all := make([]uintptr, 0, len(args)+1)
	all = append(all, p)
	all = append(all, args...)
	r, _, _ := syscall.SyscallN(fn, all...)
	return r
}

// IFileDialog 虚表槽位（IFileOpenDialog 继承链：IUnknown → IModalWindow → IFileDialog）
const (
	slotRelease       = 2  // IUnknown::Release
	slotShow          = 3  // IModalWindow::Show(hwndOwner)
	slotSetOptions    = 9  // IFileDialog::SetOptions
	slotGetOptions    = 10 // IFileDialog::GetOptions
	slotSetFolder     = 12 // IFileDialog::SetFolder
	slotSetTitle      = 17 // IFileDialog::SetTitle
	slotGetResult     = 20 // IFileDialog::GetResult
	slotGetDisplayNam = 5  // IShellItem::GetDisplayName
)

// 选项位：只认文件系统、必须存在、可以选文件夹、不改当前工作目录
const (
	fosNoChangeDir     = 0x00000008
	fosPickFolders     = 0x00000020
	fosForceFileSystem = 0x00000040
	fosPathMustExist   = 0x00000800
)

// SIGDN_FILESYSPATH：要文件系统路径，而不是显示名。
const sigdnFileSysPath = 0x80058000

// HRESULT_FROM_WIN32(ERROR_CANCELLED)：用户点了取消。
const hresultCancelled = 0x800704C7

// utf16PtrToString 从 UTF-16 指针读到第一个 NUL。
//
// 不用 unsafe.Slice + 固定长度：路径长度未知，多读一个字节就可能踩到别的分配区。
func utf16PtrToString(p uintptr) string {
	if p == 0 {
		return ""
	}
	var buf []uint16
	for i := 0; i < 32768; i++ {
		c := *(*uint16)(unsafe.Pointer(p + uintptr(i)*2))
		if c == 0 {
			break
		}
		buf = append(buf, c)
	}
	return string(utf16.Decode(buf))
}

// ChooseDir 弹出「选择文件夹」对话框，返回选中的路径。
//
// 用户取消时返回空串和 nil 错误 —— 取消是正常结果，不是失败。
// 重复调用（上一个还开着）会直接返回空串，避免连点弹出一堆窗口。
func ChooseDir(title, defaultPath string) (string, error) {
	if dirOpening.Swap(true) {
		return "", nil // 已经有一个在弹了，这次点击当没发生
	}
	defer dirOpening.Store(false)

	// COM 要求「初始化」和「调用」在同一个 OS 线程上。
	// Go 的 goroutine 会在 OS 线程之间迁移，不锁住的话
	// CoInitializeEx 和 IFileDialog 可能落在不同线程上 ——
	// 那种情况下对话框要么不显示，要么点了没反应。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// S_OK(0) = 这个线程刚被初始化；S_FALSE(1) = 已经初始化过了。
	// 这两种都要在退出时配一次 CoUninitialize。
	// RPC_E_CHANGED_MODE(0x80010106) 表示线程已按别的模式初始化过 ——
	// 那就别动它，也别 uninitialize。
	if hr, _, _ := procCoInitializeEx.Call(0, coInitApartmentThreaded); hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}

	var dlg uintptr
	hr, _, _ := procCoCreateInst.Call(
		uintptr(unsafe.Pointer(&clsidFileOpenDialog)), 0, clsctxInprocServer,
		uintptr(unsafe.Pointer(&iidFileOpenDialog)), uintptr(unsafe.Pointer(&dlg)),
	)
	if hr != 0 || dlg == 0 {
		return "", fmt.Errorf("创建文件夹对话框失败（0x%X）", hr)
	}
	defer comCall(dlg, slotRelease)

	var opts uint32
	comCall(dlg, slotGetOptions, uintptr(unsafe.Pointer(&opts)))
	comCall(dlg, slotSetOptions,
		uintptr(opts|fosPickFolders|fosForceFileSystem|fosPathMustExist|fosNoChangeDir))

	msg := title
	if msg == "" {
		msg = "选择文件夹"
	}
	if p, err := syscall.UTF16PtrFromString(msg); err == nil {
		comCall(dlg, slotSetTitle, uintptr(unsafe.Pointer(p)))
	}

	// 初始目录：能定下来就定，定不了（路径不存在 / 权限不足）就让系统用上次的位置
	if defaultPath != "" {
		if p, err := syscall.UTF16PtrFromString(defaultPath); err == nil {
			var item uintptr
			if hr2, _, _ := procSHCreateItem.Call(
				uintptr(unsafe.Pointer(p)), 0,
				uintptr(unsafe.Pointer(&iidShellItem)), uintptr(unsafe.Pointer(&item)),
			); hr2 == 0 && item != 0 {
				comCall(dlg, slotSetFolder, item)
				comCall(item, slotRelease)
			}
		}
	}

	// 宿主窗口：这一步是「不再跑到窗口背后」的关键
	hr = comCall(dlg, slotShow, ownerOrActive())
	if hr == hresultCancelled {
		return "", nil
	}
	if hr != 0 {
		return "", fmt.Errorf("文件夹对话框未能正常打开（0x%X）", hr)
	}

	var res uintptr
	if hr = comCall(dlg, slotGetResult, uintptr(unsafe.Pointer(&res))); hr != 0 || res == 0 {
		return "", nil
	}
	defer comCall(res, slotRelease)

	var namePtr uintptr
	if hr = comCall(res, slotGetDisplayNam,
		sigdnFileSysPath, uintptr(unsafe.Pointer(&namePtr))); hr != 0 || namePtr == 0 {
		return "", errors.New("拿到了目录项，但取不出它的路径")
	}
	defer procCoTaskMemFree.Call(namePtr)

	return utf16PtrToString(namePtr), nil
}

// lastError 取最近一次 Win32 错误，用于诊断「为什么对话框没弹出来」。
func lastError() error {
	code, _, _ := procGetLastError.Call()
	if code == 0 {
		return nil
	}
	return syscall.Errno(code)
}
