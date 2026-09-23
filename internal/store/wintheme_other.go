//go:build !windows

package store

// 非 Windows 没有这项系统设置（本程序目前只在 Windows 发布），
// 按深色走 —— 与出厂默认保持一致。
func appsUseLightTheme() bool { return false }
