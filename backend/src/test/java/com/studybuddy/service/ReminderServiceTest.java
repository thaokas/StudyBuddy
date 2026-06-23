package com.studybuddy.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.studybuddy.dto.request.CreateReminderRequest;
import com.studybuddy.entity.Reminder;
import com.studybuddy.entity.ReminderSettings;
import com.studybuddy.entity.StudyPlan;
import com.studybuddy.entity.Task;
import com.studybuddy.exception.BusinessException;
import com.studybuddy.repository.ReminderRepository;
import com.studybuddy.repository.ReminderSettingsRepository;
import com.studybuddy.repository.StudyPlanRepository;
import com.studybuddy.repository.TaskRepository;
import com.studybuddy.service.scheduler.RedisReminderQueue;
import com.studybuddy.websocket.ReminderPushService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.transaction.support.TransactionSynchronization;
import org.springframework.transaction.support.TransactionSynchronizationManager;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class ReminderServiceTest {

    @Mock private ReminderSettingsRepository settingsRepository;
    @Mock private ReminderRepository reminderRepository;
    @Mock private StudyPlanRepository planRepository;
    @Mock private TaskRepository taskRepository;
    @Mock private AgentClientService agentClient;
    @Mock private ReminderPushService pushService;
    @Mock private RedisReminderQueue redisQueue;

    private ReminderService service;

    @BeforeEach
    void setUp() {
        service = new ReminderService(settingsRepository, reminderRepository, planRepository,
                taskRepository, agentClient, pushService, redisQueue, new ObjectMapper());
    }

    @Test
    void customReminderUsesOnlySelectedActiveTasksForGeneratedContent() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", "[\"T1\"]");
        StudyPlan plan = plan(0);
        Task selected = task("T1", "数学", "专项练习", 0);
        selected.setTaskDate(LocalDate.now().minusDays(1));
        Task unrelated = task("T2", "英语", "阅读训练", 0);
        Task skipped = task("T3", "政治", "选择题", 3);
        givenClaimedReminder(reminder, plan, List.of(selected, unrelated, skipped));
        when(agentClient.generateReminder(anyList(), anyList(), anyList(), anyList(), anyDouble(), anyDouble(), anyString()))
                .thenReturn(Map.of("content", "该开始学习了"));

        assertTrue(service.consumePendingReminder("R1"));

        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Map<String, Object>>> totalCaptor = ArgumentCaptor.forClass(List.class);
        @SuppressWarnings("unchecked")
        ArgumentCaptor<List<Map<String, Object>>> incompleteCaptor = ArgumentCaptor.forClass(List.class);
        verify(agentClient).generateReminder(totalCaptor.capture(), incompleteCaptor.capture(),
                anyList(), anyList(), anyDouble(), anyDouble(), eq("gentle"));
        assertEquals(List.of("T1"), totalCaptor.getValue().stream().map(m -> (String) m.get("id")).toList());
        assertEquals(List.of("T1"), incompleteCaptor.getValue().stream().map(m -> (String) m.get("id")).toList());
        assertTrue(reminder.getContent().contains("数学 - 专项练习"));
        assertTrue(reminder.getContent().contains("该开始学习了"));
        assertFalse(reminder.getContent().contains("英语"));
        assertEquals("TRIGGERED", reminder.getStatus());
        verify(taskRepository, never()).findTodayTasks(eq("P1"), any(LocalDate.class));
    }

    @Test
    void customReminderFallsBackToNonBlankContentWhenAgentReturnsBlank() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", "[\"T1\"]");
        StudyPlan plan = plan(0);
        givenClaimedReminder(reminder, plan, List.of(task("T1", "数学", "专项练习", 0)));
        when(agentClient.generateReminder(anyList(), anyList(), anyList(), anyList(), anyDouble(), anyDouble(), anyString()))
                .thenReturn(Map.of("content", "   "));

        assertTrue(service.consumePendingReminder("R1"));

        assertNotNull(reminder.getContent());
        assertFalse(reminder.getContent().isBlank());
        assertTrue(reminder.getContent().contains("数学"));
        verify(agentClient).generateReminder(anyList(), anyList(), anyList(), anyList(), anyDouble(), anyDouble(), eq("gentle"));
    }

    @Test
    void customReminderGeneratesCompletionContentInsteadOfEmptyTriggeredHistory() {
        Reminder reminder = pendingCustom("R1", "ABSOLUTE", "[\"T1\"]");
        givenClaimedReminder(reminder, plan(1), List.of(task("T1", "数学", "专项练习", 2)));
        when(agentClient.generateReminder(anyList(), anyList(), anyList(), anyList(), anyDouble(), anyDouble(), anyString()))
                .thenReturn(Map.of("content", "今天选择的任务已经完成，做得很好！"));

        assertTrue(service.consumePendingReminder("R1"));

        assertTrue(reminder.getContent().contains("关联任务：数学 - 专项练习"));
        assertTrue(reminder.getContent().contains("今天选择的任务已经完成，做得很好！"));
        assertEquals(1, reminder.getIsSent());
    }

    @Test
    void historyDelegatesToTriggeredContentQueryOnly() {
        when(reminderRepository.findTriggeredHistory("U1")).thenReturn(List.of());

        assertTrue(service.getReminderHistory("U1").isEmpty());

        verify(reminderRepository).findTriggeredHistory("U1");
        verify(reminderRepository, never()).findByUserIdOrderByTriggerTimeDesc(anyString());
    }

    @Test
    void pendingReminderCannotBeMarkedReadBeforeItTriggers() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", null);
        when(reminderRepository.findById("R1")).thenReturn(Optional.of(reminder));

        assertThrows(BusinessException.class, () -> service.markAsRead("U1", "R1"));

        verify(reminderRepository, never()).markAsRead(anyString());
    }

    @Test
    void triggeredHistoryReminderCanBeDeletedByOwner() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", null);
        reminder.setStatus("TRIGGERED");
        reminder.setIsSent(1);
        reminder.setContent("已触发提醒");
        when(reminderRepository.findById("R1")).thenReturn(Optional.of(reminder));

        service.deleteHistoryReminder("U1", "R1");

        verify(reminderRepository).delete(reminder);
    }

    @Test
    void triggeredReminderCanBeDeletedThroughCancelEndpointFallback() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", null);
        reminder.setStatus("TRIGGERED");
        reminder.setIsSent(1);
        reminder.setContent("宸茶Е鍙戞彁閱?");
        when(reminderRepository.findById("R1")).thenReturn(Optional.of(reminder));

        assertDoesNotThrow(() -> service.cancelReminder("U1", "R1"));

        verify(redisQueue).cancel("R1");
        verify(reminderRepository).delete(reminder);
        verify(reminderRepository, never()).updateStatus(anyString(), anyString());
    }

    @Test
    void pendingReminderCannotBeDeletedAsHistory() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", null);
        when(reminderRepository.findById("R1")).thenReturn(Optional.of(reminder));

        assertThrows(BusinessException.class, () -> service.deleteHistoryReminder("U1", "R1"));

        verify(reminderRepository, never()).delete(any(Reminder.class));
    }

    @Test
    void repeatingReminderStoresTheUsersWallClockTimeAndQueuesTheUtcInstant() {
        CreateReminderRequest request = new CreateReminderRequest();
        request.setPlanId("P1");
        request.setScheduleType("REPEATING");
        request.setTriggerTime("2026-05-28T01:30:00Z");
        request.setTimezone("Asia/Shanghai");

        when(planRepository.findByPlanIdAndUserId("P1", "U1")).thenReturn(Optional.of(plan(1)));
        when(reminderRepository.save(any(Reminder.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Reminder reminder = service.createCustomReminder("U1", request);

        assertEquals(LocalDateTime.of(2026, 5, 28, 9, 30), reminder.getTriggerTime());
        verify(redisQueue).schedule(eq(reminder.getReminderId()), eq(Instant.parse("2026-05-28T01:30:00Z")));
    }

    @Test
    void triggerPushesOnlyAfterTheDatabaseTransactionCommits() {
        Reminder reminder = pendingCustom("R1", "INTERVAL", null);
        givenClaimedReminder(reminder, plan(1), List.of(task("T1", "数学", "专项练习", 0)));
        when(agentClient.generateReminder(anyList(), anyList(), anyList(), anyList(), anyDouble(), anyDouble(), anyString()))
                .thenReturn(Map.of("content", "开始学习"));

        TransactionSynchronizationManager.initSynchronization();
        try {
            assertTrue(service.consumePendingReminder("R1"));
            verify(pushService, never()).pushReminder(anyString(), anyString(), anyString(), anyList());

            TransactionSynchronizationManager.getSynchronizations()
                    .forEach(TransactionSynchronization::afterCommit);

            verify(pushService).pushReminder(eq("U1"), eq("R1"), eq("开始学习"), anyList());
        } finally {
            TransactionSynchronizationManager.clearSynchronization();
        }
    }

    @Test
    void inactiveReminderSettingsSuppressPresetModeReminders() {
        ReminderSettings settings = new ReminderSettings();
        settings.setUserId("U1");
        settings.setIsActive(false);
        when(settingsRepository.findById("U1")).thenReturn(Optional.of(settings));

        assertNull(service.createModeReminder("U1", "P1", 1));

        verify(reminderRepository, never()).save(any(Reminder.class));
        verifyNoInteractions(redisQueue);
    }

    private void givenClaimedReminder(Reminder reminder, StudyPlan plan, List<Task> todayTasks) {
        when(reminderRepository.claimPending(reminder.getReminderId())).thenReturn(1);
        when(reminderRepository.findById(reminder.getReminderId())).thenReturn(Optional.of(reminder));
        when(planRepository.findById("P1")).thenReturn(Optional.of(plan));
        lenient().when(taskRepository.findTodayTasks(eq("P1"), any(LocalDate.class))).thenReturn(todayTasks);
        when(taskRepository.findByPlanId("P1")).thenReturn(todayTasks);
    }

    private Reminder pendingCustom(String id, String scheduleType, String taskIds) {
        Reminder reminder = new Reminder();
        reminder.setReminderId(id);
        reminder.setUserId("U1");
        reminder.setPlanId("P1");
        reminder.setReminderType(2);
        reminder.setScheduleType(scheduleType);
        reminder.setTaskIds(taskIds);
        reminder.setStatus("PENDING");
        reminder.setIsSent(0);
        reminder.setIsRead(0);
        reminder.setTriggerTime(LocalDateTime.now());
        return reminder;
    }

    private StudyPlan plan(int mode) {
        StudyPlan plan = new StudyPlan();
        plan.setPlanId("P1");
        plan.setCurrentMode(mode);
        plan.setCreatedAt(LocalDateTime.now().minusDays(5));
        plan.setExamDate(LocalDate.now().plusDays(30));
        return plan;
    }

    private Task task(String id, String subject, String content, int status) {
        Task task = new Task();
        task.setTaskId(id);
        task.setPlanId("P1");
        task.setTaskDate(LocalDate.now());
        task.setSubject(subject);
        task.setTaskContent(content);
        task.setStatus(status);
        return task;
    }
}
