// Package dpapi 保管 Token 这类短秘密，格式与 Electron 的 safeStorage **完全兼容**。
//
// # 为什么不能只调 CryptProtectData
//
// 一开始最容易想到「safeStorage 在 Windows 上就是 DPAPI」，于是直接调
// CryptProtectData —— 结果 Electron 留下的密文一个都解不开，报
// "The data is invalid"。原因是 Chromium 从 M80 起换了格式：
//
//	Local State 里存一把 AES-256-GCM 密钥，这把密钥本身才用 DPAPI 保护；
//	真正的数据用这把 AES 密钥加密。
//
// 所以密文长这样（所谓 v10）：
//
//	"v10" (3) || nonce (12) || AES-256-GCM 密文 || 认证标签 (16)
//
// 而 Local State 里的 os_crypt.encrypted_key 是：
//
//	"DPAPI" (5) || CryptProtectData(32 字节 AES 密钥)
//
// 照这个格式读写，两边的配置就能互相解开 —— 用户从 Electron 版升级过来，
// Token 不用重填。这一层是整个迁移里最容易静默失败的地方：解不开的时候
// 界面只会显示「没有 Token」，然后让人以为是配置丢了。
//
// # 只支持 Windows
//
// 别的平台没有 DPAPI，也不该假装加密了。Encrypt 会明确返回错误，
// 让调用方提示用户，而不是悄悄把明文写进 config.json ——
// 「已加密」这个承诺不能打折。
package dpapi

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// v10Prefix 是 Chromium OSCrypt 的版本标记。解密时靠它分辨格式，
// 加密时必须原样写在最前面，否则 Electron 认不出来。
var v10Prefix = []byte("v10")

// dpapiPrefix 是 Local State 里密钥的前缀。Chromium 用它标记
// 「这段是用 DPAPI 包着的」，将来换了保护机制可以靠它分流。
var dpapiPrefix = []byte("DPAPI")

const aesKeyLen = 32
const nonceLen = 12

// Vault 保管一个用户数据目录下的加密能力。
//
// 用结构体而不是包级全局，是为了让自检能同时开两个实例（真实配置 + 临时配置），
// 各用各的 Local State，不会互相污染。
type Vault struct {
	mu        sync.Mutex
	statePath string
	key       []byte
	forbid    bool // 本机不可用，别再反复试
}

// New 打开某个用户数据目录下的保险箱。dir 就是 Electron 的 userData
// （config.json 所在目录），Local State 和它同级。
func New(dir string) *Vault {
	return &Vault{statePath: filepath.Join(dir, "Local State")}
}

// errUnsupported：本机 / 本平台没有可用的加密能力。
// 各平台的实现自己决定什么时候返回它（Windows 上 DPAPI 调不通时也会用到）。
var errUnsupported = errors.New("当前平台不支持 Token 加密（依赖 Windows DPAPI）")

// Available 报告本机能不能真正加解密（跑一次往返验证）。
// 只调 CryptProtectData 成功不代表端到端可用 —— Local State 可能写不进去。
func (v *Vault) Available() bool {
	_, err := v.key32()
	if err != nil {
		return false
	}
	blob, err := v.Encrypt([]byte("probe"))
	if err != nil {
		return false
	}
	got, err := v.Decrypt(blob)
	return err == nil && string(got) == "probe"
}

// Encrypt 加密，返回 v10 格式的密文（可直接写进 _tokenEnc 的 base64）。
func (v *Vault) Encrypt(plain []byte) ([]byte, error) {
	key, err := v.key32()
	if err != nil {
		return nil, err
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, nonceLen)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("生成随机 nonce 失败：%w", err)
	}
	// Seal 的返回值已经是「密文 || 标签」，正好是 v10 的后半段
	out := make([]byte, 0, len(v10Prefix)+nonceLen+len(plain)+16)
	out = append(out, v10Prefix...)
	out = append(out, nonce...)
	out = gcm.Seal(out, nonce, plain, nil)
	return out, nil
}

// Decrypt 解开由 Encrypt、或由 Electron safeStorage 产出的密文。
//
// 两种输入都认：
//   - v10（标准情况）
//   - 裸 DPAPI blob（万一遇到更早的格式）
//
// 解不开时错误里会带上原因，方便判断「是格式不对」还是「换了用户 / 重装过系统」。
func (v *Vault) Decrypt(cipher []byte) ([]byte, error) {
	if len(cipher) == 0 {
		return nil, nil
	}
	if len(cipher) > len(v10Prefix) && string(cipher[:len(v10Prefix)]) == string(v10Prefix) {
		return v.decryptV10(cipher)
	}
	// 不是 v10 —— 当裸 DPAPI 试一次
	return rawDecrypt(cipher)
}

