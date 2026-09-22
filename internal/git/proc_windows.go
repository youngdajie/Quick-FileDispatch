//go:build windows

package git

import (
	"os/exec"
	"syscall"
)

// hideWindow 让 git 子进程不弹控制台窗口。
// 少了这条，界面上每问一次 git:status 就会闪一下黑框 —— Electron 版对应的是
// execFile 的 windowsHide: true。
func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
	// 0x08000000 = CREATE_NO_WINDOW，HideWindow 之外再兜一道
	cmd.SysProcAttr.CreationFlags |= 0x08000000
}
