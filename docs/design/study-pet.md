# 「小搭」桌宠设计规范（`study-pet`）

- 日期：2026-11-14；2026-11-17 归档到 `docs/design/`
- 状态：**设计定稿并已实现**；现行代码路径见 [../architecture.md](../architecture.md)，剩余事项见 [../roadmap.md](../roadmap.md)
- 范围：`@studybuddy/study-pet` 的场景机、语言系统（台词包 / 气泡 / 碎碎念 / 梦话 / voice pack）、计时器联动、静图形象与可访问性
- 依据：[DSH 槽位文档](../../source/deepseek-harness/docs/subsystems/slots.md)；[外观插件设计](appearance-plugin.md) 的排版/圆角/降级约定；桌宠生态调研为一次性资料，已随开发完成删除，结论保留在本文，可从 git 历史取回
- 硬约束：不改 DSH 源码、不手工挂 `document.body`、不搬第三方美术/代码、React 之外无运行时依赖

## 0. 结论先行

| 项 | 值 |
| --- | --- |
| 注册槽位 | `shell.overlay` id `study.pet`；`settings.general.item` id `study.pet` order 36 |
| 宠物形象 | `assets/logo1.png`（451×423 RGBA，成品毛绒梨伴）→ 150×170 容器 `object-fit: contain`；静态形象，动作后期再补 |
| 状态数 | 8：idle / think / working / celebrate / rest / error / sleep / dragging（保留语义、驱动台词；暂无专属摆姿） |
| 台词场景 | 13：idle / think / working / done / error / rest / sleep / click / pat / chatter / timerStart / timerFinish / greet |
| 气泡规则 | TTL 4 s；同场景冷却 9 s；长场景每 8 s 换一句 |
| 碎碎念 | idle 时 45–90 s 一句，默认开 |
| 睡觉 | 20 s 无手势进入 sleep；梦话 60–120 s 一句；点击/拖动醒来问候 |
| 计时器轮询 | `studyClient.call('timer','status')`，20 s/次；缺失或失败静默 |
| 存储键 | `study-pet:enabled` / `:chatter` / `:size` / `:position` / `:voice` |
| 动画实现 | 静图呼吸/浮动 + 点击挤压 + 双击弹跳 + 拖动倾斜；CSS keyframes，JS 只在拖动时移动像素；镜像用 `scaleX` 包裹层 |

## 1. 场景机（`client/state-machine.js`）

### 1.1 事实来源

| 事实 | 来源 | 形状 |
| --- | --- | --- |
| 会话活动 | 标准 hook `useSessionStatus`（root 级可用） | `Map<sessionId, { running?: boolean, pendingInteraction?: object, completionUnread: boolean }>` |
| 计时器 | 可选 `ctx.get('studyClient')` → `POST /api/study/timer/status` | `{ session: { id, kind: 'study'|'rest', phase: 'running'|'paused'|'interrupted'|'finished', endedAt, remainingMs, … } | null, lastFinished }` |
| 手势 | 点击 / 双击 / 拖动 / 悬停面板按钮 / 召唤 | 组件派发 `interact` / `dragging` 事件 |
| 时间 | `Date.now()`（每 1 s 一帧） | 用于 20 s 入睡与 celebrate 窗口 |

### 1.2 优先级（由高到低）

| # | 条件 | 场景 |
| --- | --- | --- |
| 1 | 拖动指针按下并超过 4 px | `dragging` |
| 2 | 计时器 `session.phase === 'interrupted'` | `error` |
| 3 | 任一 Session 有 `pendingInteraction` | `think` |
| 4 | 计时器 running：`kind === 'rest'` → `rest`；`kind === 'study'` → `working` | `rest` / `working` |
| 5 | 任一 Session `running === true` | `working` |
| 6 | `now < celebrateUntil` | `celebrate` |
| 7 | `now - lastInteractionAt >= 20 s` | `sleep` |
| 8 | 其余 | `idle` |

要点：

- **计时器优先于会话**：学生在番茄钟里专注时，即使会话刚好空着也显示 working/rest；但“等待学生确认”的 `pendingInteraction` 比计时器更高（需要行动），`interrupted` 最高（需要处理）。
- **sleep 只在无 running / 无 pending / 无 celebrate 时可达**，不会在 agent 干活时睡着；20 s 计时由手势重置（点击、双击、拖动、摸头、碎碎念按钮、召唤）。
- **error 的来源**：DSH `SessionStatus` 没有错误事实，因此 error 只由计时器 interrupted 触发，直到学生确认（resume/finish）后回到 working/idle。这是已知限制，不伪造会话错误。

### 1.3 边沿与一次性事件

