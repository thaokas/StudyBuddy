package com.prepkeeper.service;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.util.ReflectionTestUtils;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

class AgentClientServiceTest {

    private HttpServer server;
    private AgentClientService service;

    @BeforeEach
    void setUp() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/planner/chat", exchange -> {
            byte[] body = """
                    event: message
                    data: {"content":"hello"}

                    event: state
                    data: {"stage":"confirm"}

                    event: done
                    data: {}

                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.start();

        service = new AgentClientService();
        ReflectionTestUtils.setField(
                service,
                "agentUrl",
                "http://127.0.0.1:" + server.getAddress().getPort());
    }

    @AfterEach
    void tearDown() {
        server.stop(0);
    }

    @Test
    void plannerChatStreamForwardsNamedSseEvents() throws InterruptedException {
        List<AgentClientService.SseEvent> events = new CopyOnWriteArrayList<>();
        AtomicReference<Throwable> error = new AtomicReference<>();
        CountDownLatch completed = new CountDownLatch(1);

        service.plannerChatStream(
                "user-1",
                "hello",
                null,
                Map.of(),
                events::add,
                throwable -> {
                    error.set(throwable);
                    completed.countDown();
                },
                completed::countDown);

        assertTrue(completed.await(5, TimeUnit.SECONDS));
        assertNull(error.get());
        assertEquals(List.of("message", "state", "done"),
                events.stream().map(AgentClientService.SseEvent::event).toList());
        assertEquals("{\"content\":\"hello\"}", events.get(0).data());
    }

    @Test
    void parsePlannerLinkForwardsJsonAndReturnsMaterial() {
        AtomicReference<String> requestBody = new AtomicReference<>();
        server.createContext("/api/planner/materials/link", exchange -> {
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
            byte[] body = """
                    {"id":"m1","kind":"link","name":"example.com","source":"https://example.com/syllabus","mime_type":"text/html","summary":"链接摘要","selected":true}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });

        Map<String, Object> result = service.parsePlannerLink("https://example.com/syllabus");

        assertEquals("link", result.get("kind"));
        assertEquals("链接摘要", result.get("summary"));
        assertTrue(requestBody.get().contains("\"url\":\"https://example.com/syllabus\""));
    }

    @Test
    void parsePlannerFileForwardsMultipartAndReturnsMaterial() {
        AtomicReference<String> contentType = new AtomicReference<>();
        AtomicReference<String> requestBody = new AtomicReference<>();
        server.createContext("/api/planner/materials/file", exchange -> {
            contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
            requestBody.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.ISO_8859_1));
            byte[] body = """
                    {"id":"m2","kind":"file","name":"outline.pdf","mime_type":"application/pdf","summary":"文件摘要","selected":true}
                    """.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        MockMultipartFile file = new MockMultipartFile(
                "file",
                "outline.pdf",
                "application/pdf",
                "%PDF-1.4".getBytes(StandardCharsets.UTF_8));

        Map<String, Object> result = service.parsePlannerFile(file);

        assertEquals("file", result.get("kind"));
        assertEquals("outline.pdf", result.get("name"));
        assertTrue(contentType.get().startsWith("multipart/form-data"));
        assertTrue(requestBody.get().contains("name=\"file\""));
        assertTrue(requestBody.get().contains("filename=\"outline.pdf\""));
        assertTrue(requestBody.get().contains("%PDF-1.4"));
    }
}
