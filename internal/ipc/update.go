package ipc

/*
 * 自动更新：查 GitHub 的 Release、下载安装包、静默装上去。
 *
 * 为什么更新源选 GitHub 而不是 CNB：GitHub 有现成的 `/releases/latest` 接口，
 * 一个 GET 就能拿到「最新版本号 + 附件直链」；CNB 那边要自己从列表里挑。
 * 两个仓库的 Release 内容是一样的（两边跑同一份构建脚本）。
 *
 * 下载走 netproxy.Transport()，用户在设置里配了代理就会生效 ——
 * 国内直连 github.com 的 release 下载经常很慢，这一步必须能走代理。
 */

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"cnb.cool/youngdajie/Quick-FileDispatch/internal/git"
	"cnb.cool/youngdajie/Quick-FileDispatch/internal/netproxy"
)

const (
	updateAPILatest = "https://api.github.com/repos/youngdajie/Quick-FileDispatch/releases/latest"
	// 下载超时给足：安装包 7 MB 出头，但国内直连没代理时可能要几分钟
	updateDownloadTimeout = 15 * time.Minute
)

// ---------- 版本比较 ----------

var verRe = regexp.MustCompile(`(\d+)\.(\d+)\.(\d+)`)

// parseVer 从 "v3.4.8" / "3.4.8" / "3.4.8-go" 里抠出三段数字。
// 抠不出来返回 nil（调用方当作「比较不了」，宁可不提示也别误报）。
func parseVer(s string) []int {
	m := verRe.FindStringSubmatch(s)
	if m == nil {
		return nil
	}
	out := make([]int, 3)
	for i := 0; i < 3; i++ {
		n, _ := strconv.Atoi(m[i+1])
		out[i] = n
	}
	return out
}

// newerThan 判断 a 是否比 b 新。任一侧解析不出来就返回 false。
func newerThan(a, b string) bool {
	va, vb := parseVer(a), parseVer(b)
	if va == nil || vb == nil {
		return false
	}
	for i := 0; i < 3; i++ {
		if va[i] != vb[i] {
			return va[i] > vb[i]
		}
	}
	return false
}

// ---------- 下载状态（前端轮询这个） ----------

var updateState struct {
	mu     sync.Mutex
	status string // idle / downloading / ready / installing / error
	got    int64
	total  int64
	errMsg string
	path   string
	ver    string
}

func setUpdateState(status string, got, total int64, errMsg, path, ver string) {
	updateState.mu.Lock()
	defer updateState.mu.Unlock()
	updateState.status = status
	updateState.got = got
	updateState.total = total
	updateState.errMsg = errMsg
	if path != "" {
		updateState.path = path
	}
	if ver != "" {
		updateState.ver = ver
	}
}

func snapshotUpdate() map[string]any {
	updateState.mu.Lock()
	defer updateState.mu.Unlock()
	return map[string]any{
		"status": updateState.status,
		"got":    updateState.got,
		"total":  updateState.total,
		"error":  updateState.errMsg,
		"ver":    updateState.ver,
	}
}

// ---------- 通道 ----------

func registerUpdate(r *Registry, env *Env) {
	r.Handle("update:check", func(json.RawMessage) (any, error) {
		return checkUpdate(env.Version)
	})

	// 开始下载（异步，立刻返回）。进度用 update:progress 轮询。
	r.Handle("update:download", func(payload json.RawMessage) (any, error) {
		p, err := decodeObject(payload)
		if err != nil {
			return nil, err
		}
		url := strOf(p["url"])
		name := strOf(p["name"])
		ver := strOf(p["ver"])
		if url == "" || name == "" {
			return nil, BadPayload("缺少下载地址")
		}
		// 已经在下了就别重复起
		updateState.mu.Lock()
		busy := updateState.status == "downloading"
		updateState.mu.Unlock()
		if busy {
			return snapshotUpdate(), nil
		}
		setUpdateState("downloading", 0, 0, "", "", ver)
		go downloadInstaller(url, name, ver)
		return snapshotUpdate(), nil
	})

	r.Handle("update:progress", func(json.RawMessage) (any, error) {
		return snapshotUpdate(), nil
	})

	// 静默安装：起一个中转脚本，等主程序退出后再跑安装包
	r.Handle("update:install", func(json.RawMessage) (any, error) {
		updateState.mu.Lock()
		path, status := updateState.path, updateState.status
		updateState.mu.Unlock()
		if status != "ready" || path == "" {
			return nil, BadPayload("安装包还没准备好")
		}
		if _, err := os.Stat(path); err != nil {
			return nil, BadPayload("安装包不见了，请重新检查更新")
		}
		if err := launchSilentInstall(path); err != nil {
			return nil, err
		}
		setUpdateState("installing", 0, 0, "", path, "")
		// 给脚本一点时间起来，再退出自己 —— 不然安装包会撞上「文件正在使用」
		go func() {
			time.Sleep(400 * time.Millisecond)
			os.Exit(0)
		}()
		return true, nil
	})
}

