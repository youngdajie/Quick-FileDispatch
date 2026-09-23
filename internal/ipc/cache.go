package ipc

import (
	"sync"
	"time"
)

// 仓库查询缓存。
//
// 为什么需要这一层：切一份配置会连着触发 2~3 次界面重画，而每次重画都要问一遍
// 「Git 在不在、本地目录干不干净」，一次 git:status 实测要起 6 个 git 进程、
// 200ms 以上；云端那一轮还会递归统计整个仓库（最多 60 次接口请求）。
// 配置一多、又来回点几份配置时，这些活会叠在一起，界面就变成「点了没反应」。
//
// 三件事：短缓存、同一件事只跑一个、写完立刻作废。
const (
	gitStatusTTL = 2500 * time.Millisecond
	repoStatsTTL = 30 * time.Second
	// 检测是只读的，但 CNB 那份要跑一次 git fetch（走网络）。
	// 来回点几份配置时每点一次都重算没意义，留 1.5 秒。
	detectTTL = 1500 * time.Millisecond
)

type repoCache struct {
	mu       sync.Mutex
	data     map[string]cacheItem
	inflight map[string]*call
}

type cacheItem struct {
	at   time.Time
	data any
}

type call struct {
	wg   sync.WaitGroup
	data any
}

func newRepoCache() *repoCache {
	return &repoCache{
		data:     map[string]cacheItem{},
		inflight: map[string]*call{},
	}
}

// Cached 带缓存地跑一次查询。
//
// ttl <= 0 表示「不缓存结果，只做并发去重」—— 用于必须现算的场合。
// 并发去重是这里最有价值的部分：同一个 key 正在算的时候，后来者跟着等，
// 而不是各自再起一批 git 进程。
func (c *repoCache) Cached(key string, ttl time.Duration, fn func() (any, error)) (any, error) {
	c.mu.Lock()
	if ttl > 0 {
		if hit, ok := c.data[key]; ok && time.Since(hit.at) < ttl {
			c.mu.Unlock()
			return hit.data, nil
		}
	}
	if flying, ok := c.inflight[key]; ok {
		c.mu.Unlock()
		flying.wg.Wait()
		return flying.data, nil
	}
	cl := &call{}
	cl.wg.Add(1)
	c.inflight[key] = cl
	c.mu.Unlock()

	var err error
	cl.data, err = fn()

	c.mu.Lock()
	delete(c.inflight, key)
	if err == nil && ttl > 0 {
		c.data[key] = cacheItem{at: time.Now(), data: cl.data}
	}
	c.mu.Unlock()
	cl.wg.Done()
	return cl.data, err
}

// Invalidate 作废全部缓存。
//
// 仓库内容一变（上传 / 删除 / 改名 / 替换 / 推送 / 拉取 / 克隆）就要调它 ——
// 不清会让界面继续显示旧数字，用户以为上传失败了。
func (c *repoCache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.data = map[string]cacheItem{}
}
