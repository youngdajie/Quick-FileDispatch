//go:build !windows

package git

import "os/exec"

// hideWindow 在非 Windows 上是空实现（那边本来就没有控制台闪窗的问题）。
func hideWindow(cmd *exec.Cmd) {}
