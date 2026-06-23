package com.studybuddy.entity;

import jakarta.persistence.*;
import lombok.Data;
import java.time.LocalDateTime;

@Data
@Entity
@Table(name = "reminders")
public class Reminder {

    @Id
    @Column(name = "reminder_id", length = 64)
    private String reminderId;

    @Column(name = "user_id", length = 64, nullable = false)
    private String userId;

    @Column(name = "plan_id", length = 64, nullable = false)
    private String planId;

    /**
     * 提醒类型: 1-每日提醒 2-催更提醒 3-周报提醒
     */
    @Column(name = "reminder_type", nullable = false)
    private Integer reminderType;

    /**
     * 调度类型: MODE/INTERVAL/ABSOLUTE/REPEATING
     */
    @Column(name = "schedule_type", length = 20)
    private String scheduleType = "MODE";

    @Column(name = "trigger_time", nullable = false)
    private LocalDateTime triggerTime;

    /**
     * INTERVAL 类型的间隔分钟数
     */
    @Column(name = "interval_minutes")
    private Integer intervalMinutes;

    /**
     * REPEATING 类型标记
     */
    @Column(name = "repeat_daily")
    private Boolean repeatDaily = false;

    @Column(name = "timezone", length = 50)
    private String timezone = "Asia/Shanghai";

    @Column(name = "content", length = 1000)
    private String content;

    /**
     * 是否已发送: 0-否 1-是
     */
    @Column(name = "is_sent")
    private Integer isSent = 0;

    @Column(name = "sent_at")
    private LocalDateTime sentAt;

    /**
     * 状态: PENDING/PROCESSING/TRIGGERED/CANCELLED
     */
    @Column(name = "status", length = 20)
    private String status = "PENDING";

    /**
     * 是否已读: 0-未读 1-已读
     */
    @Column(name = "is_read")
    private Integer isRead = 0;

    /**
     * JSON 数组，关联的任务 ID 列表
     */
    @Column(name = "task_ids", columnDefinition = "TEXT")
    private String taskIds;

    @Column(name = "created_at")
    private LocalDateTime createdAt;

    @Column(name = "updated_at")
    private LocalDateTime updatedAt;

    @PrePersist
    protected void onCreate() {
        LocalDateTime now = LocalDateTime.now();
        if (createdAt == null) {
            createdAt = now;
        }
        if (updatedAt == null) {
            updatedAt = now;
        }
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }
}
