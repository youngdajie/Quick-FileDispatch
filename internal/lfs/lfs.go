// Package lfs 负责 git-lfs 的查找、自动安装，以及在仓库里启用 LFS。
//
// 为什么需要这一层：CNB 的对象存储（免费 100GiB，与仓库存储分开计费）
// 通过 Git LFS 协议访问。把大文件走 LFS 有两个实在的好处 ——
// 不占 git 仓库额度，而且 clone 仓库时不会把几百 MB 的大文件一起拉下来。
//
// 但 git-lfs 不是 git 自带的，用户机器上大概率没有。让用户自己去
// 官网下载安装包、跑 installer、重启终端，是把这个功能废掉的最快方式。
// 所以这里做成**全自动**：
//
//  1. 先找程序自己装的（<配置目录>/bin/git-lfs.exe）
//  2. 再找系统 PATH 里的（用户自己装过就直接用）
//  3. 都没有 → 下载便携版 zip → 解压到 <配置目录>/bin/
//
// 刻意**不动系统目录、不写注册表、不要管理员权限** —— 便携版解压即用，
// 卸载程序时跟着配置目录一起删掉，不留痕迹。
//
// 下载源按「官方 → 国内镜像」的顺序重试，因为 GitHub Releases 在国内
// 经常连不上（而这个程序的用户在国内是多数）。
package lfs

import (
	"archive/zip"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
)

/* ------------------------------------------------------------ 常量 */

// 版本与产物名。升级时改这三行即可（版本号 3.8.0 是发布时的最新稳定版）。
const (
	Version = "3.8.0"
	// Asset 是 Windows amd64 的便携版 zip（约 5.9MB）。
	// 用它而不是 .exe installer：installer 需要跑安装流程、可能弹 UAC，
	// 而我们只想拿一个可执行文件。
	Asset = "git-lfs-windows-amd64-v" + Version + ".zip"
	// Official 是 GitHub 官方地址。
	Official = "https://github.com/git-lfs/git-lfs/releases/download/v" + Version + "/" + Asset
)

// mirrors 是加速前缀。用法是「前缀 + 原始 URL」，这是主流 gh 代理的约定。
//
// 按实测可用性排序；全部失败才认定网络不通。加新镜像注意：
// 必须是能正常回源的（有些免费代理会返回 HTML 错误页，那种会被下面的
// zip 魔数校验拦掉）。
var mirrors = []string{
	"https://ghproxy.net/",
	"https://gh-proxy.com/",
	"https://ghfast.top/",
}

// maxDownload 是下载体积上限。正常包 5.9MB，留 64MB 余量防「下载到
// 一个巨大的错误页把内存吃光」。
const maxDownload = 64 << 20

/* ------------------------------------------------------------ 路径 */

// BinDir 是存放 git-lfs.exe 的目录（配置目录下，随配置一起走）。
func BinDir(cfgDir string) string { return filepath.Join(cfgDir, "bin") }

// ExePath 是程序自己装的 git-lfs.exe 的完整路径（不保证存在）。
func ExePath(cfgDir string) string { return filepath.Join(BinDir(cfgDir), "git-lfs.exe") }

/* ------------------------------------------------------------ 查找 */

// Find 找一个可用的 git-lfs。
//
// 返回的 binDir 是**需要注入到 git 子进程 PATH** 的目录（见 git.SetExtraPath）；
// 如果是系统 PATH 里找到的，binDir 为空（不用注入）。
//
// 顺序：程序自己装的优先 —— 用户可能在系统里装了个旧版本，
// 我们装的是确定能配合本程序工作的那一个。
func Find(cfgDir string) (exe string, binDir string, ok bool) {
	if p := ExePath(cfgDir); fileExists(p) {
		return p, BinDir(cfgDir), true
	}
	if p, err := exec.LookPath("git-lfs"); err == nil {
		return p, "", true
	}
	return "", "", false
}

// Available 报告 git-lfs 是否已经可用（不触发安装）。
func Available(cfgDir string) bool {
	_, _, ok := Find(cfgDir)
	return ok
}

// InstalledBinDir 返回**程序自己装的** git-lfs 所在目录；没装返回空串。
//
// 和 Find 的区别：Find 还会去系统 PATH 里找，那种情况不需要注入 PATH
// （git 本来就能找到）。这里只回答「要不要往子进程 PATH 里塞目录」，
// 所以只看配置目录下那一份。启动时用它做一次「上次装过就预热 PATH」。
func InstalledBinDir(cfgDir string) string {
	if fileExists(ExePath(cfgDir)) {
		return BinDir(cfgDir)
	}
	return ""
}

