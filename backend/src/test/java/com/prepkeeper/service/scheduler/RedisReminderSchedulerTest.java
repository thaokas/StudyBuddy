package com.prepkeeper.service.scheduler;

import com.prepkeeper.repository.ReminderRepository;
import com.prepkeeper.service.ReminderService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ZSetOperations;

import java.util.Set;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class RedisReminderSchedulerTest {

    @Mock private StringRedisTemplate redis;
    @Mock private ZSetOperations<String, String> zset;
    @Mock private ReminderRepository reminderRepository;
    @Mock private ReminderService reminderService;

    @Test
    void removedDueWorkIsRetriedWhenConsumptionFails() {
        RedisReminderScheduler scheduler = new RedisReminderScheduler(redis, reminderRepository, reminderService);
        when(redis.opsForZSet()).thenReturn(zset);
        when(zset.rangeByScore(eq("reminder:schedule"), eq(0.0), anyDouble(), eq(0L), eq(20L)))
                .thenReturn(Set.of("R1"));
        when(zset.remove("reminder:schedule", "R1")).thenReturn(1L);
        when(reminderService.consumePendingReminder("R1")).thenThrow(new RuntimeException("agent timeout"));

        scheduler.pollAndTrigger();

        verify(reminderService).retryPendingReminder("R1");
    }
}
