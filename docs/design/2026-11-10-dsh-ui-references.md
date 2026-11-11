# StudyBuddy 前端 UI 参考与借鉴清单（DSH 生态）

- 日期：2026-11-10
- 状态：调研完成，**待你挑选**（第 8 节是勾选表；第 6 节是 3 套组合）
- 关联：spec §4.2 计划协商、§4.3 图书馆、§4.7 成就；任务 D03、T04/T05/T06/T07
- 证据：截图原先在 `refs/`（2026-11-11 删除以减小仓库体积，可在首次提交 `105bbae` 中取回）；本机审计命令见第 10 节

## 0. 结论先行

不是"换个皮肤"，而是补三层：**造型层（token + 一个注入样式表）→ 今日时间轴 → 会话内卡片**。

- **推荐组合：先做 A（原生克制）当底座，再套 B（纸本学习）的配色。** 两者共用同一套结构和 token，B 只改颜色、字面与少量表面处理，随时可退回 A。
- **C（深海静谧）建议作为夜间变体**，而不是独立方向：连续 6 小时读中文长文，深色底 + 高饱和强调会累。
- 结构上最值得抄的是 **`dsh-law` 的可拖分栏 + 月历排期首页**；组件上最值得抄的是 **`dsh-web` 的任务卡解剖** 和 **`dsh-genui` 的会话内卡片语法**；配色上最接近"学习工具"的是 **`dsh-bloom-theme` 的两条颜色轨（15 套变体）** 与 **`dsh-claude-theme` 的暖奶油 + 阅读型排版**。
- 明确不要：桌宠/全屏插画皮肤、修仙/断签、逾期红梯、"已失败"列、卡片上的 tok/ctx 遥测。

## 1. 现状体检：为什么不能只换颜色

对 `plugins/study/client/**`（31 个源文件、约 438 KB）做静态统计：

| 指标 | 现状 | 后果 |
| --- | --- | --- |
| 颜色 | 42 处 `rgba(127,127,127,*)`、11 处 hex，仅 11 处 `var(--dsw-*)` | 暗色下靠 opacity 硬撑，强调色没有语义 |
| 边框 | 37 个 `1px`，**0 个 0.5px**，只用 3 个 border token | 比原生聊天面板"重"，两栏并排时像嵌了两个应用 |
| 圆角 | 6px×13、10px×9、999px×9、8px×3、12px×2 | 与 DSH 的 R8/R12/R16/R20/R28 五档不对应 |
| 字号 | 13 种（11/11.5/12/12.5/13/13.5/14/15/17/20/28/38） | 没有层级，标题和正文打架 |
| 文字层级 | 12 档 opacity（0.62–0.90） | 同一"次要文字"在 5 个文件里是 5 个灰度 |
| 状态 | **0 个 `:hover`、0 个 `@media`、0 个 `prefers-reduced-motion`** | 内联样式表达不了交互态；键盘/减动效无从谈起 |
| 间距 | gap 8/10/12/16/18 混用，无 4 的倍数节奏 | 卡片内松紧不一致 |

DSH 自己的规范（`source/deepseek-harness/docs/web-styling.md`、`ui-radius.md`）要求：语义别名 `--dsw-alias-*`、中性描边 0.5px 发丝线、圆角 R4/R8/R12/R16/R20/R28、浮层用 `--dsw-elevation-*` 而非"边框 + 阴影"、hover 包在 `@media (hover: hover)`、保留减动效。

**约束**：我们的客户端是纯 JS + `React.createElement` + esbuild 打包（`plugins/study/scripts/build-client.mjs`），没有 CSS 管线。所以造型层的最小实现是：一个 `tokens.js`（导出 token 名 → 值）+ 一次 `ensureStyleSheet()` 注入 `<style data-study>`，类名只在需要 `:hover`/媒体查询时使用；内联样式继续写，但值只从 token 取。

**主题所有权（调研对象全都踩过的坑）**：不要自己写 `data-ds-dark-theme`。宿主会把它静默覆盖（`dsh-bloom-theme` 在 v0.24.0 才改对，`dsh-dream-skin` 干脆从不碰）。明暗必须走 `ctx.theme.setTheme('light' | 'dark' | 'system')`（用可选 `ctx.inject(['theme'])`，旧宿主缺服务时降级为只跟随），颜色只通过覆盖 `--dsw-alias-*` 表达。同理，给用户"主题包"能力时，包内容只允许是 token 覆盖 + 一个 manifest，不允许注入任意 CSS。