// versionRe 抓 `git-lfs/3.8.0 (GitHub; windows amd64; go 1.27.0)` 里的版本号。
var versionRe = regexp.MustCompile(`git-lfs/(\d+\.\d+\.\d+)`)

// InstalledVersion 跑一次 `<exe> version`，返回版本号；失败给空串。
//
// 用途是设置页那句「已安装 3.8.0」—— 光说「已安装」用户不知道装的是啥，
// 排障时也少一个线索。
func InstalledVersion(ctx context.Context, exe string) string {
	if exe == "" {
		return ""
	}
	c, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(c, exe, "version")
	git.HideWindow(cmd) // 不然界面上会闪一下黑框
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	if m := versionRe.FindStringSubmatch(string(out)); m != nil {
		return m[1]
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

/* ------------------------------------------------------------ 安装 */

// Ensure 保证 git-lfs 可用，必要时下载安装。
//
// onStatus 用来把「正在下载 / 解压」这类信息送进进度中心 ——
// 首次使用要下 5.9MB，不给任何反馈的话界面会像卡死了。
// onStatus 可以为 nil。
//
// 返回可直接用于 PATH 注入的目录（空串表示用的是系统已装的）。
func Ensure(ctx context.Context, cfgDir string, onStatus func(string)) (string, error) {
	if _, binDir, ok := Find(cfgDir); ok {
		return binDir, nil
	}

	say := func(s string) {
		if onStatus != nil {
			onStatus(s)
		}
	}

	say("未检测到 git-lfs，正在下载（约 6MB）…")
	data, err := download(ctx, onStatus)
	if err != nil {
		return "", err
	}

	say("正在解压 git-lfs…")
	dest := BinDir(cfgDir)
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return "", fmt.Errorf("创建目录失败：%w", err)
	}
	if err := extractGitLFS(data, dest); err != nil {
		return "", err
	}

	// 验证解压出来的确实能跑。这一步不是多余的 ——
	// 代理返回的 HTML 错误页、被截断的 zip 都会在这里被拦住，
	// 而不是等到用户点了上传才发现 git-lfs 是个坏文件。
	if !fileExists(ExePath(cfgDir)) {
		return "", errors.New("解压完成但没找到 git-lfs.exe，安装包可能有问题")
	}
	say("git-lfs 安装完成")
	return dest, nil
}

// download 按「官方 → 镜像」顺序尝试下载，返回 zip 的原始字节。
func download(ctx context.Context, onStatus func(string)) ([]byte, error) {
	urls := make([]string, 0, len(mirrors)+1)
	// 镜像放前面：国内环境下官方源经常直接超时，先试镜像能省掉
	// 一次几十秒的等待。官方源作为兜底（镜像全挂时还有救）。
	for _, m := range mirrors {
		urls = append(urls, m+Official)
	}
	urls = append(urls, Official)

	var lastErr error
	for i, u := range urls {
		if onStatus != nil {
			onStatus(fmt.Sprintf("正在下载 git-lfs（线路 %d/%d）…", i+1, len(urls)))
		}
		data, err := fetch(ctx, u)
		if err == nil {
			return data, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("git-lfs 下载失败（%d 条线路都不通）：%w；"+
		"可以手动下载 %s 解压后把 git-lfs.exe 放进 %s",
		len(urls), lastErr, Asset, "配置目录/bin/")
}

func fetch(ctx context.Context, u string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	// 有些代理会按 UA 拦截，给个正常的客户端标识。
	req.Header.Set("User-Agent", "QuickFileDispatch/"+Version)
	req.Header.Set("Accept", "application/octet-stream,*/*")

	client := &http.Client{Timeout: 3 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, maxDownload))
	if err != nil {
		return nil, err
	}
	// zip 魔数校验：代理挂了会返回 HTML 错误页，直接解压会得到
	// 一个看不懂的错误。在这里拦掉，错误信息才说得清。
	if len(data) < 4 || data[0] != 'P' || data[1] != 'K' {
		return nil, errors.New("下载到的不是 zip（多半是被代理拦截了）")
	}
	return data, nil
}

// extractGitLFS 从 zip 里取出 git-lfs.exe，拍平放到 destDir。
//
// git-lfs 的 zip 结构是 git-lfs-<version>/git-lfs.exe，
// 我们只需要那一个文件，所以不还原目录结构。
func extractGitLFS(data []byte, destDir string) error {
	zr, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return fmt.Errorf("安装包损坏：%w", err)
	}
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		if !strings.EqualFold(filepath.Base(f.Name), "git-lfs.exe") {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		// 先写临时文件再改名：解压到一半失败不会留下半个 exe
		// （那种 exe 下次会被 Find() 当成「已安装」，然后一直报奇怪的错）。
		tmp := filepath.Join(destDir, "git-lfs.exe.tmp")
		out, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o755)
		if err != nil {
			rc.Close()
			return err
		}
		_, cpErr := io.Copy(out, rc)
		rc.Close()
		out.Close()
		if cpErr != nil {
			os.Remove(tmp)
			return cpErr
		}
		return os.Rename(tmp, filepath.Join(destDir, "git-lfs.exe"))
	}
	return errors.New("安装包里没有 git-lfs.exe")
}

