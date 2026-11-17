# StudyBuddy 外观插件设计规范（`study-appearance`）

- 日期：2026-11-14（第二阶段：6 套配色组 + 顶栏表面，同日修订）；2026-11-17 归档到 `docs/design/`
- 状态：**设计定稿并已实现**；设计数值以本文为准，现行代码路径见 [../architecture.md](../architecture.md)，剩余事项见 [../roadmap.md](../roadmap.md)
- 配色模型：**浅色组 3 套（浅绿系）+ 深色组 3 套（深蓝系）**，每套同时提供 light/dark 两个值；默认 `sprout-paper` + `deep-sea`
- 范围：DSH **client-only 外观插件**（`@studybuddy/study-appearance`）的配色组、三面（侧边栏 / 画布 / 顶栏）映射、token 覆盖层、对比度、顶栏样式、设置行、可访问性降级；不涉及 host 业务与数据库
- 依据：[DSH Web 样式规范](../../source/deepseek-harness/docs/web-styling.md)、[`design-platform.css`](../../source/deepseek-harness/packages/client/ui-theme/src/styles/design-platform.css)、[`theme-presenter.ts`](../../source/deepseek-harness/packages/client/ui-layout/src/client/theme-presenter.ts)、[圆角标准](../../source/deepseek-harness/docs/ui-radius.md)；配色参考的生态调研为一次性资料，已随开发完成删除，结论保留在本文，可从 git 历史取回
- 硬约束：**不改 DSH 源码、不重排布局、不注册第三方 theme id、不写 `!important` 全量覆盖、不把 logo 放大到全屏**；只通过 `ctx.theme.overrideTokens()` 覆盖 token，并注入一张极小的作用域样式表

## 0. 结论先行

| 结论 | 值 |
| --- | --- |
| 配色组数量 | 浅色 3 套 + 深色 3 套；store 分开保存 `lightPack` / `darkPack` |
| 默认 | `lightPack='sprout-paper'`、`darkPack='deep-sea'` |
| 三面角色 | 画布 `base`；侧边栏 `sidebar`；顶栏 `topbar`（自定义 `--study-topbar`） |
| 浅色组 | `sprout-paper` 嫩芽纸本 / `mint-mist` 薄荷晨雾 / `celadon-page` 青瓷书页 |
| 深色组 | `deep-sea` 深海夜航 / `midnight-indigo` 午夜靛蓝 / `starry-blue` 星海雾蓝 |
| 浅色家族文字/强调 | 文字 `#20301A`/`#46563B`/`#56664A`/`#5F6F51`；强调 `#3F6B26`（hover `#35591F`，dimmed `#E3EED3`，selection `#D9E8C4`） |
| 深色家族文字/强调 | 文字 `#E6EEF9`/`#B9C8DC`/`#93A6BE`/`#8C9EB4`；强调 `#86B4FF`（hover `#A2C6FF`，dimmed `#1E3350`，selection `#223E66`） |
| 发送钮 / 信号色 | 浅色家族 `button-info-fill #3F6B26`、hover `#35591F`；深色家族 `#4E7FD8` / `#3F6FC4`（DSH 发送箭头是固定 `#fff`，填充需 ≥3:1，故深色不用 `#86B4FF`）；`brand-primary-new-colorprimary-new-color` 同这两值 |
| token 层 | 72 条 token，每条都是 `{ light, dark }` 成对；`light` 取 `lightPack` 表面、`dark` 取 `darkPack` 表面 |
| 顶栏实现 | 一条插件样式：会话头 `header[data-window-drag]:has([data-conversation-header-leading])` 与 `[data-dockkit-strip]` 的 `background: var(--study-topbar)`；入口页的 drag 头部不参与；开关关闭时不生效 |
| 对比度结论 | 6 套 × 明暗全部通过：文字/强调/按钮/选区 ≥4.5:1，焦点/滚动条/空闲点 ≥3:1；最低正文 12.55:1，最低 caption 4.83:1（light layer2），最低非文本 3.25:1 |
| 设置行 | 总开关 + 浅色组 3 chip + 深色组 3 chip（每 chip 带侧栏/背景/顶栏三色块预览）；行 id/order 仍为 `study.appearance` / 35 |
| 品牌图标 | `assets/logo1.png`（451×423 RGBA 实心毛绒梨伴，抱本子、绿背带）：侧栏 24px 用同素材正方形头部裁切，hero 34px / 设置预览 44px 用完整图；两张 PNG 都内联 data URL |
| 设计边界 | 装饰只落在 sidebar 品牌块、空会话 hero mark、设置页预览三处；不加玻璃、渐变、动态背景、壁纸 |

明暗偏好仍由 DSH `ctx.theme` 持有（`light` / `dark` / `system`）。插件不注册主题、不调用 `setTheme()`，只叠加 token 层；用户切原生明暗时自动进入对应家族。

## 1. 参考、品牌与两条颜色轨

### 1.1 参考项目取用边界

