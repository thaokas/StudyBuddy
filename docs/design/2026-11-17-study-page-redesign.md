# StudyBuddy 插件页面视觉改版（Pi 风格）执行规范

- 日期：2026-11-17
- 状态：已完成（9 个页面 + 2 个浮层组件；真实宿主审计通过，见 §7）
- 参考：<https://pi.dev/>（衬线标题、等宽微标签、发丝线、安静面板、居中阅读列）
- 目标：修复工作台/计划等页面内容超出框架却无法滚动的问题；去掉“每项一个线框盒子”的观感；所有插件页内容居中。

## 1. 事实基线

- 页面是纯 JS + `React.createElement`，构建产物是 `plugins/<pkg>/client/client.js`（esbuild 打包），改完源文件必须 `node plugins/<pkg>/scripts/build-client.mjs`。
- 页面注册进 DSH 的 `main` keyed slot；slot anchor 是 `display:contents`，所以页面根 `<section>` 是中栏 `.mainPanel`（`display:flex; flex-direction:column; min-height:0`）的直接 flex 子项。
- 因此滚动由页面自己承担：根节点 `flex:1 1 auto; min-height:0; overflow-y:auto`，内容放一个居中的内容列。
- 页面的颜色必须走 DSH 语义 token（`--dsw-alias-*`），明暗与「设置 → StudyBuddy 外观」的 6 套配色包会自动生效。不要新增字面色值，不要写 `data-ds-dark-theme`。

## 2. 共享样式层（唯一来源）

`packages/study-client/ui.js` 导出：

| 导出 | 用途 |
| --- | --- |
| `ROOT_STYLE` | 页面根：滚动容器 + 水平居中 + 页面内边距 |
| `contentStyle(maxWidth)` | 页面内容列：宽度上限 + 垂直 flex + 18px gap |
| `FONT_SERIF` / `FONT_MONO` / `FONT_TEXT` | 三声部字体 |
| `HEADER_STYLE` / `TITLE_STYLE` / `SUBTITLE_STYLE` / `TOOLBAR_STYLE` / `ACTIONS_STYLE` | 页头与操作行 |
| `CARD_STYLE` / `WARNING_CARD_STYLE` / `DRAFT_CARD_STYLE` / `CARD_ALERT_STYLE` | 面板（替代旧线框卡） |
| `SECTION_HEADING_STYLE`（别名 `SECTION_STYLE` / `SECTION_TITLE_STYLE`） | 卡内小标题 |
| `BUTTON_STYLE` / `BUTTON_ACTIVE_STYLE` / `BUTTON_PRIMARY_STYLE` | 等宽微标签按钮 |
| `INPUT_STYLE` / `FIELD_STYLE` / `FIELD_ROW_STYLE` / `FIELDS_STYLE` | 表单 |
| `MESSAGE_STYLE` / `NOTE_STYLE`（别名 `RULE_STYLE` / `MUTED_STYLE`） / `ERROR_STYLE` / `WARNING_STYLE` | 文案层级 |
| `LIST_STYLE` / `ROW_STYLE` / `META_STYLE` / `TEXT_STYLE` | 列表与行 |
| `BADGE_STYLE` / `PENDING_STYLE` | Pi 式等宽微标签（方角、字距） |
| `SUMMARY_STYLE` / `SUMMARY_BLOCK_STYLE` / `SUMMARY_LABEL_STYLE` / `SUMMARY_ROW_STYLE` | 数字摘要 |
| `TERM_STYLE` / `VALUE_STYLE` | 术语/数据行 |
| `installStudyStyles()` | 由 `study-core` 注入一次；hover / focus-visible / disabled / scrollbar / reduced-motion / 页面背景点阵与强调光晕都在这里 |

**规则**：页面文件里不再定义通用 token（颜色、边框、圆角、字号、字体）。需要的共享样式若不存在，先在本页用 `{ ...SHARED, 你的覆盖 }` 派生，并在汇报里说明；不要私改 `packages/study-client/ui.js`（Lead 持有该文件）。

## 3. 页面根与滚动（每个页面必须做）

旧写法：

```js
const ROOT_STYLE = { padding: ..., maxWidth: '980px', display: 'flex', ... };
return create('section', { 'data-testid': 'x', 'data-page': 'x', style: ROOT_STYLE }, header, body, ...);
```

新写法：

