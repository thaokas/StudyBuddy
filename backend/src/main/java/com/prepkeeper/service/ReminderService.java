package com.prepkeeper.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.prepkeeper.dto.request.CreateReminderRequest;
import com.prepkeeper.dto.request.ReminderConfigRequest;
import com.prepkeeper.dto.response.PlanResponse;
import com.prepkeeper.dto.response.ReminderSettingsResponse;
import com.prepkeeper.entity.Reminder;
import com.prepkeeper.entity.ReminderSettings;
import com.prepkeeper.entity.StudyPlan;
import com.prepkeeper.entity.Task;
import com.prepkeeper.exception.BusinessException;
import com.prepkeeper.exception.ErrorCode;
import com.prepkeeper.repository.ReminderRepository;
import com.prepkeeper.repository.ReminderSettingsRepository;
import com.prepkeeper.repository.StudyPlanRepository;
import com.prepkeeper.repository.TaskRepository;
import com.prepkeeper.util.IdGenerator;
import com.prepkeeper.service.scheduler.RedisReminderQueue;
import com.prepkeeper.websocket.ReminderPushService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

@Slf4j
@Service
@RequiredArgsConstructor
public class ReminderService {

    private final ReminderSettingsRepository settingsRepository;
    private final ReminderRepository reminderRepository;
    private final StudyPlanRepository planRepository;
    private final TaskRepository taskRepository;
    private final AgentClientService agentClient;
    private final ReminderPushService pushService;
    private final RedisReminderQueue redisQueue;
    private final ObjectMapper objectMapper;

    // ──────────────── 设置管理（保留原有逻辑）────────────────

    @Transactional
    public PlanResponse configReminder(String userId, ReminderConfigRequest request) {
        StudyPlan plan = planRepository.findByPlanIdAndUserId(request.getPlanId(), userId)
                .orElseThrow(() -> new BusinessException(ErrorCode.PLAN_NOT_FOUND));

        plan.setCurrentMode(request.getMode());
        planRepository.save(plan);

        ReminderSettings settings = settingsRepository.findById(userId)
                .orElseGet(() -> {
                    ReminderSettings s = new ReminderSettings();
                    s.setUserId(userId);
                    return s;
                });

        settings.setMode(request.getMode());
        if (request.getCustomTimes() != null) {
            settings.setCustomTimes(toJsonString(request.getCustomTimes()));
        }
        if (request.getMonkingInterval() != null) {
            settings.setMonkingInterval(request.getMonkingInterval());
        }
        if (request.getHellInterval() != null) {
            settings.setHellInterval(request.getHellInterval());
        }
        if (request.getIsActive() != null) {
            settings.setIsActive(request.getIsActive());
        }
        settingsRepository.save(settings);

        long totalTasks = taskRepository.countByPlanId(plan.getPlanId());
        long completedTasks = taskRepository.countCompletedByPlanId(plan.getPlanId());

        return toPlanResponse(plan, totalTasks, completedTasks);
    }

    @Transactional(readOnly = true)
    public ReminderSettingsResponse getSettings(String userId) {
        ReminderSettings settings = settingsRepository.findById(userId).orElse(null);

        if (settings == null) {
            return ReminderSettingsResponse.builder()
                    .mode(1)
                    .customTimes(List.of())
                    .monkingInterval(30)
                    .hellInterval(15)
                    .isActive(true)
                    .build();
        }

        return ReminderSettingsResponse.builder()
                .mode(settings.getMode())
                .customTimes(parseJsonToList(settings.getCustomTimes()))
                .monkingInterval(settings.getMonkingInterval())
                .hellInterval(settings.getHellInterval())
                .isActive(settings.getIsActive())
                .build();
    }

    @Transactional(readOnly = true)
    public List<Reminder> getReminderList(String userId) {
        return reminderRepository.findByUserId(userId);
    }

    @Transactional(readOnly = true)
    public List<Reminder> getReminderHistory(String userId) {
        return reminderRepository.findTriggeredHistory(userId);
    }

    // ──────────────── 自定义提醒 CRUD ────────────────