| 参考 | 采用 | 不采用 |
| --- | --- | --- |
| `webkubor/dsh-bloom-theme`（MIT，276★） | 多套成套色板、明暗成对、可读 accent 与氛围色两轨、对比度 ≥4.5 的工程范式、顶栏可切换 | 玻璃材质、动态背景、星空粒子、自由 CSS |
| 其他高 star 主题（一次性调研） | 设置页即时切换、成套交付、零运行时依赖的组织方式 | 皮肤市场、导入导出、第三方 theme id 注册、背景图/模糊 |

StudyBuddy 保持**纸面 / 纯色**：浅色是嫩芽纸本，深色是夜航蓝，不引入任何半透明或纹理背景。

### 1.2 品牌资产事实（2026-11-14 换用实心 logo1）

| 资产 | 尺寸 / 透明 | 结论用途 |
| --- | --- | --- |
| `assets/logo1.png` | 451×423 PNG RGBA；透明；可见包围盒 `(41,56)–(390,387)`，四边留白约 9.1% / 13.2% / 13.3% / 8.3% | **UI 唯一交付资产**（实心毛绒梨伴、抱本子、绿背带）：hero 34px 与设置预览 44px 用完整图 |
| `plugins/study-appearance/client/assets/logo1-head.png`（派生） | 250×250 PNG RGBA；自 `logo1.png` 裁 `(100,40)–(350,290)`，含叶 / 帽 / 脸 | 侧栏 `sidebar.brand.mark` 24px 专用头部裁切 |
| `assets/logo-start.png`（旧） | 125×131 PNG RGBA | **已退役**：不再被 import，插件内资产已删除 |
| 旧 `logo.png` / `logo.jpg` | 402×376 RGBA / 451×423 JPEG 白底 | 仅设计参考，已不在仓库；`logo.jpg` 不得进 UI |

`logo1.png` 自带约 9.1% / 13.2% / 13.3% / 8.3% 透明留白，禁止二次裁切；**侧栏头部裁切是唯一允许的派生裁切**（同素材、正方形、只取头部），hero 与预览必须用完整图。两张图都内联为 data URL（原 PNG 分别约 114.7 KB / 90.7 KB），因此 bundle 体积从 48 KB 增至约 306 KB。

### 1.3 两条颜色轨

| 轨道 | 用途 | 浅色家族 | 深色家族 | 规则 |
| --- | --- | --- | --- | --- |
| 可读轨 | 文字、图标、主按钮底、焦点环、链接、选区 | accent `#3F6B26` | accent `#86B4FF` | 必须 ≥4.5:1；允许进 token |
| 氛围轨 | 浅色选中底、徽章底、装饰点 | `#E3EED3` / `#D9E8C4` | `#1E3350` / `#223E66` | 只作实色浅底，**永不作正文文字或控件边框** |

两轨永不互换。深色下强调轨提亮、浅色下压暗；深色是独立手调的夜航蓝 palette，不是浅色的反相（禁止 `filter: invert`、`mix-blend-mode`、纯黑 `#000`）。

### 1.4 配色锚点（冻结自第一阶段；换 LOGO 不改 token）

| 锚点（阶段一 logo-start 取样） | 值 | 落到 |
| --- | --- | --- |
| 奶油纸（logo 主填充） | `#FDF1D7` | 浅色画布/卡面的暖白倾向 |
| 嫩芽叶（logo 叶色） | `#CCDA57` | 只做氛围参考；可读轨另取 `#3F6B26` |
| 暖墨棕（logo 描边） | `#592A0F` | 浅色正文 `#20301A`（去红、加深，保证对比度） |
| 腮花粉（logo 腮红） | `#FCC9BB` | 不再进入 token 层（MVP 的梨花粉 accent 已退役） |
| 夜航蓝（阶段二新增） | `#0A1420`–`#86B4FF` | 深色家族全部表面与强调色 |

徽标换成实心 `logo1.png` 后**只替换图片资产，token 表冻结不变**。对 `logo1.png` 的采样（按 16 级量化后的主色）为奶油 `#F8E8D8` / `#D8C8B8`、嫩芽叶 `#D5DA76`、本子 `#E5DFAB`，与既有奶油纸 / 嫩芽绿家族同色相；因此图标换新不需要改色板，也不会影响 §4 的对比度结论。

## 2. 六套配色组与三面映射

### 2.1 架构与转换契约