## 2. 筛选标准（为什么这 12 个值得看）

> 12 个里有 1 个（`dsh-dream-skin`）调研期间已 404，只保留作概念参考，不计入建议项。

用 spec 的约束 + DSH 的 UI 评审基线（对齐、分组、密度、信息层级、控件状态、组件选择、图标、几何）合成 7 条：

1. **双栏可用**：左学习 / 右对话，无会话时学习区仍在（T04 已实现布局，缺的是内容形态）。
2. **状态诚实**：待确认 ≠ 未开始，取消不伪装完成率（spec §4.5）。
3. **非惩罚语气**：不出现逾期红梯、失败列、断签、扣分动画。
4. **可长期停留**：早 8 点到晚 10 点看同一屏，插画/玻璃/高饱和只允许出现在弹层。
5. **深浅色都成立**：不能只在浅色截图里好看。
6. **窄窗能退**：容器变窄时降级到单列，而不是整块消失（现状 1023px 时学习栏直接不见）。
7. **与 DSH 原生同源**：同 token、同发丝线、同圆角，否则聊天区和工作台会像两个产品。

## 3. 借结构：工作台与信息架构

### 3.1 `dsh-law` 深法工作台 —— 同构应用，最值得拆

- 仓库：<https://github.com/wesky820/dsh-law>（MIT，约 285 KB，零依赖，无构建）
- 为什么像：它也是"本地业务工作台 + DSH 原生会话"，每个案件绑定一个原生会话，模型/技能/命令全部来自 DSH。这正是 StudyBuddy 的形态。
- 借：
  1. **三边可拖、可收起、双击复位**（主导航 / 案件栏 / 案件雷达），并有 紧凑 / 标准 / 专注对话 三档密度预设，按浏览器持久化。→ 我们已有 `studyleft` 拖拽，缺"双击复位 + 专注/标准两档"。
  2. **月历首页点日期直接新建**、按案件登记日程或法定期限、行内删除。→ 对应 spec §4.3 的时间块与 §4.6 晚间重排，是"少聊天多操作"的关键。
  3. **顶栏汇总计数 + 分级徽章**（逾期/临期/待批只在顶部计数，不铺到每张卡）。→ 对应"今天还有几项待确认"。
- 不借：四套法庭皮肤、"逆转裁判"异议动画、逾期红标梯级。那是对抗性语境，学生会把它读成惩罚。
- 注意：该仓库**没有任何截图**（已核实 21 个文件全为代码/文本），只能读 README 与源码。

### 3.2 `dsh-web` 任务看板 —— 卡片与列头的标准答案

- 仓库：<https://github.com/zhu1090093659/dsh-web>（原名 `dsh-web-ui`，现约 10.3k★；npm 侧是 `@linxin666/*` 作用域。注意 dshbase 目录里 `github:linxin666/dsh-web-ui` 那条已失效——`linxin666` 是 npm scope，不是 GitHub 账号）
- 借：
  1. **列头 = 状态圆点 + 名称 + 计数胶囊**（待规划 2 / 待办 3 / 进行中 2）。→ "今天 · 5 / 已完成 · 3"。
  2. **卡片解剖**：多行标题 + 摘要（约 8 行后渐隐 + 展开全文）+ 页脚相对时间 + 一个状态字形（时钟/转圈）。→ 今日任务卡直接照此密度。
  3. **列内按时间分组**：今天 / 近 7 天 / 更早；**标签颜色按名字哈希**（不存颜色）。
  4. 原生槽位挂载（`sidebar.panellist` + keyed `main` 页），不是 iframe——和我们 T04 的做法同路。
- 不借：默认皮肤的全出血鲸鱼插画 + 磨砂玻璃 + 动态壁纸；"已失败"作为一等列；cron 自动执行叙事（把应用说成无人值守工厂）。

### 3.3 `DSH-better-sidebar` —— 安静的分组与状态行

- 仓库：<https://github.com/omdsh-dev/DSH-better-sidebar>（5k★，MIT；把原生右栏变成标签工作台）
- 借：
  1. **可折叠分组 + 右对齐计数**（`已暂存 (2)`）→ `今天 (5)`、`已完成 (3)`。
  2. **底部一行安静状态**（`main* · No upstream`）→ `下一段 14:25 · 已完成 2/5`；位置固定、字号 11–12px、不抢主线。
  3. 每会话布局/状态持久化；面板可拖拽分栏（若以后要"任务 + 计时器"并排）。
  4. 它用 DSH 原生 primitives/slots/locale 渲染，浅色下就是白面 + 1px 发丝线 + 8px 圆角——**这是"原生感"的参照**。
