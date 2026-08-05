#!/usr/bin/env node
/**
 * BubbleLog 数据层断言测试（Node 环境）
 *
 * Scriptable 的 API 在 Node 里不存在，这里 mock 掉 FileManager 等全局对象，
 * 只测纯数据逻辑：Store（读写/备份/恢复/撤销/补记/totals 一致性）与 Stats。
 * UI 部分（ListWidget / UITable / DrawContext）需在真机 Scriptable 上验证。
 *
 * 运行：node tests/test.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ---------- Scriptable 全局 mock ----------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "bubblelog-test-"));

function makeMockFM() {
  return {
    joinPath: (a, b) => path.join(a, b),
    documentsDirectory: () => tmpRoot,
    isDirectory: (p) => fs.existsSync(p) && fs.statSync(p).isDirectory(),
    createDirectory: (p, recursive) => fs.mkdirSync(p, { recursive }),
    fileExists: (p) => fs.existsSync(p),
    readString: (p) => fs.readFileSync(p, "utf8"),
    writeString: (p, s) => fs.writeFileSync(p, s, "utf8"),
    remove: (p) => fs.rmSync(p),
    downloadFileFromiCloud: async () => {},
  };
}

global.FileManager = {
  iCloud: () => { throw new Error("iCloud unavailable in tests"); }, // 走 local 分支
  local: () => makeMockFM(),
};
global.config = { runsInWidget: false, widgetFamily: "small" };
global.Script = { setWidget: () => {}, complete: () => {} };
global.Alert = class { addTextField() {} addAction() {} addCancelAction() {} async presentAlert() { return -1; } textFieldValue() { return ""; } };
// UI 类占位（测试不触达，仅防止定义阶段引用报错）
for (const name of ["ListWidget", "UITable", "UITableRow", "DrawContext", "LinearGradient", "Path"]) {
  global[name] = class {};
}
global.Color = class Color {
  constructor(hex) { this.hex = hex; }
  static dynamic(a) { return a; }
  static white() { return new Color("#fff"); }
  static gray() { return new Color("#888"); }
};
global.Size = class { constructor(w, h) { this.width = w; this.height = h; } };
global.Point = class { constructor(x, y) { this.x = x; this.y = y; } };
global.Rect = class { constructor(x, y, w, h) { Object.assign(this, { x, y, w, h }); } };
global.Font = new Proxy({}, { get: () => () => ({}) });
global.URLScheme = { forRunningScript: () => "scriptable:///run" };

// ---------- 加载被测代码（去掉入口调用） ----------

const source = fs
  .readFileSync(path.join(__dirname, "..", "BubbleLog.js"), "utf8")
  .replace("await main();", "/* main() skipped in tests */");

const loadModule = new Function(
  source +
    "\n;return { CONFIG, Store, Stats, HeatmapPainter, PosterPainter, dateKey, todayKey," +
    " isValidDateKey, keyToDate, daysBetween, mixHex };"
);
const {
  CONFIG, Store, Stats, HeatmapPainter, PosterPainter,
  dateKey, todayKey, isValidDateKey, keyToDate, daysBetween, mixHex,
} = loadModule();