    /**
     * 创建自定义提醒（INTERVAL / ABSOLUTE / REPEATING）。
     */
    @Transactional
    public Reminder createCustomReminder(String userId, CreateReminderRequest request) {
        StudyPlan plan = planRepository.findByPlanIdAndUserId(request.getPlanId(), userId)
                .orElseThrow(() -> new BusinessException(ErrorCode.PLAN_NOT_FOUND));

        Reminder reminder = new Reminder();
        reminder.setReminderId(IdGenerator.generateReminderId());
        reminder.setUserId(userId);
        reminder.setPlanId(request.getPlanId());
        reminder.setReminderType(2); // 催更提醒
        reminder.setScheduleType(request.getScheduleType());
        reminder.setStatus("PENDING");
        reminder.setIsSent(0);
        reminder.setIsRead(0);
        reminder.setTimezone(request.getTimezone() != null ? request.getTimezone() : "Asia/Shanghai");

        if (request.getTaskIds() != null && !request.getTaskIds().isEmpty()) {
            // 验证所有 task 属于该计划
            List<Task> tasks = taskRepository.findByPlanId(request.getPlanId());
            List<String> validIds = tasks.stream().map(Task::getTaskId).toList();
            for (String taskId : request.getTaskIds()) {
                if (!validIds.contains(taskId)) {
                    throw new BusinessException(ErrorCode.PARAM_ERROR);
                }
            }
            reminder.setTaskIds(toJsonString(request.getTaskIds()));
        }

        LocalDateTime now = LocalDateTime.now(resolveTimezone(reminder.getTimezone()));

        switch (request.getScheduleType()) {
            case "INTERVAL" -> {
                reminder.setIntervalMinutes(request.getIntervalMinutes());
                reminder.setTriggerTime(now.plusMinutes(request.getIntervalMinutes()));
            }
            case "ABSOLUTE" -> {
                reminder.setTriggerTime(parseTriggerTimeInTimezone(request.getTriggerTime(), reminder.getTimezone()));
            }
            case "REPEATING" -> {
                reminder.setRepeatDaily(true);
                reminder.setTriggerTime(parseTriggerTimeInTimezone(request.getTriggerTime(), reminder.getTimezone()));
            }
            default -> throw new BusinessException(ErrorCode.PARAM_ERROR);
        }

        reminder = reminderRepository.save(reminder);

        // 加入 Redis 延迟队列
        redisQueue.schedule(reminder.getReminderId(),
                toTriggerInstant(reminder));

        return reminder;
    }

    /**
     * 预设模式创建提醒（由 DailyReminderScheduler 调用），保存并加入 Redis 队列。
     */
    @Transactional
    public Reminder createModeReminder(String userId, String planId, int mode) {
        if (settingsRepository.findById(userId)
                .map(settings -> Boolean.FALSE.equals(settings.getIsActive()))
                .orElse(false)) {
            log.debug("用户已关闭提醒，跳过预设模式创建: userId={}, planId={}", userId, planId);
            return null;
        }

        Reminder reminder = new Reminder();
        reminder.setReminderId(IdGenerator.generateReminderId());
        reminder.setUserId(userId);
        reminder.setPlanId(planId);
        reminder.setReminderType(1);
        reminder.setScheduleType("MODE");
        reminder.setTimezone("Asia/Shanghai");
        reminder.setTriggerTime(LocalDateTime.now(resolveTimezone(reminder.getTimezone())));
        reminder.setStatus("PENDING");
        reminder.setIsSent(0);
        reminder.setIsRead(0);
        reminder = reminderRepository.save(reminder);

        redisQueue.schedule(reminder.getReminderId(), toTriggerInstant(reminder));
        return reminder;
    }

    /**
     * 取消待触发的提醒。
     */
    @Transactional
    public void cancelReminder(String userId, String reminderId) {
        Reminder reminder = reminderRepository.findById(reminderId)
                .orElseThrow(() -> new BusinessException(ErrorCode.TASK_NOT_FOUND));

        if (!reminder.getUserId().equals(userId)) {
            throw new BusinessException(ErrorCode.FORBIDDEN);
        }

        if ("PENDING".equals(reminder.getStatus())) {
            reminderRepository.updateStatus(reminderId, "CANCELLED");
            redisQueue.cancel(reminderId);
            return;
        }

        if ("TRIGGERED".equals(reminder.getStatus())) {
            redisQueue.cancel(reminderId);
            reminderRepository.delete(reminder);
            return;
        }

        throw new BusinessException(ErrorCode.PARAM_ERROR);
    }

    @Transactional(readOnly = true)
    public List<Reminder> getPendingReminders(String userId) {
        return reminderRepository.findByUserIdAndStatus(userId, "PENDING");
    }