| 事件 | 触发 | 效果（`effects`） |
| --- | --- | --- |
| 会话 running 真→假 | 前一快照某 id `running === true`，新快照该 id 缺失或 `false` | `celebrateUntil = now + 6 s`；`speak('done', force)` 一次 |
| 同一快照重复上报 running=false | 上一帧已是 false | 不再触发（用前一帧 running map 比对，保证“done 只一次”） |
| 计时器刚 finished | `session.phase === 'finished'` 且 id 未处理过，且 `endedAt` 距 now ≤ 90 s | `celebrateUntil`；`speak('timerFinish', force)` 一次 |
| 计时器旧 finished | id 未处理但 endedAt 早于 90 s | 只记 `lastFinishedTimerId`，不进 celebrate、不说话（避免插件挂载时给昨天的番茄钟庆祝） |
| 计时器新 running（study） | 运行中 session id 未处理过 | `speak('timerStart', force)` |
| 计时器 interrupted | id 未处理过 | `speak('error', force)` 一次 |
| 场景进入 think/working/rest | 场景变化且本帧没有更明确的说话效果 | `speak(scene)`（受 9 s 冷却） |
| 从 sleep 被手势唤醒 | `interact`/`wake`，旧场景为 sleep | `speak('greet', force)` |
| `completionUnread` 单独出现 | 只影响实现方读取，不单独触发 done | 无 |

`celebrate` 持续 6 s（或直到更高优先级场景出现）。所有状态对象不可变，reducer 返回 `{ state, effects }`，React 只把 effects 交给气泡调度器。

### 1.4 组件帧循环

| 间隔 | 动作 |
| --- | --- |
| 1 s | `reducePetState(tick)` → 可能入睡；`bubble.tick()` → 过期 / 长场景轮换 / 碎碎念 / 梦话 |
| 20 s | 可选 `timer/status` 轮询（挂载时立即先跑一次） |
| 事件 | sessions 快照变化 → 派发 `sessions`；点击/拖动 → `interact`/`dragging` |
| 卸载 | 清 interval、window resize、window pointermove/up、happy 定时器；store 与样式表由 `ctx.effect` 回收 |

## 2. 语言系统

### 2.1 台词包（`client/lines.js`）

- `SCENES` 固定 13 个场景，`STATUS_SCENES` 为其中可由状态气泡呈现的 9 个（idle/think/working/done/error/rest/greet/timerStart/timerFinish）。
- `VOICE.zh` 与 `VOICE.en` 键集合完全一致，每池 4–8 句，冻结数组。
- 台词是纯文本：无 Markdown、无占位符、无换行；zh 单句 ≤48 字符、en ≤96 字符（测试），voice pack 上限更宽（160）。
- `voiceLocale('zh-CN') → 'zh'`，其余（含 `en-US`、未知、undefined）→ `'en'`。

### 2.2 气泡调度（`client/bubble.js`）

| 规则 | 值 | 说明 |
| --- | --- | --- |
| 气泡存活 | 4 s | `expiresAt = at + 4000`，由 1 s tick 清除 |
| 同场景冷却 | 9 s | 非 force 的自动台词；手势与 done/timerFinish/error 用 `force: true` |
| 长场景轮换 | 8 s | think/working/rest 持续时强制换下一句（轮换优先于冷却） |
| 碎碎念 | 45–90 s | 只在 idle、未睡、开关开时；进入 idle 时排下一句 |
| 梦话 | 60–120 s | 只在 sleep；进入 sleep 时排下一句 |
| 台词选择 | 池内轮转 | 每场景维护 cursor，放完一轮再从头 |
| 睡眠静音 | 所有非 sleep 台词直接返回 null | 睡觉期间不出状态气泡/碎碎念 |

气泡是共享表面：状态、点击、摸头、碎碎念、梦话都会替换当前气泡；`data-kind` 区分 `status` / `gesture` / `chatter` / `dream`（chatter 用斜体、次级色）。气泡通过 `role="status" aria-live="polite"` 播报。

### 2.3 voice pack（`client/voice-pack.js`）

- 键：`study-pet:voice`，读取一次；`{ status: { scene: string[] }, click: string[], chatter: string[], sleep: string[] }`。
- 校验：

| 检查 | 规则 |
| --- | --- |
| JSON | 合法对象；空串/缺省视为无包 |
| 顶层键 | 仅 `status`/`click`/`chatter`/`sleep`，未知键整体拒绝 |
| `status` 场景 | 仅 `STATUS_SCENES`，未知场景整体拒绝 |
| 类型 | 每池为字符串数组；每句非空、单行 |
| 条数 | 每池 ≤64 句 |
| 长度 | 每句 ≤160 字符 |
| 破坏性输入 | 整体忽略 + `console.warn`（不会半套生效） |
| 空池 | 不覆盖，保留内置台词 |
| 语言 | 覆盖同时作用于 zh/en（语言中立） |

