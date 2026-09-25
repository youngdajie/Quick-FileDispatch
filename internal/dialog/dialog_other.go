//go:build !windows

// Package dialog 的非 Windows 分支。
//
// 本程序只出 Windows 包（NSIS 安装器、DPAPI、GDI 字体枚举都绑在 Windows 上），
// 这一份桩只是为了让代码在别的系统上也能编译通过。
package dialog

import "errors"

// Filter 是「描述 + 后缀列表」。
type Filter struct {
	Name string
	Exts []string
}

// SetOwner 非 Windows 上什么都不做（没有窗口句柄这回事）。
func SetOwner(hwnd uintptr) {}

// ChooseDir / OpenFile / SaveFile 在非 Windows 上都没有实现：
// 返回明确错误，而不是悄悄给个空串 —— 空串会被上层当成「用户取消了」，
// 于是界面什么都不发生，比报错更难查。
func ChooseDir(title, defaultPath string) (string, error) {
	return "", errors.New("选择文件夹对话框只实现了 Windows 版")
}

func OpenFile(title string, filters []Filter) (string, error) {
	return "", errors.New("打开文件对话框只实现了 Windows 版")
}

func SaveFile(title, defaultName string, filters []Filter) (string, error) {
	return "", errors.New("保存文件对话框只实现了 Windows 版")
}
