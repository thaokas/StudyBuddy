package com.prepkeeper.controller;

import com.prepkeeper.dto.response.ApiResponse;
import com.prepkeeper.entity.Task;
import com.prepkeeper.repository.TaskRepository;
import com.prepkeeper.security.UserPrincipal;
import com.prepkeeper.service.AgentClientService;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

import java.io.IOException;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@Slf4j
@Tag(name = "Agent代理接口", description = "与AI Agent服务交互")
@RestController
@RequestMapping("/agent")
@RequiredArgsConstructor
public class AgentProxyController {

    private final AgentClientService agentClient;
    private final TaskRepository taskRepository;

    @Operation(summary = "计划生成SSE流式接口")
    @PostMapping(value = "/planner/chat", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter plannerChat(
            @RequestBody Map<String, Object> request,
            @AuthenticationPrincipal UserPrincipal principal) {

        String userId = principal.getUserId();
        String message = (String) request.get("message");
        String threadId = (String) request.get("thread_id");

        @SuppressWarnings("unchecked")
        Map<String, Object> state = (Map<String, Object>) request.get("state");

        SseEmitter emitter = new SseEmitter(300000L); // 5 min timeout

        agentClient.plannerChatStream(userId, message, threadId, state,
                event -> {
                    try {
                        emitter.send(SseEmitter.event()
                                .name(event.event())
                                .data(event.data(), MediaType.APPLICATION_JSON));
                    } catch (IOException e) {
                        log.error("SSE send error for user {}: {}", userId, e.getMessage());
                        emitter.completeWithError(e);
                    }
                },
                error -> {
                    log.error("Planner chat error for user {}: {}", userId, error.getMessage());
                    try {
                        emitter.send(SseEmitter.event()
                                .name("error")
                                .data(Map.of("message", error.getMessage())));
                        emitter.send(SseEmitter.event()
                                .name("done")
                                .data(Map.of()));
                    } catch (IOException ex) {
                        // ignore
                    }
                    emitter.complete();
                },
                () -> {
                    try {
                        emitter.send(SseEmitter.event()
                                .name("done")
                                .data(Map.of()));
                    } catch (IOException e) {
                        // ignore
                    }
                    emitter.complete();
                });

        emitter.onTimeout(() -> {
            log.warn("SSE timeout for user {}", userId);
            agentClient.cancelPlannerChat(threadId);
        });

        emitter.onError(throwable -> {
            log.error("SSE error for user {}: {}", userId, throwable.getMessage());
            agentClient.cancelPlannerChat(threadId);
        });

        return emitter;
    }

    @Operation(summary = "取消计划生成")
    @PostMapping("/planner/chat/cancel")
    public ResponseEntity<Map<String, Object>> cancelPlannerChat(
            @RequestBody Map<String, Object> request,
            @AuthenticationPrincipal UserPrincipal principal) {
        String threadId = (String) request.get("thread_id");
        agentClient.cancelPlannerChat(threadId);
        return ResponseEntity.ok(Map.of("status", "cancelled"));
    }

    @Operation(summary = "解析计划生成附件资料")
    @PostMapping(value = "/planner/materials/file", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, Object>> parsePlannerFile(
            @RequestPart("file") MultipartFile file,
            @AuthenticationPrincipal UserPrincipal principal) {
        Map<String, Object> response = agentClient.parsePlannerFile(file);
        return ResponseEntity.ok(response);
    }

    @Operation(summary = "解析计划生成网页资料")
    @PostMapping("/planner/materials/link")
    public ResponseEntity<Map<String, Object>> parsePlannerLink(
            @RequestBody Map<String, String> request,
            @AuthenticationPrincipal UserPrincipal principal) {
        Map<String, Object> response = agentClient.parsePlannerLink(request.get("url"));
        return ResponseEntity.ok(response);
    }

    @Operation(summary = "生成周报代理")
    @PostMapping("/report/weekly")
    public ResponseEntity<ApiResponse<Map<String, Object>>> generateWeeklyReport(
            @RequestBody Map<String, Object> request,
            @AuthenticationPrincipal UserPrincipal principal) {

        String weekStart = (String) request.get("weekStart");
        String weekEnd = (String) request.get("weekEnd");
        String userId = principal.getUserId();

        LocalDate startDate = LocalDate.parse(weekStart);
        LocalDate endDate = weekEnd != null ? LocalDate.parse(weekEnd) : startDate.plusDays(6);

        List<Task> weekTasks = taskRepository.findByUserIdAndTaskDateBetween(userId, startDate, endDate);

        List<Map<String, Object>> totalPlan = weekTasks.stream()
                .map(this::toTaskMap)
                .toList();

        List<Map<String, Object>> weeklyCompleted = weekTasks.stream()
                .filter(t -> t.getStatus() == 2)
                .map(this::toTaskMap)
                .toList();

        Map<String, Object> agentResponse = agentClient.generateWeeklyReport(
                userId, weekStart, weekEnd != null ? weekEnd : endDate.toString(),
                totalPlan, weeklyCompleted);

        Map<String, Object> response = new HashMap<>(agentResponse);
        response.put("weekStart", weekStart);
        response.put("weekEnd", weekEnd != null ? weekEnd : endDate.toString());
        if (agentResponse.containsKey("total_rate")) {
            response.put("completionRate", agentResponse.get("total_rate"));
        }
        if (agentResponse.containsKey("total_planned")) {
            response.put("totalTasks", agentResponse.get("total_planned"));
        }
        if (agentResponse.containsKey("total_completed")) {
            response.put("completedTasks", agentResponse.get("total_completed"));
        }
        if (agentResponse.containsKey("completed_hours")) {
            response.put("totalHours", agentResponse.get("completed_hours"));
        }
        if (agentResponse.containsKey("report_title")) {
            response.put("reportTitle", agentResponse.get("report_title"));
        }
        if (agentResponse.containsKey("grade")) {
            response.put("grade", agentResponse.get("grade"));
        }
        if (agentResponse.containsKey("streak_days")) {
            response.put("streakDays", agentResponse.get("streak_days"));
        }
        if (agentResponse.containsKey("daily_breakdown")) {
            response.put("dailyBreakdown", agentResponse.get("daily_breakdown"));
        }
        if (agentResponse.containsKey("subject_stats")) {
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> stats = (List<Map<String, Object>>) agentResponse.get("subject_stats");
            Map<String, Object> breakdown = new HashMap<>();
            if (stats != null) {
                for (Map<String, Object> s : stats) {
                    Object subject = s.get("subject");
                    Object hours = s.get("completed_minutes");
                    if (subject != null) {
                        double h = hours instanceof Number ? ((Number) hours).doubleValue() / 60.0 : 0.0;
                        breakdown.put(subject.toString(), Math.round(h * 10) / 10.0);
                    }
                }
            }
            response.put("subjectBreakdown", breakdown);
        }

        return ResponseEntity.ok(ApiResponse.success(response));
    }

    private Map<String, Object> toTaskMap(Task task) {
        Map<String, Object> map = new HashMap<>();
        map.put("task_date", task.getTaskDate() != null ? task.getTaskDate().toString() : null);
        map.put("subject", task.getSubject());
        map.put("task_content", task.getTaskContent() != null ? task.getTaskContent() : "");
        map.put("estimated_minutes", task.getEstimatedMinutes());
        map.put("task_type", task.getTaskType());
        return map;
    }
}