- 不借：工程师密度（Cmd+Enter 提交、xterm 标签、`⋯` 菜单铺满）。学生端要一个明显的主操作 + 更大字号。

### 3.4 `dsh-graph` —— 容器断点与右侧详情

- 仓库：<https://github.com/miuzel/dsh-graph>（25★，MIT；目标泳道看板）
- 借：
  1. **按容器自身 `clientWidth` 分档**（≥480 多列，<480 纵向堆叠 + 工具栏收进 `⋯`）。→ 我们的左栏被压到 320px 时应该这样退，而不是隐藏。
  2. 卡片点开 → **右侧详情面板**，不离开看板（计划任务详情、材料位置、历史记录）。
  3. 泳道 = 版本/周 × 阶段列，可承载"多周计划 + 本周阶段"。
- 不借：阻塞栏、质量判据、人审、DEBUG 行、卡片上的 `tok 54.6k | ctx 2%`。个人备考不是被审计的交付流水线。

### 3.5 `dsh-synapse` —— 低干扰的切换与起手

- 仓库：<https://github.com/liangmianya/dsh-synapse>（698★，MIT；会话地图）
- 借：
  1. **可拖、记忆位置、双击复位的浮动切换钮**（对话 / 会话地图）。→ "任务 / 对话"两态切换，不占布局。
  2. **ghost 卡 + 预设 chips**（展开说明 / 举例 / 通俗易懂）→ 起手 chips：`5 分钟回顾` `开始 25 分钟` `我卡住了`。
  3. 卡片 → 右滑详情，正文按需拉取（预览截断 280 字）。
- 不借：自由缩放平移画布作为主导航（认知负荷高，与"低决定"的学习界面冲突）；卡上的"失败"徽章。

### 3.6 `dsh-genui` —— 会话内卡片的现成语法

- 仓库：<https://github.com/omdsh-dev/dsh-genui>（590★，MIT；npm `@changfenhuang/dsh-genui`）
- 它把模型输出的 `dsh-ui` fence 渲染成可交互组件：`stat`（眉标 + 数值 + delta + 迷你折线）、`progress`（环/条）、`timeline`、`table`（可排序/筛选/CSV）、`callout`、`step`、`quiz`、`carousel`，以及 `panel: true` 的会话底部 dock（可拖高、可追加标签）。
- 两种用法，建议**先第二种**：
  1. 直接安装，让 Agent 在聊天里输出计划草案 / 复盘统计卡片（零前端工作，但样式是它的，且要接受一个新依赖）。
  2. 抄它的语法与视觉，用我们自己的消息贡献实现"计划差异卡 / 复盘卡 / 提醒快捷操作"，可控且不绑依赖。
- 可复用细节：动作按钮必须带 `action`（无 action 的按钮渲染为禁用，杜绝"点了没反应"）；连续拖拽用尾沿防抖；组件表面走 `--dsl-g-surface` 链，皮肤只 pin 一次表面色。

## 4. 借气质：配色、字面与主题架构

### 4.1 `dsh-bloom-theme` —— 两条颜色轨道，最该抄的工程约定

- 仓库：<https://github.com/webkubor/dsh-bloom-theme>（245★，MIT，v0.27.0）· 15 套变体 × 明/暗，全部 OKLCH 手写
- 核心机制：每套变体 8 个字段，分成**两条互不相通的轨道**——**可读色轨** `accent`（文字/按钮/描边，必须 ≥4.5:1）与**氛围色轨** `morandi`（RGB 三元组，只以 5–20% 透明度铺大面积渐变）。浅色轨压暗到达标，深色轨提亮到达标，两轨永不互换。
- 对比度是算出来的：`palette.ts` 头部有实测表（mist 5.28/5.96、cinnabar 4.87/5.63、sage 4.53/7.42、lapis 5.63/7.31…），`contrast.config.json` 进 `npm run check`；另有 `prefers-reduced-motion` / `-reduced-transparency` / `prefers-contrast` / `forced-colors` / `print` 的实色回退。
- 可抄的值：mist 强调 `oklch(50% .08 240)`、底 `oklch(96% .01 240)`；sage 强调 `oklch(54.1% .111 115)`、底 `oklch(97% .011 112)`。
- 借：**两轨约定**；以及把发丝线和阴影从正文色派生（`color-mix(in oklch, tx, transparent 94%)`），换配色时描边与浮层自动重新着色，不用手调灰阶。主题落地方式是"往 `--dsw-alias-*` 写普通声明、零 `!important`"，明暗交给 `ctx.theme`。
- 不借：22–24px backdrop blur + 位移滤镜 + SVG 颗粒的三层玻璃。窄栏里最贵，且与"减少透明"偏好直接冲突。

