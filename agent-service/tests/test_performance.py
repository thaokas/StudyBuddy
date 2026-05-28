"""
Performance benchmarks for agent-service core operations.
Covers: knowledge retrieval, state processing, SSE parsing, JSON serialization, import time.
"""
import time
import json
import sys
from pathlib import Path

# Add agent-service to path
sys.path.insert(0, str(Path(__file__).parent.parent))


def benchmark(name, func, iterations=1000):
    """Run a function multiple times and return (avg_ms, min_ms, max_ms, p99_ms)."""
    times = []
    for _ in range(iterations):
        start = time.perf_counter()
        func()
        elapsed = (time.perf_counter() - start) * 1000
        times.append(elapsed)
    times.sort()
    avg = sum(times) / len(times)
    p99_idx = int(len(times) * 0.99)
    return {
        "name": name,
        "iterations": iterations,
        "avg_ms": round(avg, 4),
        "min_ms": round(times[0], 4),
        "max_ms": round(times[-1], 4),
        "p99_ms": round(times[p99_idx], 4),
        "total_ms": round(sum(times), 2),
    }


def test_import_time():
    """Measure import time for key modules."""
    modules = [
        "app.agents.reminder.state",
        "app.agents.reminder.nodes",
        "app.agents.reminder.prompts",
        "app.agents.planner.state",
        "app.agents.checkin.state",
        "app.rag.retriever",
        "app.config",
    ]
    results = []
    app_modules_snapshot = {
        key: value
        for key, value in sys.modules.items()
        if key == "app" or key.startswith("app.")
    }

    try:
        for mod_name in modules:
            # Clear app modules to measure cold import without leaking module state.
            for key in list(sys.modules.keys()):
                if key == "app" or key.startswith("app."):
                    del sys.modules[key]

            start = time.perf_counter()
            __import__(mod_name)
            elapsed = (time.perf_counter() - start) * 1000
            results.append({"module": mod_name, "import_ms": round(elapsed, 4)})
    finally:
        for key in list(sys.modules.keys()):
            if key == "app" or key.startswith("app."):
                del sys.modules[key]
        sys.modules.update(app_modules_snapshot)

    return results


def test_knowledge_retriever_perf():
    """Benchmark KnowledgeRetriever load and query operations."""
    from app.rag.retriever import KnowledgeRetriever

    # Benchmark: cold load (first instantiation)
    start = time.perf_counter()
    retriever = KnowledgeRetriever()
    cold_load_ms = (time.perf_counter() - start) * 1000

    # Benchmark: get_encouragement (hot path)
    r1 = benchmark("get_encouragement", lambda: retriever.get_encouragement(85.5), 5000)

    # Benchmark: get_streak_reward
    r2 = benchmark("get_streak_reward", lambda: retriever.get_streak_reward(7), 5000)

    # Benchmark: get_exam_strategy
    r3 = benchmark("get_exam_strategy", lambda: retriever.get_exam_strategy("考研", 2), 5000)

    # Benchmark: get_random_tip
    r4 = benchmark("get_random_tip", lambda: retriever.get_random_tip(), 5000)

    # Benchmark: get_easter_egg
    r5 = benchmark("get_easter_egg", lambda: retriever.get_easter_egg("checkin"), 5000)

    # Benchmark: warm load (singleton from cache)
    from app.rag.retriever import get_retriever, _retriever
    _retriever_cached = _retriever
    _retriever = None  # Reset singleton
    start = time.perf_counter()
    r = get_retriever()
    warm_load_ms = (time.perf_counter() - start) * 1000
    # Restore
    import app.rag.retriever as rmod
    rmod._retriever = _retriever_cached

    return {
        "cold_load_ms": round(cold_load_ms, 4),
        "warm_load_ms": round(warm_load_ms, 4),
        "queries": [r1, r2, r3, r4, r5],
    }


