package com.prepkeeper.service.scheduler;

import com.prepkeeper.entity.Reminder;
import com.prepkeeper.repository.ReminderRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.List;

/**
 * 服务启动恢复 —— 将 DB 中 PENDING 提醒重新加载到 Redis ZSET。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class ReminderRecoveryService {

    private final ReminderRepository reminderRepository;
    private final RedisReminderQueue redisQueue;

    @EventListener(ApplicationReadyEvent.class)
    public void recoverPendingReminders() {
        log.info("开始恢复 PENDING 提醒到 Redis...");

        List<Reminder> pending = reminderRepository.findByStatus("PENDING");

        if (pending.isEmpty()) {
            log.info("无待恢复的提醒");
            return;
        }

        int recovered = 0;
        for (Reminder reminder : pending) {
            LocalDateTime trigger = reminder.getTriggerTime();
            if (trigger == null) continue;

            Instant triggerInstant = trigger.atZone(resolveTimezone(reminder.getTimezone())).toInstant();
            redisQueue.schedule(reminder.getReminderId(), triggerInstant);
            recovered++;
        }

        log.info("已恢复 {} 条 PENDING 提醒到 Redis 队列（当前队列总数: {}）",
                recovered, redisQueue.pendingCount());
    }

    private ZoneId resolveTimezone(String timezone) {
        try {
            return ZoneId.of(timezone != null ? timezone : "Asia/Shanghai");
        } catch (Exception e) {
            log.warn("提醒时区无效，按 Asia/Shanghai 恢复队列: timezone={}", timezone);
            return ZoneId.of("Asia/Shanghai");
        }
    }
}