### 4.2 `dsh-theme-endfield` —— 纸/墨/信号色，并把"克制"量化了

- 仓库：<https://github.com/ymh0000123/dsh-theme-endfield>（164★，MIT 代码，美术素材除外）· 有完整 `docs/design-language.md`
- 纸墨值（直接是 `--dsw-alias-*`）：浅色 base `#e8e8e2`、layer-1 `#f2f2ec`、正文 `#101110`、次要 `#4a4c48`、描边 `#d8d9d5`/`#b6b8b3`；深色 base `#101110`、layer-1 `#181a18`、正文 `#f5f5f0`。
- 信号色有"不能用"的实测：浅色下原色 `#fff500` 在纸面只有 **1.07:1**（文档自己写"不是配色选择，是抹除"），于是浅色改用 `#6b5d00`（5.35:1）/ 青色改 `#006a6a`（5.22:1），深色才用原色（15.26:1 / 9.14:1）；27 对对比度进测试，低于 4.5:1 构建失败。
- 连"克制"都量化：浅色黄版全屏只有 **5.47%** 信号色像素、青版 **0.39%**——"不需要被看见的东西就不上色"。这是非惩罚性设计最好的操作定义。
- 形状：一条 `body:not(.round) [class] { border-radius: 0 !important }` 强加直角，再只给头像/圆点/图标钮恢复 `50%`；圆角模式只是 body 上多一个 class（12px）。**这个"一键换形状语言"的技巧，正好能用在不受我们控制的内联样式树上。**
- 不借：满屏等高线底纹；155 KB 样式表 + `!important` 全量扫（README 记录 DSH 0.2 内四次静默失效，每次升级都要补丁）；全直角读起来像技术文档，不像学习工具。

### 4.3 `dsh-claude-theme` —— 阅读型排版 + 皮肤包结构

- 仓库：<https://github.com/aklnaaw/dsh-claude-theme>（31★；代码 MIT，字体/商标另有声明）
- 值：浅色 base `#faf9f5`、layer-1 `#f5f0e8`、正文 `#141413`、次要 `#6c6a64`、珊瑚 `#d97757`（hover `#a9583e`）；深色暖黑 `#181715`、卡片 `#252320`、珊瑚 `#e08a6a`。焦点环 `0 0 0 3px color-mix(in srgb, coral 15%, transparent)`。
- 三种字：**Newsreader 衬线读正文 16px/1.72**、Inter 做 UI、JetBrains Mono 代码；CJK 回退 `Noto Serif CJK SC` / `Songti SC`（不随包发，约 20 MB/字重）。圆角 8/12/16，输入条 26，发丝线 + 极浅阴影。
- 结构：一个皮肤 = 纯资产目录（`skin.json` v2 + `skin.css` + `patches.css` + 字体 + 预览图）；加载器把每个选择器强制 scope 到 `html[data-dsh-skin="claude"]`、重写相对资源路径，再通过官方索引注入表加一行 `<style>`。`patches.css` 只用**语义 DOM 属性**（`data-dsh-surface`、`data-pane`）而不碰哈希类名。
- 借：**"读正文用衬线、UI 用无衬线、数字用等宽"** 的三声部，以及 1.72 行高；"所有颜色一个 block、所有形状第二个 sheet"。
- 风险：无 WCAG 声明、无对比度测试；把 191 个 token 全量显式声明会随 DSH 升级漂移（文件自己承认回退机制实际上是死的）；不要学 `link:` 安装路径。

### 4.4 `dsh-dream-skin` —— 概念可借，但仓库已经 404（别依赖）

