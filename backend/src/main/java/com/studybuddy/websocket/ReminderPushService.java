package com.studybuddy.websocket;

import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * 提醒推送服务 —— 构建推送消息并通过 WebSocket 发送。
 */
@Slf4j
@Component
public class ReminderPushService {

    private final WebSocketSessionManager sessionManager;
    private final ObjectMapper objectMapper;

    public ReminderPushService(WebSocketSessionManager sessionManager, ObjectMapper objectMapper) {
        this.sessionManager = sessionManager;
        this.objectMapper = objectMapper;
    }

    /**
     * 向指定用户推送提醒消息。
     */
    public void pushReminder(String userId, String reminderId, String content, List<String> taskNames) {
        Set<WebSocketSession> userSessions = sessionManager.getSessions(userId);
        if (userSessions.isEmpty()) {
            log.info("用户 {} 无在线连接，提醒 {} 标记为未读", userId, reminderId);
            return;
        }

        Map<String, Object> message = new HashMap<>();
        message.put("type", "reminder");
        message.put("reminderId", reminderId);
        message.put("content", content);
        message.put("taskNames", taskNames != null ? taskNames : List.of());
        message.put("timestamp", System.currentTimeMillis());

        try {
            String payload = objectMapper.writeValueAsString(message);
            TextMessage textMessage = new TextMessage(payload);

            for (WebSocketSession session : userSessions) {
                if (session.isOpen()) {
                    try {
                        synchronized (session) {
                            session.sendMessage(textMessage);
                        }
                    } catch (IOException e) {
                        log.error("推送提醒失败: userId={}, sessionId={}, error={}",
                                userId, session.getId(), e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            log.error("构建推送消息失败: userId={}, error={}", userId, e.getMessage());
        }
    }

    /**
     * 检查用户是否在线。
     */
    public boolean isUserOnline(String userId) {
        return sessionManager.isUserOnline(userId);
    }
}