合并后仍是不可变表；`pat` 与内置池不在 voice pack 格式内（保持简单，见 README 限制）。

### 2.4 中英切换

组件通过 `hooks.locale`（`ctx.locale` 作为 bare observable）绑定 `useLocale(snapshot => snapshot.active)`；locale 变化时 `controller.setVoice(voiceForLocale(mergedVoice, active))`，之后的新气泡使用新语言，旧气泡自然过期。UI 文案（设置行、aria-label、面板）走 `t`，宠物台词永不走 `t`。

## 3. 计时器联动

| timer 状态 | 宠物 | 台词 |
| --- | --- | --- |
| `running` + `kind: study` | `working` | 首次观察到该 session：`timerStart`；之后长场景轮换 working |
| `running` + `kind: rest` | `rest` | rest 自动台词（进入时一句，之后 8 s 轮换） |
| `finished`（90 s 内） | `celebrate`（6 s） | `timerFinish` 一次 |
| `finished`（旧） | 不影响 | 无 |
| `interrupted` | `error` | `error` 一次（直到确认） |
| `paused` | 按会话情况 idle/working 等 | 无专门台词 |
| 服务不存在 / 调用失败 | 不影响任何状态 | 无、无 console error |

轮询 20 s（brief 要求 ≥15 s）；`pollTimer` 在 apply 内实现，先 `ctx.get('studyClient')`，再 `try { await client.call('timer','status') } catch { return null }`。契约以 `plugins/study-facts/host/modules/timer.mjs` 的 `status` 返回为准。

## 4. 宠物形象（静图 + 最小动效）

### 4.1 素材与容器

| 项 | 值 |
| --- | --- |
| 素材 | `assets/logo1.png`（451×423 RGBA 透明底；成品毛绒梨伴：奶油绒毛、奶油帽、叶冠、腮红、绿背带，抱螺旋本与笔） |
| 打包副本 | `plugins/study-pet/client/assets/logo1.png`（与源文件一致；`build.test` 校验 PNG 签名与 451×423） |
| 内联方式 | esbuild `loader: { '.png': 'dataurl' }`，bundle 内为 `data:image/png;base64,…`，离线自包含 |
| 容器 | `150×170`（三档缩放 128–204），`object-fit: contain` 等比居中；不裁切、不拉伸 |
| 可访问性 | `<img class="sp-figure sp-photo" alt="" aria-hidden="true">`；可点击主体是外层 `<button>`，label 为本地化 `pet.alt` |

**动作后期再补充**：状态 `data-state` 继续按场景机更新并驱动台词，但八个状态共用同一张静图，没有各状态专属摆姿（原 SVG 的眼睛/笔划/星星/Zzz/汗滴图层已移除）。

### 4.2 左右对称（镜像）

- 图片原始朝向为右（抱本子的一侧）。
- 组件按 `position.left + box.width/2` 与视口半宽比较：宠物在**右半**时根节点 `data-mirror="true"`，左半保持原朝向。
- CSS：`[data-study-pet][data-mirror='true'] { --sp-flip: -1 }`；图片包裹层 `transform: scaleX(var(--sp-flip)) rotate(var(--sp-tilt))`。
- 只翻转图片包裹层，不改容器尺寸、点击区域或宽高比；拖动或 resize 换边时逐帧重算，镜像实时切换。

### 4.3 最小动效

| 触发 | 动画 |
| --- | --- |
| 静止（任何状态） | `sp-photo-breathe`：4.2 s 循环 `translateY(-2px) scale(1.012)` |
| 单击 | `data-squash=true` → `sp-photo-squash` 280 ms（scale 1.06/0.9 回弹） |
| 双击 | `data-happy=true` → `sp-photo-bounce` 0.55 s ×2（上跳 8 px） |
| 拖动 | `data-dragging=true` → 包裹层 `--sp-tilt: 6deg` + 160 ms transform 过渡 |
| 气泡 | `sp-bubble-in` 160 ms（透明度 + 3 px 上浮） |

动画只用 `transform` / `opacity`；`prefers-reduced-motion: reduce` 下静图呼吸/挤压/弹跳、包裹层过渡、气泡入场与面板 120 ms 过渡全部归零，拖动倾斜也取消。降级规则不能用 `[data-study-pet] *`（specificity 0,1,0 会被 0,2,0–0,3,0 的动效规则覆盖），而是列出同 specificity 的选择器（`[data-study-pet][data-squash='true'] .sp-photo` 等）放在动画规则之后，靠 source order 生效，不写 `!important`；`pet-smoke` 在 `emulateMedia({ reducedMotion: 'reduce' })` 下实测静图/气泡 `animationName === 'none'`、面板与包裹层 `transitionDuration === '0s'`。