- 每套 pack 定义 **10 个表面角色**：`base`（画布）、`sidebar`（侧栏底）、`topbar`（顶栏）、`layer1/2/3`（抬升表面）、`overlay`（浮层）、`input`（输入/代码内容底）、`bubble`（气泡底）、`navActive`（侧栏选中导航行）。
- `tokenLayer(lightPack, darkPack, enabled)` 把 **light 值取自 lightPack、dark 值取自 darkPack**；因此一个 token 层同时容纳两套选择，用户切 DSH 原生明暗时自动换家族，无需监听方案。
- `SOURCE = '@studybuddy/study-appearance'`；关闭时 `tokenLayer` 返回 `{}`，DSH presenter 会撤回本层写过的全部变量（`theme-presenter.ts` 的 appliedTokens 机制），因此插件可反复重排覆盖而不残留。
- 自定义 `--study-topbar` 与 `--dsw-*` 走同一条 `overrideTokens` 通道：presenter 把任意 token 以 body 内联 CSS 变量写出，因此**无需改 DSH 源码**。
- 不注册主题、不改 `--dsw-static-*`、不写 `body[data-ds-dark-theme]`；明暗与 `color-scheme` 由宿主解析。
- Web Storage：`study.appearance.enabled`、`study.appearance.light-pack`、`study.appearance.dark-pack`。旧 MVP 的 `study.appearance.accent` **不读、不删**：升级后安全忽略，不会崩溃或误选色板。

### 2.2 浅色组表面（3 套）

| pack | base 画布 | sidebar 侧栏 | topbar 顶栏 | layer1 | layer2 | layer3 | overlay | input | bubble | navActive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `sprout-paper` 嫩芽纸本 | `#FBF7EC` | `#EFF5E3` | `#E3EDD2` | `#FFFDF7` | `#F6F2E5` | `#EFEADA` | `#E7E1CF` | `#FFFDF8` | `#F6F2E5` | `#E3ECD5` |
| `mint-mist` 薄荷晨雾 | `#EDF5E7` | `#F8FBF3` | `#DCEBD0` | `#FBFEF7` | `#EFF6E9` | `#E5EFDC` | `#D9E7CE` | `#FCFEF9` | `#EFF6E9` | `#E1EDD8` |
| `celadon-page` 青瓷书页 | `#F6F9F0` | `#E1EDD7` | `#FBFDF7` | `#FCFEF9` | `#F1F7EA` | `#E8F1DE` | `#DCE9D2` | `#FCFEF9` | `#F1F7EA` | `#EAF2E1` |

### 2.3 深色组表面（3 套）

| pack | base 画布 | sidebar 侧栏 | topbar 顶栏 | layer1 | layer2 | layer3 | overlay | input | bubble | navActive |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `deep-sea` 深海夜航 | `#0F1A2A` | `#0B1523` | `#0A1420` | `#142234` | `#182942` | `#1E3250` | `#22395A` | `#132032` | `#182942` | `#1D304B` |
| `midnight-indigo` 午夜靛蓝 | `#0B1522` | `#111E33` | `#16294A` | `#122033` | `#16273D` | `#1C304B` | `#203757` | `#111E31` | `#16273D` | `#1C304B` |
| `starry-blue` 星海雾蓝 | `#0D1728` | `#0A1220` | `#1A2E4F` | `#132136` | `#17283F` | `#1D3150` | `#21395D` | `#121F33` | `#17283F` | `#1E3453` |

### 2.4 三面角色 → token 映射

| 面 | 主要 token | 说明 |
| --- | --- | --- |
| 侧边栏 | `--dsw-specific-sidebar-fill`、`--dsw-specific-sidebar-nav-item-active` | AppFrame 侧栏列与品牌行消费；选中导航行用 `navActive` |
| 画布 | `--dsw-alias-bg-base`、`--dsw-alias-bg-layer-1/2/3`、`--dsw-alias-bg-overlay`、`--dsw-alias-bg-skeleton` | 页面底、卡面、分组底、浮层、骨架 |
| 顶栏 | `--study-topbar` + 插件样式表 | DSH 没有 topbar token，用自定义变量 + 一条选择器补齐（§3） |
| 输入/气泡 | `--dsw-specific-input-major`、`--dsw-specific-bubble`、`--dsw-specific-bubble-highlight`、`--dsw-specific-tip`、`--dsw-specific-selector` | 输入条、会话气泡、提示条、分段控件 |
| 代码/Markdown | `--dsw-alias-markdown-code-block`、`-banner`、`-inline-code`、`-code-segment-selected/-unselected`、`--dsw-alias-markdown-citation` | 代码块/标题条/行内代码/代码段/引用角标 |
| 设置卡/浮起按钮 | `--dsw-alias-settings-card-fill`、`-stroke`、`--dsw-elevation-stroke-color`、`--dsw-alias-button-elevated-fill`、`-floating-fill`、`-floating-hover`、`--dsw-alias-turn-trigger-bg`、`-hover` | 设置卡材质、浮层发丝线、浮起按钮、回合触发条 |

### 2.5 家族共享 token（每个家族一套，浅/深成对）

