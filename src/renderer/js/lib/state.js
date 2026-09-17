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

  /**
   * 导出 / 导入归档配置。
   * 导出走主进程的系统保存框；导入读文件后由主进程合并，再把结果交回来。
   * 导出的 JSON 里带上了 Token 和「文件链接」的全局配置，但不含本地路径 ——
   * 换台电脑原路径多半不存在，由导入流程引导用户为本机重新绑定目录。
   */
  async exportProfiles() {
    return window.cloudpic.profile.exportFile();
  }

  async importProfiles() {
    const res = await window.cloudpic.profile.importFile();
    if (res && res.ok) {
      this.cfg = await window.cloudpic.config.get();
      this.emit();
    }
    return res;
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

  /**
   * 真正「归档过」的配置 —— 列表 / 下拉只认这一份。
   *
   * 草稿（draft）是切平台或点「新建」时开出来的空落点：没有仓库信息、
   * 也从没验证过。用户还没真正填过它，不该冒充成一份配置显示出来。
   * 它依然存在于 profiles 里，好让「切到某平台」有地方可落、来回切换也不会越攒越多。
   *
   * 规则由主进程算（store.js 的 isDraftProfile）：填上仓库、或验证通过，
   * 就不再是草稿 —— 所以这里只读 p.draft，不自己判断，免得两边规则漂移。
   */
  get archivedProfiles() {
    return this.profiles.filter((p) => !p.draft);
  }

  /** 当前生效的那份是不是「还没保存的草稿」 */
  get isDraft() {
    const id = (this.cfg && this.cfg.activeProfileId) || '';
    const p = this.profiles.find((x) => x.id === id);
    return !!(p && p.draft);
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
    return (this.cfg && this.cfg.platform) === 'cnb' ? 'CNB' : 'GitHub';
  }
}

export const state = new State();
export default state;
