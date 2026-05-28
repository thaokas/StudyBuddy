package com.prepkeeper.websocket;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;

import java.io.IOException;

/**
 * WebSocket 连接处理器 —— 仅负责收发，推送逻辑委托给 ReminderPushService。
 */
@Slf4j
@Component
public class ReminderWebSocketHandler extends TextWebSocketHandler {

    private final WebSocketSessionManager sessionManager;

    public ReminderWebSocketHandler(WebSocketSessionManager sessionManager) {
        this.sessionManager = sessionManager;
    }

    @Override
    public void afterConnectionEstablished(WebSocketSession session) {
        String userId = (String) session.getAttributes().get("userId");
        if (userId == null) {
            log.warn("WebSocket 连接缺少 userId，关闭连接: sessionId={}", session.getId());
            try {
                session.close(CloseStatus.POLICY_VIOLATION);
            } catch (IOException ignored) {
            }
            return;
        }
        sessionManager.addSession(userId, session);
        log.info("WebSocket 连接建立: userId={}, sessionId={}, 当前在线连接数={}",
                userId, session.getId(), sessionManager.getSessionCount(userId));
    }

    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        // 客户端上行消息（如 ping/pong）暂不处理
        log.debug("收到 WebSocket 消息: sessionId={}, payload={}", session.getId(), message.getPayload());
    }

    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        String userId = (String) session.getAttributes().get("userId");
        if (userId != null) {
            sessionManager.removeSession(userId, session);
            log.info("WebSocket 连接关闭: userId={}, sessionId={}, status={}, 剩余连接数={}",
                    userId, session.getId(), status, sessionManager.getSessionCount(userId));
        }
    }

    @Override
    public void handleTransportError(WebSocketSession session, Throwable exception) {
        log.error("WebSocket 传输错误: sessionId={}, error={}", session.getId(), exception.getMessage());
        String userId = (String) session.getAttributes().get("userId");
        if (userId != null) {
            sessionManager.removeSession(userId, session);
        }
    }
}