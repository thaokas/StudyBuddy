# P7：建立 study-bundle，清理启动器与探针

- 前置：P0–P6（G0–G6 全部通过）
- 预计：1 个会话
- 质量门：G7（见 [PLAN.md](../PLAN.md) §7）
- 结果：产品组合从“启动器写绝对路径行”变成“profile 里选 `@studybuddy/bundle`”；`a02-probe` 与旧策略行移除

## 目标

1. 建 `packages/study-bundle`：一个只含 `cordis.patch.yml` 的组合包，集中声明 6 个业务插件、凭据插件、账号/遥测禁用、工作区目录。
2. 启动器 `scripts/project-config.mjs` 不再生成绝对路径插件行；只确保 profile 选中 bundle、首次写入模型配置、复制 Creator skill。
3. 移除产品 profile 中的 `a02-probe`。
4. 验证新数据根与已有数据根都能启动；可选插件仍可单独关闭。

## 开工前读

1. [AGENT.md](../AGENT.md)、[CONTRACTS.md](../CONTRACTS.md) 第 1/8/9 节
2. [ADR](../../../decisions/plugin-split.md) 第 5.2、5.3、6.5 节
3. `scripts/project-config.mjs`、`scripts/start-studybuddy.mjs`
4. `.studybuddy/home/cordis.patch.yml`、`.studybuddy/home/profiles/desktop/package.json`
5. DSH 上游示例：`source/deepseek-harness/packages/bundle/web-app/{package.json,cordis.patch.yml}`、`packages/boot/plugin-manager/README.md`
6. P6 的交付记录

## 所有权

**新建/可改：**

- `packages/study-bundle/**`
- `scripts/project-config.mjs`、`scripts/start-studybuddy.mjs`
- `README.md`（启动/数据路径/插件说明）
- `docs/backup.md`（如果数据根/启动方式描述需要同步）
- `docs/plans/2026-11-11-plugin-split/README.md`、`AGENT.md`、`CONTRACTS.md`、`STATUS.md`
- 测试用临时数据根（`%TEMP%` 或 `.studybuddy/plugin-split-test/`）

**不可改：**

- 6 个业务插件的业务逻辑/文案/schema；
- `platform/windows-credentials` 的实现（只通过 bundle 行引用）；
- `source/deepseek-harness/`、`patches/`；
- 用户已有 profile 的模型配置（除首次 seed 逻辑外）。

## 步骤

1. **备份。** 复制 `.studybuddy/home` 到 `.studybuddy/plugin-split-backup/P7/home`；记录当前 profile 的组合（`dsh --dump-config` 或读取 package.json + patch）。
2. **建 bundle 包。**
   - `packages/study-bundle/package.json`：
     - `name: "@studybuddy/bundle"`、`private: true`、`type: "module"`；
     - `dsh.bundle.patch: "./cordis.patch.yml"`；
     - 依赖声明 6 个业务插件与 `@studybuddy/platform-windows-credentials`（dev 可用 `file:`/`link:`；发行用版本号）；
     - 若 loader 要求入口，提供空 `index.mjs` 并声明 `main`/`exports`。
   - `cordis.patch.yml`：
     - 账号/遥测/内置 `credentials` 的禁用行；
     - `workspace-controller.documentsDirectory`；
     - `project-credentials` 行（包名/路径 + `config.path`）；
     - `study-core`（`config.dataDir`）、`study-facts`、`study-learning`、`study-reminders`、`study-memory`、`study-outcomes` 行；
     - **不插入 `a02-probe`**；
     - 行顺序按依赖：core → facts → learning → reminders → memory → outcomes；凭据行独立。
   - 配置路径优先用环境变量/`DSH_HOME` 推导；如果 patch 支持 `!!js` 表达式（参考 `dsh-web-app`），用它读 `process.env.STUDYBUDDY_*`；不支持就把路径留给插件默认值或启动器设置的环境变量，不要写死本机绝对路径。
