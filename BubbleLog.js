// Variables used by Scriptable.
// These must be at the very top of the file. Do not edit.
// icon-color: pink; icon-glyph: comment-dots;
/**
 * BubbleLog — 泡泡消息记录小组件
 *
 * 追星记录组件：展示与爱豆的订阅天数（D+xxx）和泡泡消息统计，
 * 数据由用户手动快速记录（点组件 → 面板四按钮 +1）。
 *
 * 双入口：
 *  - Widget 模式（config.runsInWidget）：渲染 small / medium 组件
 *  - App 模式：UITable 记录面板（记录 / 撤销 / 补记 / 统计 / 热力图）
 *
 * 纯本地运行，无网络依赖。数据存 iCloud Documents/bubblelog/state.json，
 * 每次写入前自动备份 state.backup.json。
 */

// ============================================================
// CONFIG — 常量：路径、主题色、字体、热力图色阶
// ============================================================

const CONFIG = {
  dirName: "bubblelog",
  stateFile: "state.json",
  backupFile: "state.backup.json",

  // 消息类型枚举（固定四种）
  types: ["text", "voice", "image", "emoji"],
  typeMeta: {
    text:  { emoji: "💬", label: "文字" },
    voice: { emoji: "🎙", label: "语音" },
    image: { emoji: "🖼", label: "图片" },
    emoji: { emoji: "😝", label: "表情" },
  },

  // 主题色板。切换主题存在 state.config.theme，面板里「🎨 切换主题」可改。
  // 每个色板字段：bg* 组件渐变背景（浅/深色模式）；primary/secondary 文字色；
  // heat* 热力图（0 条底色 + 4 档加深）。热力图分档边界不是固定条数，
  // 而是按历史非零日总数的四分位数自适应（见 Stats.heatBoundaries）。
  theme: {
    pink: {
      label: "🌸 粉",
      bgTopLight: "#FFE3EC", bgBottomLight: "#FFC2D6",
      bgTopDark:  "#3A2230", bgBottomDark:  "#241521",
      primaryLight: "#B4245A", primaryDark: "#FFB7CE",
      secondaryLight: "#8E5A6E", secondaryDark: "#C99BAC",
      heatBase: "#F3E3E9", heatBaseDark: "#4A3340",
      heatLevels: ["#F5AECB", "#EC74A8", "#D84487", "#A61B5F"],
      heatText: "#B4245A",
      heatToday: "#9C1D4E", heatTodayDark: "#FFB7CE",
    },
    gray: {
      label: "🩶 灰",
      bgTopLight: "#EEEEF2", bgBottomLight: "#D9D9E0",
      bgTopDark:  "#2C2C31", bgBottomDark:  "#1B1B1F",
      primaryLight: "#45454F", primaryDark: "#DCDCE4",
      secondaryLight: "#7A7A85", secondaryDark: "#A2A2AE",
      heatBase: "#E4E4E9", heatBaseDark: "#3C3C44",
      heatLevels: ["#C6C6D0", "#A2A2B0", "#7B7B8C", "#52525F"],
      heatText: "#45454F",
      heatToday: "#33333C", heatTodayDark: "#DCDCE4",
    },
    blue: {
      label: "🩵 蓝",
      bgTopLight: "#DFECFA", bgBottomLight: "#C2DBF5",
      bgTopDark:  "#1E2A3C", bgBottomDark:  "#131B2A",
      primaryLight: "#1F5FA8", primaryDark: "#A8CBF0",
      secondaryLight: "#5E7B9B", secondaryDark: "#8FA9C6",
      heatBase: "#E2EAF3", heatBaseDark: "#33404F",
      heatLevels: ["#A8CBEC", "#6FA6DE", "#3D7EC4", "#1E5693"],
      heatText: "#1F5FA8",
      heatToday: "#123E6E", heatTodayDark: "#A8CBF0",
    },
  },
  themeName: "pink", // 运行时会被 state.config.theme 覆盖
};

function theme() {
  return CONFIG.theme[CONFIG.themeName] || CONFIG.theme.pink;
}

// ============================================================
// 日期工具
// ============================================================

