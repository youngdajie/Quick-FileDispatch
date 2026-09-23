//go:build windows

package textenc

import (
	"strings"
	"syscall"
	"unicode/utf16"
	"unicode/utf8"
	"unsafe"
)

// 取切片首元素的指针。空切片给 nil —— 不能对空切片取 &b[0]（会 panic）。
func ptrOf(b []byte) unsafe.Pointer {
	if len(b) == 0 {
		return nil
	}
	return unsafe.Pointer(&b[0])
}

func ptrOfU16(b []uint16) unsafe.Pointer {
	if len(b) == 0 {
		return nil
	}
	return unsafe.Pointer(&b[0])
}

// decodeGB18030 用系统的码表把 GBK / GB18030 字节解成字符串。
//
// 为什么要绕 Win32 的 MultiByteToWideChar，而不是在 Go 里内置一张码表：
//   - GB18030 是**国家标准**，码表几万个码位，自己实现既大又容易和系统的行为对不上；
//   - 中文 Windows 上这份码表本来就在系统里，而且跟着系统补丁走；
//   - 项目坚持零第三方依赖（不引 golang.org/x/text），这条路正好不用加依赖。
//
// 判据和 Electron 版一致：**出现替换符就认为猜错了编码**（返回 false），
// 让调用方继续往 Latin-1 那条退，而不是把一个「解出来了但是花的」结果交出去。
func decodeGB18030(b []byte) (string, bool) {
	kernel32 := syscall.NewLazyDLL("kernel32.dll")
	proc := kernel32.NewProc("MultiByteToWideChar")

	// 先问需要多大的缓冲区（传 0 长度就只回长度）
	need, _, _ := proc.Call(
		uintptr(gbCodePage),
		uintptr(mbErrInvalidChars), // 遇到非法字节直接失败，别悄悄换成替换符
		uintptr(ptrOf(b)),
		uintptr(len(b)),
		0,
		0,
	)
	if need == 0 {
		return "", false
	}

	buf := make([]uint16, need)
	n, _, _ := proc.Call(
		uintptr(gbCodePage),
		uintptr(mbErrInvalidChars),
		uintptr(ptrOf(b)),
		uintptr(len(b)),
		uintptr(ptrOfU16(buf)),
		need,
	)
	if n == 0 {
		return "", false
	}

	s := string(utf16.Decode(buf[:n]))
	if strings.ContainsRune(s, utf8.RuneError) {
		return "", false
	}
	return s, true
}

// gbCodePage：54936 = GB18030（兼容 GBK / GB2312，是它们的超集）。
// 用 54936 而不是 936，是因为老文件里偶尔会出现四字节的 GB18030 码位，
// 936 解不了，54936 能。
const gbCodePage = 54936

// mbErrInvalidChars：让 MultiByteToWideChar 遇到非法字节时报错，
// 而不是悄悄塞一个 U+FFFD。这是「这份到底是不是 GBK」的判据所在。
const mbErrInvalidChars = 0x00000008
