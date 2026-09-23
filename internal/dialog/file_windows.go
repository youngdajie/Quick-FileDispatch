//go:build windows

package dialog

import (
	"errors"
	"runtime"
	"strings"
	"syscall"
	"unsafe"
)

var (
	comdlg32      = syscall.NewLazyDLL("comdlg32.dll")
	procGetOpen   = comdlg32.NewProc("GetOpenFileNameW")
	procGetSave   = comdlg32.NewProc("GetSaveFileNameW")
	procCommError = comdlg32.NewProc("CommDlgExtendedError")
)

// openFileName 是 OPENFILENAMEW 的 Go 镜像（x64 布局）。
//
// 这个结构体的坑全在**对齐**上：x64 上指针要 8 字节对齐，
// 所以每个 4 字节的 DWORD 后面只要跟着指针，就自动插入 4 字节填充。
// 下面的 pad 字段就是那些填充 —— 写漏一个，后面所有字段整体错位，
// 表现是「对话框打不开」或者「过滤器是乱码」，且完全不报错。
//
// 结构体总长（x64）固定 152 字节，lStructSize 就填它。
type openFileName struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       uintptr
	lpstrCustomFilter uintptr
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         uintptr
	nMaxFile          uint32
	lpstrFileTitle    uintptr
	nMaxFileTitle     uint32
	lpstrInitialDir   uintptr
	lpstrTitle        uintptr
	flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       uintptr
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    uintptr
	pvReserved        uintptr
	dwReserved        uint32
	flagsEx           uint32
}

// 对话框标志
const (
	ofnExplorer       = 0x00080000
	ofnPathMustExist  = 0x00000800
	ofnFileMustExist  = 0x00001000
	ofnHideReadOnly   = 0x00000004
	ofnOverwritePromp = 0x00000002
	ofnNoChangeDir    = 0x00000008
)

// Filter 是「描述 + 后缀列表」，例如 {Name: "JSON 配置", Exts: []string{"json"}}。
type Filter struct {
	Name string
	Exts []string
}

// buildFilter 拼出 Win32 要的过滤器串。
// 格式是「描述\0*.ext1;*.ext2\0」逐组重复，最后再补一个 \0 收尾。
// 少了结尾那个 \0，对话框会一直读到越界，过滤器列表里出现乱码项。
func buildFilter(fs []Filter) string {
	if len(fs) == 0 {
		return ""
	}
	var b strings.Builder
	for _, f := range fs {
		b.WriteString(f.Name)
		b.WriteString("\x00")
		parts := make([]string, 0, len(f.Exts))
		for _, e := range f.Exts {
			if e == "*" {
				parts = append(parts, "*.*")
				continue
			}
			parts = append(parts, "*."+e)
		}
		b.WriteString(strings.Join(parts, ";"))
		b.WriteString("\x00")
	}
	// 这里不能只存字符串：Win32 要的是以 NUL 分隔、双 NUL 结尾的**字节序列**，
	// 而 Go 的字符串本来就允许含 \x00，整体传进去就行。
	b.WriteString("\x00")
	return b.String()
}

// commonDialog 跑一次打开 / 保存对话框。
func commonDialog(save bool, title, defaultName string, filters []Filter) (string, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()

	hr, _, _ := procCoInitializeEx.Call(0, coInitAPartmentThreaded)
	if hr == 0 || hr == 1 {
		defer procCoUninitialize.Call()
	}

	// 缓冲区要够大才装得下多选；这里只选单个文件，4096 个字符足够
	const bufLen = 4096
	fileBuf := make([]uint16, bufLen)
	if defaultName != "" {
		copy(fileBuf, syscall.StringToUTF16(defaultName))
	}

	var titlePtr, filterPtr, defExtPtr, initDirPtr uintptr
	if title != "" {
		if p, err := syscall.UTF16PtrFromString(title); err == nil {
			titlePtr = uintptr(unsafe.Pointer(p))
		}
	}
	if f := buildFilter(filters); f != "" {
		if p, err := syscall.UTF16PtrFromString(f); err == nil {
			filterPtr = uintptr(unsafe.Pointer(p))
		}
	}
	// 默认扩展名取第一组过滤器的第一个后缀：用户在文件名里没写后缀时自动补上
	if len(filters) > 0 && len(filters[0].Exts) > 0 && filters[0].Exts[0] != "*" {
		if p, err := syscall.UTF16PtrFromString(filters[0].Exts[0]); err == nil {
			defExtPtr = uintptr(unsafe.Pointer(p))
		}
	}

	flags := uint32(ofnExplorer | ofnHideReadOnly | ofnNoChangeDir)
	if save {
		flags |= ofnOverwritePromp | ofnPathMustExist
	} else {
		flags |= ofnFileMustExist | ofnPathMustExist
	}

	ofn := openFileName{
		lStructSize:     uint32(unsafe.Sizeof(openFileName{})),
		lpstrFilter:     filterPtr,
		lpstrFile:       uintptr(unsafe.Pointer(&fileBuf[0])),
		nMaxFile:        bufLen,
		lpstrTitle:      titlePtr,
		flags:           flags,
		lpstrDefExt:     defExtPtr,
		lpstrInitialDir: initDirPtr,
		nFilterIndex:    1,
	}

	var ok uintptr
	if save {
		ok, _, _ = procGetSave.Call(uintptr(unsafe.Pointer(&ofn)))
	} else {
		ok, _, _ = procGetOpen.Call(uintptr(unsafe.Pointer(&ofn)))
	}
	if ok == 0 {
		// 取消 / 关闭：CommDlgExtendedError 返回 0 表示就是用户取消了
		code, _, _ := procCommError.Call()
		if code == 0 {
			return "", nil
		}
		return "", commonDialogError(code)
	}
	return syscall.UTF16ToString(fileBuf), nil
}

func commonDialogError(code uintptr) error {
	switch code {
	case 0x3002:
		return errors.New("文件名无效（可能含有非法字符）")
	case 0x3003:
		return errors.New("路径不存在")
	case 0x3006:
		return errors.New("文件缓冲区太小")
	default:
		return errors.New("文件对话框出错（代码 " + itoa(int(code)) + "）")
	}
}

// OpenFile 弹出「打开文件」对话框。取消返回空串 + nil。
func OpenFile(title string, filters []Filter) (string, error) {
	return commonDialog(false, title, "", filters)
}

// SaveFile 弹出「另存为」对话框。defaultName 是预填的文件名。
func SaveFile(title, defaultName string, filters []Filter) (string, error) {
	return commonDialog(true, title, defaultName, filters)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [24]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}
