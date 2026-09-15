/** 全局状态：配置 + 运行时信息 */

class State {
  constructor() {
    this.cfg = null;
    this.info = null;
    this.listeners = new Set();
  }

  async init() {
    this.cfg = await window.cloudpic.config.get();
    this.info = await window.cloudpic.app.info();
    return this;
  }

  async refresh() {
    this.cfg = await window.cloudpic.config.get();
    this.emit();
    return this.cfg;
  }

  async patch(patchObj) {
    this.cfg = await window.cloudpic.config.set(patchObj);
    this.emit();
    return this.cfg;
  }

  /* ---- 归档的仓库配置（远端仓库 + 本地目录绑定在一起） ---- */

  async newProfile(patchObj) {
    this.cfg = await window.cloudpic.profile.create(patchObj || {});
    this.emit();
    return this.cfg;
  }

  async activateProfile(id) {
    this.cfg = await window.cloudpic.profile.activate({ id: id });
    this.emit();
    return this.cfg;
  }

  async updateProfile(id, patchObj) {
    this.cfg = await window.cloudpic.profile.update({ id: id, patch: patchObj || {} });
    this.emit();
    return this.cfg;
  }

  async removeProfile(id) {
    this.cfg = await window.cloudpic.profile.remove({ id: id });
    this.emit();
    return this.cfg;
  }

  async verifyProfile(id, info) {
    this.cfg = await window.cloudpic.profile.verify({ id: id, info: info || {} });
    this.emit();
    return this.cfg;
  }

  /** 某个平台已有的配置（优先已验证的；没有就返回 null） */
  profileFor(platform) {
    const list = ((this.cfg && this.cfg.profiles) || []).filter(
      (p) => (p.platform || 'github') === (platform || 'github')
    );
    if (!list.length) return null;
    const verified = list.filter((p) => p.verified);
    const pool = verified.length ? verified : list;
    return pool.slice().sort((a, b) => (b.verifiedAt || b.createdAt || 0) - (a.verifiedAt || a.createdAt || 0))[0];
  }

  get profiles() {
    return (this.cfg && this.cfg.profiles) || [];
  }

  on(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit() {
    for (const fn of this.listeners) {
      try {
        fn(this.cfg);
      } catch (e) {
        /* ignore listener error */
      }
    }
  }

  /** 仓库 + Token 是否齐备 */
  get configured() {
    const c = this.cfg || {};
    return !!(c.owner && c.repo && c.hasToken);
  }

  get repoLabel() {
    const c = this.cfg || {};
    if (!c.owner || !c.repo) return '未配置仓库';
    return `${c.owner}/${c.repo} @ ${c.branch || 'main'}`;
  }

  get platformName() {
    return (this.cfg && this.cfg.platform) === 'gitee' ? 'Gitee' : 'GitHub';
  }
}

export const state = new State();
export default state;