气泡、面板、召唤按钮走宿主语义 token（`--dsw-alias-bg-layer-1`、`--dsw-alias-label-primary`、`--dsw-alias-border-l3`、`--dsw-elevation-panel`），深色下自动换皮；毛绒图片保留原图色彩，不随明暗反相。

## 5. 交互与几何

### 5.1 拖动 / 点击判定

- `pointerdown`（主键）→ 记录起点与当前 left/top；`pointermove` 超过 **4 px** 才进入 dragging；`pointerup` 时若移动过则保存位置并抑制随后的 click，否则按点击处理。
- 指针捕获 + **window 级** `pointermove`/`pointerup`/`pointercancel`，指针离开小宠物也能继续拖；卸载时移除全部监听。
- 点击：`interact`（可能唤醒）+ `click` 气泡 + 静图挤压；双击：`data-happy` 弹跳 1.1 s + 一句回应；拖动中不弹气泡。
- 悬停/`focus-within` 显示面板；`data-flip`（top < 210 px）把气泡/提示翻到宠物下方；`data-side`（left < 220 px）把面板翻到宠物右侧，避免出界。
- 镜像随位置实时更新（§4.2）：拖动时每一帧都由新 `left` 推导 `data-mirror`。

### 5.2 位置与钳制（`client/geometry.js`）

- 基础盒 `150×170`（`petBox(scale)` 四舍五入），三档约 `128/150/180` 宽、`145/170/204` 高。
- 默认位置：右下角，四边留 `12 px`。
- `clampPosition` 把整盒限制在 `[margin, viewport - size - margin]`；视口比宠物还小时固定在 `margin`。
- 存储的是像素 `{ left, top }`；渲染时 `resolvePosition` 再钳制一次，因此窗口缩小不会丢宠物，放大后可回到原记忆位。
- resize：清空拖动中的临时位置并重算；localStorage 不可用时内存态，损坏值回退默认。

## 6. 可访问性

| 偏好 / 能力 | 行为 |
| --- | --- |
| 键盘 | 主体原生 button（Enter/Space 触发点击）；面板按钮 Tab 可达；焦点环 2 px + 2 px offset（`--dsw-focus-ring-color`） |
| 屏幕阅读器 | 主体 `aria-label`；宠物图片 `alt=""` + `aria-hidden`；气泡 `role=status` + `aria-live=polite`；面板 `role=group` + label；开关 `role=switch` + `aria-checked`；大小 `aria-pressed` |
| `prefers-reduced-motion: reduce` | 静图呼吸/挤压/弹跳、包裹层过渡、气泡入场、面板过渡全部归零，拖动倾斜取消；降级选择器与动效规则同 specificity 并置于其后（无 `!important`），`pet-smoke` 实测断言 |
| `prefers-contrast: more` | 气泡/面板/召唤按钮实色底 + 1 px 边框，正文用 `label-primary` |
| `forced-colors: active` | 上述表面改用 `Canvas`/`CanvasText` 系统色，`forced-color-adjust: none` 保留可读性 |
| 指针隔离 | 根节点 `pointer-events: none`，仅 button/panel/summon `auto`，不遮挡页面其它区域 |
| 触控 | 点击/拖动可用；面板依赖 hover/focus，隐藏/召唤与大小仍能在设置行完成 |

## 7. 测试与证据

- 单测（React-free）：`plugins/study-pet/tests/lines.test.mjs`、`voice-pack.test.mjs`、`state-machine.test.mjs`、`bubble.test.mjs`、`store.test.mjs`、`geometry.test.mjs`、`style.test.mjs`（镜像/静图动效/reduced-motion 选择器覆盖、无 `!important`）、`apply.test.mjs`、`build.test.mjs`（logo1 尺寸与 bundle 内 data URL）。
- 真实浏览器：`plugins/study-pet/tests/pet-smoke.mjs` 启动临时 DSH Web profile（study-core + study-outcomes + study-facts + study-pet），断言静图 data URL/natural 尺寸、右半镜像与拖动换边实时切换、点击气泡（opacity/颜色 alpha）、拖动 120×60 + reload 记忆、设置行大小/隐藏/恢复、**reduced-motion 下 animationName/transitionDuration 归零**、深色模式、`timer/status` 200、无 pageerror/console/HTTP 错误；截图写入测试证据目录。
- 一次性验收记录已随开发完成从 docs 归档中删除，可从 git 历史取回；剩余扩展项见 [../roadmap.md](../roadmap.md)。
