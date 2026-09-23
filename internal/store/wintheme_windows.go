//go:build windows

// 读 Windows 的「应用模式」主题（设置 → 个性化 → 颜色 → 选择模式）。
// 注册表 HKCU\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize
// 下的 AppsUseLightTheme：1 = 浅色，0 = 深色。应用主题就是跟着这一项走的，
// 纯 syscall 读一个 DWORD 即可，不引第三方依赖。
package store

import (
	"syscall"
	"unsafe"
)

var (
	advapi32             = syscall.NewLazyDLL("advapi32.dll")
	procRegOpenKeyExW    = advapi32.NewProc("RegOpenKeyExW")
	procRegQueryValueExW = advapi32.NewProc("RegQueryValueExW")
	procRegCloseKey      = advapi32.NewProc("RegCloseKey")
)

const (
	hkcu          = 0x80000001 // HKEY_CURRENT_USER
	keyQueryValue = 0x0001
	regDword      = 4
)

// appsUseLightTheme 返回系统的应用主题是不是浅色。
// 键不存在（老系统 / 被策略隐藏）或读失败一律按 false（深色）算 ——
// 深色是本程序一直以来的出厂默认，探测失败时行为不变。
func appsUseLightTheme() bool {
	path, err := syscall.UTF16PtrFromString(`Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`)
	if err != nil {
		return false
	}
	var h syscall.Handle
	r, _, _ := procRegOpenKeyExW.Call(uintptr(hkcu), uintptr(unsafe.Pointer(path)),
		0, keyQueryValue, uintptr(unsafe.Pointer(&h)))
	if r != 0 {
		return false
	}
	defer procRegCloseKey.Call(uintptr(h))

	name, err := syscall.UTF16PtrFromString("AppsUseLightTheme")
	if err != nil {
		return false
	}
	var val, size, typ uint32
	size = 4
	r, _, _ = procRegQueryValueExW.Call(uintptr(h), uintptr(unsafe.Pointer(name)), 0,
		uintptr(unsafe.Pointer(&typ)), uintptr(unsafe.Pointer(&val)), uintptr(unsafe.Pointer(&size)))
	if r != 0 || typ != regDword {
		return false
	}
	return val == 1
}
