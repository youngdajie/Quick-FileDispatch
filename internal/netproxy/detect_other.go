//go:build !windows

package netproxy

// systemProxy 在非 Windows 上没有「系统代理」这项可读，交给端口探测兜底。
func systemProxy() (string, bool) { return "", false }
