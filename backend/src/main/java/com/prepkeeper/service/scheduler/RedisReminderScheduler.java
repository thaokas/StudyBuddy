package com.prepkeeper.service.scheduler;

import com.prepkeeper.repository.ReminderRepository;
import com.prepkeeper.service.ReminderService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.Set;

/**
 * Redis ZSET 延迟队列调度器 —— 每 1 秒检查到期提醒并触发。
 *
 * <p>队列结构：Redis Sorted Set，key = "reminder:schedule"
 * <ul>
 *   <li>member = reminderId</li>
 *   <li>score = triggerTime 的 epoch 秒数</li>
 * </ul>
 *
 * <p>生产者：ReminderService（创建 PENDING 提醒时 ZADD）<br>
 * 消费者：本调度器（ZRANGEBYSCORE 拉取到期项 → ZREM → 触发）
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class RedisReminderScheduler {

    private static final String SCHEDULE_KEY = "reminder:schedule";

    private final StringRedisTemplate redis;
    private final ReminderRepository reminderRepository;
    private final ReminderService reminderService;

    /**
     * 每秒轮询 Redis ZSET，拉取 score ≤ 当前秒的到期提醒。
     */
    @Scheduled(fixedRate = 1_000)
    public void pollAndTrigger() {
        long nowSec = Instant.now().getEpochSecond();

        // ZRANGEBYSCORE reminder:schedule 0 <now> LIMIT 0 20
        Set<String> dueIds = redis.opsForZSet()
                .rangeByScore(SCHEDULE_KEY, 0, nowSec, 0, 20);

        if (dueIds == null || dueIds.isEmpty()) return;

        for (String reminderId : dueIds) {
            // 原子移除：ZREM reminder:schedule <reminderId>
            Long removed = redis.opsForZSet().remove(SCHEDULE_KEY, reminderId);
            if (removed == null || removed == 0) {
                // 已被其他实例消费
                continue;
            }

            try {
                reminderService.consumePendingReminder(reminderId);
            } catch (Exception e) {
                log.error("Redis 调度触发提醒失败: reminderId={}, error={}", reminderId, e.getMessage());
                reminderService.retryPendingReminder(reminderId);
            }
        }
    }

    /**
     * 将提醒加入 Redis 延迟队列。
     */
    public void schedule(String reminderId, Instant triggerTime) {
        redis.opsForZSet().add(SCHEDULE_KEY, reminderId, triggerTime.getEpochSecond());
        log.debug("提醒已加入 Redis 队列: reminderId={}, triggerAt={}", reminderId, triggerTime);
    }

    /**
     * 从 Redis 延迟队列中移除提醒（取消时调用）。
     */
    public void cancel(String reminderId) {
        redis.opsForZSet().remove(SCHEDULE_KEY, reminderId);
        log.debug("提醒已移出 Redis 队列: reminderId={}", reminderId);
    }

    /**
     * 获取队列中待处理的提醒数量。
     */
    public long pendingCount() {
        Long size = redis.opsForZSet().zCard(SCHEDULE_KEY);
        return size != null ? size : 0;
    }
}