    @Transactional(readOnly = true)
    public List<Reminder> getUnreadReminders(String userId) {
        return reminderRepository.findUnreadReminders(userId);
    }

    @Transactional
    public void markAsRead(String userId, String reminderId) {
        Reminder reminder = reminderRepository.findById(reminderId)
                .orElseThrow(() -> new BusinessException(ErrorCode.TASK_NOT_FOUND));

        if (!reminder.getUserId().equals(userId)) {
            throw new BusinessException(ErrorCode.FORBIDDEN);
        }

        if (!"TRIGGERED".equals(reminder.getStatus())) {
            throw new BusinessException(ErrorCode.PARAM_ERROR);
        }

        reminderRepository.markAsRead(reminderId);
    }

    @Transactional
    public void deleteHistoryReminder(String userId, String reminderId) {
        Reminder reminder = reminderRepository.findById(reminderId)
                .orElseThrow(() -> new BusinessException(ErrorCode.TASK_NOT_FOUND));

        if (!reminder.getUserId().equals(userId)) {
            throw new BusinessException(ErrorCode.FORBIDDEN);
        }

        if (!"TRIGGERED".equals(reminder.getStatus())) {
            throw new BusinessException(ErrorCode.PARAM_ERROR);
        }

        redisQueue.cancel(reminderId);
        reminderRepository.delete(reminder);
    }

    // ──────────────── 提醒触发（核心） ────────────────

    /**
     * 原子领取并触发提醒。只有成功从 PENDING 领取到 PROCESSING 的消费者会推送。
     */
    @Transactional
    public boolean consumePendingReminder(String reminderId) {
        if (reminderRepository.claimPending(reminderId) == 0) {
            return false;
        }

        Reminder reminder = reminderRepository.findById(reminderId)
                .orElseThrow(() -> new BusinessException(ErrorCode.TASK_NOT_FOUND));
        triggerClaimedReminder(reminder);
        return true;
    }

    /**
     * Redis 成员已取出但处理失败时，将仍在处理中的记录恢复并延时重试。
     */
    @Transactional
    public void retryPendingReminder(String reminderId) {
        Reminder reminder = reminderRepository.findById(reminderId).orElse(null);
        if (reminder == null || "TRIGGERED".equals(reminder.getStatus())
                || "CANCELLED".equals(reminder.getStatus())) {
            return;
        }
        if ("PROCESSING".equals(reminder.getStatus())) {
            reminderRepository.updateStatus(reminderId, "PENDING");
        }
        redisQueue.schedule(reminderId, Instant.now().plusSeconds(5));
    }

    /**
     * 统一触发逻辑 —— 查询提醒范围内任务，生成文案并推送 WebSocket。
     */
    private void triggerClaimedReminder(Reminder reminder) {
        String userId = reminder.getUserId();
        String planId = reminder.getPlanId();

        StudyPlan plan = planRepository.findById(planId).orElse(null);
        if (plan == null) {
            log.warn("触发提醒时计划不存在: planId={}", planId);
            reminderRepository.updateStatus(reminder.getReminderId(), "CANCELLED");
            return;
        }

        if ("MODE".equals(reminder.getScheduleType()) && Integer.valueOf(0).equals(plan.getCurrentMode())) {
            reminder.setStatus("CANCELLED");
            reminderRepository.save(reminder);
            return;
        }

        LocalDate today = LocalDate.now(resolveTimezone(reminder.getTimezone()));

        // Explicit task selections remain the reminder scope even after the calendar day changes.
        List<String> taskIds = parseJsonToStringList(reminder.getTaskIds());
        List<Task> scopeCandidates = taskIds.isEmpty()
                ? taskRepository.findTodayTasks(planId, today)
                : taskRepository.findByPlanId(planId);
        List<Task> scopedTasks = scopeCandidates.stream()
                .filter(t -> !Integer.valueOf(3).equals(t.getStatus()))
                .filter(t -> taskIds.isEmpty() || taskIds.contains(t.getTaskId()))
                .toList();
        List<Task> targetIncomplete = scopedTasks.stream()
                .filter(t -> !Integer.valueOf(2).equals(t.getStatus()))
                .toList();

        // 生成提醒内容
        String content = generateReminderContent(reminder, plan, scopedTasks, targetIncomplete);

        // 更新提醒记录
        reminder.setContent(content);
        reminder.setIsSent(1);
        reminder.setSentAt(LocalDateTime.now(resolveTimezone(reminder.getTimezone())));
        reminder.setStatus("TRIGGERED");
        reminder.setIsRead(0);
        reminderRepository.save(reminder);

        // REPEATING 类型：成功触发后总是创建下一条 PENDING 记录。
        if ("REPEATING".equals(reminder.getScheduleType()) && Boolean.TRUE.equals(reminder.getRepeatDaily())) {
            createNextRepeatingReminder(reminder);
        }

        // WebSocket 推送
        List<Task> displayTasks = targetIncomplete.isEmpty() ? scopedTasks : targetIncomplete;
        List<String> taskNames = displayTasks.stream()
                .map(t -> t.getSubject() + " - " + t.getTaskContent())
                .limit(5)
                .toList();
        pushReminderAfterCommit(userId, reminder.getReminderId(), content, taskNames);
    }

