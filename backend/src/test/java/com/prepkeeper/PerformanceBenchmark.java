package com.prepkeeper;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.time.*;
import java.time.temporal.ChronoUnit;
import java.util.*;
import java.util.stream.Collectors;
import java.util.stream.IntStream;

/**
 * Standalone performance benchmarks for backend core operations.
 * No Spring context needed — tests pure Java operations used in hot paths.
 */
public class PerformanceBenchmark {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    record BenchResult(String name, int iterations, double avgUs, double minUs, double maxUs, double p99Us) {
        @Override
        public String toString() {
            return String.format("  %-50s avg=%.2fμs  min=%.2fμs  max=%.2fμs  p99=%.2fμs  (%d iters)",
                    name, avgUs, minUs, maxUs, p99Us, iterations);
        }
    }

    static BenchResult benchmark(String name, Runnable task, int iterations) {
        long[] times = new long[iterations];
        for (int i = 0; i < iterations; i++) {
            long start = System.nanoTime();
            task.run();
            times[i] = (System.nanoTime() - start) / 1000; // to μs
        }
        Arrays.sort(times);
        long sum = 0;
        for (long t : times) sum += t;
        double avg = sum / (double) iterations;
        int p99Idx = (int) (iterations * 0.99);
        return new BenchResult(name, iterations,
                round(avg), round((double) times[0]),
                round((double) times[iterations - 1]), round((double) times[p99Idx]));
    }

    static double round(double v) { return Math.round(v * 100.0) / 100.0; }

    // ─── 1. JSON Serialization / Deserialization ───

    static void benchmarkJson() {
        System.out.println("\n--- 1. JSON Serialization / Deserialization ---");

        // Small payload (typical API response)
        Map<String, Object> smallPayload = new LinkedHashMap<>();
        smallPayload.put("userId", "user-001");
        smallPayload.put("planId", "plan-001");
        smallPayload.put("mode", 2);
        smallPayload.put("tasks", IntStream.range(0, 5).mapToObj(i -> {
            Map<String, Object> t = new LinkedHashMap<>();
            t.put("subject", "数学");
            t.put("name", "第三章习题");
            t.put("estimated_minutes", 60);
            return t;
        }).toList());

        // Large payload (plan with 90 days × 3 subjects)
        Map<String, Object> largePayload = new LinkedHashMap<>();
        largePayload.put("planId", "plan-001");
        largePayload.put("tasks", IntStream.range(1, 91).boxed().flatMap(d ->
                List.of(
                        Map.of("day", d, "subject", "数学", "content", "第" + d + "天数学学习", "estimated_minutes", 60),
                        Map.of("day", d, "subject", "英语", "content", "第" + d + "天英语学习", "estimated_minutes", 30),
                        Map.of("day", d, "subject", "政治", "content", "第" + d + "天政治学习", "estimated_minutes", 45)
                ).stream()
        ).toList());

        String smallJson;
        String largeJson;
        try {
            smallJson = MAPPER.writeValueAsString(smallPayload);
            largeJson = MAPPER.writeValueAsString(largePayload);
        } catch (JsonProcessingException e) { throw new RuntimeException(e); }

        System.out.println(benchmark("dumps(small ~500B)", () -> {
            try { MAPPER.writeValueAsString(smallPayload); } catch (JsonProcessingException e) {}
        }, 10000));

        System.out.println(benchmark("loads(small ~500B)", () -> {
            try { MAPPER.readValue(smallJson, Map.class); } catch (JsonProcessingException e) {}
        }, 10000));

        System.out.println(benchmark("dumps(large ~80KB)", () -> {
            try { MAPPER.writeValueAsString(largePayload); } catch (JsonProcessingException e) {}
        }, 500));

        System.out.println(benchmark("loads(large ~80KB)", () -> {
            try { MAPPER.readValue(largeJson, new TypeReference<List<Map<String, Object>>>() {}); } catch (JsonProcessingException e) {}
        }, 500));

        // toJsonString helper (hot path in ReminderService)
        List<String> ids = IntStream.range(0, 20).mapToObj(i -> "task-" + i).toList();
        System.out.println(benchmark("toJsonString(List<String> 20 items)", () -> {
            try { MAPPER.writeValueAsString(ids); } catch (JsonProcessingException e) {}
        }, 10000));

        String idsJson;
        try { idsJson = MAPPER.writeValueAsString(ids); } catch (JsonProcessingException e) { throw new RuntimeException(e); }
        System.out.println(benchmark("parseJsonToStringList(20 items)", () -> {
            try { MAPPER.readValue(idsJson, new TypeReference<List<String>>() {}); } catch (JsonProcessingException e) {}
        }, 10000));
    }

    // ─── 2. Timezone Conversion ───

    static void benchmarkTimezone() {
        System.out.println("\n--- 2. Timezone Conversion (ReminderService hot path) ---");

        ZoneId tz = ZoneId.of("Asia/Shanghai");
        LocalDateTime now = LocalDateTime.now(tz);
        Instant nowInstant = now.atZone(tz).toInstant();

        System.out.println(benchmark("LocalDateTime -> Instant", () -> {
            now.atZone(tz).toInstant();
        }, 50000));

        System.out.println(benchmark("Instant -> LocalDateTime", () -> {
            LocalDateTime.ofInstant(nowInstant, tz);
        }, 50000));

        System.out.println(benchmark("ZoneId.of('Asia/Shanghai')", () -> {
            ZoneId.of("Asia/Shanghai");
        }, 50000));

        System.out.println(benchmark("ChronoUnit.DAYS.between(30 days)", () -> {
            LocalDate start = LocalDate.of(2026, 4, 28);
            LocalDate end = LocalDate.of(2026, 5, 28);
            ChronoUnit.DAYS.between(start, end);
        }, 50000));

        System.out.println(benchmark("Instant.now().getEpochSecond()", Instant.now()::getEpochSecond, 50000));
    }

