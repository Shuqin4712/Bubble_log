# 🫧 BubbleLog — 泡泡消息记录小组件

一个运行在 iOS [Scriptable](https://scriptable.app/) 上的追星记录组件。展示与爱豆的订阅天数（D+xxx）和泡泡（Bubble / Dear U）消息统计：今日/累计的文字、语音、图片、表情包条数。数据由你手动快速记录——收到消息后点组件、按类型点一下按钮，整个操作 5 秒内完成。

> 为什么是手动记录：Bubble 无公开 API，iOS 沙盒禁止跨 App 读取数据，自动统计不可行且有账号风险。本项目定位是「把追星手账产品化」——记录本身就是仪式感的一部分。

纯本地 JavaScript，无后端、无 npm 依赖、完全离线。数据存 iCloud，换机不丢。

## 功能

- **桌面组件**（small / medium / large）：D+ 天数、今日条数、累计总数，渐变主题背景，支持深浅色模式；medium 展示近 30 天迷你热力格，large 展示近 6 周（42 格）热力格 + 月度统计
- **主题切换**：面板内「🎨 切换主题」，内置 🌸 粉 / 🩶 灰 / 🩵 蓝 三套色板（`CONFIG.theme` 里可自行加）
- **自定义头像**：面板内「🖼 组件头像」从相册选图，圆形头像显示在组件 D+ 天数前面，存为 `bubblelog/avatar.png`
- **锁屏小组件**：矩形（昵称 + D+ + 今日条数）、圆形（D+）、行内（时间上方一行）三种档位，跟随系统锁屏渲染风格，无头像无背景
- **累计仪表盘**：面板统计区顶部为计步环样式——中心是历史累计总条数，外圈按文字/语音/图片/表情四类占比分段着色
- **快速记录面板**：点组件打开，四个大按钮「💬 文字 / 🎙 语音 / 🖼 图片 / 😝 表情」点一下 +1，可连点；支持撤销上一条、补记其他日期、直接改写某天每类的总条数（记错时用）
- **统计**：今日明细、本月/上月/环比、历史累计、日均条数
- **月度热力图**：记录面板内为日历式布局，**格子中央直接显示当天总条数**，日期缩为左上角角标（0 条的日子留空）；桌面组件上为紧凑的近 30 天色块格。色阶按你自己历史数据的四分位数自适应分档——不管爱豆一天发几条还是几十条，都能拉开深浅层次
- **月报**：面板内「📅 月报」，含本月总数/环比、四类明细、打卡率、最长连击、单日最高、月度排名；点日历可全屏查看**四类明细大日历**（每格分开显示文字/语音/图片/表情条数）；可一键导出 1080px **竖版海报图**存相册或分享
- **海报照片**：月报页内「🖼 海报照片」从相册选图，居中裁成 1080×640 显示在海报顶部通栏
- **纪念日**：整百天（D+100、D+200…）和周年当天显示 🎉
- **数据安全**：每次写入前自动备份 `state.backup.json`，主文件损坏时自动恢复

## 安装

1. App Store 安装 [Scriptable](https://apps.apple.com/app/scriptable/id1405459188)（免费）
2. 把 `BubbleLog.js` 的内容添加为 Scriptable 的新脚本：
   - 方式 A：Scriptable → 右上角 `+` → 粘贴代码 → 命名为 `BubbleLog`
   - 方式 B：把 `BubbleLog.js` 放进 iCloud Drive 的 `Scriptable/` 目录
3. 在 Scriptable 里点一次脚本运行，跟随初始化引导输入爱豆昵称和订阅起始日（YYYY-MM-DD）
4. 回到主屏幕长按 → 添加小组件 → Scriptable → 选 small / medium / large（large 带当月热力图）→ 编辑组件，Script 选 `BubbleLog`

之后收到泡泡：**点组件 → 点对应类型按钮 → 关闭**，就记录完成了。

## 数据存储

数据保存在 iCloud Drive（iCloud 不可用时回退本机）：

```
iCloud Drive/Scriptable/bubblelog/
├── state.json         # 全部数据（配置 + 每日计数 + 累计）
└── state.backup.json  # 最近一次写入前的自动备份
```

`state.json` 结构：

```json
{
  "config": { "idolName": "OO", "startDate": "2024-11-20", "theme": "pink" },
  "days": {
    "2026-07-04": { "text": 3, "voice": 1, "image": 2, "emoji": 0 }
  },
  "totals": { "text": 412, "voice": 38, "image": 96, "emoji": 51 },
  "lastAction": { "date": "2026-07-04", "type": "text", "ts": 1751600000 }
}
```

`days` 是唯一事实来源；`totals` 为冗余缓存，不一致时自动以 `days` 重算修正。

## 开发

- 单文件架构：`BubbleLog.js` 内部分区为 CONFIG / 日期工具 / Store / Stats / HeatmapPainter（含四类明细大日历）/ RingPainter / PosterPainter / WidgetView / ReportView / PanelView / main
- 两套日历渲染分工：`paintMonth` 每格一个总数（36pt 格子，面板日常看）；`paintMonthDetail` 每格四类明细（100pt 格子，月报全屏图和海报用）
- 数据层测试（Node 环境，mock 掉 Scriptable API）：

```bash
node tests/test.js
```

UI 部分（组件渲染、UITable 面板、DrawContext 热力图）需在真机 Scriptable 上验证。

## Backlog

- 事件流 `events: [{ts, type}]`：每条记录带时间戳，解锁「几点收到泡泡」「深夜含量」等时段统计
- 多爱豆切换
- 数据导出 CSV
- 自定义消息类型（如视频通话事件）
