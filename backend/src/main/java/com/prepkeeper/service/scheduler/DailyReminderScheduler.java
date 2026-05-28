package com.prepkeeper.service.scheduler;

import com.prepkeeper.entity.StudyPlan;
import com.prepkeeper.repository.StudyPlanRepository;
import com.prepkeeper.service.ReminderService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;

/**
 * 每日提醒定时任务 —— 按预设模式创建 PENDING 状态提醒记录并加入 Redis 延迟队列。
 * 实际触发和推送由 RedisReminderScheduler 统一处理。
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class DailyReminderScheduler {

    private final StudyPlanRepository planRepository;
    private final ReminderService reminderService;

    @Scheduled(cron = "0 0 22 * * ?")
    public void gentleReminder() {
        log.info("开始创建温柔模式提醒...");
        createModeReminders(1);
    }

    @Scheduled(cron = "0 0 21,22 * * ?")
    public void enhancedReminder() {
        log.info("开始创建强化模式提醒...");
        createModeReminders(2);
    }

    @Scheduled(cron = "0 0/30 21-23 * * ?")
    public void monkReminder() {
        log.info("开始创建唐僧模式提醒...");
        createModeReminders(3);
    }

    @Scheduled(cron = "0 0/15 20-23 * * ?")
    public void hellReminder() {
        log.info("开始创建地狱模式提醒...");
        createModeReminders(4);
    }

    private void createModeReminders(int mode) {
        List<StudyPlan> plans = planRepository.findAllActivePlansWithReminder().stream()
                .filter(p -> p.getCurrentMode() == mode)
                .toList();

        if (plans.isEmpty()) {
            log.debug("模式 {} 无活跃计划", mode);
            return;
        }

        for (StudyPlan plan : plans) {
            try {
                reminderService.createModeReminder(plan.getUserId(), plan.getPlanId(), mode);
            } catch (Exception e) {
                log.error("创建模式提醒失败: userId={}, planId={}, error={}",
                        plan.getUserId(), plan.getPlanId(), e.getMessage());
            }
        }

        log.info("模式 {} 创建了 {} 条 PENDING 提醒", mode, plans.size());
    }
}