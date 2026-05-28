# 小搭 - Spring Boot 后端

## 项目简介

PrepKeeper 后端服务，基于 Spring Boot 3.2 构建，提供用户认证、计划管理、任务管理、打卡记录、定时提醒、WebSocket 实时推送等功能。AI 相关能力通过 HTTP 代理转发至 Python Agent 服务。

## 技术栈

- Java 17
- Spring Boot 3.2
- Spring Data JPA + Hibernate
- Spring Security + JWT
- Spring WebSocket
- PostgreSQL
- Redis（延迟队列与缓存）
- SpringDoc OpenAPI

## 快速开始

### 环境要求

- JDK 17+
- Maven 3.8+
- PostgreSQL 14+
- Redis 6+

### 数据库配置

1. 创建数据库：
```sql
CREATE DATABASE prepkeeper;
```

2. 执行 `sql/schema.sql` 初始化表结构

3. 修改 `src/main/resources/application.yml` 中的数据库和 Redis 连接信息

### 运行项目

```bash
mvn spring-boot:run
```

服务运行在 `http://localhost:8080`，Swagger 文档位于 `/swagger-ui.html`

## 项目结构

```
src/main/java/com/prepkeeper/
├── PrepKeeperApplication.java
├── config/
│   ├── CorsConfig.java
│   ├── OpenApiConfig.java
│   ├── RedisConfig.java
│   ├── SecurityConfig.java
│   └── WebSocketConfig.java
├── controller/
│   ├── AgentProxyController.java    # Agent 服务代理接口
│   ├── AuthController.java          # 认证接口
│   ├── CheckinController.java       # 打卡管理
│   ├── PlanController.java          # 计划管理
│   ├── ReminderController.java      # 提醒管理
│   ├── TaskController.java          # 任务管理
│   └── UserController.java          # 用户管理
├── service/
│   ├── AgentClientService.java      # Agent HTTP 调用封装
│   ├── AuthService.java
│   ├── CheckinService.java
│   ├── PlanService.java
│   ├── ReminderService.java
│   ├── TaskService.java
│   ├── UserService.java
│   └── scheduler/
│       ├── DailyReminderScheduler.java    # 每日预设模式提醒
│       ├── RedisReminderQueue.java        # Redis 延迟队列操作
│       ├── RedisReminderScheduler.java    # Redis ZSET 轮询消费
│       ├── ReminderRecoveryService.java   # 启动时恢复 PENDING 提醒
│       ├── StreakCheckScheduler.java      # 连续打卡检查
│       └── WeeklyReportScheduler.java     # 周报生成
├── repository/
│   ├── CheckinRepository.java
│   ├── EasterEggRepository.java
│   ├── ReminderRepository.java
│   ├── ReminderSettingsRepository.java
│   ├── StudyPlanRepository.java
│   ├── TaskRepository.java
│   └── UserRepository.java
├── entity/
│   ├── Checkin.java
│   ├── EasterEgg.java
│   ├── Reminder.java
│   ├── ReminderSettings.java
│   ├── StudyPlan.java
│   ├── Task.java
│   └── User.java
├── dto/
│   ├── request/
│   │   ├── CheckinRequest.java
│   │   ├── CreateReminderRequest.java
│   │   ├── LoginRequest.java
│   │   ├── PlanCreateRequest.java
│   │   ├── PlanWithTasksRequest.java
│   │   ├── RefreshTokenRequest.java
│   │   ├── RegisterRequest.java
│   │   └── ReminderConfigRequest.java
│   └── response/
│       ├── ApiResponse.java
│       ├── AuthResponse.java
│       ├── CheckinResponse.java
│       ├── EasterEggResponse.java
│       ├── PlanResponse.java
│       ├── ReminderSettingsResponse.java
│       ├── TaskResponse.java
│       └── UserResponse.java
├── security/
│   ├── CustomUserDetailsService.java
│   ├── JwtAuthenticationFilter.java
│   ├── JwtTokenProvider.java
│   └── UserPrincipal.java
├── websocket/
│   ├── AuthHandshakeInterceptor.java   # WebSocket 握手 JWT 鉴权
│   ├── ReminderPushService.java        # 提醒推送逻辑
│   ├── ReminderWebSocketHandler.java   # WebSocket 连接处理
│   └── WebSocketSessionManager.java    # 会话管理 (userId → Sessions)
├── exception/
│   ├── BusinessException.java
│   ├── ErrorCode.java
│   └── GlobalExceptionHandler.java
└── util/
    └── IdGenerator.java
```

## API 接口

所有接口前缀不含 `/api`（由前端 nginx 反向代理处理路径）。

### 认证模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | /auth/register | 用户注册 | 否 |
| POST | /auth/login | 用户登录 | 否 |
| POST | /auth/refresh | 刷新 Token | 否 |
| GET | /auth/me | 获取当前用户信息 | 是 |

