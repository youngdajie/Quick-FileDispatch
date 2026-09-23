//go:build !windows

package dpapi

import (
	"bytes"
	"errors"
	"io"
)

// 非 Windows 上没有 DPAPI，也就没有地方安全地藏那把 AES 密钥
// （藏了等于没藏 —— 密钥和密文放一起，谁都能解）。
//
// 所以这里**不做明文兜底**：直接报「不支持」。
// 悄悄存明文会把「Token 已加密」这个承诺变成谎言 —— 用户以为安全，
// 实际上 Token 就躺在 config.json 里，而这个承诺在关于页上是写出来的。
//
// 本项目只出 Windows 包，这条分支只是为了让代码在别的系统上也能编译。
func rawEncrypt(plain []byte) ([]byte, error) { return nil, errUnsupported }

func rawDecrypt(cipher []byte) ([]byte, error) { return nil, errUnsupported }

func bytesReader(b []byte) io.Reader { return bytes.NewReader(b) }
