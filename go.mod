module cnb.cool/youngdajie/Quick-FileDispatch

// 目标：Windows 桌面端，安装包 10 MB 级。
//
// 目前**零第三方依赖**，只用标准库 —— 这不是洁癖，是刻意的：
//   1. Electron 版 106 MB 里有将近 100 MB 是它自带的 Chromium 运行时，
//      换成 Go + 系统 WebView2 之后，「我们自己的代码」就是安装包的全部，
//      所以每一兆都要省着花；
//   2. 目标机器是国内 Windows，能少一个模块代理的坑就少一个。
// 什么时候可以破例：窗口壳如果最终选了需要 cgo 的 WebView2 绑定
// （见 main.go 的待办），会引入 golang.org/x/sys 一类的间接依赖，那时再放进来。
//
// go 1.24 是刻意压低的下限，不是本机版本（本机 1.27.1）：
// 用不到新语法就别把门槛设高，将来 CNB 流水线里换 Go 版本也不会被卡住。
go 1.24