### 用户模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | /users/{userId} | 获取用户信息 | 是 |
| PUT | /users/{userId} | 更新用户信息 | 是 |
| GET | /users/{userId}/stats | 获取用户统计数据 | 是 |

### 计划模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | /plans | 创建计划 | 是 |
| GET | /plans/{planId} | 获取计划详情 | 是 |
| GET | /plans/user/{userId} | 获取用户计划列表 | 是 |
| POST | /plans/with-tasks | 创建计划（含任务列表） | 是 |
| PUT | /plans/{planId} | 更新计划 | 是 |
| PUT | /plans/{planId}/mode | 切换监督模式 | 是 |
| DELETE | /plans/{planId} | 删除计划 | 是 |

### 任务模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | /tasks/today | 获取今日任务 | 是 |
| GET | /tasks/plan/{planId} | 获取计划下所有任务 | 是 |
| PUT | /tasks/{taskId}/status | 更新任务状态 | 是 |
| POST | /tasks/{taskId}/complete | 完成单个任务 | 是 |

### 打卡模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | /checkins | 提交打卡 | 是 |
| GET | /checkins/today | 获取今日打卡 | 是 |
| GET | /checkins/history | 获取打卡历史 | 是 |
| GET | /checkins/streak | 获取连续打卡天数 | 是 |

### 提醒模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| GET | /reminders | 获取提醒列表 | 是 |
| GET | /reminders/settings | 获取提醒设置 | 是 |
| PUT | /reminders/config | 配置提醒设置 | 是 |
| GET | /reminders/history | 获取已触发提醒历史 | 是 |
| POST | /reminders/custom | 创建自定义提醒 | 是 |
| DELETE | /reminders/{id} | 取消待触发提醒 | 是 |
| DELETE | /reminders/history/{id} | 删除历史提醒记录 | 是 |
| GET | /reminders/pending | 获取待触发提醒 | 是 |
| GET | /reminders/unread | 获取已触发未读提醒 | 是 |
| PUT | /reminders/{id}/read | 标记提醒已读 | 是 |

### Agent 代理模块

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|------|
| POST | /agent/planner/chat | Planner SSE 对话 | 是 |
| POST | /agent/planner/chat/cancel | 取消 Planner 对话 | 是 |
| POST | /agent/planner/materials/file | 上传备考资料文件 | 是 |
| POST | /agent/planner/materials/link | 解析备考资料链接 | 是 |
| POST | /agent/report/weekly | 生成周报 | 是 |

## 定时任务

| 任务 | 说明 |
|------|------|
| DailyReminderScheduler | 根据用户监督模式（温柔 22:00 / 强化 21:00,22:00 / 唐僧 每30分钟 / 地狱 每15分钟）创建提醒 PENDING 记录 |
| RedisReminderScheduler | 每秒轮询 Redis ZSET 到期提醒，领取后触发生成 AI 文案并 WebSocket 推送 |
| WeeklyReportScheduler | 每周日 22:00 自动生成周报 |
| StreakCheckScheduler | 每天 00:05 检查昨日打卡情况，重置连续天数 |
| ReminderRecoveryService | 服务启动时从 DB 恢复所有 PENDING 提醒到 Redis 延迟队列 |

## WebSocket

提醒通过 WebSocket 实时推送到前端。连接方式：

```
ws://host/ws?token=<JWT_TOKEN>
```

- `AuthHandshakeInterceptor` 在握手阶段验证 JWT Token
- `WebSocketSessionManager` 维护 `Map<userId, Set<WebSocketSession>>`，支持多端登录
- `ReminderPushService` 封装推送逻辑，在事务提交后发送消息
- 推送消息 JSON 格式：`{"type":"reminder","reminderId":"...","content":"...","timestamp":...}`

## 提醒系统架构

```
预设模式 → DailyReminderScheduler (cron)
                ↓ 创建 PENDING 记录
自定义提醒 → ReminderService → DB (reminders) + Redis ZSET (reminder:schedule)
                                      ↓
RedisReminderScheduler (每秒轮询 ZSET)
        ↓ ZREM 原子领取
ReminderService.triggerClaimedReminder()
        ↓ 调用 Agent 生成文案
WebSocket / 浏览器通知 推送
        ↓
REPEATING 类型 → 创建下一条 PENDING 记录
```

## 环境变量

| 变量名 | 说明 | 默认值 |
|--------|------|--------|
| DB_USERNAME | 数据库用户名 | postgres |
| DB_PASSWORD | 数据库密码 | (application.yml 中配置) |
| JWT_SECRET | JWT 密钥 | (application.yml 中配置) |
| AGENT_URL | Agent 服务地址 | http://localhost:8000 |
| REDIS_HOST | Redis 地址 | localhost |
| REDIS_PORT | Redis 端口 | 6379 |