| token | 浅色家族 | 深色家族 | 用途 |
| --- | --- | --- | --- |
| `--dsw-alias-label-primary` | `#20301A` | `#E6EEF9` | 正文/标题 |
| `--dsw-alias-label-secondary` | `#46563B` | `#B9C8DC` | 次要正文、设置说明 |
| `--dsw-alias-label-tertiary` | `#56664A` | `#93A6BE` | 辅助信息 |
| `--dsw-alias-label-caption` | `#5F6F51` | `#8C9EB4` | 12px 注释 |
| `--dsw-alias-label-dimmed` | `#9AA88B` | `#5E6F85` | 仅 disabled/装饰 |
| `--dsw-alias-label-primary-foreground` | `#FDFCF7` | `#0A1422` | 强调底上的文字 |
| `--dsw-alias-border-l1`…`l4` | `#E6EEDC`/`#D6E1C8`/`#C5D4B4`/`#B3C5A0` | `#1B2A3E`/`#263A54`/`#314866`/`#3D5678` | 0.5px 发丝线 |
| `--dsw-alias-interactive-bg-hover` / `-active` | `#EDF3E3` / `#E2ECD4` | `#152235` / `#1C2C44` | hover / pressed |
| `--dsw-alias-state-success-primary` / `-tertiary` | `#3F6B2C` / `#E6EDD6` | `#7FD3A0` / `#14301F` | 成功 |
| `--dsw-alias-state-warn-primary` / `label` / `tertiary` | `#8A6118` / `#7A5510` / `#F4E5C8` | `#E8B45E` / `#F0C079` / `#322610` | 警告 |
| `--dsw-alias-state-error-primary` | `#A33B33` | `#F58A82` | 错误 |
| `--dsw-alias-state-business-primary` / `-tertiary` | `#3E5F57` / `#E0EAE5` | `#83B7D9` / `#14282F` | 信息/进行中 |
| `--dsw-alias-state-idle-primary` / `done-primary` | `#7C8B6B` / `#56664A` | `#6B7D93` / `#93A6BE` | 空闲点 / 完成 |
| `--dsw-alias-scrollbar-bg-l1/l2`、`hover` | `#7E8B6C` / `#6B7859` | `#5E6F85` / `#73869C` | 滚动条 |
| `--dsw-alias-switch-thumb` | `#FDFCF7` | `#E6EEF9` | Switch 滑块 |
| `--dsw-alias-brand-primary`、`brand-text`、`link`、`button-primary-fill`、`focus-ring-color` | `#3F6B26` | `#86B4FF` | 可读强调轨 |
| `--dsw-alias-button-primary-hover` | `#35591F` | `#A2C6FF` | 主按钮 hover |
| `--dsw-alias-button-primary-dimmed`、`sidebar-nav-item-active-accent`、`bg-multi-select`、`button-ghost-active-fill` | `#E3EED3` | `#1E3350` | 强调浅底 |
| `--dsw-alias-bg-document-selection` | `#D9E8C4` | `#223E66` | 文本选区底 |
| `--dsw-alias-button-info-fill` | `#3F6B26` | `#4E7FD8` | 发送圆钮 / info 填充（背景类） |
| `--dsw-alias-button-info-hover` | `#35591F` | `#3F6FC4` | 发送圆钮 hover |
| `--dsw-alias-brand-primary-new-colorprimary-new-color` | `#3F6B26` | `#4E7FD8` | Dockkit / trajectory / 更新徽标等信号色 |

发送钮与信号色必须按**背景类**取色，因为 DSH 的发送箭头写死静态 `#fff`（`ui-conversation/InputBar.module.css`）。浅色家族直接用 accent（白箭头 6.28:1）；深色家族不能复用提亮后的可读 accent `#86B4FF`（白箭头仅 2.10:1），改用 `#4E7FD8`（3.92:1）/ hover `#3F6FC4`（4.90:1）。`brand-primary-new-colorprimary-new-color` 在 Dockkit 页签底、trajectory 选中底、更新徽标等位置同样承担背景与标记用途，因此浅色取 accent、深色取 `#4E7FD8`。

派生项一律写成与上表同值的显式 hex（不写 `var()` 链），便于测试与主题诊断直接读取。

### 2.6 派生 token 映射（不新增色，只引用表面）

| 目标 token | 取值 |
| --- | --- |
| `--dsw-alias-bg-skeleton` | `layer3` |
| `--dsw-specific-bubble-highlight` | `layer3` |
| `--dsw-specific-selector` | `layer3` |
| `--dsw-specific-tip` | `layer2` |
| `--dsw-alias-markdown-code-block` / `-banner` / `-segment-unselected` | `layer2` |
| `--dsw-alias-markdown-inline-code` | `layer3` |
| `--dsw-alias-markdown-code-segment-selected` | `input` |
| `--dsw-alias-markdown-citation` | `layer2` |
| `--dsw-alias-settings-card-fill` | `layer2` |
| `--dsw-alias-settings-card-stroke` / `--dsw-elevation-stroke-color` | `border-l4` |
| `--dsw-alias-button-elevated-fill` / `-floating-fill` | `layer1` |
| `--dsw-alias-button-floating-hover` / `--dsw-alias-turn-trigger-bg` | `layer2` |
| `--dsw-alias-turn-trigger-bg-hover` | `interactive-bg-hover` |
| `--dsw-alias-menu-icon` / `--dsw-alias-label-primary-dimmed` | `label-secondary` |
| `--dsw-alias-button-ghost-active-border` | `border-l3` |