3. **开发期解析方式。**
   - 选一种并记录到 CONTRACTS：`link:` 本地包、`--patch` 叠加、或 profile 依赖 `file:`；
   - 验收标准是“启动器不再逐行写插件绝对路径”，不是“完全不使用绝对路径”。
   - 如果 dev 必须用 `--patch` 绝对路径，该 overlay 只存在于开发启动器，不进入 bundle 产品定义。
4. **改启动器。**
   - `prepareProfile`：
     - 确保 profile `dsh.profile.bundles` 含 `@studybuddy/bundle`（保留用户已有顺序/其它 bundle）；
     - 不再写 `home/cordis.patch.yml` 的插件/策略行；如必须保留用户覆盖，写一个空文件或只写注释；
     - 保留首次模型配置（`profiles/desktop/cordis.patch.yml` 的 `llm-pi-ai` / `agent-default-model`）与 Creator skill 复制（P6 之后从 `skills/study-creator` 复制）；
     - `--prepare-only` 打印 profile、bundle 选择、凭据路径，并做可解析性检查。
   - `start-studybuddy.mjs`：数据根、环境变量、凭据导入、桌面启动逻辑保持；删除对 `deploymentPolicy` 的依赖。
5. **已有数据根迁移。**
   - 检测旧 `home/cordis.patch.yml` 里由启动器管理的行（`project-credentials`、`study`、`a02-probe`、账号/遥测禁用）。
   - 先备份，再删除/替换为最小用户覆盖；确保 `study` 旧行不再加载。
   - 如果用户手动改过这些行，不要静默删除；在控制台输出差异并保留备份，要求确认。
6. **测试。**
   - **新数据根**：`STUDYBUDDY_DATA_DIR=<temp>` + `--prepare-only`；检查 profile bundle 列表、patch 内容、无 `a02-probe`、无逐行绝对路径；启动桌面，检查 6 个插件行与 9 个页面。
   - **已有数据根**：复制 `.studybuddy` 到临时目录，跑 prepare，确认旧行被清理/备份、数据仍可读、应用可启动。
   - **可选插件**：在 Plugins 页关闭 memory/learning/outcomes/reminders 各一次，重启，检查降级；再启用。
   - **凭据/模型**：DPAPI 路径正确；模型设置可编辑；不覆盖用户已有模型配置。
   - **导出/备份**：导出 JSON 仍包含所有表；冷备份仍能复制数据根。
7. **文档。**
   - 更新 `README.md`：启动方式、profile/bundle、插件列表、数据路径。
   - 更新 `AGENT.md` 的仓库地图（去掉旧 shell，加入 bundle）。
   - 更新 `CONTRACTS.md` 第 8 节为最终 bundle 内容。
   - `docs/backup.md` 如涉及启动器/数据根描述，同步更新。

## 验收（G7）

- [ ] `@studybuddy/bundle` 可被 profile 解析，6 个业务插件 + 凭据插件加载；
- [ ] 启动器不再逐行写插件绝对路径；`home/cordis.patch.yml` 只剩用户覆盖或为空；
- [ ] `a02-probe` 不在产品 profile；
- [ ] 新数据根与已有数据根都能启动；已有数据根迁移有备份；
- [ ] 可选插件关闭矩阵仍通过；
- [ ] 模型/凭据/工作区/Creator skill 行为不变；
- [ ] 导出/备份仍覆盖所有数据；
- [ ] README/AGENT/CONTRACTS/STATUS 更新。

## 明确不做

- 发行打包、品牌、安装器、更新源、签名（另立计划）；
- 修改 DSH 源码或新增核心补丁；
- 把 bundle 发布到 registry（先本地）；
- 改变模型默认值或用户已有配置。

## 回退

- 停止应用；恢复 `.studybuddy/plugin-split-backup/P7/home` 与 `scripts/*` 备份；删除 `packages/study-bundle`；重启验证。
- 如果 bundle 行有问题但插件本身正常，可以临时用 `--patch` overlay 回到 P6 的 profile 行为，再修 bundle。

## 交付记录

在 STATUS 追加 P7 记录；在本文件末尾写：

```md
## 后续（发行阶段）注意事项
- bundle 的 dev/release 解析方式：
- 已有数据根迁移的实际行为：
- 仍需在发行计划处理的事项：
```