    // ──────────────── 内部辅助 ────────────────

    /**
     * 生成提醒文案 —— 优先用 AI，失败回退到模板。
     */
    private String generateReminderContent(Reminder reminder, StudyPlan plan, List<Task> scopedTasks,
                                           List<Task> targetIncomplete) {
        // 尝试 AI 生成
        try {
            List<Map<String, Object>> todayTotalTasks = toTaskMaps(scopedTasks);
            List<Map<String, Object>> todayIncompleteTasks = toTaskMaps(targetIncomplete);

            List<Task> allTasks = taskRepository.findByPlanId(plan.getPlanId()).stream()
                    .filter(t -> !Integer.valueOf(3).equals(t.getStatus()))
                    .toList();
            List<Map<String, Object>> examTotalTasks = toTaskMaps(allTasks);
            List<Map<String, Object>> examCompletedTasks = allTasks.stream()
                    .filter(t -> t.getStatus() == 2)
                    .map(this::toTaskMap)
                    .toList();

            long totalStudyDays = ChronoUnit.DAYS.between(plan.getCreatedAt().toLocalDate(), plan.getExamDate());
            if (totalStudyDays < 1) totalStudyDays = 1;
            long elapsedStudyDays = ChronoUnit.DAYS.between(plan.getCreatedAt().toLocalDate(),
                    LocalDate.now(resolveTimezone(reminder.getTimezone())));
            if (elapsedStudyDays < 0) elapsedStudyDays = 0;

            int mode = plan.getCurrentMode() != null ? plan.getCurrentMode() : 1;
            if (!"MODE".equals(reminder.getScheduleType()) && mode == 0) {
                mode = 1;
            }
            String strictnessMode = AgentClientService.modeToStrictness(mode);

            Map<String, Object> agentResponse = agentClient.generateReminder(
                    todayTotalTasks, todayIncompleteTasks,
                    examTotalTasks, examCompletedTasks,
                    elapsedStudyDays, totalStudyDays,
                    strictnessMode);

            if (agentResponse != null && agentResponse.get("content") instanceof String content
                    && !content.isBlank()) {
                return withSelectedTaskContext(reminder, scopedTasks, content.trim());
            }
        } catch (Exception e) {
            log.warn("AI 生成提醒失败，使用模板: {}", e.getMessage());
        }

        // 模板回退
        List<Task> displayTasks = targetIncomplete.isEmpty() ? scopedTasks : targetIncomplete;
        String names = displayTasks.stream()
                .limit(3)
                .map(t -> t.getSubject() + " - " + t.getTaskContent())
                .collect(Collectors.joining("、"));
        if (targetIncomplete.isEmpty()) {
            return names.isEmpty()
                    ? "当前没有需要督促的未完成任务，保持节奏！"
                    : String.format("你选择的任务已完成：%s。做得很好，继续保持！", names);
        }
        return String.format("还有 %d 个任务未完成：%s。加油，坚持就是胜利！",
                targetIncomplete.size(), names);
    }

    private String withSelectedTaskContext(Reminder reminder, List<Task> scopedTasks, String content) {
        if ("MODE".equals(reminder.getScheduleType()) || parseJsonToStringList(reminder.getTaskIds()).isEmpty()
                || scopedTasks.isEmpty()) {
            return content;
        }
        String names = scopedTasks.stream()
                .limit(5)
                .map(t -> t.getSubject() + " - " + t.getTaskContent())
                .collect(Collectors.joining("、"));
        return String.format("关联任务：%s%n%s", names, content);
    }