### 2.7 不覆盖（宿主拥有材质或另有对比度契约）

`--dsw-menu-surface-fill` / `--dsw-menu-backdrop-filter`（菜单材质）、`--dsw-alias-toast-*` / `--dsw-alias-tooltip-*`（浮层深色高对比）、`--dsw-alias-bg-mask-*`（遮罩）、`--dsw-static-*`（静态色阶）、字体 token。缺失时宿主原值仍在，不产生第二套灰阶。

## 3. 顶栏表面实现约束

### 3.1 为什么需要一条样式

DSH 0.2.2-rc.1 的 token 目录没有顶栏 token。真实 DOM 复核（2026-11-14，本地 0.2.2-rc.1，Playwright/Edge，1440×900）：

- 主区会话头是 `<header data-window-drag>`：空白首页 40px、有会话时 76px，默认透明；会话头内部带 `[data-conversation-header-leading]` 稳定标记；
- 插件页、账号引导页的头部**也**带 `data-window-drag`，但它们不是会话头，只按 drag 标记匹配会误染这些入口页（2026-11-17 修复）；
- 左栏品牌行是 `div[data-window-drag]`（60px，位于侧栏填充色上）；侧栏品牌行**不参与**顶栏组合；
- `[data-dockkit-strip]` 是右栏 / 浮动面板的 38px 页签条，默认透明。

因此“顶栏”= 带会话头标记的 `header[data-window-drag]:has([data-conversation-header-leading])`，并同步右栏/浮动面板页签条以保持多栏一致；入口页头部保持宿主表面。

### 3.2 插件样式（`client/style.js`）

```css
:root[data-study-appearance='on'] header[data-window-drag]:has([data-conversation-header-leading]),
:root[data-study-appearance='on'] [data-dockkit-strip] {
  background: var(--study-topbar);
  transition: background-color 160ms ease;
}

@media (prefers-reduced-motion: reduce) {
  :root[data-study-appearance='on'] header[data-window-drag]:has([data-conversation-header-leading]),
  :root[data-study-appearance='on'] [data-dockkit-strip] {
    transition: none;
  }
}
```

约束：

1. 只允许 `header[data-window-drag]` 及其 `[data-conversation-header-leading]` 后代、`[data-dockkit-strip]` 这几个**稳定 DOM 标记**；不得使用 DSH 哈希类名，也不得只写裸 `header[data-window-drag]`（会把插件页 / 引导页一起染色）。
2. 不得出现 `!important`；不得写全局 `body` 选择器；不得改布局属性（只画背景与过渡）。
3. 颜色只来自 `--study-topbar`，因此开关关闭 / token 层撤回时变量缺失，规则失效并回到透明，不需要 JS 反向清理。
4. 淡入淡出只在 `prefers-reduced-motion: no-preference` 下生效；reduce 时 `transition: none`（不是“更短”）。
5. 样式表只有这一条会落到宿主结构上；其余内容限于 `::selection`、logo 标记几何与四种系统偏好降级。

## 4. 对比度计算与结果

### 4.1 公式与口径

按 WCAG 2.x 相对亮度（与 `plugins/study-appearance/tests/theme.test.mjs` 同一实现）：

```text
sRGB 通道 c = C/255
linear(c) = c ≤ 0.03928 ? c/12.92 : ((c + 0.055)/1.055)^2.4
L = 0.2126·R + 0.7152·G + 0.0722·B
CR = (L_max + 0.05) / (L_min + 0.05)
```

- 正文 / 次要 / 三级 / 说明 / 强调 / 按钮标签 / 选区：目标 **≥ 4.5:1**（AA，小号文字同标准）。
- 焦点环、滚动条、空闲状态点：目标 **≥ 3:1**（WCAG 1.4.11 非文本）。
- 每个配对在**三套浅色、三套深色**上分别测量；任一不合格即测试失败。

### 4.2 关键配对最低值（三套中的最差）

| 配对 | 浅色组最低 | 深色组最低 |
| --- | --- | --- |
| 正文 / 画布 | 12.55（mint-mist） | 14.95（deep-sea） |
| 正文 / 侧栏 | 11.54（celadon-page） | 14.29（midnight-indigo） |
| 正文 / 顶栏 | 11.23（mint-mist） | 11.61（starry-blue） |
| 正文 / 选中导航行 | 11.49（sprout-paper） | 10.75（starry-blue） |
| 次要文字 / 画布 | 7.09（mint-mist） | 10.29（deep-sea） |
| 三级文字 / 画布 | 5.54（mint-mist） | 7.02（deep-sea） |
| 说明文字 / 画布 | **4.85**（mint-mist） | 6.38（deep-sea） |
| 说明文字 / layer2 | **4.83**（sprout-paper） | 5.34（deep-sea） |
| 强调 / 画布 | 5.63（mint-mist） | 8.31（deep-sea） |
| 强调 / layer2 | 5.61（sprout-paper） | 6.96（deep-sea） |
| 强调 / 顶栏 | 5.04（mint-mist） | 6.45（starry-blue） |
| 按钮标签 / 主按钮底 | 6.12 | 8.79（deep-sea） |
| 按钮标签 / hover 底 | 7.86 | 10.61（deep-sea） |
| 选区文字 / 选区底 | 10.87 | 9.22（deep-sea） |
| 焦点环 / 画布 | 5.63（mint-mist） | 8.31（deep-sea） |
| 滚动条 / 画布 | **3.25**（mint-mist） | 3.40（deep-sea） |
| 空闲点 / 画布 | 3.27（mint-mist） | 4.14（deep-sea） |
| 发送钮白箭头 / info-fill | 6.28 | **3.92**（deep-sea 等三套同值） |
| 发送钮白箭头 / info-hover | 8.08 | 4.90（三套同值） |

