package com.prepkeeper.service.scheduler;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;

import java.time.Instant;

@Slf4j
@Component
@RequiredArgsConstructor
public class RedisReminderQueue {

    private static final String SCHEDULE_KEY = "reminder:schedule";

    private final StringRedisTemplate redis;

    public void schedule(String reminderId, Instant triggerTime) {
        redis.opsForZSet().add(SCHEDULE_KEY, reminderId, triggerTime.getEpochSecond());
        log.debug("Reminder scheduled in Redis: reminderId={}, triggerAt={}", reminderId, triggerTime);
    }

    public void cancel(String reminderId) {
        redis.opsForZSet().remove(SCHEDULE_KEY, reminderId);
        log.debug("Reminder removed from Redis: reminderId={}", reminderId);
    }

    public long pendingCount() {
        Long size = redis.opsForZSet().zCard(SCHEDULE_KEY);
        return size != null ? size : 0;
    }
}
