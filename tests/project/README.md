# 工程测试

分两层，用途不同，不要混在一起跑。

## 第一层：单元/工程测试（无需启动应用）

```powershell
node --test tests/project/config.test.mjs tests/project/credentials.test.mjs tests/project/import-errors.test.mjs
```

期望：`pass 5 / fail 0`。覆盖部署配置、DPAPI 凭据读写与并发、导入凭据的错误处理。

## 第二层：桌面冒烟（必须先启动应用）

```powershell
# 终端 A：启动，等到日志出现 "dsh web: http://..." 后再等 3 秒
node scripts/start-studybuddy.mjs

# 终端 B：执行
node tests/project/desktop.test.mjs
```

前置：首次启动已把 API Key 写入 `.studybuddy/home/credentials.dpapi`，否则凭据检查项会失败。只等 DevTools 端口还不够——Host 未就绪时 `session/modelCatalog` 会返回 503。

期望：输出 `"passed": true`，报告落在 `.studybuddy/test-results/desktop.json`。检查项：没有原生登录窗口、自定义模型目录与默认模型、账号 RPC 不可用、DPAPI 凭据可读、原生模型设置可增删改且不破坏原配置。

加 `--real` 会真实调用一次模型（需要 Key 与授权），默认不要加。

## 注意

- `node --test tests/project` 会把桌面冒烟也算进去；应用没启动时会因连接被拒而失败。这是预期行为，不是回归失败。
- `desktop.test.mjs` 直接读 `.studybuddy/launch.json` 的调试端口，所以必须用 `scripts/start-studybuddy.mjs` 启动，不能用其他 profile。
- 测试会临时增删一个合成 provider，结束时会清理；不会改动学生的真实模型配置。
- 旧 `probes/A02/verify.mjs` 断言"上游工作树干净"，在有 `patches/0001` 之后不再适用，仅作历史证据；新的基线校验由后续任务在 `tests/project` 中按"只允许预期改动"实现。