// checkUpdate 问 GitHub 要最新版，跟当前版本比一比。
func checkUpdate(current string) (any, error) {
	client := &http.Client{Timeout: 20 * time.Second, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", updateAPILatest, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "QuickFileDispatch/"+current)

	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("连不上 GitHub：%v（如果网络需要代理，去设置页填一下）", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return nil, fmt.Errorf("仓库里还没有 Release")
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("GitHub 返回 %d", resp.StatusCode)
	}

	var rel struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		Assets  []struct {
			Name string `json:"name"`
			Size int64  `json:"size"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return nil, fmt.Errorf("解析 GitHub 返回失败：%v", err)
	}

	latest := strings.TrimPrefix(rel.TagName, "v")
	out := map[string]any{
		"hasUpdate": newerThan(rel.TagName, current),
		"current":   current,
		"latest":    latest,
		"notes":     rel.Body,
	}
	// 挑安装包（不是那个免安装单 exe）
	for _, a := range rel.Assets {
		if strings.HasPrefix(a.Name, "QuickFileDispatch-Setup-") && strings.HasSuffix(a.Name, ".exe") {
			out["assetName"] = a.Name
			out["assetSize"] = a.Size
			out["url"] = a.URL
			break
		}
	}
	if _, ok := out["url"]; !ok {
		out["hasUpdate"] = false
		out["notes"] = "最新版本没有可用的安装包"
	}
	return out, nil
}

// downloadInstaller 把安装包下到临时目录，进度写进 updateState。
func downloadInstaller(url, name, ver string) {
	client := &http.Client{Timeout: updateDownloadTimeout, Transport: netproxy.Transport()}
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		setUpdateState("error", 0, 0, err.Error(), "", ver)
		return
	}
	req.Header.Set("User-Agent", "QuickFileDispatch")

	resp, err := client.Do(req)
	if err != nil {
		setUpdateState("error", 0, 0, "下载失败："+err.Error(), "", ver)
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		setUpdateState("error", 0, 0, fmt.Sprintf("下载失败：HTTP %d", resp.StatusCode), "", ver)
		return
	}

	// 放进一个专门的目录，方便下次覆盖、也方便用户自己去找
	dir := filepath.Join(os.TempDir(), "QuickFileDispatch-update")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		setUpdateState("error", 0, 0, "建临时目录失败："+err.Error(), "", ver)
		return
	}
	dest := filepath.Join(dir, name)
	f, err := os.Create(dest)
	if err != nil {
		setUpdateState("error", 0, 0, "写文件失败："+err.Error(), "", ver)
		return
	}

	total := resp.ContentLength
	setUpdateState("downloading", 0, total, "", "", ver)

	buf := make([]byte, 64*1024)
	var got int64
	lastPush := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, werr := f.Write(buf[:n]); werr != nil {
				f.Close()
				os.Remove(dest)
				setUpdateState("error", got, total, "写文件失败："+werr.Error(), "", ver)
				return
			}
			got += int64(n)
			// 别每读一块就抢锁，250ms 推一次够了
			if time.Since(lastPush) > 250*time.Millisecond {
				setUpdateState("downloading", got, total, "", "", ver)
				lastPush = time.Now()
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(dest)
			setUpdateState("error", got, total, "下载中断："+rerr.Error(), "", ver)
			return
		}
	}
	f.Close()
	setUpdateState("ready", got, total, "", dest, ver)
}

/*
 * launchSilentInstall 起一个中转脚本去跑安装包。
 *
 * 为什么不直接 exec 安装包：主程序这时候还活着，安装包要覆盖的正是它自己，
 * Windows 上「文件正在使用」会直接失败。所以走一个 .bat ——
 * 它先等两秒（我们在这期间退出），再带 /S 静默跑安装包。
 *
 * /S 是 NSIS 的静默开关，安装器是 RequestExecutionLevel user（当前用户级），
 * 不需要管理员提权，静默装不会弹 UAC。
 */
func launchSilentInstall(pkg string) error {
	bat := filepath.Join(filepath.Dir(pkg), "apply-update.bat")
	// 引号包住路径：临时目录可能带空格
	script := "@echo off\r\n" +
		"timeout /t 2 /nobreak >nul\r\n" +
		"start \"\" \"" + pkg + "\" /S\r\n" +
		"del \"%~f0\"\r\n"
	if err := os.WriteFile(bat, []byte(script), 0o644); err != nil {
		return fmt.Errorf("写更新脚本失败：%v", err)
	}
	cmd := exec.Command("cmd", "/c", bat)
	git.HideWindow(cmd)
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("启动安装程序失败：%v", err)
	}
	go cmd.Wait() // 收尸，免得留僵尸
	return nil
}
