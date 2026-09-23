//go:build windows

package dpapi

import (
	"bytes"
	"errors"
	"io"
	"syscall"
	"unsafe"
)

// rawEncrypt / rawDecrypt 是裸 DPAPI：直接调 CryptProtectData / CryptUnprotectData。
//
// 参数是刻意和 Chromium 保持一致的：
//   - 不加额外熵（pOptionalEntropy = null）
//   - 不写描述
//   - CRYPTPROTECT_UI_FORBIDDEN：不弹任何界面
//   - **不加** CRYPTPROTECT_LOCAL_MACHINE：绑当前用户，同机其它账户解不开
//
// 少加或多加任何一个，产出的密文就和 Electron 的不互通。
const uiForbidden = 0x1

var (
	crypt32       = syscall.NewLazyDLL("crypt32.dll")
	procProtect   = crypt32.NewProc("CryptProtectData")
	procUnprotect = crypt32.NewProc("CryptUnprotectData")
	kernel32      = syscall.NewLazyDLL("kernel32.dll")
	procLocalFree = kernel32.NewProc("LocalFree")
)

// dataBlob 是 DPAPI 唯一认的输入输出结构：一段字节 + 长度。
type dataBlob struct {
	cbData uint32
	pbData *byte
}

func blobOf(b []byte) *dataBlob {
	if len(b) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{cbData: uint32(len(b)), pbData: &b[0]}
}

func (b *dataBlob) bytes() []byte {
	if b == nil || b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	return out
}

// free 释放 DPAPI 自己分配的缓冲区。不释放就漏内存，
// 而 Token 每次保存都会走一次。
func (b *dataBlob) free() {
	if b != nil && b.pbData != nil {
		procLocalFree.Call(uintptr(unsafe.Pointer(b.pbData)))
		b.pbData = nil
	}
}

func rawEncrypt(plain []byte) ([]byte, error) {
	in := blobOf(plain)
	out := &dataBlob{}
	r1, _, err := procProtect.Call(
		uintptr(unsafe.Pointer(in)), 0, 0, 0, 0,
		uiForbidden,
		uintptr(unsafe.Pointer(out)),
	)
	if r1 == 0 {
		return nil, wrap("CryptProtectData", err)
	}
	defer out.free()
	return out.bytes(), nil
}

func rawDecrypt(cipher []byte) ([]byte, error) {
	if len(cipher) == 0 {
		return nil, errors.New("密文是空的")
	}
	in := blobOf(cipher)
	out := &dataBlob{}
	r1, _, err := procUnprotect.Call(
		uintptr(unsafe.Pointer(in)), 0, 0, 0, 0,
		uiForbidden,
		uintptr(unsafe.Pointer(out)),
	)
	if r1 == 0 {
		return nil, wrap("CryptUnprotectData", err)
	}
	defer out.free()
	return out.bytes(), nil
}

// wrap 把 Win32 错误翻译成能看懂的中文。
// err 常常是 "The operation completed successfully."（errno 没被正确设置），
// 那种时候只能给出不带原因的一句话。
func wrap(name string, err error) error {
	if err != nil {
		msg := err.Error()
		if msg != "" && msg != "The operation completed successfully." {
			return errors.New(name + " 失败：" + msg)
		}
	}
	return errors.New(name + " 失败：密文可能已损坏，或换过 Windows 用户 / 重装过系统（DPAPI 绑的是当前用户，换人就解不开）")
}

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