```js
import { ROOT_STYLE, contentStyle, /* 其他共享样式 */ } from '../../../../packages/study-client/ui.js';

return create('section',
  { 'data-testid': 'study-workbench', 'data-page': 'workbench', 'data-study-page': '', style: ROOT_STYLE },
  create('div', { style: contentStyle(1040) }, header, body, ...));
```

- `data-study-page` 必须有（不带值的空属性）。共享样式表用它作用域：页面背景、`h2::before` 强调短横线、hover/focus。
- 内容列宽度：默认 960；工作台 1040；会话密集表单页 840–900；紧凑视图 760。所有内容必须落在这一列里，随窗口始终居中。
- 不要在根或内容列上用 `height:100vh`、`position:fixed`、`overflow:hidden`。
- 页面内出现横向溢出时修正内容本身（`flexWrap` / `minWidth:0` / `overflow-wrap`），不要给根加 `overflow-x` 隐藏来遮住问题。

## 4. 视觉语言（Pi 风格，落到现有页面）

- **页头**：`h1` 用 `TITLE_STYLE`（衬线、33px、-0.02em），副标题 `SUBTITLE_STYLE`；操作按钮在右侧 `TOOLBAR_STYLE`。
- **卡片**：`CARD_STYLE` 是“面板”而不是线框：浅色 token 派生底 + 发丝线 + 4px 圆角 + 极浅投影。卡内间距 18/20；卡间 18。
- **卡内小标题**：`SECTION_HEADING_STYLE`（17.5px 衬线）。样式表会给每个 `h2` 前加 16px 强调短横线，不要再手写装饰。
- **列表**：列表项之间只用 `ROW_STYLE` 的顶部发丝线分隔；**不要**再给每一项套一个 `1px` 边框的盒子（这正是用户抱怨的“简单线框”）。原本每项独立盒子的地方（如按天分组的日卡、评分小卡），改成：整块一张 `CARD_STYLE`，内部用 `ROW_STYLE` / `PANEL_SOFT` 分组，标题用等宽小标签。
- **按钮**：`BUTTON_STYLE`（等宽 11px、大写、字距 .07em、3px 圆角、发丝线）；当前态用 `data-active` 不需要，直接用 `BUTTON_ACTIVE_STYLE` / `BUTTON_PRIMARY_STYLE`。hover/focus/disabled 由样式表提供。
- **徽章**：`BADGE_STYLE`（方角、等宽、大写、10.5px）；未确认状态 `PENDING_STYLE`（虚线）。
- **输入**：`INPUT_STYLE`；标签 `FIELD_STYLE`（等宽小字大写感）。数字、时间、ID、代码用 `FONT_MONO` + `fontVariantNumeric: 'tabular-nums'`。
- **错误/提示**：`ERROR_STYLE` / `WARNING_STYLE` / `NOTE_STYLE`，不要用 `color:'#c2410c'` 这类字面色。
- **层级**：只保留 4 档字号：11（等宽 micro）/ 12（note）/ 13–13.5（正文）/ 17.5（卡标题）/ 26–33（页标题）。不要新增 14/15/16 混用。
- **间距**：4 的倍数（4/8/12/18/24）；卡片内 gap 12，页面顶层 gap 18，表单字段 gap 12。
- 允许保留页面独有的布局常量（`CLOCK_STYLE`、`COLUMNS_STYLE` 等），但值必须从共享常量或 token 派生。

## 5. 具体页面要点

- **workbench**：全/紧凑两档；全档根 `contentStyle(1040)`，紧凑 `contentStyle(760)`。时间块/任务行用发丝线分隔；摘要卡、完成率卡、表单卡用 `CARD_STYLE`；`day`/`week` 模式切换保持按钮组；拖拽提示条用 `DRAFT_CARD_STYLE` 系。
- **plan**：草稿卡 `DRAFT_CARD_STYLE`、容量风险 `WARNING_CARD_STYLE`；阶段/周目标用 `SECTION_HEADING_STYLE`；材料 `<details>` 保留原生结构（样式表已处理）。
- **onboarding**：步骤条改成等宽大写小 chip（步骤号 + 名称），当前步用 `BUTTON_ACTIVE_STYLE` 的配色语义（可用局部派生）；表单三列网格；提交区唯一主按钮用 `BUTTON_PRIMARY_STYLE`。
- **timer**：大号等宽 tabular 数字（现有 38px 可保留，但字体用 `FONT_MONO`），卡片化；主操作按钮 `BUTTON_PRIMARY_STYLE`。
- **questions**：双列在窄窗坍塌为单列（现有 COLUMNS_STYLE 加 `@media` 无法内联，改为 `gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))'`）；行用发丝线。
- **memory**：tab 行用等宽按钮，列表行发丝线；编辑区字段用共享表单样式。
- **outcomes**：评分卡们用 `PANEL_SOFT` 分区而不是每卡一个边框；日历/天行用发丝线；数值统一 `FONT_MONO` tabular。
- **reminders**：表单卡、提醒列表用发丝线；底部的 shell 浮层 banner 保持 `position:fixed`（它不是页面，不套 `data-study-page`），但配色/圆角/阴影改 token。
- **feedback**（outcomes 的浮层卡片）：不是页面，保留 fixed/overlay 定位；卡面改 `CARD_STYLE` 派生 + 等宽小标题；不套 `data-study-page`。