- 核查（2026-11-10）：`api.github.com/repos/RevolutionLA/dsh-dream-skin` 与 `users/RevolutionLA` 均 404，所有 raw README 变体 404，账号疑似删除或转私有。下架前它声明过：8 套 Mirage 主题、每浏览器强调色、壁纸 2.0、主题包导入/导出、收藏与随机、"纯原生 token 系统"。
- 现有事实只能从镜像 fork `lhg-dsh-plugins/lhg-dsh-dream-skin` 的逐字 README 读到（一手证据不可得）。本目录里的 `refs/dsh-dream-skin/*` 是该 fork 的预览卡，不是上游实时页面。
- 可借的概念：皮肤 = **tokens（40 个语义 `--dsw-*`）+ glow（环境光）+ defaults（滑杆/材质）** 三件；主题包是 `{format, version, manifest:{tokens}}`；玩家的 accent 是**叠加层**，不改皮肤本身；"专注时自动压暗壁纸"。
- 结论：只抄"三件式拆分 + accent 叠加"的想法，**不要写进依赖清单**——它可能明天就再次消失。

### 4.5 `DSH-Transparent-UI-Plugin`（Aqua）—— 可逆开关怎么写

- 仓库：<https://github.com/WYH66666666/DSH-Transparent-UI-Plugin>（435★，**AGPL-3.0**）
- **许可警告：AGPL 有网络传染性，只能读思路、不能把代码抄进 StudyBuddy。**
- 做法：覆盖 104 个 `--dsw-*`；开关状态全部落在 `<html>` 的 6 个 `data-*` 属性上（`data-dsh-aqua`、`data-dsh-float`、`data-dsh-compat`、壁纸/媒体等）；`ctx.theme.overrideTokens(...)` 返回 disposer，关闭时逐一 `removeAttribute` 并销毁流体画布 → 逐字节回到原生 UI。
- 两档模式值得抄：**重排布局** vs **只换材质**（Compat 模式保持原生布局，只换表面）。学生不喜欢新布局时仍能拿到"更安静的表面"。
- 不借：默认 20px 背景模糊；它 README 自述"DSH 更新后无法及时跟进，安装可能崩溃"——正是我们不该背的依赖风险。

### 4.6 `dsh-worktime-board` —— 学期轴与数字纪律

- 仓库：<https://github.com/spacexun2/dsh-worktime-board>（9★，MIT；暗色专用，硬编码 `rgba(24,24,30,.96)` + `#ffb347` 琥珀）
- 借：**8 月 1 日 → 次年 7 月 31 日的"学年轴"**——正好对齐考研周期，比自然年更贴学生心智；日/周/月/学年四档切换；所有计数用 `font-variant-numeric: tabular-nums`，窄栏里数字跳动不会挤动布局。
- 不借：44px "修仙值"、卷王榜、突破奖励、连续天数；也**不要学它的暗色硬编码兜底**——那正是我们缺 token 层会重演的错误（浅色宿主下整个面板还是黑的）。

### 4.7 `dsh-mobile` —— 只作窄窗与触屏参考

- 仓库：<https://github.com/clarklevis1995/dsh-mobile>（756★，MIT；Kotlin Multiplatform 原生客户端，不是 Web 插件）
- 值：品牌深海军蓝 `#07182B`、内容暖白 `#F7F8FA`、墨 `#101318`、海洋蓝 `#2E6BE6`；紫/橙**只用于执行轨迹语义**，不当装饰。
- 借：**"玻璃只给导航、分段控件、输入框、底栏、主操作；长文保持实色"**——这是玻璃用在哪的判据；1px 内高光代替投影；44×44 触控目标；等宽数字；宽窗时侧栏变"主页列"而不是抽屉。
- 不借：深蓝渐变 + 点阵 + 鲸鱼光尾的品牌化首页。它的设计规范自己就警告"不要通用的蓝紫 AI 渐变"。

## 5. 落到我们的界面：映射表