### 4.3 每套最小值

| 套 | 最低配对 | 值 | 余量 |
| --- | --- | --- | --- |
| light `sprout-paper` | 滚动条 / 画布 | 3.38:1 | 非文本阈值 3:1 |
| light `mint-mist` | 滚动条 / 画布 | 3.25:1 | 同上 |
| light `celadon-page` | 滚动条 / 画布 | 3.40:1 | 同上 |
| dark `deep-sea` | 滚动条 / 画布 | 3.40:1 | 同上 |
| dark `midnight-indigo` | 滚动条 / 画布 | 3.57:1 | 同上 |
| dark `starry-blue` | 滚动条 / 画布 | 3.49:1 | 同上 |

文字类最低值为 light `sprout-paper` 说明文字 / layer2 4.83:1，仍高于 4.5:1；配色无需为门槛牺牲色相。

### 4.4 门槛

- `plugins/study-appearance/tests/theme.test.mjs` 固定 38 条 `CONTRAST_PAIRS`（19 浅 + 19 深），按 3 套浅色 / 3 套深色展开为 114 个断言；发送钮的固定白箭头以前景字面量 `#FFFFFF` 参与断言（非 token 名）；新增 token 或改值必须同跑，低于阈值即失败。
- `label-dimmed` 仅用于 disabled/装饰（WCAG 1.4.3 对 inactive 组件豁免）；正文与 placeholder 一律用 `label-secondary` 及以上。
- 任何后置的第三方 `overrideTokens` 层都可能覆盖本主题；本规范只保证“仅本层生效”时的对比度。

## 5. 排版、圆角、发丝线与装饰边界

### 5.1 字号阶梯（只约束插件自有表面）

| 角色 | 字号 / 行高 | 字重 | 用在哪 |
| --- | --- | --- | --- |
| 品牌字标 | 18 / 24 | 600 | sidebar.brand.name |
| 设置行标题 | 14 / 22 | 500 | 设置行第一行 |
| 正文 | 14 / 22 | 400 | 设置说明、长句 |
| 注释 | 12 / 18 | 400 | 说明、组标签、chip、hint |
| 微标 | 11 / 16 | 500 | 徽章/角标；不作正文 |

不覆盖 `--dsw-font-*`、Markdown 字号、用户字号设置；不打包字体；数字用 `tabular-nums`。

### 5.2 圆角

| 角色 | Token | px |
| --- | --- | --- |
| 设置行 hover 底 | `--dsw-radius-md` | 12 |
| 设置预览图块 | `--dsw-radius-md` | 12 |
| 色板 chip / 开关 | `999px` + `corner-shape: round` | 胶囊 |
| 卡片 / hero 容器 | `--dsw-radius-xl` | 20 |
| 菜单 / 弹层 / 主面板 | 宿主 R16 / R28 | — |

禁止 10 / 14 / 18 / 24 等自造圆角；嵌套按 `inner = max(0, outer − inset)`。

### 5.3 发丝线与阴影

- 中性实线只用 **0.5px**；`border-l1/l2` 用于列表内边与卡片，`border-l3/l4` 用于控件/浮层描边。
- 浮层、菜单、弹窗、浮起按钮：`border: 0` + 宿主 elevation；绝不“中性 border + elevation”叠加。
- 不加自造 `box-shadow`、发光、渐变文字；logo 不加投影/描边。

### 5.4 纸张质感与装饰边界

| 规则 | 具体值 |
| --- | --- |
| 允许装饰的表面 | ① sidebar 品牌块；② `conversation.hero.brand.mark` 空会话 hero；③ 设置行 44px 预览 |
| 纸张质感 | 只用 `base` / `layer-*` 的色阶与 0.5px 发丝线，不加噪声/纹理/插画背景 |
| 加色面积 | 强调色像素 ≤8% 视口；三面色块只出现在设置行小 chip 内 |
| 渐变 | **不用**；层次只叠实色表面与发丝线 |
| 动效 | 仅预览切换与顶栏背景 ≤160ms；`prefers-reduced-motion` 下为 0 |
| 禁止位置 | 消息正文背后、代码块、工具卡、表格、全屏插画、壁纸 |

