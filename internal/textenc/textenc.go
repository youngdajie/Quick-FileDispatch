// Package textenc 把一段字节当文本解开，对应 Electron 版 main.js 的 decodeText。
//
// 四件事必须在这里做完，不能丢给渲染层：
//
//  1. 二进制要在读完前就认出来 —— 一张 2 MB 的图当文本塞进 textarea 会直接卡死界面；
//  2. 换行统一成 \n 再交出去，但要**记下原始换行符**：textarea 的 value 本身就会
//     把 \r\n 归一成 \n，不记下来，保存时就会把整个文件改成 LF，Git 里是满屏 diff；
//  3. BOM 记录在案，保存时原样写回；
//  4. 不是 UTF-8 的老文件不能当乱码扔出去。中文 Windows 上「记事本存过的」
//     HTML / CSS / bat / ini 大量是 GBK（ANSI），按 UTF-8 硬解就是满屏乱码 ——
//     而这跟换行符没关系：同样是 CRLF，UTF-8 的没事、GBK 的就花了，
//     很容易被误判成「CRLF 的文件预览乱码」。
//
// 非 UTF-8 解出来的文字**只给看，不给改**：改回去会把整份文件从 GBK 变成 UTF-8，
// 一次「改个错别字」就能让 Git 里出现全文件重写。所以结果里带 Editable。
package textenc

import (
	"bytes"
	"strings"
	"unicode/utf8"
)

// Result 是一次解码的结果。字段名和 Electron 版逐一对应。
type Result struct {
	OK       bool   `json:"ok"`
	Reason   string `json:"reason,omitempty"` // binary | utf16
	Text     string `json:"text"`
	BOM      bool   `json:"bom"`
	EOL      string `json:"eol"`      // "crlf" | "lf"
	Encoding string `json:"encoding"` // utf-8 | gb18030 | unknown
	Editable bool   `json:"editable"` // 只有 utf-8 允许改写
}

// Decode 解开一段字节。
// 失败时返回 ok=false 与原因，由调用方决定怎么提示（不要丢给渲染层猜）。
func Decode(buf []byte) Result {
	// UTF-16：前两个字节是 BOM。这两种一律拒绝 —— 界面上没有按 UTF-16 写回的通路。
	if len(buf) >= 2 && ((buf[0] == 0xff && buf[1] == 0xfe) || (buf[0] == 0xfe && buf[1] == 0xff)) {
		return Result{OK: false, Reason: "utf16"}
	}

	bom := false
	body := buf
	if len(buf) >= 3 && buf[0] == 0xef && buf[1] == 0xbb && buf[2] == 0xbf {
		bom = true
		body = buf[3:]
	}

	// 前 8 KB 里出现 NUL 就当二进制。文本文件里几乎不可能有 NUL，
	// 而有 NUL 的又几乎一定是二进制 —— 这条判据便宜且准。
	head := body
	if len(head) > 8192 {
		head = head[:8192]
	}
	if bytes.IndexByte(head, 0) >= 0 {
		return Result{OK: false, Reason: "binary"}
	}

	var text string
	encoding := "utf-8"
	if utf8.Valid(body) {
		// utf8.Valid 是**严格**判定：一遇到非法字节就为 false。
		// 对应 Electron 版 TextDecoder('utf-8', {fatal:true}) 的用法，
		// 千万别换成「把坏字节换成 U+FFFD」的非严格解码 ——
		// 那样 GBK 文件也会「解成功」，只是满屏替换符。
		text = string(body)
	} else if gbk, ok := decodeGB18030(body); ok {
		text = gbk
		encoding = "gb18030"
	} else {
		// 既不是 UTF-8 也不是 GB18030（多半是 Latin-1 那一类单字节编码）。
		// 退回非严格解码：坏字节显示成替换符，至少完好部分还看得见。
		text = string(bytes.ToValidUTF8(body, []byte(string(utf8.RuneError))))
		encoding = "unknown"
	}

	eol := "lf"
	if strings.Contains(text, "\r\n") {
		eol = "crlf"
	}
	text = strings.ReplaceAll(text, "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")

	return Result{
		OK:       true,
		Text:     text,
		BOM:      bom,
		EOL:      eol,
		Encoding: encoding,
		Editable: encoding == "utf-8",
	}
}

// Encode 把文本写回字节，还原 BOM 与原始换行符。
//
// 保存时**必须**走这里：用户在 textarea 里改的是 \n，而文件原本可能是 CRLF，
// 直接写出去就是「改一个字，整个文件 diff」。
func Encode(text string, bom bool, eol string) []byte {
	if eol == "crlf" {
		text = strings.ReplaceAll(text, "\n", "\r\n")
	}
	var buf bytes.Buffer
	if bom {
		buf.Write([]byte{0xef, 0xbb, 0xbf})
	}
	buf.WriteString(text)
	return buf.Bytes()
}
