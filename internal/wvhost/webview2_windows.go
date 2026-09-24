//go:build windows

// WebView2 的宿主逻辑：加载 Loader DLL → 建环境 → 建控制器 → 导航。
//
// vtable 下标全部对着官方 WebView2.h（SDK 1.0.3124）数过，注释里标了
// 接口名和方法名。改这里的任何数字前先重数一遍头文件。
package wvhost

import (
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"unsafe"
)

//go:embed WebView2Loader.dll
var loaderDLL []byte

var (
	procCreateEnv uintptr // CreateCoreWebView2EnvironmentWithOptions
	loadOnce      sync.Once
	loadErr       error
)

// loadLoader 把内嵌的 WebView2Loader.dll 落到磁盘再 LoadLibrary。
//
// 这个 dll 是进 COM 的唯一入口（官方设计如此），没法从内存加载。
// 落盘位置：优先 exe 旁边（安装目录，一次写好以后都在），
// 没有写权限再退回临时目录。写文件用「临时名 + 改名」保证原子。
func loadLoader() error {
	loadOnce.Do(func() {
		target := ""
		if exe, err := os.Executable(); err == nil {
			p := filepath.Join(filepath.Dir(exe), "WebView2Loader.dll")
			if writeAtomically(p) == nil {
				target = p
			}
		}
		if target == "" {
			p := filepath.Join(os.TempDir(), "QuickFileDispatch-WebView2Loader.dll")
			if writeAtomically(p) != nil {
				loadErr = fmt.Errorf("WebView2Loader.dll 落盘失败")
				return
			}
			target = p
		}
		h, err := syscall.LoadLibrary(target)
		if err != nil {
			loadErr = fmt.Errorf("加载 WebView2Loader.dll 失败：%w", err)
			return
		}
		p, err := findProc(h, "CreateCoreWebView2EnvironmentWithOptions")
		if err != nil {
			loadErr = err
			return
		}
		procCreateEnv = p
	})
	return loadErr
}

func writeAtomically(path string) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, loaderDLL, 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		// 目标已存在（上一次运行写的，或正被本进程加载着）——只要文件在就用它
		if _, statErr := os.Stat(path); statErr == nil {
			return nil
		}
		return err
	}
	return nil
}

func findProc(h syscall.Handle, name string) (uintptr, error) {
	p, err := syscall.GetProcAddress(h, name)
	if err != nil || p == 0 {
		return 0, fmt.Errorf("WebView2Loader.dll 里找不到 %s", name)
	}
	return p, nil
}

/* ------------------------------------------------------------ 环境与控制器 */

// webview 持有创建成功后的接口指针。只在 UI 线程上碰。
type webview struct {
	env  unsafe.Pointer // ICoreWebView2Environment
	ctrl unsafe.Pointer // ICoreWebView2Controller（本体至少是 Controller2）
	core unsafe.Pointer // ICoreWebView2
}

var wv webview

// keptHandlers 钉住交给 COM 的回调对象。
//
// createWebView 返回后这些局部变量就从 Go 侧「不可达」了，但 COM 还握着
// 它们的裸指针随时要回调 —— GC 一收就是拿野虚表调函数，症状随机
// （窗口闪没、崩溃、回调不触发）。COM 不参与 Go 的 GC，必须自己保活。
var keptHandlers []*comHandler

