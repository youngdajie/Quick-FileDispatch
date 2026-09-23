//go:build !windows

package textenc

// 非 Windows 上没有 MultiByteToWideChar，也就没有系统的中文码表可用。
//
// 这里**不做**「按 UTF-8 硬解」的兜底 —— 那正是乱码的来源：
// 一个 GBK 文件会被解成一串替换符，界面显示「预览成功」但内容是花的，
// 比直接说「认不出这个编码」更难排查。
//
// 本项目（快捷文件分发服务@JIE）只出 Windows 包，这条分支只是为了
// 让代码在别的系统上也能编译。
func decodeGB18030(b []byte) (string, bool) {
	return "", false
}