def test_state_processing_perf():
    """Benchmark reminder state processing operations."""
    from app.agents.reminder.nodes import format_task_label

    # Build test data
    small_tasks = [
        {"subject": "数学", "name": f"完成第{i}章习题", "estimated_minutes": 60}
        for i in range(10)
    ]
    large_tasks = [
        {"subject": "英语", "name": f"单词背诵第{i}组", "estimated_minutes": 30}
        for i in range(100)
    ]

    # Benchmark: format_task_label
    r1 = benchmark("format_task_label(small)", lambda: [format_task_label(t) for t in small_tasks], 5000)
    r2 = benchmark("format_task_label(large)", lambda: [format_task_label(t) for t in large_tasks], 1000)

    # Benchmark: task stats calculation (simulating generate_reminder_node's stats logic)
    state = {
        "today_total_tasks": [{"id": str(i)} for i in range(50)],
        "today_incomplete_tasks": [{"id": str(i)} for i in range(20)],
        "exam_total_tasks": [{"id": str(i)} for i in range(200)],
        "exam_completed_tasks": [{"id": str(i)} for i in range(80)],
        "elapsed_study_days": 30.0,
        "total_study_days": 90.0,
    }

    def calc_stats():
        today_total = len(state["today_total_tasks"])
        today_incomplete = len(state["today_incomplete_tasks"])
        today_done = today_total - today_incomplete
        exam_total = len(state["exam_total_tasks"])
        exam_done = len(state["exam_completed_tasks"])
        exam_rate = round(exam_done / exam_total * 100, 1) if exam_total > 0 else 0.0
        elapsed = state["elapsed_study_days"]
        total = state["total_study_days"]
        time_rate = round(elapsed / total * 100, 1) if total > 0 else 0.0
        incomplete_names = "、".join(
            f"Task-{t['id']}" for t in state["today_incomplete_tasks"][:5]
        )
        return today_done, exam_rate, time_rate, incomplete_names

    r3 = benchmark("calc_reminder_stats", calc_stats, 10000)

    return {
        "format_task_label": [r1, r2],
        "stats_calculation": r3,
    }


def test_sse_frame_parsing_perf():
    """Benchmark SSE frame parsing (simulating frontend handleFrame logic)."""
    # Simulate various SSE frame sizes
    tiny_frame = "event:message\ndata:{\"ok\":true}\n\n"
    typical_frame = "event:plan_update\ndata:" + json.dumps({
        "phase": "generate_plan",
        "tasks": [{"day": i, "subject": "数学", "content": "完成第{i}章练习题"} for i in range(1, 8)],
        "progress": 0.65,
    }) + "\n\n"
    large_frame = "event:plan_complete\ndata:" + json.dumps({
        "plan_id": "plan-001",
        "tasks": [
            {"day": d, "subject": s, "content": f"第{d}天{s}学习任务", "estimated_minutes": m}
            for d in range(1, 91)
            for s, m in [("数学", 60), ("英语", 30), ("政治", 45)]
        ]
    }) + "\n\n"

    def parse_frame(frame):
        event = "message"
        data_lines = []
        for line in frame.split("\n"):
            if line.startswith("event:"):
                event = line[6:].strip() or "message"
            elif line.startswith("data:"):
                data_lines.append(line[5:].removeprefix(" "))
        if data_lines:
            return json.loads("\n".join(data_lines))
        return None

    r1 = benchmark("sse_parse(tiny)", lambda: parse_frame(tiny_frame), 10000)
    r2 = benchmark("sse_parse(typical)", lambda: parse_frame(typical_frame), 5000)
    r3 = benchmark("sse_parse(large)", lambda: parse_frame(large_frame), 1000)

    # Benchmark: buffer splitting (simulating stream processing)
    buffer = "\n\n".join([tiny_frame.strip()] * 50)

    def split_buffer():
        frames = buffer.split("\n\n")
        return [parse_frame(f + "\n\n") for f in frames[:10]]

    r4 = benchmark("sse_buffer_split_50frames", split_buffer, 1000)

    return {
        "frame_parsing": [r1, r2, r3],
        "buffer_processing": r4,
    }