// createWebView 启动异步创建链：
//
//	CreateCoreWebView2EnvironmentWithOptions
//	  → 环境就绪回调 → environment.CreateCoreWebView2Controller(hwnd)
//	    → 控制器就绪回调 → 存指针、导航、显示窗口
//
// 回调在 UI 线程的消息循环里到达，所以本函数返回后要尽快进消息循环。
func createWebView(userDataDir, url string, bg uint32) error {
	if err := loadLoader(); err != nil {
		return err
	}

	ctrlDone := newHandler(&iidCtrlDone, syscall.NewCallback(
		func(self, errCode uintptr, ctrl unsafe.Pointer) uintptr {
			if ctrl == nil {
				fmt.Fprintf(os.Stderr, "[wvhost] 控制器创建失败：HRESULT 0x%X\n", errCode)
				return sOK
			}
			onControllerReady(ctrl, url, bg)
			return sOK
		}))

	envDone := newHandler(&iidEnvDone, syscall.NewCallback(
		func(self, errCode uintptr, env unsafe.Pointer) uintptr {
			if env == nil {
				fmt.Fprintf(os.Stderr, "[wvhost] 环境创建失败：HRESULT 0x%X\n", errCode)
				return sOK
			}
			// 必须自己 AddRef 持有：回调一返回 WebView2 会释放它那侧的引用，
			// 没人持有的话对象直接被析构——后续浏览器进程会跟着被优雅关闭，
			// 症状就是「浏览器子进程起来一秒内全体静默退出」。
			comAddRef(env)
			wv.env = env
			// ICoreWebView2Environment::CreateCoreWebView2Controller [槽 3]
			hr := vcall(env, 3, gHwnd.Load(), ctrlDone.self)
			if hr != sOK {
				fmt.Fprintf(os.Stderr, "[wvhost] CreateCoreWebView2Controller 返回 0x%X\n", hr)
			}
			return sOK
		}))

	ud, err := syscall.UTF16PtrFromString(userDataDir)
	if err != nil {
		return err
	}
	keptHandlers = append(keptHandlers, envDone, ctrlDone)
	hr, _, _ := syscall.SyscallN(procCreateEnv,
		0, // browserExecutableFolder：nil = 用系统安装的运行时
		uintptr(unsafe.Pointer(ud)),
		0, // environmentOptions：nil 用默认；调试参数走环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
		envDone.self)
	if hr != sOK {
		return fmt.Errorf("创建 WebView2 环境失败（HRESULT 0x%X）——多半是没装 WebView2 运行时", hr)
	}
	return nil
}

// onControllerReady 在控制器就绪回调里完成装配。
func onControllerReady(ctrl unsafe.Pointer, url string, bg uint32) {
	fmt.Fprintf(os.Stderr, "[wvhost] 控制器就绪 ctrl=%p\n", ctrl)
	// 同环境：controller / core 都要自己 AddRef 持有，理由见 envDone 回调里的注释
	comAddRef(ctrl)
	wv.ctrl = ctrl
	if os.Getenv("QFD_WV2_BISECT") == "1" {
		// 二分排查：只创建不装配，看浏览器进程死不死
		return
	}
	// ICoreWebView2Controller::get_CoreWebView2 [槽 25]
	wv.core = vcallOut(ctrl, 25)
	comAddRef(wv.core)

	// ICoreWebView2Controller2::put_DefaultBackgroundColor [槽 27]
	// 设成 Electron 版那个深色底（#0a1018），深色主题下启动不闪白。
	vcall(ctrl, 27, uintptr(bg))

	// ICoreWebView2::get_Settings [槽 3]
	// → QI ICoreWebView2Settings9
	// → put_IsNonClientRegionSupportEnabled [槽 38]（VARIANT_TRUE = 0xFFFF）
	//
	// 打开后渲染层现成的 -webkit-app-region: drag（Electron 的拖动机制，
	// app.css 的 .topbar 上就写着）由 WebView2 原生接管：拖动、双击最大化
	// 都走系统非客户区路径。不能靠 bridge.js 的 mousedown 垫片自己发
	// WM_NCLBUTTONDOWN —— 按下时浏览器进程握着鼠标捕获，宿主的拖动循环
	// 启动了也收不到移动，实测窗口纹丝不动（2026-09-23）。
	if settings := vcallOut(wv.core, 3); settings != nil {
		// ICoreWebView2Settings 基接口（不需要 QI），vtable 顺序对着 WebView2.h
		// （SDK 1.0.3124，头文件 ICoreWebView2SettingsVtbl）数：
		// 0 QueryInterface / 1 AddRef / 2 Release、
		// 3 get_IsScriptEnabled / 4 put_IsScriptEnabled、
		// 5 get_IsWebMessageEnabled / 6 put_IsWebMessageEnabled、
		// 7 get_AreDefaultScriptDialogsEnabled / 8 put_AreDefaultScriptDialogsEnabled、
		// 9 get_IsStatusBarEnabled / 10 put_IsStatusBarEnabled、
		// 11 get_AreDevToolsEnabled / 12 put_AreDevToolsEnabled、
		// 13 get_AreDefaultContextMenusEnabled / 14 put_AreDefaultContextMenusEnabled、
		// 15 get_AreHostObjectsAllowed / 16 put_AreHostObjectsAllowed、……

		// [槽 10] put_IsStatusBarEnabled(false)：关掉悬停链接时左下角那条 URL
		// 角标。它是浏览器层画在页面之外的，DOM/CSS 拦不住，只能原生关。
		vcall(settings, 10, 0)

		// [槽 14] put_AreDefaultContextMenusEnabled(false)：全局关掉浏览器默认
		// 右键菜单。注意语义：只关浏览器自带的菜单，页面 DOM 的 contextmenu
		// 事件仍照常触发 —— 文件管理页 manage.js 自己的右键菜单（contextmenu
		// 里 preventDefault + 自绘 .menu）继续工作，其它页面右键则无菜单。
		vcall(settings, 14, 0)

		if s9 := comQI(settings, &iidSettings9); s9 != nil {
			vcall(s9, 38, uintptr(0xFFFF))
		} else {
			fmt.Fprintln(os.Stderr, "[wvhost] 运行时没有 ICoreWebView2Settings9（太旧），标题栏拖动退回 bridge.js 垫片")
		}
	}

	// 先铺满再导航，避免内容从左上角一小块展开
	fitToBounds(ctrl)

	// ICoreWebView2::Navigate [槽 5]
	if u, err := syscall.UTF16PtrFromString(url); err == nil {
		vcall(wv.core, 5, uintptr(unsafe.Pointer(u)))
	}
	// 窗口已在 Run 里先行显示（见那里的注释），这里不再重复 show
}

