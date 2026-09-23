//go:build windows

// 这一个文件是「用纯 syscall 走 COM」的最底层：GUID、虚表调用、回调对象。
//
// 为什么不用 cgo / go-ole：本项目保持零第三方依赖，而 WebView2 要用的
// COM 面其实很窄（两个回调 + 三个接口的六七个方法），手写完全可控。
// 手写的代价是 vtable 下标必须**逐字对着 WebView2.h 核对**——MIDL 生成的
// 接口方法顺序就是虚表顺序，差一个槽位就是跳到别人的函数上，直接崩。
package wvhost

import (
	"syscall"
	"unsafe"
)

/* ------------------------------------------------------------ GUID */

// guid 是 COM IID 的内存布局（小端，MIDL 顺序）。struct 可直接 == 比较。
type guid struct {
	Data1 uint32
	Data2 uint16
	Data3 uint16
	Data4 [8]byte
}

var (
	iidIUnknown = guid{0x00000000, 0x0000, 0x0000,
		[8]byte{0xC0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x46}}

	// ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler
	iidEnvDone = guid{0x4e8a3389, 0xc9d8, 0x4bd2,
		[8]byte{0xb6, 0xb5, 0x12, 0x4f, 0xee, 0x6c, 0xc1, 0x4d}}

	// ICoreWebView2CreateCoreWebView2ControllerCompletedHandler
	iidCtrlDone = guid{0x6c4819f3, 0xc9b7, 0x4260,
		[8]byte{0x81, 0x27, 0xc9, 0xf5, 0xbd, 0xe7, 0xf6, 0x8c}}
)

/* ------------------------------------------------------------ 虚表调用 */

// vcall 调 COM 接口的第 index 个虚表方法（index 含 IUnknown 的 0/1/2）。
//
// obj 是接口指针（指向的对象首字段是虚表指针）。指针运算全走 unsafe.Add、
// 只在传给 SyscallN 的那一刻才转 uintptr —— go vet 只认这个形状。
func vcall(obj unsafe.Pointer, index int, args ...uintptr) uintptr {
	vt := *(*unsafe.Pointer)(obj)
	fn := *(*uintptr)(unsafe.Add(vt, index*8))
	all := append([]uintptr{uintptr(obj)}, args...)
	ret, _, _ := syscall.SyscallN(fn, all...)
	return ret
}

// vcallOut 调一个「返回接口指针」的方法：COM 惯例出参是 (T** ppv)。
func vcallOut(obj unsafe.Pointer, index int) unsafe.Pointer {
	var out unsafe.Pointer
	vcall(obj, index, uintptr(unsafe.Pointer(&out)))
	return out
}

// comAddRef 调 IUnknown::AddRef [槽 1]。
//
// 回调参数里收到的接口指针（env/controller/core）必须显式持有：
// 回调返回后 WebView2 会释放它那侧的引用，这里不加的话对象被析构，
// 浏览器进程会随之被「优雅关闭」——整个进程树一秒内静默退出，
// 无崩溃转储、无日志、宿主还活着，极难排查。
func comAddRef(obj unsafe.Pointer) {
	if obj != nil {
		vcall(obj, 1)
	}
}

// vcallStr 调一个「接收字符串出参」的方法：出参是 LPWSTR*，调用方负责释放。
func vcallStr(obj unsafe.Pointer, index int) string {
	var p *uint16
	vcall(obj, index, uintptr(unsafe.Pointer(&p)))
	if p == nil {
		return ""
	}
	return utf16ToString(p)
}

func utf16ToString(p *uint16) string {
	n := 0
	for ptr := unsafe.Pointer(p); *(*uint16)(ptr) != 0; n++ {
		ptr = unsafe.Add(ptr, 2)
	}
	return syscall.UTF16ToString(unsafe.Slice(p, n))
}

/* ------------------------------------------------------------ 回调对象 */

// comHandler 是我们交给 WebView2 的回调对象（环境就绪 / 控制器就绪）。
// COM 会先 QueryInterface 要接口，事件发生时调 Invoke。
//
// 生命周期：一个进程就两个对象、活到进程结束，AddRef/Release 糊弄成
// 返回 1 即可；真正的 Go 对象挂在包级变量上不会被 GC。
type comHandler struct {
	vt   *handlerVtbl
	iid  *guid
	self uintptr // 自己的地址（QueryInterface 要回填）
}

type handlerVtbl struct {
	queryInterface uintptr
	addRef         uintptr
	release        uintptr
	invoke         uintptr
}

// newHandler 造一个回调对象。invoke 由调用方用 NewCallback 造好传进来。
func newHandler(iid *guid, invoke uintptr) *comHandler {
	h := &comHandler{iid: iid}
	h.vt = &handlerVtbl{
		// 回调参数直接声明成 unsafe.Pointer：NewCallback 允许指针尺寸的参数，
		// 这样从 uintptr 到指针的转换发生在系统边界上，不经过我们的手
		queryInterface: syscall.NewCallback(func(self, riid, ppv unsafe.Pointer) uintptr {
			g := (*guid)(riid)
			if *g == *h.iid || *g == iidIUnknown {
				*(*uintptr)(ppv) = uintptr(h.self)
				return 0 // S_OK
			}
			*(*uintptr)(ppv) = 0
			return 0x80004002 // E_NOINTERFACE
		}),
		addRef:  syscall.NewCallback(func(uintptr) uintptr { return 1 }),
		release: syscall.NewCallback(func(uintptr) uintptr { return 1 }),
		invoke:  invoke,
	}
	h.self = uintptr(unsafe.Pointer(h))
	return h
}

/* ------------------------------------------------------------ 常量（HRESULT） */

const (
	sOK           = 0
	eNoInterface  = 0x80004002
	eFail         = 0x80004005
	hrNotFound    = 0x80070002 // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
	hrAlreadyDone = 0x800700B7 // ERROR_ALREADY_EXISTS
)