| 界面 | 现在的样子 | 借用来源 | 具体做法 | 量级 |
| --- | --- | --- | --- | --- |
| 左栏「今日」 | 平铺 6 行时间 + 一个"打开完整工作台"按钮 | law 的分栏机制 + web 的卡片 + better-sidebar 的计数 | 纵向时间轴（时间槽 + 当前时刻线 + 固定课灰卡），每块一张任务卡：复选框 / 标题 / 学科·分钟·位置 chips / 状态字；底部一行安静状态 | M |
| 工作台「今日」页 | 5 张 1px 边框卡片 + 底部表单 | genui 的 stat/progress + worktime 的分段控件 | 三段式：概览（环 + 3 个 stat）→ 时间轴 → 待办；新增/编辑进右侧抽屉或行内展开，不再占一屏 | L |
| 番茄钟 | 独立页 + 按钮 | genui dock + worktime 的数字 | 卡片化：大号 tabular 数字 + 细环 + 三个动作（开始/暂停/结束）；会话顶栏一个 12px 状态位 | S |
| 计划草案 | 纯文本差异 | genui callout/table + law 的"草案不生效"提示 | 差异卡（新增/变更/移除三色左条）+ 试行风险 callout + 两个动作（确认 / 继续讨论）；过期版本显示"已被新修改覆盖" | M |
| 晚间复盘 | 列表 | web 的"今天/近 7 天"分组 + synapse 的详情面板 | 摘要卡："移动 3 项、保留 1 项待确认、明天 2 个时间块"，可展开逐项，带撤销 | M |
| 成果页 | 数字 + 文案 | worktime 的学年轴 + 堆叠条 + bloom 的两轨克制 | 月历热力（完成/部分/取消三色）+ **8/1→7/31 学年轴**（对齐考研周期）+ 学习/练习/订正/休息堆叠条 + 里程碑卡；数字全部 tabular；**不显示连续天数** | M |
| 完成反馈 | 左下 toast | genui 的 stat + feedback 现有 overlay | 轻量：一行字 + 一个勾形；里程碑才出卡；`prefers-reduced-motion` 下只淡入 | S |
| 窄窗 <1024 | 学习栏整体消失 | graph 的容器断点 + mobile 的列表 | 学栏改成底部/侧边「今日」抽屉（按钮常驻），内容单列；320px 仍可勾选与计时 | S |

## 6. 三套推荐组合（选一个）

### A. 原生克制（底座，建议必做）

- 内容：不引入新色。全部改用 `--dsw-alias-*`；发丝线 0.5px；圆角只取 R8/R12/R16/R20；字号收敛到 11/12/13/15/20；间距 4/8/12/16/24；补 hover、focus-visible、reduced-motion；卡片用 `--dsw-elevation-panel` 代替"1px 边框 + 阴影"。
- 优点：和原生聊天无缝；风险最低；后续换主题只改 token。
- 代价：约 2–3 天（含视觉回归截图）。
- 截图参照：`refs/DSH-better-sidebar/git-changes-commit-graph.png`（原生发丝线与分组）。

### B. 纸本学习（推荐默认）

- 内容：A + 只给**学习栏与学习页**一层奶油纸底（`#F5F0E8` 或 `#F2F2EC` 级），墨黑正文（`#141413`），单一强调色（珊瑚 `#D97757`，或琥珀 `#B4762A`），发丝线/阴影从正文色派生而不是另挑灰。套 bloom 的两轨：强调色走"可读轨"必须 ≥4.5:1，同色族的"氛围值"只以 5–15% 铺在今日卡与当前时间块上。小标题可上 Newsreader 衬线（正文仍无衬线，避免中文回退到宋体后不协调），行高 1.72。
- 优点：像"笔记本"而不是"控制台"；中文长文在暖白底上更稳；强调色只在主操作与"现在"出现，天然克制。
- 代价：A 之上再加 1 天；需要单独校暗色（暖白不能直接反相；深色用 `#181715` 暖黑而不是纯黑）。
- 截图参照：`refs/dsh-bloom-theme/bloom-01-ui-switcher.png`、`refs/dsh-claude-theme/claude-01-light.jpg`、`refs/dsh-theme-endfield/endfield-02-light-wuling-teal.webp`。

### C. 深海静谧（夜间变体，不建议做主方向）

- 内容：近黑底（`#151517` 级）+ 单一青/蓝强调 + 玻璃只用于浮层；文字三级用 token 而非 opacity。
- 优点：晚上不刺眼；与 DSH 深色原生一致。
- 风险：白天在图书馆窗边对比度不足；长文阅读疲劳；需要逐项 AA 验证。
- 截图参照：`refs/dsh-bloom-theme/bloom-02-aurora-dark.png`、`refs/DSH-Transparent-UI-Plugin/aqua-01-glass-main.png`。

> 建议路径：**A → B**，C 作为"跟随系统深色"的实现目标而不是第三套设计。

## 7. 明确不借鉴

| 不借 | 出处 | 原因 |
| --- | --- | --- |
| 桌宠 / Live2D / 鲸鱼娘 | `dsh-pet`、`whale-girl`、`dsh-live2d-companion` | spec 明确避免高度拟人化关系；分心且占屏 |
| 全屏插画 + 磨砂 + 动态壁纸 | `dsh-web` 默认皮肤、`dsh-deep-whale` | 学习界面每天 6 小时，插画是噪音 |
| 修仙 / 境界 / 突破奖励 | `dsh-worktime-board` | 把学习变成游戏数值，与"不用断签制造压力"冲突 |
| 逾期红梯 + 异议动画 | `dsh-law` | 对抗性语气，学生会读成责备 |
| "已失败"列 + 人审 + 阻塞栏 | `dsh-web`、`dsh-graph` | 个人备考不是交付流水线 |
| 卡片上的 tok/ctx/DEBUG | `dsh-graph` | 遥测信息对学习无意义 |
| 自由缩放画布主导航 | `dsh-synapse` | 认知负荷高，找不到"现在该做什么" |
| 玻璃糊满整页 | `DSH-Transparent-UI-Plugin` 默认态 | 正文对比度不稳，长文不可读 |

