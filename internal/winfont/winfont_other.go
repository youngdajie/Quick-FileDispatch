//go:build !windows

package winfont

// Families 在非 Windows 平台上是空实现。
// 这个程序只发 Windows 版（安装包、图标、字体枚举都按 Windows 来），
// 留这个文件只是为了让 `go build ./...` 在别的平台上不会因为
// 「包里一个 .go 文件都没有」而报错，方便以后接 CI。
func Families() []string { return []string{} }
