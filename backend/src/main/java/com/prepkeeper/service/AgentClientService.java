package com.prepkeeper.service;

import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.codec.ServerSentEvent;
import org.springframework.http.client.MultipartBodyBuilder;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.reactive.function.client.WebClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

@Slf4j
@Service
public class AgentClientService {

    @Value("${agent.service.url}")
    private String agentUrl;

    private final WebClient webClient;

    public AgentClientService() {
        this.webClient = WebClient.create();
    }

    /**
     * SSE streaming planner chat — connects to agent-service SSE and relays events.
     */
    public void plannerChatStream(String userId, String message, String threadId,
                                   Map<String, Object> state,
                                   Consumer<SseEvent> onEvent,
                                   Consumer<Throwable> onError,
                                   Runnable onComplete) {
        String url = agentUrl + "/api/planner/chat";

        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("message", message);
        requestBody.put("thread_id", threadId != null ? threadId : userId);
        requestBody.put("state", state != null ? state : Map.of());

        webClient.post()
                .uri(url)
                .contentType(MediaType.APPLICATION_JSON)
                .accept(MediaType.TEXT_EVENT_STREAM)
                .bodyValue(requestBody)
                .retrieve()
                .bodyToFlux(new ParameterizedTypeReference<ServerSentEvent<String>>() {})
                .subscribe(
                        sse -> {
                            if (sse.data() != null) {
                                onEvent.accept(new SseEvent(
                                        sse.event() != null ? sse.event() : "message",
                                        sse.data()));
                            }
                        },
                        error -> {
                            log.error("SSE stream error for user {}: {}", userId, error.getMessage());
                            onError.accept(error);
                        },
                        () -> {
                            log.info("SSE stream complete for user {}", userId);
                            onComplete.run();
                        });
    }

    /**
     * Cancel an in-progress planner chat.
     */
    public void cancelPlannerChat(String threadId) {
        if (threadId == null) return;
        try {
            String url = agentUrl + "/api/planner/chat/cancel";
            Map<String, Object> body = Map.of("thread_id", threadId);
            webClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(body)
                    .retrieve()
                    .toBodilessEntity()
                    .subscribe(
                            resp -> log.info("Cancelled planner chat: {}", threadId),
                            err -> log.warn("Failed to cancel planner chat {}: {}", threadId, err.getMessage())
                    );
        } catch (Exception e) {
            log.warn("Error cancelling planner chat {}: {}", threadId, e.getMessage());
        }
    }

    /**
     * Parse and summarize a public planner material link via agent-service.
     */
    public Map<String, Object> parsePlannerLink(String urlValue) {
        String url = agentUrl + "/api/planner/materials/link";
        Map<String, Object> requestBody = Map.of("url", urlValue);

        return webClient.post()
                .uri(url)
                .contentType(MediaType.APPLICATION_JSON)
                .bodyValue(requestBody)
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .block();
    }

    /**
     * Parse and summarize one uploaded planner material file via agent-service.
     */
    public Map<String, Object> parsePlannerFile(MultipartFile file) {
        String url = agentUrl + "/api/planner/materials/file";
        MultipartBodyBuilder builder = new MultipartBodyBuilder();
        try {
            ByteArrayResource resource = new ByteArrayResource(file.getBytes()) {
                @Override
                public String getFilename() {
                    return file.getOriginalFilename();
                }
            };
            builder.part("file", resource)
                    .header(HttpHeaders.CONTENT_DISPOSITION,
                            "form-data; name=\"file\"; filename=\"" + file.getOriginalFilename() + "\"")
                    .contentType(file.getContentType() != null
                            ? MediaType.parseMediaType(file.getContentType())
                            : MediaType.APPLICATION_OCTET_STREAM);
        } catch (Exception e) {
            throw new RuntimeException("读取上传资料失败: " + e.getMessage(), e);
        }

        return webClient.post()
                .uri(url)
                .contentType(MediaType.MULTIPART_FORM_DATA)
                .bodyValue(builder.build())
                .retrieve()
                .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                .block();
    }