## 6. logo 使用规范

| 位置 | 槽位 | 尺寸 | 几何 / 资产 |
| --- | --- | --- | --- |
| 侧栏品牌标记 | `sidebar.brand.mark` | 24×24 | `logo1-head.png`（同素材 250×250 头部裁切），透明底，`object-fit: contain`，不设圆角、不加底板 |
| 侧栏品牌名 | `sidebar.brand.name` | 18/24 字标 | `label-primary`，600 |
| 空会话 hero | `conversation.hero.brand.mark` | 34×34 | `logo1.png` 完整实心梨伴，透明底；不加投影/光晕 |
| 设置页预览 | `settings.general.item` | 44×44 | `logo1.png` 完整图，`R12` 图块，`bg-layer-2` 底，`0.5px border-l2`，内边距 4 |

- 只接受 RGBA PNG；保持透明背景、等比缩放，不裁切/改色/描边；**侧栏头部裁切是唯一允许的派生裁切**，hero 与预览不得裁切。
- 侧栏 mark 保持原图朝向（面朝字标方向），不做假对称镜像；不把 24px mark 拉成 34/44px，也不给 logo 加白色圆底。
- mark 紧邻可见品牌名时为装饰图（`alt=""` + `aria-hidden`）；独立出现时用 `appearance.brand.alt`；设置预览用 `appearance.preview.alt`。
- v1 内联 `logo1.png`（完整）与 `logo1-head.png`（派生头部）两张 data URL；`logo-start.png` 已删除、不再引用；两张图使 bundle 约 306 KB（`build.test.mjs` 断言 ≥2 个内联 PNG 与体积下限）。

## 7. 设置行：契约、文案与交互

### 7.1 注册契约

| 项 | 值 |
| --- | --- |
| locale NS | `study-appearance`（一插件一 NS） |
| 槽位 | `settings.general.item`（`kind: list`, `scope: root`） |
| 行 id / order | `study.appearance` / **35**（在通用“回复提醒”40 之前） |
| 存储键 | `study.appearance.enabled`（`'1'`/`'0'`，缺省开）、`study.appearance.light-pack`、`study.appearance.dark-pack` |
| 退役键 | `study.appearance.accent`（不读、不删；旧值被安全忽略） |
| 注入 | `slots`、`theme`、`locale`；row 通过 `hooks.appearance` 读快照，`setEnabled` / `setLightPack` / `setDarkPack` 写入 |
| testid | `study-appearance-setting`、`study-appearance-toggle`、`study-appearance-light-<id>`、`study-appearance-dark-<id>`、`study-appearance-preview` |

### 7.2 文案（键 → zh / en）

| Key | zh | en |
| --- | --- | --- |
| `appearance.setting.label` | StudyBuddy 外观 | StudyBuddy appearance |
| `appearance.setting.description` | 浅色组与深色组各选一套；每套同时决定侧边栏、画布与顶栏，主色使用可读的绿色或蓝色。 | Pick one light and one dark palette. Each pack colors the sidebar, canvas and top bar together, with a readable green or blue accent. |
| `appearance.setting.enabled` / `disabled` | 已开启 / 已关闭 | On / Off |
| `appearance.light.label` / `dark.label` | 浅色组 / 深色组 | Light palette / Dark palette |
| `appearance.pack.sprout-paper` | 嫩芽纸本 | Sprout Paper |
| `appearance.pack.mint-mist` | 薄荷晨雾 | Mint Mist |
| `appearance.pack.celadon-page` | 青瓷书页 | Celadon Page |
| `appearance.pack.deep-sea` | 深海夜航 | Deep Sea |
| `appearance.pack.midnight-indigo` | 午夜靛蓝 | Midnight Indigo |
| `appearance.pack.starry-blue` | 星海雾蓝 | Starry Blue |
| `appearance.preview.alt` | 梨伴形象预览 | Buddy preview |
| `appearance.hint.native` | 菜单、原生控件与弹层保持 DSH 原样。 | Menus, native controls, and overlays stay native. |
| `appearance.restore` | 关闭后立即恢复 DSH 原生外观，无需重启。 | Turns off immediately and restores the native DSH look. |

英文句首大写（sentence case）；「DSH」「StudyBuddy」不翻译；不使用感叹号与拟人化语气。

### 7.3 行布局与交互

| 项 | 规格 |
| --- | --- |
| 行容器 | `display:flex`，`gap:16px`，`padding:12px 0`；窄容器自动换行 |
| 标题 / 说明 | 14/22 500 `label-primary`；12/18 `label-secondary`、`max-width:46ch` |
| 色板分组 | 两行：浅色组 / 深色组；每行 3 个 chip，左对齐 |
| chip | 胶囊 `padding:3px 10px`、12/18；选中态 `aria-pressed="true"` + 强调边框 + `button-primary-dimmed` 底；最小触控区 44×44 |
| 三色块预览 | chip 内 3 个 8×8 圆角色块，顺序固定为**侧栏 / 背景 / 顶栏**；`aria-hidden`，不承担标签 |
| 开关 | `role="switch"` + `aria-checked` + `aria-labelledby` 指向标题；可见文字“已开启/已关闭”；最小点击区 44×44 |
| 预览图 | 44×44 `R12` 图块，右上角与开关同列 |
| 即时生效 | 切 chip 只重排 token 层；开关关闭时 token 层清空（`{}`），样式表规则因 dataset 不匹配而失效 |
| 失败 | Web Storage 被禁时退化为内存态；行仍可用 |

