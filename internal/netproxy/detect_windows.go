//go:build windows

package netproxy

import (
	"syscall"
	"unsafe"
)

/*
 * 读 Windows 那个「系统代理」开关。
 *
 * 只认注册表，因为 Clash / v2rayN 那一类软件默认就是改这里，
 * 也正是本程序（和我门给 git 子进程的环境变量）读不到的那个地方。
 * 用 syscall 直接调 advapi32，不引 golang.org/x/sys：这点需求不值得为它
 * 破掉「零第三方依赖」。
 */

const internetSettingsKey = `Software\Microsoft\Windows\CurrentVersion\Internet Settings`

// systemProxy 返回 ProxyServer 的原始值；ProxyEnable 为 0 时视为没有。
func systemProxy() (string, bool) {
	key, err := openRegKey(internetSettingsKey)
	if err != nil {
		return "", false
	}
	defer syscall.RegCloseKey(key)

	// 开关关着的时候 ProxyServer 里还留着上次的地址，那是个死地址，
	// 照着它填进去只会让用户以为「扫描扫错了」
	if on, ok := queryDword(key, "ProxyEnable"); !ok || on == 0 {
		return "", false
	}
	// 走 PAC 脚本的情况拿不到单一地址，这里不猜
	return queryString(key, "ProxyServer")
}

func openRegKey(path string) (syscall.Handle, error) {
	p, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var h syscall.Handle
	if err := syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, p, 0, syscall.KEY_READ, &h); err != nil {
		return 0, err
	}
	return h, nil
}

// readValue 先问长度再取值。
func readValue(key syscall.Handle, name string) (uint32, []byte, error) {
	p, err := syscall.UTF16PtrFromString(name)
	if err != nil {
		return 0, nil, err
	}
	var typ, size uint32
	if err := syscall.RegQueryValueEx(key, p, nil, &typ, nil, &size); err != nil {
		return 0, nil, err
	}
	buf := make([]byte, size+8) // 多留几个字节：值可能在两次调用之间变长
	if err := syscall.RegQueryValueEx(key, p, nil, &typ, &buf[0], &size); err != nil {
		return 0, nil, err
	}
	return typ, buf[:size], nil
}

func queryDword(key syscall.Handle, name string) (uint32, bool) {
	typ, b, err := readValue(key, name)
	if err != nil || typ != syscall.REG_DWORD || len(b) < 4 {
		return 0, false
	}
	return *(*uint32)(unsafe.Pointer(&b[0])), true
}

func queryString(key syscall.Handle, name string) (string, bool) {
	typ, b, err := readValue(key, name)
	if err != nil || (typ != syscall.REG_SZ && typ != syscall.REG_EXPAND_SZ) || len(b) < 2 {
		return "", false
	}
	// UTF-16LE，尾部可能跟着一个 \x00
	u := make([]uint16, 0, len(b)/2)
	for i := 0; i+1 < len(b); i += 2 {
		v := uint16(b[i]) | uint16(b[i+1])<<8
		if v == 0 {
			break
		}
		u = append(u, v)
	}
	s := syscall.UTF16ToString(u)
	return s, s != ""
}
