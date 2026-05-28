package com.prepkeeper.config;

import com.prepkeeper.websocket.AuthHandshakeInterceptor;
import com.prepkeeper.websocket.ReminderWebSocketHandler;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final ReminderWebSocketHandler handler;
    private final AuthHandshakeInterceptor interceptor;

    public WebSocketConfig(ReminderWebSocketHandler handler, AuthHandshakeInterceptor interceptor) {
        this.handler = handler;
        this.interceptor = interceptor;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws")
                .addInterceptors(interceptor)
                .setAllowedOrigins("*");
    }
}