/** 设备本地时区的日历日 key：YYYY-MM-DD */
function dateKey(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayKey() {
  return dateKey(new Date());
}

/** 校验 YYYY-MM-DD 且为真实日期，返回 true/false */
function isValidDateKey(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** dateKey 转本地零点 Date */
function keyToDate(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** 两个日历日相差的天数（b - a） */
function daysBetween(a, b) {
  const ms = keyToDate(dateKey(b)) - keyToDate(dateKey(a));
  return Math.round(ms / 86400000);
}

// ============================================================
// Store — 读写 state：load / save（含备份）/ rebuildTotals / 初始化引导
// ============================================================

const Store = {
  _fm: null,
  _usingiCloud: false,

  fm() {
    if (this._fm) return this._fm;
    // iCloud 优先（防换机丢数据），不可用时回退本地
    try {
      this._fm = FileManager.iCloud();
      this._usingiCloud = true;
    } catch (e) {
      this._fm = FileManager.local();
      this._usingiCloud = false;
    }
    return this._fm;
  },

  dirPath() {
    const fm = this.fm();
    return fm.joinPath(fm.documentsDirectory(), CONFIG.dirName);
  },

  statePath() {
    return this.fm().joinPath(this.dirPath(), CONFIG.stateFile);
  },

  backupPath() {
    return this.fm().joinPath(this.dirPath(), CONFIG.backupFile);
  },

  ensureDir() {
    const fm = this.fm();
    if (!fm.isDirectory(this.dirPath())) {
      fm.createDirectory(this.dirPath(), true);
    }
  },

  async _readJSON(path) {
    const fm = this.fm();
    if (!fm.fileExists(path)) return null;
    if (this._usingiCloud) {
      try { await fm.downloadFileFromiCloud(path); } catch (e) { /* 离线时用本地缓存 */ }
    }
    const raw = fm.readString(path);
    if (raw === null || raw === undefined || raw.trim() === "") return null;
    return JSON.parse(raw); // 解析失败会抛出，由调用方处理
  },

  /** 校验 state 基本结构 */
  isValidState(s) {
    return !!(
      s && typeof s === "object" &&
      s.config && typeof s.config.idolName === "string" &&
      isValidDateKey(s.config.startDate) &&
      s.days && typeof s.days === "object" &&
      s.totals && typeof s.totals === "object"
    );
  },

  /**
   * 加载 state。主文件损坏时尝试从备份恢复。
   * 返回 { state, source }，source: "main" | "backup" | null（无数据/全部损坏）
   */
  async load() {
    let mainErr = null;
    try {
      const s = await this._readJSON(this.statePath());
      if (s === null) {
        // 主文件不存在 → 无数据（不自动读备份，避免误用旧数据；由引导决定）
      } else if (this.isValidState(s)) {
        return { state: this._normalize(s), source: "main" };
      } else {
        mainErr = new Error("state.json 结构不合法");
      }
    } catch (e) {
      mainErr = e;
    }

    if (mainErr) {
      // 主文件损坏 → 尝试备份
      try {
        const b = await this._readJSON(this.backupPath());
        if (this.isValidState(b)) {
          const state = this._normalize(b);
          await this.save(state, { skipBackup: true }); // 用备份内容修复主文件
          return { state, source: "backup" };
        }
      } catch (e) { /* 备份也坏了 */ }
      return { state: null, source: null, corrupt: true };
    }
    return { state: null, source: null };
  },

  /** 补齐缺失字段、保证四类计数为非负整数 */
  _normalize(s) {
    for (const key of Object.keys(s.days)) {
      const day = s.days[key];
      for (const t of CONFIG.types) {
        day[t] = Math.max(0, Math.floor(Number(day[t]) || 0));
      }
    }
    for (const t of CONFIG.types) {
      s.totals[t] = Math.max(0, Math.floor(Number(s.totals[t]) || 0));
    }
    if (!("lastAction" in s)) s.lastAction = null;
    if (!s.config.theme) s.config.theme = CONFIG.themeName;
    return s;
  },

  /** 保存：先把现有主文件备份为 state.backup.json，再写入 */
  async save(state, opts) {
    opts = opts || {};
    const fm = this.fm();
    this.ensureDir();
    const sp = this.statePath();
    const bp = this.backupPath();
    if (!opts.skipBackup && fm.fileExists(sp)) {
      try {
        if (this._usingiCloud) {
          try { await fm.downloadFileFromiCloud(sp); } catch (e) {}
        }
        const raw = fm.readString(sp);
        if (raw && raw.trim() !== "") {
          if (fm.fileExists(bp)) fm.remove(bp);
          fm.writeString(bp, raw);
        }
      } catch (e) { /* 备份失败不阻塞主写入 */ }
    }
    fm.writeString(sp, JSON.stringify(state, null, 2));
  },

  /** 以 days 为唯一事实来源重算 totals */
  rebuildTotals(state) {
    const totals = { text: 0, voice: 0, image: 0, emoji: 0 };
    for (const key of Object.keys(state.days)) {
      const day = state.days[key];
      for (const t of CONFIG.types) totals[t] += day[t] || 0;
    }
    state.totals = totals;
    return totals;
  },

  /** totals 与 days 不一致时以 days 重算修正，返回是否做了修正 */
  reconcileTotals(state) {
    const fresh = { text: 0, voice: 0, image: 0, emoji: 0 };
    for (const key of Object.keys(state.days)) {
      const day = state.days[key];
      for (const t of CONFIG.types) fresh[t] += day[t] || 0;
    }
    let dirty = false;
    for (const t of CONFIG.types) {
      if ((state.totals[t] || 0) !== fresh[t]) { dirty = true; break; }
    }
    if (dirty) state.totals = fresh;
    return dirty;
  },

  /**
   * 原子修改：每次写入前重新读取文件最新内容再合并写回，
   * 禁止在内存里长期持有旧状态直接覆盖写。
   * mutator(state) 同步修改 state；返回修改后的 state。
   */
  async mutate(mutator) {
    const { state } = await this.load();
    if (!state) throw new Error("state 不存在，无法修改");
    this.reconcileTotals(state);
    mutator(state);
    await this.save(state);
    return state;
  },

  /** 记录一条消息（type ∈ CONFIG.types），date 缺省为今天 */
  async record(type, date) {
    const key = date || todayKey();
    return await this.mutate((s) => {
      if (!s.days[key]) s.days[key] = { text: 0, voice: 0, image: 0, emoji: 0 };
      s.days[key][type] += 1;
      s.totals[type] += 1;
      s.lastAction = { date: key, type, ts: Math.floor(Date.now() / 1000) };
    });
  },

  /** 撤销上一条（只支持一步）。返回修改后的 state；无可撤销时返回 null */
  async undo() {
    const { state } = await this.load();
    if (!state || !state.lastAction) return null;
    const { date, type } = state.lastAction;
    return await this.mutate((s) => {
      if (s.days[date] && s.days[date][type] > 0) {
        s.days[date][type] -= 1;
        s.totals[type] = Math.max(0, s.totals[type] - 1);
        // 当天四类归零则清掉这一天，保持 days 干净
        const d = s.days[date];
        if (CONFIG.types.every((t) => d[t] === 0)) delete s.days[date];
      }
      s.lastAction = null;
    });
  },

  avatarPath() {
    return this.fm().joinPath(this.dirPath(), "avatar.png");
  },

  hasAvatar() {
    return this.fm().fileExists(this.avatarPath());
  },

  async loadAvatar() {
    const fm = this.fm();
    const p = this.avatarPath();
    if (!fm.fileExists(p)) return null;
    if (this._usingiCloud) {
      try { await fm.downloadFileFromiCloud(p); } catch (e) {}
    }
    try { return fm.readImage(p); } catch (e) { return null; }
  },

  /** 保存头像：居中裁成正方形并缩到 256px，控制组件内存占用 */
  saveAvatar(img) {
    this.ensureDir();
    const side = 256;
    const scale = Math.max(side / img.size.width, side / img.size.height);
    const w = img.size.width * scale;
    const h = img.size.height * scale;
    const ctx = new DrawContext();
    ctx.size = new Size(side, side);
    ctx.opaque = false;
    ctx.respectScreenScale = false;
    ctx.drawImageInRect(img, new Rect((side - w) / 2, (side - h) / 2, w, h));
    this.fm().writeImage(this.avatarPath(), ctx.getImage());
  },

  removeAvatar() {
    const fm = this.fm();
    if (fm.fileExists(this.avatarPath())) fm.remove(this.avatarPath());
  },

  /**
   * 直接改写某天的四类条数（记错了用这个改）。
   * totals 以 days 重算保证一致；手动改写后一键撤销不再适用，清空 lastAction。
   */
  async setDayCounts(key, counts) {
    return await this.mutate((s) => {
      const clean = {};
      for (const t of CONFIG.types) {
        clean[t] = Math.max(0, Math.floor(Number(counts[t]) || 0));
      }
      if (CONFIG.types.every((t) => clean[t] === 0)) delete s.days[key];
      else s.days[key] = clean;
      this.rebuildTotals(s);
      s.lastAction = null;
    });
  },

  /** 首次运行初始化引导：Alert 依次询问昵称与订阅起始日 */
  async initWizard() {
    // 第一步：昵称
    const a1 = new Alert();
    a1.title = "🫧 BubbleLog 初始化";
    a1.message = "第一次使用，先做个简单设置。\n\n你家爱豆叫什么？（昵称即可）";
    a1.addTextField("爱豆昵称");
    a1.addAction("下一步");
    a1.addCancelAction("取消");
    if ((await a1.presentAlert()) === -1) return null;
    let name = a1.textFieldValue(0).trim();
    if (!name) name = "OO";

    // 第二步：订阅起始日（循环直到合法）
    let startDate = null;
    while (startDate === null) {
      const a2 = new Alert();
      a2.title = "订阅起始日";
      a2.message = `记录和 ${name} 的泡泡是从哪天开始订阅的？\n格式：YYYY-MM-DD（如 2024-11-20）`;
      a2.addTextField("YYYY-MM-DD", todayKey());
      a2.addAction("完成");
      a2.addCancelAction("取消");
      if ((await a2.presentAlert()) === -1) return null;
      const v = a2.textFieldValue(0).trim();
      if (isValidDateKey(v) && keyToDate(v) <= new Date()) {
        startDate = v;
      } else {
        const err = new Alert();
        err.title = "日期格式不对";
        err.message = "请输入 YYYY-MM-DD 格式、且不晚于今天的日期。";
        err.addAction("重新输入");
        await err.presentAlert();
      }
    }

    const state = {
      config: { idolName: name, startDate, theme: CONFIG.themeName },
      days: {},
      totals: { text: 0, voice: 0, image: 0, emoji: 0 },
      lastAction: null,
    };
    await this.save(state);

    const done = new Alert();
    done.title = "🎀 设置完成";
    done.message = `今天是和 ${name} 的 D+${Stats.dPlus(state)}。\n把 BubbleLog 组件添加到主屏幕，收到泡泡后点组件即可记录。`;
    done.addAction("开始使用");
    await done.presentAlert();
    return state;
  },
};

// ============================================================
// Stats — 统计计算
// ============================================================

const Stats = {
  /** D+ 天数：订阅起始日当天为 D+1 */
  dPlus(state) {
    return daysBetween(keyToDate(state.config.startDate), new Date()) + 1;
  },

  /** 纪念日：整百天（D+100、D+200…）或周年当天 */
  isAnniversary(state) {
    const d = this.dPlus(state);
    if (d > 0 && d % 100 === 0) return true;
    const start = keyToDate(state.config.startDate);
    const now = new Date();
    return (
      now.getFullYear() > start.getFullYear() &&
      now.getMonth() === start.getMonth() &&
      now.getDate() === start.getDate()
    );
  },

  /** 某一天的四类计数（不存在时返回全 0） */
  dayCounts(state, key) {
    return state.days[key] || { text: 0, voice: 0, image: 0, emoji: 0 };
  },

  todayCounts(state) {
    return this.dayCounts(state, todayKey());
  },

  dayTotal(counts) {
    return CONFIG.types.reduce((sum, t) => sum + (counts[t] || 0), 0);
  },

  /** 某月总条数。monthOffset：0 = 当月，-1 = 上月 */
  monthTotal(state, monthOffset) {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth() + (monthOffset || 0), 1);
    const prefix = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}-`;
    let sum = 0;
    for (const key of Object.keys(state.days)) {
      if (key.startsWith(prefix)) sum += this.dayTotal(state.days[key]);
    }
    return sum;
  },

  grandTotal(state) {
    return this.dayTotal(state.totals);
  },

  /** 近 N 天（含今天）总条数 */
  recentTotal(state, days) {
    const today = keyToDate(todayKey());
    let sum = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(
        today.getFullYear(), today.getMonth(), today.getDate() - i
      );
      sum += this.dayTotal(this.dayCounts(state, dateKey(d)));
    }
    return sum;
  },

  /**
   * 热力图自适应分档边界：取全部非零日总数的四分位数 [q25, q50, q75]。
   * 判档用 count < 边界（见 HeatmapPainter.levelIndex），
   * 数据不足 4 天时退回固定档 [2, 4, 7]（即 1 / 2~3 / 4~6 / 7+）。
   */
  heatBoundaries(state) {
    const values = Object.keys(state.days)
      .map((k) => this.dayTotal(state.days[k]))
      .filter((v) => v > 0)
      .sort((a, b) => a - b);
    if (values.length < 4) return [2, 4, 7];
    const q = (p) => values[Math.min(values.length - 1, Math.floor(values.length * p))];
    return [q(0.25), q(0.5), q(0.75)];
  },

  /** 开通订阅至今的日均条数（1 位小数） */
  dayAvg(state) {
    const days = Math.max(1, this.dPlus(state));
    return Math.round((this.grandTotal(state) / days) * 10) / 10;
  },

  /** 环比文案：如 "+25%" / "-10%" / "—"（上月为 0 时） */
  momText(state) {
    const cur = this.monthTotal(state, 0);
    const prev = this.monthTotal(state, -1);
    if (prev === 0) return "—";
    const pct = Math.round(((cur - prev) / prev) * 100);
    return (pct >= 0 ? "+" : "") + pct + "%";
  },
};

// ============================================================
// HeatmapPainter — DrawContext 画当月热力图，返回 Image
// ============================================================

const HeatmapPainter = {
  /** 条数 → 档位序号：-1 = 空格（0 条），0~3 逐档加深。bounds 见 Stats.heatBoundaries */
  levelIndex(count, bounds) {
    if (count <= 0) return -1;
    bounds = bounds || [2, 4, 7];
    if (count < bounds[0]) return 0;
    if (count < bounds[1]) return 1;
    if (count < bounds[2]) return 2;
    return 3;
  },

  /** 条数 → 色阶颜色 */
  levelColor(count, dark, bounds) {
    const t = theme();
    const i = this.levelIndex(count, bounds);
    return i < 0
      ? new Color(dark ? t.heatBaseDark : t.heatBase)
      : new Color(t.heatLevels[i]);
  },

  /** 近 N 天网格的像素尺寸（组件里设置 imageSize 用，避免图片被拉伸铺满） */
  gridMetrics(opts) {
    opts = opts || {};
    const days = opts.days || 30;
    const cols = opts.cols || 6;
    const rows = Math.ceil(days / cols);
    const cell = opts.cell || 26;
    const gap = opts.gap || 6;
    return {
      days, cols, rows, cell, gap,
      w: cols * cell + (cols - 1) * gap,
      h: rows * cell + (rows - 1) * gap,
    };
  },

  /**
   * GitHub 风格近 N 天热力格（组件用）：不画日期数字和星期标签，
   * 纯色块按时间顺序叠放（左上最早，右下 = 今天，带描边高亮），返回 Image。
   *
   * opts：dark 深色取色；days 天数（默认 30）；cols 每行格数（默认 6）；
   *       cell/gap 格子尺寸
   */
  paintRecentGrid(state, opts) {
    opts = opts || {};
    const dark = !!opts.dark;
    const t = theme();
    const m = this.gridMetrics(opts);
    const corner = Math.round(m.cell * 0.28);
    const bounds = Stats.heatBoundaries(state);

    const ctx = new DrawContext();
    ctx.size = new Size(m.w, m.h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    const today = keyToDate(todayKey());
    for (let i = 0; i < m.days; i++) {
      // 用 (年,月,日-偏移) 构造，避免跨夏令时按毫秒加减出现日期偏移
      const d = new Date(
        today.getFullYear(), today.getMonth(), today.getDate() - (m.days - 1 - i)
      );
      const count = Stats.dayTotal(Stats.dayCounts(state, dateKey(d)));
      const col = i % m.cols;
      const row = Math.floor(i / m.cols);
      const x = col * (m.cell + m.gap);
      const y = row * (m.cell + m.gap);

      const path = new Path();
      path.addRoundedRect(new Rect(x, y, m.cell, m.cell), corner, corner);
      ctx.addPath(path);
      ctx.setFillColor(this.levelColor(count, dark, bounds));
      ctx.fillPath();

      if (i === m.days - 1) { // 今天
        const ring = new Path();
        ring.addRoundedRect(
          new Rect(x + 1, y + 1, m.cell - 2, m.cell - 2), corner - 1, corner - 1
        );
        ctx.addPath(ring);
        ctx.setStrokeColor(new Color(dark ? t.heatTodayDark : t.heatToday));
        ctx.setLineWidth(2);
        ctx.strokePath();
      }
    }

    return ctx.getImage();
  },

  /**
   * 画当月日历式热力图（7 列 周日~周六 x 最多 6 行），返回 Image。
   * DrawContext 出图是静态位图，Color.dynamic 不生效，
   * 深浅色由调用方传 opts.dark（用 Device.isUsingDarkAppearance() 判断）。
   *
   * opts：dark 深色模式取色；cell/gap/pad 格子尺寸；
   *       showFooter 是否在图内标注当月总条数（组件里改用组件文字，传 false）
   */
  paintCurrentMonth(state, opts) {
    opts = opts || {};
    const dark = !!opts.dark;
    const t = theme();
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-based
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const firstWeekday = new Date(year, month, 1).getDay(); // 0 = 周日
    const rows = Math.ceil((firstWeekday + daysInMonth) / 7);

    const cell = opts.cell || 30;
    const gap = opts.gap || 7;
    const pad = opts.pad != null ? opts.pad : 10;
    const headerH = Math.round(cell * 0.85); // 星期标签行
    const showFooter = opts.showFooter !== false;
    const footerH = showFooter ? 34 : 0;     // 当月总条数
    const w = pad * 2 + cell * 7 + gap * 6;
    const h = pad * 2 + headerH + rows * cell + (rows - 1) * gap + footerH;

    const labelColor = new Color(dark ? t.secondaryDark : t.secondaryLight);

    const ctx = new DrawContext();
    ctx.size = new Size(w, h);
    ctx.opaque = false;
    ctx.respectScreenScale = true;

    // 星期标签
    ctx.setFont(Font.mediumSystemFont(Math.round(cell * 0.4)));
    ctx.setTextColor(labelColor);
    ctx.setTextAlignedCenter();
    const weekdays = ["日", "一", "二", "三", "四", "五", "六"];
    for (let i = 0; i < 7; i++) {
      const x = pad + i * (cell + gap);
      ctx.drawTextInRect(weekdays[i], new Rect(x, pad, cell, headerH - 6));
    }

    // 日期格子
    const tKey = todayKey();
    const bounds = Stats.heatBoundaries(state);
    const dayFont = Math.round(cell * 0.37);
    const corner = Math.round(cell * 0.23);
    ctx.setFont(Font.mediumSystemFont(dayFont));
    for (let day = 1; day <= daysInMonth; day++) {
      const idx = firstWeekday + day - 1;
      const col = idx % 7;
      const row = Math.floor(idx / 7);
      const x = pad + col * (cell + gap);
      const y = pad + headerH + row * (cell + gap);
      const rect = new Rect(x, y, cell, cell);
      const key = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const count = Stats.dayTotal(Stats.dayCounts(state, key));
      const level = this.levelIndex(count, bounds);

      const path = new Path();
      path.addRoundedRect(rect, corner, corner);
      ctx.addPath(path);
      ctx.setFillColor(this.levelColor(count, dark, bounds));
      ctx.fillPath();

      // 今天加描边高亮
      if (key === tKey) {
        const ring = new Path();
        ring.addRoundedRect(new Rect(x + 1, y + 1, cell - 2, cell - 2), corner - 1, corner - 1);
        ctx.addPath(ring);
        ctx.setStrokeColor(new Color(dark ? t.heatTodayDark : t.heatToday));
        ctx.setLineWidth(2);
        ctx.strokePath();
      }

      // 日期数字：深色档用白字；浅粉档固定深字保证对比度；空格随模式
      if (level >= 2) ctx.setTextColor(Color.white());
      else if (level >= 0) ctx.setTextColor(new Color(t.secondaryLight));
      else ctx.setTextColor(labelColor);
      const textH = dayFont + 3;
      ctx.drawTextInRect(String(day), new Rect(x, y + (cell - textH) / 2, cell, textH));
    }

    // 当月总条数
    if (showFooter) {
      const monthSum = Stats.monthTotal(state, 0);
      ctx.setFont(Font.semiboldSystemFont(14));
      ctx.setTextColor(new Color(dark ? t.primaryDark : t.heatText));
      ctx.drawTextInRect(
        `${month + 1}月共 ${monthSum} 条泡泡`,
        new Rect(0, h - pad - footerH + 10, w, 20)
      );
    }

    return ctx.getImage();
  },
};

// ============================================================
// WidgetView — 组件渲染：small / medium
// ============================================================

const WidgetView = {
  _applyBackground(widget) {
    const t = theme();
    const g = new LinearGradient();
    g.colors = [
      Color.dynamic(new Color(t.bgTopLight), new Color(t.bgTopDark)),
      Color.dynamic(new Color(t.bgBottomLight), new Color(t.bgBottomDark)),
    ];
    g.locations = [0, 1];
    g.startPoint = new Point(0, 0);
    g.endPoint = new Point(1, 1);
    widget.backgroundGradient = g;
  },

  _primary() {
    const t = theme();
    return Color.dynamic(new Color(t.primaryLight), new Color(t.primaryDark));
  },

  _secondary() {
    const t = theme();
    return Color.dynamic(new Color(t.secondaryLight), new Color(t.secondaryDark));
  },

  build(state, family, avatar) {
    if (family === "large") return this.buildLarge(state, avatar);
    if (family === "medium") return this.buildMedium(state, avatar);
    return this.buildSmall(state, avatar);
  },

  /** 在 stack 里加一行 [圆形头像?] D+xxx，返回 D+ 文本元素 */
  _addDPlusRow(stack, state, avatar, avatarSize, fontSize) {
    const row = stack.addStack();
    row.layoutHorizontally();
    row.centerAlignContent();
    if (avatar) {
      const av = row.addImage(avatar);
      av.imageSize = new Size(avatarSize, avatarSize);
      av.cornerRadius = avatarSize / 2;
      av.applyFillingContentMode();
      row.addSpacer(6);
    }
    const dText = row.addText(`D+${Stats.dPlus(state)}`);
    dText.font = Font.heavySystemFont(fontSize);
    dText.textColor = this._primary();
    dText.minimumScaleFactor = 0.5;
    dText.lineLimit = 1;
    return dText;
  },

  /** small：D+天数（超大字）+ 今日总条数一行小字 */
  buildSmall(state, avatar) {
    const widget = new ListWidget();
    this._applyBackground(widget);
    widget.setPadding(14, 14, 14, 14);

    const name = state.config.idolName + (Stats.isAnniversary(state) ? " 🎉" : "");
    const nameText = widget.addText(`🫧 ${name}`);
    nameText.font = Font.semiboldSystemFont(13);
    nameText.textColor = this._secondary();
    nameText.lineLimit = 1;

    widget.addSpacer();

    this._addDPlusRow(widget, state, avatar, 30, 34);

    widget.addSpacer();

    const today = Stats.todayCounts(state);
    const todayTotal = Stats.dayTotal(today);
    const line = todayTotal === 0
      ? "今天还没有泡泡 🫧"
      : `今日 ${todayTotal} 条 · 累计 ${Stats.grandTotal(state)}`;
    const sub = widget.addText(line);
    sub.font = Font.mediumSystemFont(11);
    sub.textColor = this._secondary();
    sub.minimumScaleFactor = 0.7;
    sub.lineLimit = 1;

    return widget;
  },

  /** medium：左侧昵称 + D+ + 今日条数；右侧近 30 天迷你热力格；底部统计 */
  buildMedium(state, avatar) {
    const widget = new ListWidget();
    this._applyBackground(widget);
    widget.setPadding(16, 18, 14, 18);

    const body = widget.addStack();
    body.layoutHorizontally();
    body.centerAlignContent();

    // 左列：昵称 + D+
    const left = body.addStack();
    left.layoutVertically();

    const name = state.config.idolName + (Stats.isAnniversary(state) ? " 🎉" : "");
    const nameText = left.addText(`🫧 ${name}`);
    nameText.font = Font.semiboldSystemFont(14);
    nameText.textColor = this._secondary();
    nameText.lineLimit = 1;

    left.addSpacer(6);

    this._addDPlusRow(left, state, avatar, 32, 38);

    left.addSpacer(4);

    const today = Stats.todayCounts(state);
    const todayText = left.addText(
      Stats.dayTotal(today) === 0
        ? "今天还没有泡泡 🫧"
        : `今日 ${Stats.dayTotal(today)} 条`
    );
    todayText.font = Font.mediumSystemFont(12);
    todayText.textColor = this._secondary();
    todayText.lineLimit = 1;

    body.addSpacer();

    // 右列：近 30 天迷你热力格（包一层竖排 stack 往下压、右侧留白往左挪）
    const gridOpts = { days: 30, cols: 6, cell: 15, gap: 4 };
    const m = HeatmapPainter.gridMetrics(gridOpts);
    const img = HeatmapPainter.paintRecentGrid(state, {
      ...gridOpts,
      dark: Device.isUsingDarkAppearance(),
    });
    const right = body.addStack();
    right.layoutVertically();
    right.addSpacer(12); // 往下
    const imgEl = right.addImage(img);
    imgEl.imageSize = new Size(m.w, m.h); // 按原尺寸显示，不让系统拉伸铺满
    imgEl.centerAlignImage();
    body.addSpacer(10); // 距右边留白，整体往左

    widget.addSpacer(8);

    // 底部：近 30 天 / 累计
    const footer = widget.addText(
      `近30天 ${Stats.recentTotal(state, 30)} 条 · 累计 ${Stats.grandTotal(state)} 条`
    );
    footer.font = Font.mediumSystemFont(11);
    footer.textColor = this._secondary();
    footer.lineLimit = 1;

    return widget;
  },

  /** large：顶部昵称 + 头像/D+，今日四类计数，近 6 周热力格（42 格），底部两行统计 */
  buildLarge(state, avatar) {
    const widget = new ListWidget();
    this._applyBackground(widget);
    widget.setPadding(16, 16, 12, 16);

    // 顶部：昵称 + D+
    const header = widget.addStack();
    header.layoutHorizontally();
    header.centerAlignContent();

    const name = state.config.idolName + (Stats.isAnniversary(state) ? " 🎉" : "");
    const nameText = header.addText(`🫧 ${name}`);
    nameText.font = Font.semiboldSystemFont(15);
    nameText.textColor = this._secondary();
    nameText.lineLimit = 1;

    header.addSpacer();

    this._addDPlusRow(header, state, avatar, 26, 24);

    widget.addSpacer(2);

    // 今日一行
    const today = Stats.todayCounts(state);
    const todayLine = Stats.dayTotal(today) === 0
      ? "今天还没有泡泡 🫧"
      : "今日  " + CONFIG.types
          .map((tp) => `${CONFIG.typeMeta[tp].emoji} ${today[tp]}`)
          .join("  ");
    const todayText = widget.addText(todayLine);
    todayText.font = Font.mediumSystemFont(13);
    todayText.textColor = this._secondary();
    todayText.lineLimit = 1;

    widget.addSpacer();

    // 近 6 周热力格（42 格，GitHub 风格，无日期数字；静态位图，按当前深浅色取色）
    const gridOpts = { days: 42, cols: 7, cell: 26, gap: 6 };
    const m = HeatmapPainter.gridMetrics(gridOpts);
    const img = HeatmapPainter.paintRecentGrid(state, {
      ...gridOpts,
      dark: Device.isUsingDarkAppearance(),
    });
    const imgEl = widget.addImage(img);
    imgEl.imageSize = new Size(m.w, m.h); // 按原尺寸显示，不让系统拉伸铺满
    imgEl.centerAlignImage();

    widget.addSpacer();

    // 底部两行：月度对比 + 累计
    const line1 = widget.addText(
      `本月 ${Stats.monthTotal(state, 0)} 条 · 上月 ${Stats.monthTotal(state, -1)} 条 · 环比 ${Stats.momText(state)}`
    );
    line1.font = Font.mediumSystemFont(12);
    line1.textColor = this._secondary();
    line1.centerAlignText();
    line1.lineLimit = 1;

    widget.addSpacer(4);

    const line2 = widget.addText(
      `近6周 ${Stats.recentTotal(state, 42)} 条 · 累计 ${Stats.grandTotal(state)} 条 · 日均 ${Stats.dayAvg(state)}`
    );
    line2.font = Font.mediumSystemFont(12);
    line2.textColor = this._secondary();
    line2.centerAlignText();
    line2.lineLimit = 1;

    return widget;
  },

  /** 尚未初始化时的占位组件 */
  buildEmpty() {
    const widget = new ListWidget();
    this._applyBackground(widget);
    const txt = widget.addText("🫧 点我初始化 BubbleLog");
    txt.font = Font.semiboldSystemFont(14);
    txt.textColor = this._primary();
    txt.centerAlignText();
    return widget;
  },
};

// ============================================================
// PanelView — 记录面板：UITable（四按钮 + 撤销 + 补记 + 统计区 + 热力图）
// ============================================================

const PanelView = {
  /**
   * 展示记录面板。
   * @param {string} targetDate 记录写入的日期 key；今天 = 主面板，其他 = 补记面板
   */
  async present(targetDate) {
    targetDate = targetDate || todayKey();
    const isToday = targetDate === todayKey();

    const table = new UITable();
    table.showSeparators = true;

    let { state } = await Store.load();
    if (!state) return;
    let feedback = null; // { type, count } 最近一次点击的反馈

    const render = () => {
      // 每次重绘时取当前主题色，切换主题后立即生效
      const t = theme();
      const primary = new Color(t.primaryLight);
      const secondary = new Color(t.secondaryLight);

      table.removeAllRows();

      // ---- 头部 ----
      const header = new UITableRow();
      header.isHeader = true;
      header.height = 54;
      const anniversary = Stats.isAnniversary(state) ? " 🎉" : "";
      const headCell = header.addText(
        `🫧 ${state.config.idolName}${anniversary}  D+${Stats.dPlus(state)}`,
        isToday ? "记录今天的泡泡，点一下就 +1" : `📅 补记 ${targetDate} 的泡泡`
      );
      headCell.titleFont = Font.boldSystemFont(20);
      headCell.titleColor = primary;
      headCell.subtitleFont = Font.systemFont(12);
      headCell.subtitleColor = secondary;
      table.addRow(header);

      // ---- 四个记录按钮 ----
      const dayLabel = isToday ? "今日" : targetDate.slice(5).replace("-", "/");
      for (const type of CONFIG.types) {
        const meta = CONFIG.typeMeta[type];
        const row = new UITableRow();
        row.height = 58;
        row.dismissOnSelect = false;
        const count = Stats.dayCounts(state, targetDate)[type];
        const isFeedback = feedback && feedback.type === type;
        const title = `${meta.emoji}  ${meta.label}`;
        const subtitle = isFeedback
          ? `已记录 ✓ ${dayLabel}${meta.label} x${count}`
          : `${dayLabel} ${count} 条`;
        const cell = row.addText(title, subtitle);
        cell.titleFont = Font.semiboldSystemFont(18);
        cell.subtitleFont = Font.systemFont(13);
        cell.subtitleColor = isFeedback ? primary : secondary;
        row.onSelect = async () => {
          state = await Store.record(type, targetDate);
          feedback = { type };
          render();
        };
        table.addRow(row);
      }

      // ---- 撤销（仅当 lastAction 存在且属于当前面板日期时可用） ----
      const canUndo = !!(state.lastAction && state.lastAction.date === targetDate);
      const undoRow = new UITableRow();
      undoRow.height = 48;
      undoRow.dismissOnSelect = false;
      if (canUndo) {
        const meta = CONFIG.typeMeta[state.lastAction.type];
        const cell = undoRow.addText(
          "↩️  撤销上一条",
          `将撤销：${meta.emoji} ${meta.label}（${state.lastAction.date}）`
        );
        cell.titleFont = Font.mediumSystemFont(16);
        cell.subtitleFont = Font.systemFont(12);
        cell.subtitleColor = secondary;
        undoRow.onSelect = async () => {
          const updated = await Store.undo();
          if (updated) state = updated;
          feedback = null;
          render();
        };
      } else {
        const cell = undoRow.addText("↩️  撤销上一条", "暂无可撤销的记录");
        cell.titleFont = Font.mediumSystemFont(16);
        cell.titleColor = Color.gray();
        cell.subtitleFont = Font.systemFont(12);
        cell.subtitleColor = Color.gray();
      }
      table.addRow(undoRow);

      // ---- 直接修改这天的条数（记错了在这里改） ----
      const editRow = new UITableRow();
      editRow.height = 48;
      editRow.dismissOnSelect = false;
      const editCell = editRow.addText(
        "✏️  修改这天的条数",
        `记错了？直接改写 ${isToday ? "今天" : targetDate} 每类的总数`
      );
      editCell.titleFont = Font.mediumSystemFont(16);
      editCell.subtitleFont = Font.systemFont(12);
      editCell.subtitleColor = secondary;
      editRow.onSelect = async () => {
        const counts = await this._askEditCounts(state, targetDate);
        if (counts) {
          state = await Store.setDayCounts(targetDate, counts);
          feedback = null;
          render();
        }
      };
      table.addRow(editRow);

      // ---- 补记入口（仅主面板显示，避免套娃） ----
      if (isToday) {
        const backfillRow = new UITableRow();
        backfillRow.height = 48;
        backfillRow.dismissOnSelect = false;
        const cell = backfillRow.addText("📅  补记其他日期", "凌晨收到、忘了记？在这里补");
        cell.titleFont = Font.mediumSystemFont(16);
        cell.subtitleFont = Font.systemFont(12);
        cell.subtitleColor = secondary;
        backfillRow.onSelect = async () => {
          const key = await this._askBackfillDate();
          if (key) {
            await this.present(key); // 补记面板（同样的四按钮，写入指定日期）
            const reloaded = await Store.load(); // 回来后刷新主面板数据
            if (reloaded.state) state = reloaded.state;
            feedback = null;
            render();
          }
        };
        table.addRow(backfillRow);

        // ---- 切换主题 ----
        const themeRow = new UITableRow();
        themeRow.height = 48;
        themeRow.dismissOnSelect = false;
        const themeCell = themeRow.addText(
          "🎨  切换主题",
          `当前：${t.label}（组件稍后自动换色）`
        );
        themeCell.titleFont = Font.mediumSystemFont(16);
        themeCell.subtitleFont = Font.systemFont(12);
        themeCell.subtitleColor = secondary;
        themeRow.onSelect = async () => {
          const names = Object.keys(CONFIG.theme);
          const a = new Alert();
          a.title = "切换主题";
          for (const n of names) a.addAction(CONFIG.theme[n].label);
          a.addCancelAction("取消");
          const idx = await a.presentSheet();
          if (idx === -1) return;
          const chosen = names[idx];
          state = await Store.mutate((s) => { s.config.theme = chosen; });
          CONFIG.themeName = chosen;
          render();
        };
        table.addRow(themeRow);

        // ---- 组件头像 ----
        const avatarRow = new UITableRow();
        avatarRow.height = 48;
        avatarRow.dismissOnSelect = false;
        const avatarCell = avatarRow.addText(
          "🖼  组件头像",
          Store.hasAvatar() ? "已设置 · 显示在组件 D+ 前面" : "从相册选一张，显示在组件 D+ 前面"
        );
        avatarCell.titleFont = Font.mediumSystemFont(16);
        avatarCell.subtitleFont = Font.systemFont(12);
        avatarCell.subtitleColor = secondary;
        avatarRow.onSelect = async () => {
          const a = new Alert();
          a.title = "组件头像";
          a.addAction("从相册选择");
          if (Store.hasAvatar()) a.addDestructiveAction("移除头像");
          a.addCancelAction("取消");
          const idx = await a.presentAlert();
          if (idx === 0) {
            try {
              const img = await Photos.fromLibrary();
              if (img) Store.saveAvatar(img);
            } catch (e) { /* 用户取消选择 */ }
          } else if (idx === 1) {
            Store.removeAvatar();
          }
          render();
        };
        table.addRow(avatarRow);
      }

      // ---- 统计区（只读） ----
      const statsHeader = new UITableRow();
      statsHeader.isHeader = true;
      statsHeader.height = 40;
      const sh = statsHeader.addText("📊 统计");
      sh.titleFont = Font.boldSystemFont(16);
      sh.titleColor = primary;
      table.addRow(statsHeader);

      const addStatRow = (title, subtitle) => {
        const row = new UITableRow();
        row.height = 46;
        row.dismissOnSelect = false;
        const cell = row.addText(title, subtitle);
        cell.titleFont = Font.mediumSystemFont(15);
        cell.subtitleFont = Font.systemFont(12);
        cell.subtitleColor = secondary;
        table.addRow(row);
      };

      const today = Stats.todayCounts(state);
      const todayLine = CONFIG.types
        .map((tp) => `${CONFIG.typeMeta[tp].emoji} ${today[tp]}`)
        .join("　");
      addStatRow(
        Stats.dayTotal(today) === 0 ? "今天还没有泡泡 🫧" : todayLine,
        `今日共 ${Stats.dayTotal(today)} 条`
      );

      const cur = Stats.monthTotal(state, 0);
      const prev = Stats.monthTotal(state, -1);
      addStatRow(`本月 ${cur} 条 · 上月 ${prev} 条`, `环比 ${Stats.momText(state)}`);

      addStatRow(
        `历史累计 ${Stats.grandTotal(state)} 条`,
        `订阅 ${Stats.dPlus(state)} 天 · 日均 ${Stats.dayAvg(state)} 条`
      );

      // ---- 月度热力图 ----
      const heatRow = new UITableRow();
      heatRow.height = 250;
      heatRow.dismissOnSelect = false;
      const img = HeatmapPainter.paintCurrentMonth(state, {
        dark: Device.isUsingDarkAppearance(),
      });
      const imgCell = heatRow.addImage(img);
      imgCell.centerAligned();
      table.addRow(heatRow);

      // ---- 底部提示 ----
      const tip = new UITableRow();
      tip.height = 36;
      tip.dismissOnSelect = false;
      const tipCell = tip.addText("记录已保存，桌面组件稍后自动更新 ✓");
      tipCell.titleFont = Font.systemFont(12);
      tipCell.titleColor = Color.gray();
      tipCell.centerAligned();
      table.addRow(tip);

      table.reload();
    };

    render();
    await table.present(false);
  },

  /**
   * 弹出四个输入框（预填当前值），直接改写某天每类的总条数。
   * 返回 { text, voice, image, emoji } 或 null（取消）。
   */
  async _askEditCounts(state, key) {
    const cur = Stats.dayCounts(state, key);
    while (true) {
      const a = new Alert();
      a.title = `修改 ${key}`;
      a.message = "填入这天每类消息的总条数（不是增量）";
      for (const tp of CONFIG.types) {
        const meta = CONFIG.typeMeta[tp];
        a.addTextField(`${meta.emoji} ${meta.label}`, String(cur[tp]));
      }
      a.addAction("保存");
      a.addCancelAction("取消");
      if ((await a.presentAlert()) === -1) return null;
      const counts = {};
      let ok = true;
      CONFIG.types.forEach((tp, i) => {
        const v = a.textFieldValue(i).trim();
        if (!/^\d+$/.test(v)) ok = false;
        counts[tp] = Number(v);
      });
      if (ok) return counts;
      const err = new Alert();
      err.title = "数字格式不对";
      err.message = "每一项都要填 0 或正整数。";
      err.addAction("重新输入");
      await err.presentAlert();
    }
  },

  /** 弹出补记日期输入，返回合法 dateKey 或 null（取消） */
  async _askBackfillDate() {
    while (true) {
      const a = new Alert();
      a.title = "补记其他日期";
      a.message = "输入要补记的日期（YYYY-MM-DD）";
      a.addTextField("YYYY-MM-DD", todayKey());
      a.addAction("确定");
      a.addCancelAction("取消");
      if ((await a.presentAlert()) === -1) return null;
      const v = a.textFieldValue(0).trim();
      if (isValidDateKey(v) && keyToDate(v) <= new Date()) return v;
      const err = new Alert();
      err.title = "日期格式不对";
      err.message = "请输入 YYYY-MM-DD 格式、且不晚于今天的日期。";
      err.addAction("重新输入");
      await err.presentAlert();
    }
  },
};

// ============================================================
// main — 入口分发
// ============================================================

async function main() {
  if (config.runsInWidget) {
    // ---- Widget 模式：静态快照，点击跳回脚本 ----
    const { state } = await Store.load();
    let widget;
    if (state) {
      CONFIG.themeName = state.config.theme || CONFIG.themeName;
      const avatar = await Store.loadAvatar();
      widget = WidgetView.build(state, config.widgetFamily, avatar);
    } else {
      widget = WidgetView.buildEmpty();
    }
    widget.url = URLScheme.forRunningScript();
    Script.setWidget(widget);
  } else {
    // ---- App 模式：初始化引导 / 记录面板 ----
    const loaded = await Store.load();
    let state = loaded.state;

    if (loaded.source === "backup") {
      const a = new Alert();
      a.title = "已从备份恢复";
      a.message = "state.json 损坏，已自动从 state.backup.json 恢复数据。";
      a.addAction("好");
      await a.presentAlert();
    } else if (loaded.corrupt) {
      const a = new Alert();
      a.title = "数据文件损坏";
      a.message = "state.json 与备份均无法读取。可以重新初始化（历史数据将丢失），或先取消并手动检查 iCloud Drive/Scriptable/bubblelog/ 目录。";
      a.addAction("重新初始化");
      a.addCancelAction("取消");
      if ((await a.presentAlert()) === -1) {
        Script.complete();
        return;
      }
      state = null;
    }

    if (!state) {
      state = await Store.initWizard();
      if (!state) {
        Script.complete();
        return;
      }
    }

    CONFIG.themeName = state.config.theme || CONFIG.themeName;
    await PanelView.present();
  }
  Script.complete();
}

await main();