/* ------------------------------------------------------------ 在仓库启用 */

// EnableParams 是在仓库里启用 LFS 所需的参数。
type EnableParams struct {
	// RepoDir 是本地仓库目录（已 clone 好、准备提交）。
	RepoDir string
	// Paths 是要走 LFS 的文件（仓库相对路径）。为空表示只注册 filter，
	// 不 track 任何文件（用于「提前装好，先不用」）。
	Paths []string
	// RemoteURL 是远端地址，用来设置 CNB 需要的 locksverify。
	// 可以为空。
	RemoteURL string
}

// EnableInRepo 在仓库里注册 LFS filter 并 track 指定文件。
//
// 做三件事：
//
//  1. git lfs install --local —— 往 .git/config 写 filter.lfs.*，
//     这样这个仓库的 add/checkout 会自动走 LFS。用 --local 不用 --global：
//     不污染用户的全局配置。
//  2. （CNB）设置 lfs.<url>.locksverify —— 不设的话 git-lfs 在 push 时
//     会卡在「Locking support detected...」反复重试（CNB 侧有公开 issue）。
//     显式设成 false 跳过锁定协商。
//  3. git lfs track <path> —— 往 .gitattributes 写跟踪规则。
//
// 调用方拿到返回后要 **把 .gitattributes 一起 add 提交**，否则规则不生效。
func EnableInRepo(ctx context.Context, p EnableParams) error {
	if p.RepoDir == "" {
		return errors.New("缺少仓库目录")
	}

	// 1) 注册 filter
	if r := runLFS(ctx, p.RepoDir, 60*time.Second, "install", "--local"); !r.OK {
		return fmt.Errorf("启用 LFS 失败：%s", orDefault(r.Message, "命令执行失败"))
	}

	// 2) CNB 的锁定协商跳过（见上面的说明）
	if p.RemoteURL != "" && strings.Contains(p.RemoteURL, "cnb.cool") {
		key := "lfs." + p.RemoteURL + ".locksverify"
		// 用 git config 写，不用 git-lfs（这是普通 git 配置）
		git.SetConfig(ctx, p.RepoDir, key, "false")
	}

	// 3) track 每个文件
	for _, path := range p.Paths {
		if strings.TrimSpace(path) == "" {
			continue
		}
		// 直接 track，**没有 --force 这种参数**（git-lfs 的 track 根本没这个开关，
		// 写了会直接报 "unknown flag" 而整个上传失败 —— 这是实测踩出来的）。
		//
		// 天然幂等：对已经跟踪过的路径，git-lfs 输出「already supported」
		// 但**退出码仍是 0**，也不需要重复写 .gitattributes。
		if r := runLFS(ctx, p.RepoDir, 30*time.Second, "track", path); !r.OK {
			return fmt.Errorf("LFS 跟踪 %s 失败：%s", path, orDefault(r.Message, "命令执行失败"))
		}
	}
	return nil
}

// runLFS 执行 `git lfs <args>`。走 git 分发（而不是直接调 git-lfs.exe），
// 这样行为和用户在命令行敲的一样，也能顺带验证 filter 注册是否成功。
func runLFS(ctx context.Context, dir string, timeout time.Duration, args ...string) git.OpResult {
	full := append([]string{"lfs"}, args...)
	return git.Run(ctx, dir, timeout, full...)
}

// orDefault 空串时给个兜底文案（错误信息不能是空的，否则界面上一片空白）。
func orDefault(s, def string) string {
	if strings.TrimSpace(s) == "" {
		return def
	}
	return s
}
