# SB-15 同日拖拽到起始分钟

- 状态：TODO
- 优先级：P2
- 来源：issue 19
- 依赖：SB-01
- 预计：0.5–1 个会话
- 所有权：`plugins/study/client/pages/workbench.js`、`plugins/study/host/modules/tasks.mjs`、`plugins/study/tests/progress/**`、`plugins/study/tests/client/**`
- 开工阅读：`issues/2026-11-10-design-code-review.md#issue-19`；设计 §4.3；T06 任务卡。

## 1. 问题

工作台拖拽的放置目标只有日期；同一天放下直接 `return`，payload 只有 `date`，保留原起止时间。学生不能在同一天把 09:00 的块拖到 14:00，只能手动编辑时刻。

## 2. 当前证据

- `workbench.js` 的 drop 目标只有日期；同日移动被视为 no-op。
- `tasks.moveBlock` 支持日期/起止，但 UI 没有传同日的起止。
- 手动编辑时间块可用，但不是“拖一下就排好”。
- 静态确认见 issue 19。

## 3. 正确业务逻辑

1. 拖拽目标包含日期和起始分钟；同日/跨日都提交 `date/start/end`（或 `startMinute/endMinute`）。
2. 默认保持块时长；拖到新起点后 `end = start + duration`，跨午夜要拆块或拒绝并提示。
3. 提交前/后做重叠检测；冲突返回 `conflict` 和冲突列表，UI 提供“保留重叠”/取消。
4. 块 ID、任务 ID、createdAt 不变；只追加一条 move 变更。
5. 并发版本失效时提示重新读取，不静默覆盖。
6. 拖拽期间不连带重排其他块；整天重排仍由明确操作/Agent 触发。

## 4. 修改范围

- `workbench.js`：拖拽落点计算起始分钟；同日移动提交完整时间；视觉提示落点。
- `tasks.moveBlock`：接收同日 `start/end`；校验时长/重叠/版本；跨午夜处理。
- 测试：同日移动、保持时长、冲突、跨日、跨午夜、块 ID 不变、requestId 幂等。

## 5. 验收标准

- [ ] 09:00–09:30 块可拖到同日 14:00，变为 14:00–14:30，ID/taskId 不变。
- [ ] 拖到重叠位置显示冲突，确认后才保存。
- [ ] 跨日拖拽仍可用；跨午夜非法时明确提示，不静默截断。
- [ ] 只追加一条 move 变更；重复提交同 requestId 不重复移动。
- [ ] `node --test --test-isolation=none plugins/study/tests/progress plugins/study/tests/client` 通过。

## 6. 不做

- 不做全天自动重排。
- 不做触屏手势；本轮鼠标/HTML5 DnD。
- 不改变固定块是否可拖拽的产品规则；如需限制，另开卡。

## 7. 完成后

1. 记录同日/跨日/冲突的测试结果和截图/证据。
2. 更新 `README.md` 状态表。
3. 如果 SB-01 改了块模型，复用其字段。
