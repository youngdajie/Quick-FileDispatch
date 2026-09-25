//go:build !windows

// 非 Windows 平台的占位实现：本项目只出 Windows 包，
// 这边只是让 internal/ipc 引用窗口操作时还能编译过。
package wvhost

import "errors"

type Options struct {
	URL         string
	UserDataDir string
	Icon        []byte
	Width       int
	Height      int
	MinWidth    int
	MinHeight   int
	Background  uint32
}

func Run(o Options) error { return errors.New("当前平台没有窗口壳（仅支持 Windows）") }

// Hwnd 非 Windows 平台没有窗口句柄。
func Hwnd() uintptr { return 0 }

func Minimize() bool       { return false }
func ToggleMaximize() bool { return false }
func CloseWin() bool       { return false }
func IsMaximized() bool    { return false }
func BeginDrag()           {}
