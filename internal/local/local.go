// Package local 读写「绑定到本地的那个仓库目录」，对应 Electron 版的 src/main/local.js。
//
// 管理页默认直接读本地（快），只有切到「远程」才去调接口。
// 所以列目录 / 统计 / 目录树这三件事在 Go 侧都得有，而且要快 ——
// 界面每进一层目录就问一次。
package local

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/paths"
)

// imageExt 是能直接预览的图片后缀。和 Electron 版的 IMAGE_EXT 逐项对齐，
// 少一个就会「明明是图片却不显示缩略图」。
var imageExt = map[string]bool{
	".jpg": true, ".jpeg": true, ".png": true, ".gif": true, ".webp": true,
	".bmp": true, ".svg": true, ".avif": true, ".ico": true, ".tif": true,
	".tiff": true, ".jfif": true,
}

func IsImage(name string) bool {
	return imageExt[strings.ToLower(filepath.Ext(name))]
}

// skipName：这些条目不该出现在文件列表里（.git 是仓库自身，另两个是系统垃圾文件）。
func skipName(name string) bool {
	switch name {
	case ".git", ".DS_Store", "Thumbs.db":
		return true
	}
	return false
}

// Entry 是列表里的一项，字段和 local.js 的返回值逐字对应 ——
// 渲染层直接按这些名字取值，改一个就是「某列空白」。
type Entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Type    string `json:"type"` // "dir" | "file"
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"` // 毫秒
	IsImage bool   `json:"isImage"`
}

// ListDir 列出 root 下 rel 目录的内容。
// 目录在前、文件在后，同层按名称用中文排序规则排 —— 和 Electron 版一致，
// 不然同一个仓库两边顺序不一样，用户会以为文件丢了。
func ListDir(root, rel string) ([]Entry, error) {
	abs, err := paths.SafeJoin(root, rel)
	if err != nil {
		return nil, err
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		// 目录不存在 / 不是一个目录：当「空的」处理，而不是报错。
		// 列目录处在界面重画的热路径上，抛错会让整页红一片。
		return []Entry{}, nil
	}
	items, err := os.ReadDir(abs)
	if err != nil {
		return []Entry{}, nil
	}

	out := make([]Entry, 0, len(items))
	for _, it := range items {
		name := it.Name()
		if skipName(name) {
			continue
		}
		kind := "file"
		var size int64
		var mtime int64
		if it.IsDir() {
			kind = "dir"
		}
		if info, err := it.Info(); err == nil {
			mtime = info.ModTime().UnixMilli()
			if kind == "file" {
				size = info.Size()
			}
		}
		out = append(out, Entry{
			Name:    name,
			Path:    paths.Join(rel, name),
			Type:    kind,
			Size:    size,
			Mtime:   mtime,
			IsImage: kind == "file" && IsImage(name),
		})
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Type != out[j].Type {
			return out[i].Type == "dir"
		}
		return strings.Compare(out[i].Name, out[j].Name) < 0
	})
	return out, nil
}

// Count 递归统计 { 文件数, 总字节, 图片数 }。深度上限 8 层，
// 和 Electron 版一致 —— 再深也只是数字，不值得继续递归。
type Count struct {
	Files  int64 `json:"files"`
	Bytes  int64 `json:"bytes"`
	Images int64 `json:"images"`
}

func CountDir(root, rel string, depth int, acc *Count) *Count {
	if acc == nil {
		acc = &Count{}
	}
	if depth > 8 {
		return acc
	}
	items, err := ListDir(root, rel)
	if err != nil {
		return acc
	}
	for _, it := range items {
		if it.Type == "dir" {
			CountDir(root, it.Path, depth+1, acc)
			continue
		}
		acc.Files++
		acc.Bytes += it.Size
		if it.IsImage {
			acc.Images++
		}
	}
	return acc
}

// Node 是管理页左侧那棵目录树的一个节点。
type Node struct {
	Name     string `json:"name"`
	Path     string `json:"path"`
	Children []Node `json:"children"`
}

// Tree 只取到 maxDepth 层，默认 2 层 —— 和 Electron 版一致。
// 展开到很深会让一次点击等很久，而且那棵树展开后也没人看。
func Tree(root, rel string, depth, maxDepth int) []Node {
	if depth > maxDepth {
		return []Node{}
	}
	items, err := ListDir(root, rel)
	if err != nil {
		return []Node{}
	}
	out := make([]Node, 0, len(items))
	for _, it := range items {
		if it.Type != "dir" {
			continue
		}
		out = append(out, Node{
			Name:     it.Name,
			Path:     it.Path,
			Children: Tree(root, it.Path, depth+1, maxDepth),
		})
	}
	return out
}

// Exists 判断路径在不在。 swallowed 掉所有错误：
// 权限不足 / 路径非法都表现为「不在」，调用方按这个分支提示用户即可。
func Exists(p string) bool {
	if p == "" {
		return false
	}
	_, err := os.Stat(p)
	return err == nil
}

// EnsureDir 建目录（含父级）。写入通道落文件前都要先调它，
// 否则「上传到 a/b/c/ 而 a/b 还不存在」会失败。
func EnsureDir(p string) error {
	return os.MkdirAll(p, 0o755)
}
