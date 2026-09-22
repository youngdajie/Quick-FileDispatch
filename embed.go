package main

import (
	"embed"
	"io/fs"
)

// 把渲染层整个编进 exe。
//
// 注意 embed 指令**不能写 ..**，所以这个文件必须待在模块根：
// src/renderer 是它的子目录，恰好满足。
//
// 这也是「渲染层一行不改」这条承诺的落点 —— 编进去的就是 Electron 版
// 正在用的那份 src/renderer，没有拷贝、没有分叉。等 Go 版站稳了，
// 再把渲染层挪到自己的顶层目录（比如 ui/），那时两边就真的分家了。
//
// all: 前缀是为了把 _ 和 . 开头的文件也带上（默认会被忽略）。
//
//go:embed all:src/renderer
var rendererFS embed.FS

// 垫片：把 window.cloudpic 从 Electron IPC 接到本地 HTTP 的 /ipc 上。
//
//go:embed web/bridge.js
var bridgeJS []byte

// renderer 是剥掉 src/renderer 前缀之后的静态资源根，直接对应 URL 的 /。
var renderer = mustSub(rendererFS, "src/renderer")

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic("嵌入静态资源失败：" + err.Error())
	}
	return sub
}