    private void pushReminderAfterCommit(String userId, String reminderId, String content, List<String> taskNames) {
        Runnable push = () -> pushService.pushReminder(userId, reminderId, content, taskNames);
        if (TransactionSynchronizationManager.isSynchronizationActive()) {
            TransactionSynchronizationManager.registerSynchronization(new TransactionSynchronization() {
                @Override
                public void afterCommit() {
                    push.run();
                }
            });
            return;
        }
        push.run();
    }

    /**
     * 为 REPEATING 类型的提醒创建下一条 PENDING 记录。
     */
    private void createNextRepeatingReminder(Reminder triggered) {
        Reminder next = new Reminder();
        next.setReminderId(IdGenerator.generateReminderId());
        next.setUserId(triggered.getUserId());
        next.setPlanId(triggered.getPlanId());
        next.setReminderType(triggered.getReminderType());
        next.setScheduleType("REPEATING");
        next.setRepeatDaily(true);
        next.setTaskIds(triggered.getTaskIds());
        next.setTimezone(triggered.getTimezone());
        next.setStatus("PENDING");
        next.setIsSent(0);
        next.setIsRead(0);
        next.setTriggerTime(triggered.getTriggerTime().plusDays(1));
        next = reminderRepository.save(next);

        redisQueue.schedule(next.getReminderId(),
                toTriggerInstant(next));
        log.info("已创建下一条 REPEATING 提醒: reminderId={}, triggerTime={}", next.getReminderId(), next.getTriggerTime());
    }

    private LocalDateTime parseTriggerTimeInTimezone(String triggerTime, String timezone) {
        try {
            return LocalDateTime.ofInstant(Instant.parse(triggerTime), resolveTimezone(timezone));
        } catch (DateTimeParseException e) {
            throw new BusinessException(ErrorCode.PARAM_ERROR, "触发时间必须为 UTC ISO 时间");
        }
    }

    private Instant toTriggerInstant(Reminder reminder) {
        return reminder.getTriggerTime().atZone(resolveTimezone(reminder.getTimezone())).toInstant();
    }

    private ZoneId resolveTimezone(String timezone) {
        try {
            return ZoneId.of(timezone != null ? timezone : "Asia/Shanghai");
        } catch (Exception e) {
            throw new BusinessException(ErrorCode.PARAM_ERROR, "无效时区");
        }
    }

    private Map<String, Object> toTaskMap(Task task) {
        Map<String, Object> map = new HashMap<>();
        map.put("id", task.getTaskId());
        map.put("subject", task.getSubject());
        map.put("name", task.getTaskContent());
        map.put("estimated_minutes", task.getEstimatedMinutes());
        map.put("task_date", task.getTaskDate() != null ? task.getTaskDate().toString() : null);
        return map;
    }

    private List<Map<String, Object>> toTaskMaps(List<Task> tasks) {
        return tasks.stream().map(this::toTaskMap).toList();
    }

    private PlanResponse toPlanResponse(StudyPlan plan, long totalTasks, long completedTasks) {
        double completionRate = totalTasks > 0 ? (double) completedTasks / totalTasks * 100 : 0;

        return PlanResponse.builder()
                .planId(plan.getPlanId())
                .userId(plan.getUserId())
                .examName(plan.getExamName())
                .examType(plan.getExamType())
                .examDate(plan.getExamDate())
                .dailyHours(plan.getDailyHours())
                .foundationLevel(plan.getFoundationLevel())
                .currentMode(plan.getCurrentMode())
                .planStatus(plan.getPlanStatus())
                .currentPhase(plan.getCurrentPhase())
                .createdAt(plan.getCreatedAt())
                .totalTasks(totalTasks)
                .completedTasks(completedTasks)
                .completionRate(completionRate)
                .build();
    }

    private String toJsonString(Object obj) {
        if (obj == null) return null;
        try {
            return objectMapper.writeValueAsString(obj);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private List<String> parseJsonToList(String json) {
        if (json == null || json.isEmpty()) return new ArrayList<>();
        try {
            return objectMapper.readValue(json, List.class);
        } catch (JsonProcessingException e) {
            return new ArrayList<>();
        }
    }

    private List<String> parseJsonToStringList(String json) {
        if (json == null || json.isEmpty()) return new ArrayList<>();
        try {
            return objectMapper.readValue(json, new TypeReference<List<String>>() {});
        } catch (JsonProcessingException e) {
            return new ArrayList<>();
        }
    }
}