    // ─── 3. Task Filtering / Aggregation (ReminderService triggerClaimedReminder) ───

    record SimTask(String taskId, String subject, String taskContent,
                   int status, LocalDate taskDate, int estimatedMinutes) {}

    static void benchmarkTaskFiltering() {
        System.out.println("\n--- 3. Task Filtering & Aggregation (triggerClaimedReminder) ---");

        // Simulate 200 tasks for a 90-day plan
        List<SimTask> tasks = IntStream.range(1, 201).mapToObj(i -> new SimTask(
                "task-" + i,
                List.of("数学", "英语", "政治").get(i % 3),
                "学习任务" + i,
                List.of(0, 1, 2).get(i % 3), // 0=未开始, 1=进行中, 2=已完成
                LocalDate.of(2026, 5, 1).plusDays(i % 90),
                30 + (i % 4) * 15
        )).toList();

        List<String> selectedTaskIds = IntStream.range(1, 201).filter(i -> i % 3 == 0)
                .mapToObj(i -> "task-" + i).toList();
        LocalDate today = LocalDate.of(2026, 5, 28);

        System.out.println(benchmark("filter+group 200 tasks", () -> {
            var scopedCandidates = selectedTaskIds.isEmpty()
                    ? tasks.stream().filter(t -> t.taskDate().equals(today)).toList()
                    : tasks;
            var scoped = scopedCandidates.stream()
                    .filter(t -> t.status() != 3)
                    .filter(t -> selectedTaskIds.isEmpty() || selectedTaskIds.contains(t.taskId()))
                    .toList();
            var incomplete = scoped.stream()
                    .filter(t -> t.status() != 2)
                    .toList();
            // don't let JIT eliminate the dead code
            int x = scoped.size() + incomplete.size();
        }, 5000));

        // Task-to-map conversion
        List<SimTask> subset50 = tasks.subList(0, 50);
        System.out.println(benchmark("toTaskMaps(50 tasks)", () -> {
            var maps = subset50.stream().map(t -> {
                Map<String, Object> m = new HashMap<>();
                m.put("id", t.taskId());
                m.put("subject", t.subject());
                m.put("name", t.taskContent());
                m.put("estimated_minutes", t.estimatedMinutes());
                m.put("task_date", t.taskDate() != null ? t.taskDate().toString() : null);
                return m;
            }).toList();
        }, 5000));

        // Task name joining
        List<String> names = subset50.stream().map(t -> t.subject() + " - " + t.taskContent()).toList();
        System.out.println(benchmark("task names join(50 items)", () -> {
            String s = names.stream().limit(5).collect(Collectors.joining("、"));
        }, 10000));
    }

    // ─── 4. ID Generation ───

    static void benchmarkIdGeneration() {
        System.out.println("\n--- 4. ID Generation ---");

        System.out.println(benchmark("UUID.randomUUID()", UUID.randomUUID()::toString, 10000));

        System.out.println(benchmark("nanoTime-based ID", () -> {
            String id = "rem-" + System.nanoTime() + "-" + Thread.currentThread().getId();
        }, 10000));
    }

    // ─── 5. String Operations ───

    static void benchmarkStringOps() {
        System.out.println("\n--- 5. String Operations (hot paths) ---");

        String content = "这是AI生成的提醒内容，包含任务列表和鼓励语句，" +
                "大约50-100字的提醒文案，用于督促用户完成每日学习任务。".repeat(5);
        String shortStr = "数学 - 完成第三章习题";

        System.out.println(benchmark("String.trim()", content::trim, 50000));

        System.out.println(benchmark("String.format(template)", () -> {
            String.format("还有 %d 个任务未完成：%s。加油！", 3, "数学-习题、英语-单词、政治-复习");
        }, 50000));

        System.out.println(benchmark("String.contains()", () -> shortStr.contains("数学"), 100000));

        System.out.println(benchmark("String.isBlank()", content::isBlank, 100000));
    }

    // ─── Main ───

    public static void main(String[] args) {
        System.out.println("=".repeat(80));
        System.out.println("JAVA BACKEND PERFORMANCE BENCHMARKS");
        System.out.println("=".repeat(80));
        System.out.println("Java: " + System.getProperty("java.version") +
                " | OS: " + System.getProperty("os.name") +
                " | CPUs: " + Runtime.getRuntime().availableProcessors());

        // Warmup
        System.out.println("\n[Warming up JIT...]");
        for (int i = 0; i < 3; i++) {
            benchmarkJson();
            benchmarkTimezone();
            benchmarkTaskFiltering();
            benchmarkIdGeneration();
            benchmarkStringOps();
        }

        System.out.println("\n\n" + "=".repeat(80));
        System.out.println("BENCHMARK RESULTS (post-warmup)");
        System.out.println("=".repeat(80));

        benchmarkJson();
        benchmarkTimezone();
        benchmarkTaskFiltering();
        benchmarkIdGeneration();
        benchmarkStringOps();

        System.out.println("\n" + "=".repeat(80));
        System.out.println("BENCHMARKS COMPLETE");
        System.out.println("=".repeat(80));
    }
}
