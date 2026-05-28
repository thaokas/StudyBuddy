package com.prepkeeper.websocket;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.WebSocketSession;

import java.io.IOException;
import java.util.Collections;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 管理 WebSocket 会话: userId → Set&lt;WebSocketSession&gt;
 */
@Slf4j
@Component
public class WebSocketSessionManager {

    private final Map<String, Set<WebSocketSession>> sessions = new ConcurrentHashMap<>();

    public void addSession(String userId, WebSocketSession session) {
        sessions.computeIfAbsent(userId, k -> ConcurrentHashMap.newKeySet()).add(session);
    }

    public void removeSession(String userId, WebSocketSession session) {
        Set<WebSocketSession> userSessions = sessions.get(userId);
        if (userSessions != null) {
            userSessions.remove(session);
            if (userSessions.isEmpty()) {
                sessions.remove(userId);
            }
        }
    }

    public Set<WebSocketSession> getSessions(String userId) {
        return sessions.getOrDefault(userId, Collections.emptySet());
    }

    public int getSessionCount(String userId) {
        Set<WebSocketSession> userSessions = sessions.get(userId);
        return userSessions != null ? userSessions.size() : 0;
    }

    public boolean isUserOnline(String userId) {
        return getSessionCount(userId) > 0;
    }

    public void closeAllSessions(String userId) {
        Set<WebSocketSession> userSessions = sessions.remove(userId);
        if (userSessions == null) return;
        for (WebSocketSession session : userSessions) {
            try {
                session.close();
            } catch (IOException ignored) {
            }
        }
    }
}