//go:build windows

// Package dialog 提供 Windows 原生的文件 / 目录选择对话框。
//
// 为什么不用前端的 <input type="file">：它没有 webkitdirectory 之外的新建目录能力，
// 而且选中的是相对虚拟路径；而 Electron 版用的是原生对话框（dialog:chooseDir），
// 用户看到的东西应该一致。
//
// 用 SHBrowseForFolderW 而不是更现代的 IFileDialog（IFileOpenDialog）：
// 后者要自己搭 COM 的 vtable / 接口定义，代码量翻几倍，而这里只需要
// 「选一个文件夹」这一件事 —— 老接口够用且稳定。
package dialog

import (
	"errors"
	"runtime"
	"syscall"
	"unsafe"
)

var (
	ole32    = syscall.NewLazyDLL("ole32.dll")
	shell32  = syscall.NewLazyDLL("shell32.dll")
	user32   = syscall.NewLazyDLL("user32.dll")
	kernel32 = syscall.NewLazyDLL("kernel32.dll")

	procCoInitializeEx  = ole32.NewProc("CoInitializeEx")
	procCoUninitialize  = ole32.NewProc("CoUninitialize")
	procSHBrowse        = shell32.NewProc("SHBrowseForFolderW")
	procSHGetPathFromID = shell32.NewProc("SHGetPathFromIDListW")
	procGetActiveWindow = user32.NewProc("GetActiveWindow")
	procCoTaskMemFree   = ole32.NewProc("CoTaskMemFree")
	procGetLastError    = kernel32.NewProc("GetLastError")
)

// BROWSEINFOW 是 SHBrowseForFolderW 的参数结构。
//
// 字段顺序必须和 Win32 的定义完全一致，错一个就是「点确定没反应」
// 或者更糟的随机行为 —— 这类错误不会报错，只会静默地不对。
type browseInfo struct {
	hwndOwner      uintptr
	pidlRoot       uintptr
	pszDisplayName uintptr
	lpszTitle      uintptr
	ulFlags        uint32
	lpfn           uintptr
	lParam         uintptr
	iImage         int32
}

// 这些标志的组合是刻意的：
//
//	BIF_RETURNONLYFSDIRS  —— 只让选真实文件夹（排除控制面板这类虚拟目录）
//	BIF_NEWDIALOGSTYLE    —— 新版样式，带「新建文件夹」按钮和地址栏
//	BIF_EDITBOX           —— 可以直接粘贴 / 输入路径
//	BIF_USENEWUI          —— 上面两个的合集，单独列出是为了读代码时看得清
const (
	bifReturnOnlyFSDirs  = 0x00000001
	bifDontGoBelowDomain = 0x00000002
	bifNewDialogStyle    = 0x00000040
	bifEditBox           = 0x00000010
	bifUseNewUI          = bifNewDialogStyle | bifEditBox
)

// coInitAPartmentThreaded：SHBrowseForFolderW 必须在 COM 初始化过的线程上调用。
const coInitAPartmentThreaded = 0x2

// ChooseDir 弹出「选择文件夹」对话框，返回选中的路径。
//
// 用户取消时返回空串和 nil 错误 —— 取消是正常结果，不是失败。
// 只有「弹不出来」（COM 初始化失败 / 接口调用失败）才返回错误。
func ChooseDir(title, defaultPath string) (string, error) {
	// COM 要求「初始化」和「调用」在同一个 OS 线程上。
	// Go 的 goroutine 会在 OS 线程之间迁移，不锁住的话
	// CoInitializeEx 和 SHBrowseForFolderW 可能落在不同线程上 ——
	// 那种情况下对话框要么不显示，要么点了没反应。
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	// S_OK(0) = 这个线程刚被初始化；S_FALSE(1) = 已经初始化过了。
	// 这两种都要在退出时配一次 CoUninitialize。
	//
	// 另一种常见返回是 RPC_E_CHANGED_MODE(0x80010106)，表示这个线程
	// 已经以别的模式初始化过 —— 那就别动它，也别 uninitialize
	// （把别人的初始化拆了会影响同一线程上的其它 COM 调用）。
	hr, _, _ := procCoInitializeEx.Call(0, coInitAPartmentThreaded)
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}

	msg := title
	if msg == "" {
		msg = "选择文件夹"
	}
	titlePtr, err := syscall.UTF16PtrFromString(msg)
	if err != nil {
		return "", err
	}

	hwnd, _, _ := procGetActiveWindow.Call()

	bi := browseInfo{
		hwndOwner: hwnd,
		lpszTitle: uintptr(unsafe.Pointer(titlePtr)),
		ulFlags:   bifReturnOnlyFSDirs | bifUseNewUI,
	}

	/**
	 * 默认路径（defaultPath）这里**没有**设置。
	 * SHBrowseForFolderW 要设置初始目录必须提供一个回调函数（BFFCALLBACK）
	 * 响应 BFFM_INITIALIZED 消息 —— 而 Go 里做回调要过 syscall.NewCallback，
	 * 还要求在回调里操作窗口句柄，代码量和风险都不划算。
	 * 权衡下来：宁可对话框打开在「上次的位置」，也不为了一个默认值
	 * 引入这层脆弱性。调用方需要引导用户去哪，用标题文字说明。
	 */
	_ = defaultPath

	idl, _, _ := procSHBrowse.Call(uintptr(unsafe.Pointer(&bi)))
	if idl == 0 {
		// 返回 0 就是用户点了取消
		return "", nil
	}
	defer procCoTaskMemFree.Call(idl)

	buf := make([]uint16, 4096)
	ok, _, _ := procSHGetPathFromID.Call(idl, uintptr(unsafe.Pointer(&buf[0])))
	if ok == 0 {
		return "", errors.New("拿到了目录项，但取不出它的路径")
	}
	return syscall.UTF16ToString(buf), nil
}

// lastError 取最近一次 Win32 错误，用于诊断「为什么对话框没弹出来」。
func lastError() error {
	code, _, _ := procGetLastError.Call()
	if code == 0 {
		return nil
	}
	return syscall.Errno(code)
}