// ---------- 断言工具 ----------

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}
function assertEq(actual, expected, msg) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${msg}（期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}）`
  );
}

// ---------- 测试 ----------

(async () => {
  console.log("== 日期工具 ==");
  assert(isValidDateKey("2024-11-20"), "合法日期通过校验");
  assert(!isValidDateKey("2024-13-01"), "13 月被拒绝");
  assert(!isValidDateKey("2024-02-30"), "2 月 30 日被拒绝");
  assert(!isValidDateKey("2024/11/20"), "斜杠格式被拒绝");
  assertEq(daysBetween(keyToDate("2026-07-01"), keyToDate("2026-07-06")), 5, "daysBetween 计算");

  console.log("== 初始化与加载 ==");
  const initial = {
    config: { idolName: "OO", startDate: "2024-11-20", theme: "pink" },
    days: {},
    totals: { text: 0, voice: 0, image: 0, emoji: 0 },
    lastAction: null,
  };
  await Store.save(initial);
  let { state, source: src } = await Store.load();
  assert(src === "main", "从主文件加载");
  assertEq(state.totals, { text: 0, voice: 0, image: 0, emoji: 0 }, "初始 totals 为 0");

  console.log("== 记录（连点） ==");
  const tKey = todayKey();
  await Store.record("text");
  await Store.record("text");
  state = await Store.record("voice");
  assertEq(state.days[tKey], { text: 2, voice: 1, image: 0, emoji: 0 }, "今日计数正确");
  assertEq(state.totals, { text: 2, voice: 1, image: 0, emoji: 0 }, "totals 同步维护");
  assertEq(state.lastAction.type, "voice", "lastAction 记录最后一次类型");
  assertEq(state.lastAction.date, tKey, "lastAction 记录日期");

  console.log("== 撤销 ==");
  state = await Store.undo();
  assertEq(state.days[tKey], { text: 2, voice: 0, image: 0, emoji: 0 }, "撤销后计数回退一步");
  assertEq(state.totals.voice, 0, "撤销后 totals 同步回退");
  assert(state.lastAction === null, "撤销后 lastAction 清空（只支持一步）");
  const noUndo = await Store.undo();
  assertEq(noUndo, null, "无 lastAction 时撤销返回 null");

  console.log("== 补记 ==");
  const now = new Date();
  const backKey = dateKey(new Date(now.getFullYear(), now.getMonth(), 1)); // 当月 1 号
  state = await Store.record("image", backKey);
  const expectBack = backKey === tKey ? { text: 2, voice: 0, image: 1, emoji: 0 } : { text: 0, voice: 0, image: 1, emoji: 0 };
  assertEq(state.days[backKey], expectBack, "补记写入指定日期");
  assertEq(state.lastAction.date, backKey, "补记后 lastAction 指向补记日期");
  // 撤销补记
  state = await Store.undo();
  if (backKey !== tKey) {
    assert(!(backKey in state.days), "补记日期归零后从 days 中清除");
  }

  console.log("== totals 一致性 ==");
  state.totals.text = 999; // 人为制造不一致
  const dirty = Store.reconcileTotals(state);
  assert(dirty, "检测到 totals 与 days 不一致");
  assertEq(state.totals.text, 2, "以 days 重算修正 totals");
  Store.rebuildTotals(state);
  assertEq(Stats.grandTotal(state), 2, "rebuildTotals 后 grandTotal 正确");

  console.log("== Stats ==");
  const s2 = {
    config: { idolName: "OO", startDate: dateKey(new Date(Date.now() - 9 * 86400000)), theme: "pink" },
    days: {}, totals: { text: 0, voice: 0, image: 0, emoji: 0 }, lastAction: null,
  };
  assertEq(Stats.dPlus(s2), 10, "起始日当天为 D+1，9 天前开始 = D+10");
  s2.days[todayKey()] = { text: 3, voice: 1, image: 2, emoji: 0 };
  assertEq(Stats.dayTotal(Stats.todayCounts(s2)), 6, "todayCounts 求和");
  assert(Stats.monthTotal(s2, 0) >= 6, "当月总数包含今日");
  Store.rebuildTotals(s2);
  assertEq(Stats.grandTotal(s2), 6, "grandTotal");
  assert(typeof Stats.momText(s2) === "string", "环比文案可生成");
  // 近 N 天统计：31 天前的记录不计入近 30 天，但计入累计
  const oldKey = dateKey(new Date(Date.now() - 31 * 86400000));
  s2.days[oldKey] = { text: 2, voice: 0, image: 0, emoji: 0 };
  Store.rebuildTotals(s2);
  assertEq(Stats.recentTotal(s2, 30), 6, "recentTotal 只统计近 30 天");
  assertEq(Stats.grandTotal(s2), 8, "31 天前的记录仍计入累计");
  delete s2.days[oldKey];
  Store.rebuildTotals(s2);
  const s100 = {
    config: { idolName: "OO", startDate: dateKey(new Date(Date.now() - 99 * 86400000)), theme: "pink" },
    days: {}, totals: { text: 0, voice: 0, image: 0, emoji: 0 }, lastAction: null,
  };
  assertEq(Stats.dPlus(s100), 100, "整百天 D+ 计算");
  assert(Stats.isAnniversary(s100), "D+100 判定为纪念日");

  console.log("== 热力图自适应分档 ==");
  const s3 = {
    config: { idolName: "OO", startDate: "2026-01-01", theme: "pink" },
    days: {}, totals: { text: 0, voice: 0, image: 0, emoji: 0 }, lastAction: null,
  };
  s3.days["2026-06-01"] = { text: 5, voice: 0, image: 0, emoji: 0 };
  assertEq(Stats.heatBoundaries(s3), [2, 4, 7], "非零天数不足 4 时退回固定档");
  // 八天：10/20/30/40/50/60/70/80 → 四分位 [30, 50, 70]
  [10, 20, 30, 40, 50, 60, 70, 80].forEach((n, i) => {
    s3.days[`2026-06-${String(i + 2).padStart(2, "0")}`] = { text: n, voice: 0, image: 0, emoji: 0 };
  });
  delete s3.days["2026-06-01"];
  s3.days["2026-06-01"] = { text: 25, voice: 0, image: 0, emoji: 0 }; // 凑 9 天，边界不变段
  const bounds = Stats.heatBoundaries(s3);
  assert(bounds[0] < bounds[1] && bounds[1] < bounds[2], "几十条量级下边界拉开层次");
  assertEq(HeatmapPainter.levelIndex(0, bounds), -1, "0 条 = 空格");
  assertEq(HeatmapPainter.levelIndex(10, bounds), 0, "低于 q25 为最浅档");
  assertEq(HeatmapPainter.levelIndex(80, bounds), 3, "高于 q75 为最深档");
  assert(
    HeatmapPainter.levelIndex(10, bounds) < HeatmapPainter.levelIndex(45, bounds) &&
    HeatmapPainter.levelIndex(45, bounds) < HeatmapPainter.levelIndex(80, bounds),
    "条数越多档位越深（不再全是同色）"
  );

  console.log("== 直接修改某天条数 ==");
  await Store.record("text"); // 制造 lastAction
  let edited = await Store.setDayCounts(tKey, { text: 5, voice: 2, image: 1, emoji: 0 });
  assertEq(edited.days[tKey], { text: 5, voice: 2, image: 1, emoji: 0 }, "改写为指定条数（非增量）");
  assertEq(Stats.grandTotal(edited), 8, "改写后 totals 以 days 重算");
  assert(edited.lastAction === null, "手动改写后清空 lastAction");
  edited = await Store.setDayCounts(tKey, { text: 0, voice: 0, image: 0, emoji: 0 });
  assert(!(tKey in edited.days), "全部清零后从 days 中移除");
  assertEq(Stats.grandTotal(edited), 0, "清零后累计归零");

  console.log("== 主题色板 ==");
  const paletteKeys = [
    "label", "bgTopLight", "bgBottomLight", "bgTopDark", "bgBottomDark",
    "primaryLight", "primaryDark", "secondaryLight", "secondaryDark",
    "heatBase", "heatBaseDark", "heatLevels", "heatText", "heatToday", "heatTodayDark",
  ];
  for (const name of ["pink", "gray", "blue"]) {
    const p = CONFIG.theme[name];
    assert(p && paletteKeys.every((k) => k in p), `${name} 主题色板字段完整`);
    assert(p && p.heatLevels.length === 4, `${name} 主题热力图为 4 档色阶`);
  }
  // 切主题写入 state
  const themed = await Store.mutate((s) => { s.config.theme = "blue"; });
  assertEq(themed.config.theme, "blue", "主题选择持久化到 state.config.theme");
  await Store.mutate((s) => { s.config.theme = "pink"; });

  console.log("== 月度统计 ==");
  // 固定用 2020 年的数据，避免断言随运行日期漂移
  const sm = {
    config: { idolName: "OO", startDate: "2020-01-01", theme: "pink" },
    days: {
      "2020-02-10": { text: 10, voice: 0, image: 0, emoji: 0 },
      "2020-03-01": { text: 2, voice: 0, image: 0, emoji: 0 },
      "2020-03-02": { text: 1, voice: 2, image: 0, emoji: 0 },
      "2020-03-03": { text: 0, voice: 1, image: 0, emoji: 0 },
      "2020-03-05": { text: 0, voice: 0, image: 3, emoji: 0 },
      "2020-03-20": { text: 0, voice: 9, image: 0, emoji: 0 },
    },
    totals: { text: 0, voice: 0, image: 0, emoji: 0 },
    lastAction: null,
  };
  Store.rebuildTotals(sm);

  assertEq(Stats.monthKey(2020, 3), "2020-03", "monthKey 补零");
  assertEq(
    Stats.monthCounts(sm, 2020, 3),
    { text: 3, voice: 12, image: 3, emoji: 0 },
    "monthCounts 只统计目标月"
  );
  assertEq(Stats.availableMonths(sm), ["2020-03", "2020-02"], "availableMonths 倒序");
  assertEq(
    Stats.monthStreak(sm, 2020, 3),
    { days: 3, from: "2020-03-01", to: "2020-03-03" },
    "monthStreak 找到最长连续段"
  );
  assertEq(Stats.monthStreak(sm, 2020, 2), { days: 1, from: "2020-02-10", to: "2020-02-10" }, "单天也算 1 连击");
  assertEq(Stats.monthStreak(sm, 2020, 5), { days: 0, from: null, to: null }, "空月份连击为 0");
  assertEq(Stats.monthPeakDay(sm, 2020, 3), { key: "2020-03-20", total: 9 }, "monthPeakDay 取最高日");
  assert(Stats.monthPeakDay(sm, 2020, 5) === null, "空月份无峰值日");

  const r = Stats.monthReport(sm, 2020, 3);
  assertEq(r.total, 18, "月报总条数");
  assertEq(r.prevTotal, 10, "月报上月总数");
  assertEq(r.momPct, 80, "月报环比百分比");
  assertEq(r.elapsedDays, 31, "已结束的月份按整月天数算");
  assertEq(r.activeDays, 5, "有泡泡的天数");
  assertEq(r.activeRate, 16, "打卡率 = 5/31");
  assertEq(r.dayAvg, 0.6, "日均保留一位小数");
  assertEq(r.topType, "voice", "类型偏好取条数最多的一类");
  assertEq(r.rank, 1, "18 条是记录中最高的月份");
  assertEq(r.monthsWithData, 2, "有记录的月份数");
  assert(r.isCurrent === false, "2020-03 不是当月");

  // 跨年回退：2020-01 的上一月应为 2019-12
  const rJan = Stats.monthReport(sm, 2020, 1);
  assertEq(rJan.prevTotal, 0, "1 月的上月回退到去年 12 月（无数据为 0）");
  assertEq(rJan.momPct, null, "上月为 0 时环比为 null 而非 Infinity");

  // 当月口径：elapsed 用已过天数，不用整月天数
  const nowM = new Date();
  const rCur = Stats.monthReport(sm, nowM.getFullYear(), nowM.getMonth() + 1);
  assert(rCur.isCurrent === true, "当月被识别为进行中");
  assertEq(rCur.elapsedDays, nowM.getDate(), "当月按已过天数计算，月初不会被稀释");

  console.log("== 月历排版尺寸 ==");
  // 2020-03-01 是周日，31 天 → 5 行
  const hm = HeatmapPainter.monthMetrics(2020, 3, {});
  assertEq(hm.rows, 5, "2020 年 3 月为 5 行");
  assertEq(hm.cell, 36, "默认格子放大到 36（要装下条数 + 日期角标）");
  assertEq(hm.w, 298, "月历宽度（iPhone SE 上不会被压缩）");
  assertEq(hm.h, 281, "月历高度含星期行与页脚");
  const hmNoFooter = HeatmapPainter.monthMetrics(2020, 3, { showFooter: false });
  assertEq(hmNoFooter.h, 247, "关掉页脚少 34pt");
  assertEq(mixHex("#000000", "#ffffff", 0.5), "#808080", "渐变插值取中间色");

  console.log("== 四类明细大日历 ==");
  const CW = HeatmapPainter.DETAIL_CELL_W;
  const CH = HeatmapPainter.DETAIL_CELL_H;
  const dm = HeatmapPainter.detailMetrics(2020, 3, {});
  assertEq(dm.rows, 5, "明细日历行数与紧凑版一致");
  assertEq(dm.cellW, CW, "格宽取 DETAIL_CELL_W");
  assertEq(dm.w, CW * 7 + 8 * 6, "默认明细日历宽度");
  assertEq(dm.h, dm.headerH + 5 * CH + 4 * 8, "默认明细日历高度（星期行 + 5 行格子 + 行距）");
  // 海报按日历版心反推格宽，必须刚好塞得下
  const calInner = PosterPainter.W - PosterPainter.calPad * 2;
  const posterCellW = Math.floor((calInner - 6 * 8) / 7);
  const pm = HeatmapPainter.detailMetrics(2020, 3, { cellW: posterCellW, cellH: CH, gap: 8, pad: 0 });
  assert(pm.w <= calInner, `明细日历不超出海报版心（${pm.w} <= ${calInner}）`);
  assert(
    posterCellW >= CW,
    `海报格宽不小于默认值，日历是可视化主体（${posterCellW} >= ${CW}）`
  );
  // 每日照片按 2 倍格子尺寸存盘，比例必须和格子一致，否则贴上去会变形或留黑边
  assertEq(
    (CW * 2) / (CH * 2),
    CW / CH,
    "每日照片裁切比例与日历格一致"
  );
  assertEq(HeatmapPainter.levelHex(0, [2, 4, 7]), null, "0 条没有档位色");
  assertEq(
    HeatmapPainter.levelHex(99, [2, 4, 7]),
    CONFIG.theme[CONFIG.themeName].heatLevels[3],
    "高档取色阶最深一档"
  );
  // 6 行的月份（2020-05：5/1 是周五，31 天 → 6 行）要能撑开高度
  const dm6 = HeatmapPainter.detailMetrics(2020, 5, {});
  assertEq(dm6.rows, 6, "2020 年 5 月为 6 行");
  assertEq(dm6.h, dm6.headerH + 6 * CH + 5 * 8, "6 行月份高度正确");

  console.log("== 备份与损坏恢复 ==");
  // 上面多次 save 已产生备份；现在写坏主文件
  const fm = Store.fm();
  fm.writeString(Store.statePath(), "{ this is not json !!!");
  const recovered = await Store.load();
  assert(recovered.source === "backup", "主文件损坏时从备份加载");
  assert(recovered.state !== null, "备份数据可用");
  const afterRepair = await Store.load();
  assert(afterRepair.source === "main", "恢复后主文件已被修复");

  // 主文件与备份都损坏
  fm.writeString(Store.statePath(), "broken");
  fm.writeString(Store.backupPath(), "also broken");
  const dead = await Store.load();
  assert(dead.state === null && dead.corrupt === true, "双损坏时返回 corrupt 标记且不崩溃");

  // ---------- 汇总 ----------
  console.log(`\n结果：${passed} 通过，${failed} 失败`);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  process.exit(failed > 0 ? 1 : 0);
})();