// fitToBounds 让控制器铺满整个客户区。
//
// 2.9.0 早期版本曾在左、右、下三边留一条「缩放带」不盖：WebView2 的子
// 窗口会把鼠标命中测试全部吃掉，留带子宿主才能收到 WM_NCHITTEST 走原生
// 缩放（Tauri 同款思路）。但带子露出来的只能是纯色底，页面边缘的星野/
// 点阵画不进去，深浅主题下都看得出一条段落缝（杰哥原话「明显的段落感」）。
// 现改为页面铺满 + 渲染层边缘隐形缩放条（bridge.js）调 win:resizeEdge，
// 宿主轮询光标自己缩放（resize_windows.go），观感与 Electron 版一致。
func fitToBounds(ctrl unsafe.Pointer) {
	r := clientRect(gHwnd.Load())
	// put_Bounds(RECT) [槽 6]。x64 ABI：大于 8 字节的结构体按**引用**传
	// （调用方复制一份、传指针）—— 不是 System V 那种「16 字节拆两个寄存器」，
	// 想当然拆开传会直接访问违例。
	vcall(ctrl, 6, uintptr(unsafe.Pointer(&r)))
}

// SetBackground 运行中改控制器底色（Controller2::put_DefaultBackgroundColor [槽 27]）。
// 主题切换时由 ipc 的 OnBackground 钩子调过来：页面还没画出来的一瞬露的就是它。
// 控制器还没就绪时静默忽略 —— 启动路径用的是 Options.Background。
func SetBackground(color uint32) {
	if wv.ctrl != nil {
		vcall(wv.ctrl, 27, uintptr(color))
	}
}

// closeWebView 关控制器。在 WM_DESTROY 里调用（已在 UI 线程）。
func closeWebView() {
	if wv.ctrl != nil {
		// ICoreWebView2Controller::Close [槽 24]
		// （21 是 get_ParentWindow——照官方头文件数：IsVisible 3/4、Bounds 5/6、
		// ZoomFactor 7/8、ZoomFactorChanged 9/10、SetBoundsAndZoomFactor 11、
		// MoveFocus 12、MoveFocusRequested 13/14、GotFocus 15/16、LostFocus 17/18、
		// AcceleratorKeyPressed 19/20、ParentWindow 21/22、NotifyParent 23、Close 24、
		// get_CoreWebView2 25；Controller2 的 put_DefaultBackgroundColor 顺延到 27）
		vcall(wv.ctrl, 24)
		wv = webview{}
	}
}