func (v *Vault) decryptV10(cipher []byte) ([]byte, error) {
	key, err := v.key32()
	if err != nil {
		return nil, err
	}
	body := cipher[len(v10Prefix):]
	if len(body) < nonceLen+16 {
		return nil, errors.New("密文太短，不是完整的 v10 数据")
	}
	gcm, err := newGCM(key)
	if err != nil {
		return nil, err
	}
	nonce := body[:nonceLen]
	return gcm.Open(nil, nonce, body[nonceLen:], nil)
}

func newGCM(key []byte) (cipher.AEAD, error) {
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("初始化 AES 失败：%w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("初始化 GCM 失败：%w", err)
	}
	return gcm, nil
}

/* ------------------------------------------------------------ AES 密钥 */

// key32 取出 32 字节的 AES 密钥，第一次调用时解密 / 生成并缓存。
func (v *Vault) key32() ([]byte, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if len(v.key) == aesKeyLen {
		return v.key, nil
	}
	if v.forbid {
		return nil, errUnsupported
	}

	key, err := v.loadKey()
	if err != nil {
		// 读不到（第一次用 / 文件被删了 / 换了用户解不开）→ 自己造一把
		key, err = v.createKey()
		if err != nil {
			// 造不出来说明 DPAPI 本身就不可用，记下来别反复试
			v.forbid = true
			return nil, err
		}
	}
	v.key = key
	return key, nil
}

// loadKey 从 Local State 里读出并解开那把 AES 密钥。
func (v *Vault) loadKey() ([]byte, error) {
	raw, err := os.ReadFile(v.statePath)
	if err != nil {
		return nil, err
	}
	var state struct {
		OSCrypt struct {
			EncryptedKey string `json:"encrypted_key"`
		} `json:"os_crypt"`
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return nil, fmt.Errorf("Local State 不是合法 JSON：%w", err)
	}
	if state.OSCrypt.EncryptedKey == "" {
		return nil, errors.New("Local State 里没有 os_crypt.encrypted_key")
	}
	blob, err := base64.StdEncoding.DecodeString(state.OSCrypt.EncryptedKey)
	if err != nil {
		return nil, fmt.Errorf("encrypted_key 不是合法 base64：%w", err)
	}
	if len(blob) > len(dpapiPrefix) && string(blob[:len(dpapiPrefix)]) == string(dpapiPrefix) {
		blob = blob[len(dpapiPrefix):]
	}
	key, err := rawDecrypt(blob)
	if err != nil {
		return nil, err
	}
	if len(key) != aesKeyLen {
		return nil, fmt.Errorf("解出来的密钥是 %d 字节，期望 32", len(key))
	}
	return key, nil
}

// createKey 生成一把新密钥，用 DPAPI 保护后写进 Local State。
//
// 写回时**必须保留文件里其它字段**：Local State 是 Electron / Chromium 的
// 全局状态文件，里面有窗口位置、设备 id 等一堆东西，整个覆盖掉会让
// Electron 版下次启动表现异常（比如窗口位置丢了）。
func (v *Vault) createKey() ([]byte, error) {
	key := make([]byte, aesKeyLen)
	if _, err := rand.Read(key); err != nil {
		return nil, fmt.Errorf("生成随机密钥失败：%w", err)
	}
	protected, err := rawEncrypt(key)
	if err != nil {
		return nil, err
	}
	stored := make([]byte, 0, len(dpapiPrefix)+len(protected))
	stored = append(stored, dpapiPrefix...)
	stored = append(stored, protected...)

	state := map[string]any{}
	if raw, err := os.ReadFile(v.statePath); err == nil {
		// UseNumber：把数字读成 json.Number 而不是 float64，
		// 写回时才会原样输出成 123 而不是 123.0 / 1.23e+06
		dec := json.NewDecoder(bytesReader(raw))
		dec.UseNumber()
		_ = dec.Decode(&state)
	}
	osCrypt, _ := state["os_crypt"].(map[string]any)
	if osCrypt == nil {
		osCrypt = map[string]any{}
	}
	osCrypt["encrypted_key"] = base64.StdEncoding.EncodeToString(stored)
	state["os_crypt"] = osCrypt

	buf, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(filepath.Dir(v.statePath), 0o755); err != nil {
		return nil, err
	}
	if err := os.WriteFile(v.statePath, buf, 0o600); err != nil {
		return nil, fmt.Errorf("写 Local State 失败：%w", err)
	}
	return key, nil
}