## 8. 可访问性降级

| 偏好 | 行为 |
| --- | --- |
| `prefers-reduced-motion: reduce` | 顶栏背景与 logo 的 transition/animation 全部 `none`；无循环动画 |
| `prefers-reduced-transparency: reduce` | 不用半透明填充；选区为实色 `bg-document-selection` |
| `prefers-contrast: more` | 选区改用 `label-primary` 底 + `primary-foreground` 字；焦点可见性优先 |
| `forced-colors: active` | 选区走 `Highlight`/`HighlightText`；背景与边框交给系统色 |
| `prefers-color-scheme` | 只由宿主 `ctx.theme` 解析；插件不写 `data-ds-dark-theme`、不自行监听媒体查询切色 |
| 键盘 | Tab 顺序：标题 → chip（浅色 3 → 深色 3）→ 开关；每组 `role="group"` + `aria-label`；选中不只靠颜色（`aria-pressed`） |
| 200% / 320px | 行纵向堆叠，chip 换行，无横向滚动；说明不截断 |

## 9. 非目标

1. **不改 DSH 源码**（`source/deepseek-harness` 保持零 diff），不为本插件新增宿主 token。
2. **不做布局重排**：不改侧栏宽度、页面结构、会话流、卡片顺序。
3. **不做主题包导入/导出/市场**，不提供第三方皮肤、任意 CSS 注入或 `!important` 全量覆盖。
4. **不打包字体**；不替换宿主文字系统。
5. **不做 favicon、启动图、桌面图标、托盘图标、加载动画**。
6. **不做全屏插画/壁纸/毛玻璃/动态背景/桌宠**；不把 logo 放大到全屏。
7. **不注册第三方 theme id**（不新增 `setTheme` 可选主题）；明暗跟随宿主 light/dark/system。
8. **不新增网络请求、遥测、账号能力**；资产只来自包内。
9. 不覆盖菜单材质、toast/tooltip、遮罩；不重定义 `--dsw-static-*`。

## 10. 验收清单

| # | 检查 | 通过标准 |
| --- | --- | --- |
| 1 | token 完整性 | 72 条 token；3×3 任一 `lightPack`×`darkPack` 组合下均有 `light`/`dark` 两值；关闭时层为 `{}` |
| 2 | 三面映射 | 每套 pack 的 `base`/`sidebar`/`topbar` 分别落到 `bg-base`、`sidebar-fill`、`study-topbar`；live DOM computed 值等于设计值 |
| 3 | 对比度 | 114 个断言全过；正文/说明/强调/按钮/选区 ≥4.5，焦点/滚动条/空闲点 ≥3；发送钮白箭头 / info-fill 与 hover ≥3 |
| 4 | 顶栏 | `header[data-window-drag]` 与 `[data-dockkit-strip]` 吃到 `--study-topbar`；无 `!important`、无哈希类名、无全局 body；关闭后规则不生效 |
| 5 | 品牌图 | sidebar 24×24 用 `logo1-head.png`（同素材头部裁切，内联 data URL）；hero 34×34 与设置预览 44×44 用完整 `logo1.png`（内联）；透明底、等比、不裁不拉；旧 `logo-start.png` 无引用 |
| 6 | 降级 | reduced-motion 下顶栏过渡为 none；reduced-transparency/contrast/forced-colors 四态可用 |
| 7 | 设置行 | 两组 chip + 三色块预览 + 开关；en/zh 键齐全；testid 符合 §7.1；旧 accent 值安全忽略 |
| 8 | 持久化 | `lightPack`/`darkPack` 分别写入 Web Storage；刷新后保持 |
| 9 | 深色成立 | 深色三套的 computed 画布/侧栏/顶栏等于设计值；无 `filter` 反相 |
| 10 | 构建 | `node plugins/study-appearance/scripts/build-client.mjs` 退出 0；bundle id = `@studybuddy/study-appearance`；约 306 KB、含 2 张内联 PNG |
| 11 | 冒烟 | `node plugins/study-appearance/tests/appearance-smoke.mjs` → `passed: true`；6 套截图 + 设置行 + 窄窗；品牌图 natural/渲染尺寸正确；无 pageerror/toast |
| 12 | 范围 | 插件目录与本文档目录之外无代码改动；`source/deepseek-harness` 零 diff |

> 一次性验收记录与审计证据已随开发完成从 docs 归档中删除，可从 git 历史取回；后续扩展项见 [../roadmap.md](../roadmap.md)。
