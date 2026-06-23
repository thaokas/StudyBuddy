-- StudyBuddy Database Schema
-- PostgreSQL

-- 用户表
CREATE TABLE IF NOT EXISTS users (
    user_id VARCHAR(64) PRIMARY KEY,
    nickname VARCHAR(50),
    password VARCHAR(256),
    email VARCHAR(100) UNIQUE,
    avatar_url VARCHAR(500),
    total_checkins INTEGER DEFAULT 0,
    current_streak INTEGER DEFAULT 0,
    max_streak INTEGER DEFAULT 0,
    created_at TIMESTAMP,
    updated_at TIMESTAMP
);

-- 备考计划表
CREATE TABLE IF NOT EXISTS study_plans (
    plan_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    exam_name VARCHAR(100) NOT NULL,
    exam_type VARCHAR(64) NOT NULL,
    exam_date DATE NOT NULL,
    daily_hours DECIMAL(3,1),
    foundation_level INTEGER DEFAULT 1,
    weak_subjects VARCHAR(500),
    current_mode INTEGER DEFAULT 1,          -- 监督模式: 0-静默 1-温柔 2-强化 3-唐僧
    plan_status INTEGER DEFAULT 0,           -- 计划状态: 0-进行中 1-已完成 2-已暂停
    current_phase INTEGER DEFAULT 1,         -- 当前阶段: 1-基础 2-强化 3-冲刺
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    CONSTRAINT fk_study_plans_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
    task_id VARCHAR(64) PRIMARY KEY,
    plan_id VARCHAR(64) NOT NULL,
    task_date DATE NOT NULL,
    subject VARCHAR(50) NOT NULL,
    task_content VARCHAR(500) NOT NULL,
    estimated_minutes INTEGER,
    task_type INTEGER DEFAULT 1,             -- 任务类型: 1-学习 2-复习 3-刷题 4-模考
    phase INTEGER NOT NULL,                  -- 所属阶段: 1-基础 2-强化 3-冲刺
    status INTEGER DEFAULT 0,                -- 状态: 0-未开始 1-进行中 2-已完成 3-已跳过
    completed_at TIMESTAMP,
    checkin_type INTEGER,                    -- 打卡方式: 1-文字 2-图片
    created_at TIMESTAMP,
    CONSTRAINT fk_tasks_plan FOREIGN KEY (plan_id) REFERENCES study_plans(plan_id) ON DELETE CASCADE
);

-- 打卡记录表
CREATE TABLE IF NOT EXISTS checkins (
    checkin_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    plan_id VARCHAR(64) NOT NULL,
    checkin_date DATE NOT NULL,
    completed_tasks INTEGER DEFAULT 0,
    total_tasks INTEGER DEFAULT 0,
    completion_rate DECIMAL(5,2) DEFAULT 0,
    is_makeup INTEGER DEFAULT 0,             -- 是否为补卡: 0-否 1-是
    streak_broken INTEGER DEFAULT 0,         -- 是否中断连续: 0-否 1-是
    created_at TIMESTAMP,
    CONSTRAINT fk_checkins_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_checkins_plan FOREIGN KEY (plan_id) REFERENCES study_plans(plan_id) ON DELETE CASCADE
);

-- 提醒记录表
CREATE TABLE IF NOT EXISTS reminders (
    reminder_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    plan_id VARCHAR(64) NOT NULL,
    reminder_type INTEGER NOT NULL,          -- 提醒类型: 1-每日提醒 2-催更提醒 3-周报提醒
    schedule_type VARCHAR(20) DEFAULT 'MODE', -- 调度类型: MODE/INTERVAL/ABSOLUTE/REPEATING
    trigger_time TIMESTAMP NOT NULL,
    interval_minutes INTEGER,                -- INTERVAL 类型的间隔分钟数
    repeat_daily BOOLEAN DEFAULT false,      -- REPEATING 类型标记
    timezone VARCHAR(50) DEFAULT 'Asia/Shanghai',
    content VARCHAR(1000),
    is_sent INTEGER DEFAULT 0,               -- 是否已发送: 0-否 1-是
    sent_at TIMESTAMP,
    status VARCHAR(20) DEFAULT 'PENDING',    -- PENDING/PROCESSING/TRIGGERED/CANCELLED
    is_read INTEGER DEFAULT 0,               -- 是否已读: 0-未读 1-已读
    task_ids TEXT,                           -- JSON 数组，关联的任务 ID 列表
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    CONSTRAINT fk_reminders_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE,
    CONSTRAINT fk_reminders_plan FOREIGN KEY (plan_id) REFERENCES study_plans(plan_id) ON DELETE CASCADE
);

ALTER TABLE reminders ADD COLUMN IF NOT EXISTS schedule_type VARCHAR(20) DEFAULT 'MODE';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS interval_minutes INTEGER;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS repeat_daily BOOLEAN DEFAULT false;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'Asia/Shanghai';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'PENDING';
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS is_read INTEGER DEFAULT 0;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS task_ids TEXT;
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT NOW();
ALTER TABLE reminders ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();
ALTER TABLE reminders ALTER COLUMN status SET DEFAULT 'PENDING';
UPDATE reminders SET status = 'PENDING' WHERE status IS NULL;
UPDATE reminders SET status = 'PENDING' WHERE is_sent = 0 AND status = 'TRIGGERED';

-- 提醒设置表
CREATE TABLE IF NOT EXISTS reminder_settings (
    user_id VARCHAR(64) PRIMARY KEY,
    mode INTEGER DEFAULT 1,                    -- 监督模式: 0-静默 1-温柔 2-强化 3-唐僧 4-地狱
    custom_times VARCHAR(500),                 -- 自定义提醒时间 JSON数组 ["09:00","14:00","20:00"]
    monking_interval INTEGER DEFAULT 30,       -- 唐僧模式间隔(分钟) 5-120
    hell_interval INTEGER DEFAULT 15,          -- 地狱模式间隔(分钟) 5-60
    is_active BOOLEAN DEFAULT true,            -- 是否启用
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    CONSTRAINT fk_reminder_settings_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

ALTER TABLE reminder_settings ADD COLUMN IF NOT EXISTS hell_interval INTEGER DEFAULT 15;

-- 彩蛋触发记录表
CREATE TABLE IF NOT EXISTS easter_eggs (
    record_id VARCHAR(64) PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    egg_type VARCHAR(50) NOT NULL,           -- 彩蛋类型: late_night/weekend/early_bird/random
    trigger_date DATE NOT NULL,
    content VARCHAR(500),
    is_triggered INTEGER DEFAULT 0,          -- 是否已触发: 0-否 1-是
    CONSTRAINT fk_easter_eggs_user FOREIGN KEY (user_id) REFERENCES users(user_id) ON DELETE CASCADE
);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_study_plans_user ON study_plans(user_id);
CREATE INDEX IF NOT EXISTS idx_tasks_plan ON tasks(plan_id);
CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_checkins_user ON checkins(user_id);
CREATE INDEX IF NOT EXISTS idx_checkins_plan ON checkins(plan_id);
CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(checkin_date);
CREATE INDEX IF NOT EXISTS idx_reminders_user ON reminders(user_id);
CREATE INDEX IF NOT EXISTS idx_reminders_plan ON reminders(plan_id);
CREATE INDEX IF NOT EXISTS idx_easter_eggs_user ON easter_eggs(user_id);