## 6. 验证（每个 agent 必须跑）

```powershell
node plugins/<pkg>/scripts/build-client.mjs
node --test plugins/<pkg>/tests/<相关目录>/*.test.mjs
```

- build 输出 `ok: true` 且字节数变化合理。
- 相关 Node 测试全绿（页面测试用 stub，不需要浏览器）。
- 汇报：改了哪些文件、页面根是否改为滚动容器、内容最大宽度、构建字节数、测试通过数、你派生/新增的局部样式及其理由。
- 不要改 `packages/study-client/ui.js`、不要改别的插件、不要改 `client/client.js`（构建脚本会写它，这不算手改）、不要改测试。

## 7. 落地结果与证据（2026-11-17）

### 共享层

- `packages/study-client/ui.js`：Pi 式设计 token + 页面根/内容列 + 全部通用样式常量（标题、卡片、按钮、输入、徽章、列表、行、摘要、提示）+ `STYLE_TEXT` / `installStudyStyles`。
- `plugins/study-core/client/plugin.js` 在 `apply` 里 `ctx.effect(() => installStudyStyles())` 注入一次；样式表作用域为 `[data-study-page]`，提供页面背景点阵与顶部强调光晕、`h1` 上方短横线、`h2` 前强调短横线、hover / focus-visible / disabled、滚动条、`prefers-reduced-motion`、强制色模式回退。
- 页面 bundle 不再携带样式表：`STYLE_TEXT` 无顶层副作用，esbuild tree-shake 后 only-core 包含 CSS。页面产物因此比改版前更小或持平（例如 study-learning 50,202 B → 45,540 B 之后；study-facts 314,182 B → 303,758 B）。

### 页面清单

| 插件 | 页面/组件 | 内容列宽 | 根滚动 |
| --- | --- | --- | --- |
| study-core | today | 840 | 是 |
| study-facts | workbench（完整/紧凑） | 1040 / 760 | 是 |
| study-facts | plan | 1000 | 是 |
| study-facts | onboarding | 880 | 是 |
| study-facts | timer | 840 | 是 |
| study-learning | questions | 940 | 是 |
| study-memory | memory | 820 | 是 |
| study-outcomes | outcomes / feedback / personal-milestones | 1000 | 页面是；两个浮层组件保持 fixed/overlay |
| study-reminders | reminders（页面 + fixed banner） | 880 | 页面是；banner 保持 fixed |

### 验证

- 单元测试：study-core + study-facts 410 项（409 pass / 1 skipped）、study-learning + study-memory 17 项、study-outcomes + study-reminders 448 项，全部通过。
- 真实宿主页面审计（已执行，结论如下）：1440×720、zh-CN、sprout-paper 浅色与 deep-sea 深色下逐页打开 9 个页面并断言：
  - 每个页面根 `overflow-y: auto`，高度等于主面板高度（页内滚动，不再被框架裁切）；
  - 内容列水平居中偏移 0px，宽度等于各自上限；
  - workbench 内容确实溢出并用鼠标滚轮滚动（scrollTop > 100）；
  - 紧凑工作台内容列 760 且仍居中；
  - 深色下页面背景为 deep-sea 基色 `rgb(15, 26, 42)`，文字为主标签色，不是浅色残留；
  - 无未捕获页面错误/控制台错误。
- 改版前的静态预览（浅色/深色两张示意图）用于视觉定调。

> 上述审计与预览由一次性探针 `probes/ui-redesign` 完成；该探针与证据已随开发完成删除，结论保留在本规范。需要复跑时从 git 历史取回探针目录。
