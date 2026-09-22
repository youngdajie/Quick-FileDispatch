//go:build windows

// Package winfont 枚举本机已安装字体的「家族名」。
//
// 为什么不用别的手段：
//   - 注册表 HKLM\...\Fonts 里存的是**全名**（"LXGW WenKai Regular"），
//     拿去写 CSS font-family 是错的 —— 那里要家族名（"LXGW WenKai"）。
//   - 原先试过 powershell + System.Drawing 的 InstalledFontCollection，
//     在这台机器上直接跑不出东西（返回空），而且每次要起一个进程、约 300ms，
//     它又在渲染层启动链路上被 await，界面会晚一步才上主题色。
//
// GDI 的 EnumFontFamiliesExW 回调里给的就是 lfFaceName = 家族名，正好是 CSS 要的，
// 一次调用几十微秒。所以直接调 GDI，不绕 .NET、也不像 Electron 版（src/main/fonts.js）
// 那样自己去解析字体文件的 name 表 —— 那 232 行可以省了。
//
// 两个注意点：
//   - 过滤掉以 '@' 开头的名字：那是竖排变体（@SimSun），不是给人的选项。
//   - 过滤掉点阵字体（RASTER_FONTTYPE）：Modern / Roman / Script 那几个老式
//     点阵字体没有字体文件，Electron 版按扩展名扫目录时本来就扫不到，这里对齐。
//
// 已知差异（先记着，暂时不修）：lfFaceName 是 32 个 wchar 的定长数组，家族名超过
// 31 个字符会被**截断** —— 实测 192 个家族里只有 Bahnschrift 那几个变体受影响
// （"Bahnschrift SemiBold SemiCondensed" 出来是 "...SemiConden"）。截断的名字拿去写
// CSS font-family 匹配不上，选中它界面不会变。真要修就得像 src/main/fonts.js 那样
// 自己解析字体文件的 name 表（凭名 ID 1/16 取家族名），那是另一件事 ——
// demo 阶段先把快的这条走通，GDI 这条路 192 个家族 5ms 出结果。
package winfont

import (
	"sort"
	"strings"
	"sync"
	"syscall"
	"unsafe"
)

var (
	user32 = syscall.NewLazyDLL("user32.dll")
	gdi32  = syscall.NewLazyDLL("gdi32.dll")

	procGetDC               = user32.NewProc("GetDC")
	procReleaseDC           = user32.NewProc("ReleaseDC")
	procEnumFontFamiliesExW = gdi32.NewProc("EnumFontFamiliesExW")
)

const (
	defaultCharset = 1 // DEFAULT_CHARSET
	rasterFontType = 0x0001
)

// logFontW 是 Windows 的 LOGFONTW。字段顺序和大小必须严格对齐，
// 因为回调给的是一个指向 ENUMLOGFONTEXW 的裸指针，只能靠结构体布局去读 lfFaceName。
type logFontW struct {
	Height         int32
	Width          int32
	Escapement     int32
	Orientation    int32
	Weight         int32
	Italic         byte
	Underline      byte
	StrikeOut      byte
	CharSet        byte
	OutPrecision   byte
	ClipPrecision  byte
	Quality        byte
	PitchAndFamily byte
	FaceName       [32]uint16
}

// 回调第一个参数实际指向 ENUMLOGFONTEXW，它的首成员就是 LOGFONTW。
// 后面几个成员用不到，但留着保证结构体足够大、读 lfFaceName 时不会越界。
type enumLogFontExW struct {
	LogFont  logFontW
	FullName [64]uint16
	Style    [32]uint16
	Script   [32]uint16
}

var (
	once    sync.Once
	cached  []string
	mu      sync.Mutex
	scratch []string
	proc    uintptr
)

// Families 返回本机字体家族名（已排序、去重）。结果只算一次并缓存 ——
// 设置页每次重画都会问，字幕枚举本身很快但没必要反复做。
func Families() []string {
	once.Do(func() { cached = enumerate() })
	return cached
}

func enumerate() []string {
	hdc, _, _ := procGetDC.Call(0)
	if hdc == 0 {
		return []string{}
	}
	defer procReleaseDC.Call(0, hdc)

	mu.Lock()
	scratch = nil
	// NewCallback 只需建一次；建多了会攒下永远不释放的代码桩
	if proc == 0 {
		proc = syscall.NewCallback(enumProc)
	}
	lf := logFontW{CharSet: defaultCharset}
	procEnumFontFamiliesExW.Call(hdc, uintptr(unsafe.Pointer(&lf)), proc, 0, 0)
	names := scratch
	scratch = nil
	mu.Unlock()

	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, n := range names {
		if n == "" || strings.HasPrefix(n, "@") {
			continue
		}
		key := strings.ToLower(n)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}

// enumProc 是 GDI 的回调：返回 1 表示继续枚举下一个家族。
//
// 参数类型说明：指针用 unsafe.Pointer、DWORD 和 LPARAM 用 uintptr ——
// 这是 runtime 的 compileCallback 认的形状（字节大小等于指针大小）。
// 头两个参数如果写成 uintptr，读的时候就得把 uintptr 转回 unsafe.Pointer，
// 那是 unsafe 里明令禁止的写法（GC 可能已经把它当普通整数了），go vet 也会报
// "possible misuse of unsafe.Pointer"。
func enumProc(lpelfe unsafe.Pointer, _ unsafe.Pointer, fontType, _ uintptr) uintptr {
	if lpelfe == nil {
		return 1
	}
	if fontType&rasterFontType != 0 {
		return 1
	}
	name := syscall.UTF16ToString((*enumLogFontExW)(lpelfe).LogFont.FaceName[:])
	if name != "" {
		scratch = append(scratch, name)
	}
	return 1
}
