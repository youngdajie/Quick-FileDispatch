//go:build windows

// GUI 子系统下的控制台兼容层。
//
// exe 编译成 -H=windowsgui 后（双击不弹 CMD 窗口，2026-09-23 杰哥要求），
// Windows 默认不给它控制台 —— 从 cmd 里跑 `xxx.exe --check` 会一行输出
// 都看不见。这里的补救：检测到自己没有标准输出句柄时，主动 AttachConsole
// 接回父进程的控制台。
//
// 两种场景的行为：
//   - 从终端跑 --check / --headless：没有 std 句柄 → AttachConsole 接上，
//     fmt.Printf 照常打印；
//   - 输出被重定向 / 管道（CI、脚本、WorkBuddy 的 bash 工具）：std 句柄
//     已经是管道，绝不能去动它 —— 所以先探测再决定，不是无脑 attach。
//
// 双击启动（无父控制台）attach 会失败，返回 false，无副作用。
package main

import (
	"os"
	"syscall"
)

var (
	kernel32ForConsole = syscall.NewLazyDLL("kernel32.dll")
	procAttachConsole  = kernel32ForConsole.NewProc("AttachConsole")
	procGetStdHandleC  = kernel32ForConsole.NewProc("GetStdHandle")
)

// attachParentProcess = ATTACH_PARENT_PROCESS，即 (DWORD)-1。
// GetStdHandle 的参数 STD_OUTPUT_HANDLE=-11、STD_ERROR_HANDLE=-12，
// 以 uintptr 传负数要用按位取反（^uintptr(10) == -11 的补码）。
const (
	attachParentProcess = ^uintptr(0)
	stdOutputHandle     = ^uintptr(10) // -11
	stdErrorHandle      = ^uintptr(11) // -12
)

// attachConsole 保证 --check / --headless 这类命令行场景下输出可见。
// 必须在 main 里任何 fmt 打印之前调。
func attachConsole() {
	if h, _, _ := procGetStdHandleC.Call(stdOutputHandle); h != 0 {
		return // 已有标准输出（管道 / 重定向），别动
	}
	if hr, _, _ := procAttachConsole.Call(attachParentProcess); hr == 0 {
		return // 没有父控制台（双击启动），维持沉默
	}
	out, _, _ := procGetStdHandleC.Call(stdOutputHandle)
	errh, _, _ := procGetStdHandleC.Call(stdErrorHandle)
	if out != 0 {
		os.Stdout = os.NewFile(out, "stdout")
	}
	if errh != 0 {
		os.Stderr = os.NewFile(errh, "stderr")
	}
}