    /**
     * 调用Agent处理打卡 — POST /api/checkin/
     */
    public Map<String, Object> processCheckin(String completedContent, java.math.BigDecimal overallCompletionRate, String imageUrl) {
        String url = agentUrl + "/api/checkin/";
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("completed_content", completedContent);
        requestBody.put("overall_completion_rate", overallCompletionRate);

        // Convert image file path to base64 data URI for the agent
        String imageData = null;
        if (imageUrl != null && !imageUrl.isEmpty()) {
            try {
                Path imagePath = Paths.get(imageUrl.startsWith("/") ? imageUrl.substring(1) : imageUrl);
                if (Files.exists(imagePath)) {
                    byte[] bytes = Files.readAllBytes(imagePath);
                    String base64 = Base64.getEncoder().encodeToString(bytes);
                    String mimeType = Files.probeContentType(imagePath);
                    if (mimeType == null) mimeType = "image/jpeg";
                    imageData = "data:" + mimeType + ";base64," + base64;
                }
            } catch (Exception e) {
                log.warn("读取打卡图片失败: {}", e.getMessage());
            }
        }
        requestBody.put("image_url", imageData);

        try {
            return webClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(requestBody)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .block();
        } catch (Exception e) {
            log.error("调用Agent处理打卡失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 调用Agent生成提醒文案 — POST /api/reminder/generate
     */
    public Map<String, Object> generateReminder(List<Map<String, Object>> todayTotalTasks,
                                                 List<Map<String, Object>> todayIncompleteTasks,
                                                 List<Map<String, Object>> examTotalTasks,
                                                 List<Map<String, Object>> examCompletedTasks,
                                                 double elapsedStudyDays,
                                                 double totalStudyDays,
                                                 String strictnessMode) {
        String url = agentUrl + "/api/reminder/generate";
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("today_total_tasks", todayTotalTasks);
        requestBody.put("today_incomplete_tasks", todayIncompleteTasks);
        requestBody.put("exam_total_tasks", examTotalTasks);
        requestBody.put("exam_completed_tasks", examCompletedTasks);
        requestBody.put("elapsed_study_days", elapsedStudyDays);
        requestBody.put("total_study_days", totalStudyDays);
        requestBody.put("strictness_mode", strictnessMode);

        try {
            return webClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(requestBody)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .block();
        } catch (Exception e) {
            log.error("调用Agent生成提醒失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 调用Agent生成周报 — POST /api/report/weekly
     */
    public Map<String, Object> generateWeeklyReport(String userId, String weekStart, String weekEnd,
                                                     List<Map<String, Object>> totalPlan,
                                                     List<Map<String, Object>> weeklyCompleted) {
        String url = agentUrl + "/api/report/weekly";
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("user_id", userId);
        requestBody.put("week_start", weekStart);
        requestBody.put("week_end", weekEnd);
        requestBody.put("total_plan", totalPlan != null ? totalPlan : List.of());
        requestBody.put("weekly_completed", weeklyCompleted != null ? weeklyCompleted : List.of());

        try {
            return webClient.post()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(requestBody)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .block();
        } catch (Exception e) {
            log.error("调用Agent生成周报失败: {}", e.getMessage());
            throw new RuntimeException("Agent服务异常: " + e.getMessage());
        }
    }

    /**
     * 获取Agent端提醒设置 — GET /api/reminder/settings/{userId}
     */
    public Map<String, Object> getReminderSettingsFromAgent(String userId) {
        String url = agentUrl + "/api/reminder/settings/" + userId;
        try {
            return webClient.get()
                    .uri(url)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .block();
        } catch (Exception e) {
            log.error("获取Agent提醒设置失败: {}", e.getMessage());
            return null;
        }
    }

    /**
     * 更新Agent端提醒设置 — PUT /api/reminder/settings/{userId}
     */
    public Map<String, Object> updateReminderSettingsInAgent(String userId, int mode,
                                                              List<String> customTimes, int monkingInterval) {
        String url = agentUrl + "/api/reminder/settings/" + userId;
        Map<String, Object> requestBody = new HashMap<>();
        requestBody.put("mode", mode);
        requestBody.put("custom_times", customTimes != null ? customTimes : List.of());
        requestBody.put("monking_interval", monkingInterval);

        try {
            return webClient.put()
                    .uri(url)
                    .contentType(MediaType.APPLICATION_JSON)
                    .bodyValue(requestBody)
                    .retrieve()
                    .bodyToMono(new ParameterizedTypeReference<Map<String, Object>>() {})
                    .block();
        } catch (Exception e) {
            log.error("更新Agent提醒设置失败: {}", e.getMessage());
            return null;
        }
    }

    /** Simple SSE event data holder. */
    public record SseEvent(String event, String data) {}

    /**
     * strictness_mode映射: 后端整数模式 → Agent字符串模式
     */
    public static String modeToStrictness(int mode) {
        return switch (mode) {
            case 0 -> "silent";
            case 1 -> "gentle";
            case 2 -> "intensive";
            case 3 -> "tangseng";
            case 4 -> "nightmare";
            default -> "gentle";
        };
    }
}
