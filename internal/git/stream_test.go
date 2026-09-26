package git

import (
	"strings"
	"testing"
)

// TestParsePushLine 覆盖 git push 输出的各种真实形状。
//
// 这些字符串是实测抓下来的（Windows 上 git 2.47 的输出），
// 不是凭印象编的 —— 解析器的价值全在「格式对不对得上」，
// 用假的输入测等于没测。
func TestParsePushLine(t *testing.T) {
	// 与 humanBytes 一样做截断（int64 转换丢小数），期望值就这么算，
	// 免得手算出来的数字和实现对不上。
	mib := func(f float64) int64 { return int64(f * 1024 * 1024) }
	kib := func(f float64) int64 { return int64(f * 1024) }

	cases := []struct {
		name    string
		line    string
		wantOK  bool
		phase   string
		percent float64
		bytes   int64
		total   int64
		speed   int64
		done    bool
	}{
		{
			name:    "上传中（MiB）",
			line:    "Writing objects:  45% (9/20), 1.20 MiB | 3.40 MiB/s",
			wantOK:  true,
			phase:   "upload",
			percent: 45,
			bytes:   mib(1.20),
			total:   int64(float64(mib(1.20)) / 0.45),
			speed:   mib(3.40),
		},
		{
			name:    "上传完成（带 done）",
			line:    "Writing objects: 100% (20/20), 5.60 MiB | 3.40 MiB/s, done.",
			wantOK:  true,
			phase:   "upload",
			percent: 100,
			bytes:   mib(5.60),
			total:   mib(5.60),
			speed:   mib(3.40),
			done:    true,
		},
		{
			name:    "小文件用 bytes（无单位前缀）",
			line:    "Writing objects: 100% (3/3), 291 bytes | 291.00 KiB/s, done.",
			wantOK:  true,
			phase:   "upload",
			percent: 100,
			bytes:   291,
			total:   291,
			speed:   kib(291.00),
			done:    true,
		},
		{
			name:    "压缩阶段（没有字节和速度）",
			line:    "Compressing objects:  66% (8/12)",
			wantOK:  true,
			phase:   "prepare",
			percent: 66,
			// 没有字节信息时用「对象个数」兜底：8/12 个对象
			bytes: 8,
			total: 12,
		},
		{
			name:    "0% 时不算总字节（避免除零）",
			line:    "Writing objects:   0% (0/20), 0 bytes",
			wantOK:  true,
			phase:   "upload",
			percent: 0,
			bytes:   0,
			total:   0,
		},
		{
			name:   "普通输出不算进度",
			line:   "remote: Create a pull request for 'main' on GitHub by visiting:",
			wantOK: false,
		},
		{
			name:   "空行不算进度",
			line:   "",
			wantOK: false,
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := ParsePushLine(c.line)
			if ok != c.wantOK {
				t.Fatalf("ok = %v，想要 %v（输入 %q）", ok, c.wantOK, c.line)
			}
			if !c.wantOK {
				return
			}
			if got.Phase != c.phase {
				t.Errorf("Phase = %q，想要 %q", got.Phase, c.phase)
			}
			if got.Percent != c.percent {
				t.Errorf("Percent = %v，想要 %v", got.Percent, c.percent)
			}
			if got.Bytes != c.bytes {
				t.Errorf("Bytes = %v，想要 %v", got.Bytes, c.bytes)
			}
			if got.Total != c.total {
				t.Errorf("Total = %v，想要 %v", got.Total, c.total)
			}
			if got.Speed != c.speed {
				t.Errorf("Speed = %v，想要 %v", got.Speed, c.speed)
			}
			if got.Done != c.done {
				t.Errorf("Done = %v，想要 %v", got.Done, c.done)
			}
		})
	}
}

// TestTotalFromPercent 单独盯住「由百分比反推总字节」这条路径。
//
// 它是估算值（git 不给总量），但必须保持在合理范围 —— 算错的话
// 界面上会出现「12 MB / 3 MB」这种一眼假的数字。
func TestTotalFromPercent(t *testing.T) {
	// 45% 时已传 1.20 MiB → 总量应该约等于 1.20/0.45 ≈ 2.67 MiB
	got, ok := ParsePushLine("Writing objects:  45% (9/20), 1.20 MiB | 3.40 MiB/s")
	if !ok {
		t.Fatal("应该有进度")
	}
	wantApprox := float64(1.20*1024*1024) / 0.45
	diff := float64(got.Total) - wantApprox
	if diff < -1 || diff > 1 {
		t.Errorf("Total = %v，想要约 %v", got.Total, wantApprox)
	}
	if got.Total < got.Bytes {
		t.Errorf("总量 %v 不该小于已传 %v", got.Total, got.Bytes)
	}
}

// TestSplitCRLF 盯住「按 \r 切行」这条关键行为。
//
// git 的进度是 \r 原地刷新的，只认 \n 的话整段进度会被当成一行
// 攒到结束才吐出来 —— 那正是「进度条到最后才跳一下」的成因。
//
// 直接用真实的 scanCRLF（同包内可见），不复刻逻辑 ——
// 复刻出来的测试只能证明「我写的那份复刻是对的」。
func TestSplitCRLF(t *testing.T) {
	input := "Writing objects: 10% (1/10)\rWriting objects: 50% (5/10)\rWriting objects: 100% (10/10), done.\n"
	var lines []string
	var sink strings.Builder

	scanCRLF(strings.NewReader(input), &sink, func(s string) {
		lines = append(lines, s)
	})

	if len(lines) != 3 {
		t.Fatalf("切出 %d 行，想要 3 行：%q", len(lines), lines)
	}
	for i, want := range []string{"10%", "50%", "100%"} {
		if !strings.Contains(lines[i], want) {
			t.Errorf("第 %d 行 = %q，应该含 %q", i, lines[i], want)
		}
	}

	// sink 里应该是完整的原文（换行统一成 \n），供失败时诊断用
	if !strings.Contains(sink.String(), "10%") || !strings.Contains(sink.String(), "100%") {
		t.Errorf("sink 内容不完整：%q", sink.String())
	}
}