## 8. 可勾选清单（回复编号即可）

> 时间紧就只看这 3 个：**2（任务卡）+ 3（分组与状态行）+ 7（两条颜色轨）**——它们覆盖了"今日"界面 80% 的视觉问题。

布局 / 信息架构：

| # | 项目 | 一句话 | 工作量 |
| --- | --- | --- | --- |
| 1 | [dsh-law](https://github.com/wesky820/dsh-law) 分栏 + 月历排期 | 三边拖拽/双击复位/密度预设；点日期新建时间块 | M |
| 2 | [dsh-web](https://github.com/zhu1090093659/dsh-web) 任务看板 | 列头 dot+计数、卡片页脚元信息、今天/近 7 天分组 | S |
| 3 | [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 折叠分组 + 状态行 | `今天 (5)`、底部 `下一段 14:25` | S |
| 4 | [dsh-graph](https://github.com/miuzel/dsh-graph) 容器断点 + 右侧详情 | 320px 也能用；点卡不离开看板 | S |
| 5 | [dsh-synapse](https://github.com/liangmianya/dsh-synapse) 浮动切换 + 起手 chips | 任务/对话一键切；`开始 25 分钟` 等预设 | S |
| 6 | [dsh-genui](https://github.com/omdsh-dev/dsh-genui) 会话内卡片 | 计划差异卡、复盘卡、进度环、动作按钮 | M |

配色 / 字面：

| # | 项目 | 一句话 | 工作量 |
| --- | --- | --- | --- |
| 7 | [dsh-bloom-theme](https://github.com/webkubor/dsh-bloom-theme) 两条颜色轨 | 可读 accent + 氛围 morandi 分开；对比度进 CI；发丝线由正文色派生 | S |
| 8 | [dsh-theme-endfield](https://github.com/ymh0000123/dsh-theme-endfield) 纸/墨/信号色 | `#e8e8e2` 纸 + `#101110` 墨 + 一个信号色；一键直角/圆角 | S |
| 9 | [dsh-claude-theme](https://github.com/aklnaaw/dsh-claude-theme) 阅读型排版 | 衬线读正文 16/1.72 + 无衬线 UI + 等宽数字；皮肤包结构 | S |
| 10 | ~~dsh-dream-skin~~ 三件式皮肤模型 | **仓库 404，仅概念参考**（tokens/glow/defaults + accent 叠加层）；不建议依赖 | — |
| 11 | [DSH-Transparent-UI-Plugin](https://github.com/WYH66666666/DSH-Transparent-UI-Plugin) 可逆开关 | **AGPL，只读不抄**；6 个 data-* 属性 + disposer 关闭回原生；"只换材质"模式 | S |
| 12 | [dsh-worktime-board](https://github.com/spacexun2/dsh-worktime-board) 学年轴 + 数字 | 8/1→7/31 学年历、日/周/月/学年四档、tabular-nums | S |

还可以自己逛：

- <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> —— 社区精选总表
- dshbase 的 **UI & Skins 分类共 2892 个**，主题类可用 `theme` / `看板` 等单词检索；已装的 `dsh-market` 也能在应用内浏览
- 想看纯主题合集：`dsh-client-ui-skins`、`dsh-bloom-theme`、`dsh-catppuccin-theme`、`dsh-theme-endfield`（`dsh-dream-skin` 已 404，不要再装）

## 9. 实施顺序（假设选 A + B）

| 步 | 内容 | 产出 / 验收 |
| --- | --- | --- |
| S0 | 造型层：`client/lib/tokens.js` + `ensureStyleSheet()`；替换 42 处 rgba / 11 处 hex；统一 0.5px 发丝线、R8–R20、字号 5 档、间距 4 档；补 hover / focus-visible / reduced-motion；明暗走 `ctx.theme`（不写 `data-ds-dark-theme`） | 1440 / 1024 / 320 宽度 + 明暗共 6 张截图；token 覆盖率脚本输出 0 处字面色；两张截图下强调色对比度 ≥ 4.5:1 |
| S1 | 左栏今日时间轴（含当前时刻线、固定课灰卡、任务卡） | 无会话可用；320px 可勾选；拖拽不丢身份 |
| S2 | 工作台今日页三段式 + 行内编辑/抽屉 | 首屏无需滚动即可看到"现在该做什么 + 今天还剩多少" |
| S3 | 会话内卡片：计划差异、复盘摘要、提醒快捷操作 | 动作都有回执；无 action 的按钮不出现 |
| S4 | 成果页：月历热力 + 堆叠条 + 里程碑 | 取消与待确认分别成色；无连续天数 |
| S5 | 窄窗抽屉 + 暗色实测 | 1023px 不再"整块消失"；AA 对比度报告 |

每步结束跑：`node plugins/study/scripts/build-client.mjs`、`node --test plugins/study/tests/client`（显示切换的证据脚本为 `tests/client/workbench-display.test.mjs`；常驻学习栏与 T04 专项冒烟已按 2026-11-11 调整移除，见 `docs/decisions/layout.md` 第 8 节）。

## 10. 来源与证据

### 外部

- dsh-law：<https://github.com/wesky820/dsh-law>
- dsh-web（原 dsh-web-ui）：<https://github.com/zhu1090093659/dsh-web>
- DSH-better-sidebar：<https://github.com/omdsh-dev/DSH-better-sidebar>
- dsh-graph：<https://github.com/miuzel/dsh-graph>
- dsh-synapse：<https://github.com/liangmianya/dsh-synapse>
- dsh-genui：<https://github.com/omdsh-dev/dsh-genui>
- dsh-bloom-theme：<https://github.com/webkubor/dsh-bloom-theme>
- dsh-theme-endfield：<https://github.com/ymh0000123/dsh-theme-endfield>
- dsh-claude-theme：<https://github.com/aklnaaw/dsh-claude-theme>
- dsh-dream-skin：<https://github.com/RevolutionLA/dsh-dream-skin>（**已 404**，仅镜像 fork `lhg-dsh-plugins/lhg-dsh-dream-skin` 可读 README）
- DSH-Transparent-UI-Plugin：<https://github.com/WYH66666666/DSH-Transparent-UI-Plugin>（AGPL-3.0）
- dsh-worktime-board：<https://github.com/spacexun2/dsh-worktime-board>
- dsh-mobile：<https://github.com/clarklevis1995/dsh-mobile>

星数采样自 GitHub REST API（2026-11-10），与 dshbase 目录里的旧值可能有差（例如 dsh-web 目录仍写 5.8k，实际约 10.3k）。

### 本地截图

截图取自各仓库 README 的原图（不是我们渲染的）。`refs/dsh-dream-skin/*` 来自镜像 fork，上游已不可访问；`refs/dsh-law/` 为空——该仓库确实一张图都没有。

| 用途 | 文件 |
| --- | --- |
| 卡片/列头 | `refs/dsh-web-ui/task-board.png` |
| 原生发丝线与分组 | `refs/DSH-better-sidebar/git-changes-commit-graph.png` |
| 容器断点窄态 | `refs/dsh-graph/sidebar-kanban-narrow.png` |
| 两轨配色（sage 浅色） | `refs/dsh-bloom-theme/bloom-01-ui-switcher.png` |
| 暖奶油 + 珊瑚 | `refs/dsh-claude-theme/claude-01-light.jpg` |
| 纸/直角/信号色 | `refs/dsh-theme-endfield/endfield-02-light-wuling-teal.webp` |
| 学年轴 + 堆叠条（反面语气） | `refs/dsh-worktime-board/worktime-04-school-year.png` |
| 玻璃（仅浮层参考） | `refs/DSH-Transparent-UI-Plugin/aqua-01-glass-main.png` |

### 本机规范与审计

- `source/deepseek-harness/docs/web-styling.md`（token、发丝线、浮层、hover、减动效）
- `source/deepseek-harness/docs/ui-radius.md`（R4–R28 五档与例外）
- `source/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css`（`--dsw-alias-*` 全量，含 `body[data-ds-dark-theme]`）
- 审计口径：统计 `plugins/study/client/**/*.js`（排除 `.build` 与产物 `client.js`）中的字面色值、`border: 1px`、`borderRadius`、`opacity`、`fontSize`、`gap`、`@media`/`:hover`、`prefers-reduced-motion`。