def test_json_perf():
    """Benchmark JSON serialization/deserialization of typical payloads."""
    small_payload = {
        "user_id": "user-001",
        "plan_id": "plan-001",
        "mode": 2,
        "today_total_tasks": [
            {"subject": "数学", "name": "第三章习题", "estimated_minutes": 60}
            for _ in range(5)
        ],
        "today_incomplete_tasks": [
            {"subject": "数学", "name": "第三章习题", "estimated_minutes": 60}
            for _ in range(3)
        ],
    }
    small_json = json.dumps(small_payload)

    large_payload = {
        "plan_id": "plan-001",
        "tasks": [
            {"day": d, "subject": s, "content": f"第{d}天{s}学习", "estimated_minutes": m}
            for d in range(1, 91)
            for s, m in [("数学", 60), ("英语", 30), ("政治", 45)]
        ],
    }
    large_json = json.dumps(large_payload)

    r1 = benchmark("json_dumps(small)", lambda: json.dumps(small_payload), 10000)
    r2 = benchmark("json_loads(small)", lambda: json.loads(small_json), 10000)
    r3 = benchmark("json_dumps(large)", lambda: json.dumps(large_payload), 1000)
    r4 = benchmark("json_loads(large)", lambda: json.loads(large_json), 1000)

    return {
        "serialization": [r1, r3],
        "deserialization": [r2, r4],
    }


def print_result(result, indent=0):
    """Pretty print a benchmark result."""
    prefix = "  " * indent
    if isinstance(result, dict):
        if "avg_ms" in result:
            print(f"{prefix}{result['name']}:")
            print(f"{prefix}  avg={result['avg_ms']}ms  min={result['min_ms']}ms  "
                  f"max={result['max_ms']}ms  p99={result['p99_ms']}ms  "
                  f"({result['iterations']} iters, {result['total_ms']}ms total)")
        elif "import_ms" in result:
            print(f"{prefix}{result['module']}: {result['import_ms']}ms")
        elif "cold_load_ms" in result:
            print(f"{prefix}KnowledgeRetriever cold_load: {result['cold_load_ms']}ms")
            print(f"{prefix}KnowledgeRetriever warm_load: {result['warm_load_ms']}ms")
            for q in result.get("queries", []):
                print_result(q, indent + 1)
        elif "format_task_label" in result:
            print(f"{prefix}format_task_label:")
            for r in result["format_task_label"]:
                print_result(r, indent + 1)
            print(f"{prefix}stats_calculation:")
            print_result(result["stats_calculation"], indent + 1)
        elif "frame_parsing" in result:
            print(f"{prefix}frame_parsing:")
            for r in result["frame_parsing"]:
                print_result(r, indent + 1)
            print(f"{prefix}buffer_processing:")
            print_result(result["buffer_processing"], indent + 1)
        elif "serialization" in result:
            print(f"{prefix}serialization:")
            for r in result["serialization"]:
                print_result(r, indent + 1)
            print(f"{prefix}deserialization:")
            for r in result["deserialization"]:
                print_result(r, indent + 1)
        else:
            for k, v in result.items():
                if isinstance(v, list):
                    print(f"{prefix}{k}:")
                    for item in v:
                        print_result(item, indent + 1)
    elif isinstance(result, list):
        for item in result:
            print_result(item, indent)
    else:
        print(f"{prefix}{result}")


def main():
    print("=" * 80)
    print("AGENT-SERVICE PERFORMANCE BENCHMARKS")
    print("=" * 80)

    print("\n--- 1. Module Import Time ---")
    import_results = test_import_time()
    for r in import_results:
        print_result(r)

    print("\n--- 2. KnowledgeRetriever Performance ---")
    kr_results = test_knowledge_retriever_perf()
    print_result(kr_results)

    print("\n--- 3. State Processing Performance ---")
    sp_results = test_state_processing_perf()
    print_result(sp_results)

    print("\n--- 4. SSE Frame Parsing Performance ---")
    sse_results = test_sse_frame_parsing_perf()
    print_result(sse_results)

    print("\n--- 5. JSON Serialization Performance ---")
    json_results = test_json_perf()
    print_result(json_results)

    print("\n" + "=" * 80)
    print("BENCHMARKS COMPLETE")
    print("=" * 80)


if __name__ == "__main__":
    main()
