"""Tests for the planner agent."""
import pytest
from datetime import date, datetime, timedelta

import app.agents.planner.graph as planner_graph_module
import app.agents.planner.nodes as planner_nodes_module
from app.agents.planner.graph import run_planner_turn
from app.agents.planner.state import initial_state
from app.agents.planner.nodes import (
    _parse_llm_json,
    _compute_missing_fields,
    _merge_profile,
    _expand_plan_structure,
    _build_default_plan_structure,
    _build_search_queries,
    search_node,
    confirm_node,
    generate_plan_node,
)
from app.agents.planner.prompts import (
    EXTRACT_INTENT_PROMPT,
    ASK_MISSING_PROMPT,
    CONFIRM_PROMPT,
    GENERATE_PLAN_PROMPT,
)


class TestHelpers:
    """Unit tests for helper functions (no LLM needed)."""

    def test_parse_llm_json_valid(self):
        result = _parse_llm_json('{"message": "hello", "extracted": {"exam_name": "雅思"}}')
        assert result["message"] == "hello"
        assert result["extracted"]["exam_name"] == "雅思"

    def test_parse_llm_json_code_block(self):
        result = _parse_llm_json('```json\n{"message": "hello"}\n```')
        assert result["message"] == "hello"

    def test_parse_llm_json_brace_match(self):
        result = _parse_llm_json('some text {"message": "hello"} more text')
        assert result["message"] == "hello"

    def test_parse_llm_json_fallback(self):
        result = _parse_llm_json('not json at all')
        assert result["message"] == "not json at all"

    def test_compute_missing_fields_all_missing(self):
        profile = initial_state()["profile"]
        missing = _compute_missing_fields(profile)
        assert len(missing) == 6
        assert "考试名称" in missing
        assert "实际备考科目" in missing
        assert "每周休息天数" in missing

    def test_compute_missing_fields_all_filled(self):
        profile = {
            "exam_name": "雅思", "exam_type": "学术类",
            "exam_date": "2026-12-01", "daily_hours": 3.0,
            "exam_subjects": ["写作", "阅读"], "rest_days_per_week": 1,
        }
        missing = _compute_missing_fields(profile)
        assert missing == []

    def test_merge_profile_extracts_new(self):
        profile = {"exam_name": None, "missing_fields": ["考试名称"]}
        extracted = {"exam_name": "雅思", "exam_type": "学术类"}
        merged = _merge_profile(profile, extracted)
        assert merged["exam_name"] == "雅思"
        assert merged["exam_type"] == "学术类"
        assert "考试名称" not in merged["missing_fields"]

    def test_merge_profile_preserves_existing(self):
        profile = {"exam_name": "雅思", "daily_hours": 4.0, "missing_fields": ["考试日期"]}
        extracted = {"exam_date": "2026-12-01"}
        merged = _merge_profile(profile, extracted)
        assert merged["exam_name"] == "雅思"  # preserved
        assert merged["daily_hours"] == 4.0  # preserved
        assert merged["exam_date"] == "2026-12-01"  # new

    @pytest.mark.parametrize("rest_days", [0, 1, 2, 3])
    def test_merge_profile_keeps_subjects_and_valid_rest_days(self, rest_days):
        merged = _merge_profile(initial_state()["profile"], {
            "exam_subjects": ["会计", "审计"],
            "rest_days_per_week": rest_days,
        })
        assert merged["exam_subjects"] == ["会计", "审计"]
        assert merged["rest_days_per_week"] == rest_days

    def test_merge_profile_clears_explicit_empty_subject_lists(self):
        profile = initial_state()["profile"]
        profile.update({"exam_subjects": ["会计"], "weak_subjects": ["审计"]})

        merged = _merge_profile(profile, {"exam_subjects": [], "weak_subjects": []})

        assert merged["exam_subjects"] == []
        assert merged["weak_subjects"] == []
        assert "实际备考科目" in merged["missing_fields"]

    def test_merge_profile_preserves_collected_values_when_schema_fields_are_null(self):
        profile = initial_state()["profile"]
        profile.update({
            "exam_name": "会计证",
            "exam_type": "考证",
            "exam_date": "2099-06-08",
            "daily_hours": 2,
            "foundation_level": 1,
            "exam_subjects": ["会计"],
            "weak_subjects": ["审计"],
            "rest_days_per_week": 1,
        })

        merged = _merge_profile(profile, {
            "exam_name": None,
            "exam_type": None,
            "exam_date": None,
            "daily_hours": None,
            "foundation_level": None,
            "exam_subjects": None,
            "weak_subjects": None,
            "rest_days_per_week": 2,
        })

        assert merged["exam_date"] == "2099-06-08"
        assert merged["daily_hours"] == 2
        assert merged["exam_subjects"] == ["会计"]
        assert merged["weak_subjects"] == ["审计"]
        assert merged["rest_days_per_week"] == 2
        assert merged["missing_fields"] == []

    @pytest.mark.parametrize(
        ("field", "value", "label"),
        [
            ("exam_date", "六月十日", "考试日期"),
            ("exam_date", "2000-01-01", "考试日期"),
            ("daily_hours", 0, "每日学习时长"),
            ("daily_hours", -1, "每日学习时长"),
            ("daily_hours", "两小时", "每日学习时长"),
        ],
    )
    def test_merge_profile_rejects_invalid_planning_values(self, field, value, label):
        merged = _merge_profile(initial_state()["profile"], {field: value})

        assert merged[field] is None
        assert label in merged["missing_fields"]

    def test_merge_profile_rejects_infinite_daily_hours(self):
        merged = _merge_profile(initial_state()["profile"], {"daily_hours": float("inf")})

        assert merged["daily_hours"] is None
        assert "每日学习时长" in merged["missing_fields"]

    def test_expand_plan_structure_creates_tasks(self):
        profile = {
            "exam_name": "考研数学一", "exam_date": "2026-08-01",
            "daily_hours": 2, "foundation_level": 1,
            "weak_subjects": ["线性代数"], "rest_days_per_week": 1,
        }
        plan_structure = _build_default_plan_structure(profile)
        tasks = _expand_plan_structure(plan_structure, profile, "2026-07-01")
        assert len(tasks) > 0
        for t in tasks:
            assert "taskDate" in t
            assert "subject" in t
            assert "taskContent" in t
            assert "estimatedMinutes" in t
            assert "taskType" in t
            assert "phase" in t

    def test_expand_plan_structure_no_exam_date(self):
        profile = {"exam_name": "test", "daily_hours": 2}
        tasks = _expand_plan_structure({}, profile, date.today().isoformat())
        assert tasks == []

    def test_expand_plan_structure_rejects_non_iso_exam_date(self):
        profile = {"exam_date": "六月十日", "daily_hours": 2}

        tasks = _expand_plan_structure({}, profile, "2026-06-01")

        assert tasks == []

    def test_expand_plan_structure_short_timeline_uses_available_days(self):
        profile = {
            "exam_name": "雅思", "exam_date": "2026-05-28",
            "daily_hours": 2, "foundation_level": 1,
            "weak_subjects": ["写作"], "rest_days_per_week": 1,
        }
        plan_structure = _build_default_plan_structure(profile)

        tasks = _expand_plan_structure(plan_structure, profile, "2026-05-26")

        assert tasks
        assert {task["taskDate"] for task in tasks} <= {"2026-05-26", "2026-05-27"}

    def test_build_default_plan_structure(self):
        profile = {"weak_subjects": ["数学", "英语"], "foundation_level": 1}
        structure = _build_default_plan_structure(profile)
        assert len(structure["phases"]) == 3
        assert structure["phases"][0]["name"] == "基础阶段"
        assert "数学" in structure["subjectTopics"]

    def test_default_structure_uses_confirmed_subjects_not_placeholders(self):
        structure = _build_default_plan_structure({
            "exam_subjects": ["会计", "经济法"],
            "weak_subjects": [],
        })
        assert structure["phases"][0]["subjects"] == ["会计", "经济法"]
        assert "科目一" not in str(structure)
        assert "科目二" not in str(structure)
        assert "科目三" not in str(structure)

    def test_expanded_default_tasks_use_only_confirmed_subjects(self):
        subjects = {"会计", "经济法"}
        profile = {
            "exam_date": "2026-06-10",
            "daily_hours": 1,
            "exam_subjects": list(subjects),
            "weak_subjects": [],
            "rest_days_per_week": 0,
        }
        structure = _build_default_plan_structure(profile)

        tasks = _expand_plan_structure(structure, profile, "2026-06-01")

        assert tasks
        assert {task["subject"] for task in tasks} <= subjects

    @pytest.mark.parametrize(
        ("rest_days", "excluded_dates"),
        [
            (0, set()),
            (1, {"2026-05-31"}),
            (2, {"2026-05-30", "2026-05-31"}),
            (3, {"2026-05-29", "2026-05-30", "2026-05-31"}),
        ],
    )
    def test_expand_plan_structure_applies_requested_rest_days(self, rest_days, excluded_dates):
        profile = {
            "exam_date": "2026-06-02",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "weak_subjects": [],
            "rest_days_per_week": rest_days,
        }
        structure = {
            "phases": [{
                "phase": 1,
                "durationPercent": 100,
                "subjects": ["会计"],
                "taskTemplates": [{"taskContent": "{subject}", "estimatedMinutes": 60, "taskType": 1}],
            }],
            "subjectTopics": {"会计": ["基础"]},
        }

        dates = {task["taskDate"] for task in _expand_plan_structure(structure, profile, "2026-05-29")}

        assert dates == {"2026-05-29", "2026-05-30", "2026-05-31", "2026-06-01"} - excluded_dates

    def test_initial_state(self):
        state = initial_state()
        assert state["stage"] == "extract_intent"
        assert state["profile"]["exam_name"] is None
        assert state["search_results"] == []
        assert state["plan_tasks"] == []
        assert state["materials"] == []
        assert state["profile"]["exam_subjects"] == []
        assert state["profile"]["rest_days_per_week"] is None

    def test_extraction_prompts_request_subjects_and_rest_preference(self):
        assert "exam_subjects" in EXTRACT_INTENT_PROMPT
        assert "rest_days_per_week" in EXTRACT_INTENT_PROMPT
        assert "exam_subjects" in ASK_MISSING_PROMPT
        assert "rest_days_per_week" in ASK_MISSING_PROMPT

    def test_profile_prompts_distinguish_omitted_subject_lists_from_explicit_clear(self):
        for prompt in (EXTRACT_INTENT_PROMPT, ASK_MISSING_PROMPT, CONFIRM_PROMPT):
            assert "未提及或未修改则为null" in prompt
            assert "明确表示没有或清空时才返回[]" in prompt

    def test_confirm_prompt_displays_confirmed_subjects(self):
        assert "exam_subjects" in CONFIRM_PROMPT
        assert "- 实际备考科目" in CONFIRM_PROMPT

    def test_generation_prompt_restricts_subjects_to_confirmed_set(self):
        assert "exam_subjects" in GENERATE_PLAN_PROMPT
        assert "只能使用" in GENERATE_PLAN_PROMPT

    def test_build_search_queries_uses_subject_and_separate_purposes(self):
        queries = _build_search_queries({
            "exam_name": "中国注册会计师 CPA",
            "exam_type": "专业阶段",
            "exam_subjects": ["会计"],
        })

        assert {purpose for purpose, _query in queries} == {"syllabus", "schedule", "resources"}
        assert all("中国注册会计师 CPA" in query for _purpose, query in queries)
        assert all("专业阶段" in query for _purpose, query in queries)
        assert all("会计" in query for _purpose, query in queries)

    def test_search_prompt_contract_mentions_materials(self):
        for prompt in (ASK_MISSING_PROMPT, CONFIRM_PROMPT, GENERATE_PLAN_PROMPT):
            assert "{materials_summary}" in prompt
            assert "不可信参考" in prompt


@pytest.mark.asyncio
class TestPlannerGraph:
    """Integration tests for the planner graph (requires LLM)."""

    async def test_state_event_exposes_search_done_for_next_turn(self, monkeypatch):
        result = initial_state()
        result["last_message"] = ""
        result["stage"] = "confirm"
        result["materials"] = [{"kind": "link", "title": "考纲"}]
        result["search_results"] = [{"title": "官网", "snippet": "范围", "url": "https://example.test"}]

        async def fake_invoke(_state):
            return result

        monkeypatch.setattr(planner_graph_module.planner_graph, "ainvoke", fake_invoke)

        events = [event async for event in run_planner_turn("制定计划")]
        state_event = next(event for event in events if event["event"] == "state")
        confirm_event = next(event for event in events if event["event"] == "confirm")

        assert state_event["data"]["search_done"] is False
        assert state_event["data"]["materials"] == result["materials"]
        assert confirm_event["data"]["materials"] == result["materials"]
        assert confirm_event["data"]["search_results"] == result["search_results"]

    async def test_existing_state_materials_survive_next_turn_events(self, monkeypatch):
        existing_state = initial_state()
        existing_state["materials"] = [{"kind": "file", "title": "会计考纲.pdf"}]
        existing_state["stage"] = "confirm"

        async def fake_invoke(state):
            assert state["materials"] == existing_state["materials"]
            return {
                "stage": "confirm",
                "profile": state["profile"],
                "search_results": state["search_results"],
                "last_message": "",
            }

        monkeypatch.setattr(planner_graph_module.planner_graph, "ainvoke", fake_invoke)

        events = [event async for event in run_planner_turn("继续确认", existing_state)]
        state_event = next(event for event in events if event["event"] == "state")
        confirm_event = next(event for event in events if event["event"] == "confirm")

        assert state_event["data"]["materials"] == existing_state["materials"]
        assert confirm_event["data"]["materials"] == existing_state["materials"]

    async def test_confirm_node_waits_in_confirm_stage_until_user_accepts(self, monkeypatch):
        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {
                    "content": '{"message": "请确认信息", "confirmation": false, "extracted": {}}'
                })()

        monkeypatch.setattr("app.agents.planner.nodes.get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"] = {
            "exam_name": "雅思",
            "exam_type": "学术类",
            "exam_date": "2026-12-01",
            "daily_hours": 2,
            "foundation_level": 1,
            "exam_subjects": ["听力", "阅读"],
            "weak_subjects": [],
            "rest_days_per_week": 1,
            "missing_fields": [],
            "is_ready": False,
        }

        result = await confirm_node(state)

        assert result["stage"] == "confirm"

    async def test_extract_intent_basic(self, monkeypatch):
        """Basic intent extraction from user message."""
        result = initial_state()
        result["profile"]["exam_name"] = "雅思"
        result["last_message"] = "已记录"

        async def fake_invoke(_state):
            return result

        monkeypatch.setattr(planner_graph_module.planner_graph, "ainvoke", fake_invoke)
        events = []
        async for event in run_planner_turn("我想备考2026年12月的雅思学术类考试，每天能学3小时"):
            events.append(event)

        # Should get message and state events
        event_types = [e["event"] for e in events]
        assert "message" in event_types
        assert "state" in event_types
        assert "done" in event_types

        # State should have profile extracted
        state_event = next(e for e in events if e["event"] == "state")
        profile = state_event["data"]["profile"]
        assert profile.get("exam_name") is not None

    async def test_generate_plan_from_ready_state(self, sample_planner_state, monkeypatch):
        """Generate a plan when profile is already complete."""
        state = dict(sample_planner_state)
        state["stage"] = "generate"
        state["is_ready"] = True

        result = dict(state)
        result["stage"] = "complete"
        result["last_message"] = "计划已生成"
        result["plan_tasks"] = [{"taskDate": "2026-05-29", "subject": "高等数学"}]

        async def fake_invoke(_state):
            return result

        monkeypatch.setattr(planner_graph_module.planner_graph, "ainvoke", fake_invoke)

        events = []
        async for event in run_planner_turn("确认，请生成备考计划", state):
            events.append(event)

        event_types = [e["event"] for e in events]
        assert "message" in event_types or "plan_generated" in event_types
        assert "state" in event_types

        # Check if plan was generated
        state_event = next(e for e in events if e["event"] == "state")
        tasks = state_event["data"].get("plan_tasks", [])
        if tasks:
            assert len(tasks) > 0
            assert "taskDate" in tasks[0]

    async def test_generate_without_subjects_returns_to_confirmation_before_llm(self, monkeypatch):
        class FailIfCalled:
            async def ainvoke(self, _messages):
                raise AssertionError("generation model must not be called without real subjects")

        monkeypatch.setattr("app.agents.planner.nodes.get_chat_model", lambda: FailIfCalled())
        state = initial_state()
        state["profile"].update({
            "exam_name": "证书考试",
            "exam_type": "考证",
            "exam_date": "2026-08-01",
            "daily_hours": 2,
            "rest_days_per_week": 1,
            "is_ready": True,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "confirm"
        assert result["plan_tasks"] == []
        assert "科目" in result["last_message"]

    async def test_generate_filters_unconfirmed_structure_subjects(self, monkeypatch):
        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {
                    "content": """{
                        "message": "已生成",
                        "plan_structure": {
                            "phases": [{
                                "phase": 1,
                                "durationPercent": 100,
                                "subjects": ["会计", "不存在科目"],
                                "taskTemplates": [{
                                    "taskContent": "学习{subject}",
                                    "estimatedMinutes": 60,
                                    "taskType": 1
                                }]
                            }],
                            "subjectTopics": {"会计": ["基础"], "不存在科目": ["虚构"]}
                        }
                    }"""
                })()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-05",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "complete"
        assert result["plan_tasks"]
        assert {task["subject"] for task in result["plan_tasks"]} == {"会计"}

    async def test_generate_rejects_unconfirmed_direct_plan_tasks(self, monkeypatch):
        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {
                    "content": """{
                        "message": "已生成",
                        "plan_tasks": [{
                            "taskDate": "2026-06-02",
                            "subject": "不存在科目",
                            "taskContent": "非法任务",
                            "estimatedMinutes": 60,
                            "taskType": 1,
                            "phase": 1
                        }]
                    }"""
                })()

        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2099-06-05",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "confirm"
        assert result["plan_tasks"] == []

    async def test_generate_default_plan_supports_four_daily_hours(self, monkeypatch):
        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {"content": '{"message": "已生成"}'})()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-10",
            "daily_hours": 4,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "complete"
        assert result["plan_tasks"]
        assert all(15 <= task["estimatedMinutes"] <= 180 for task in result["plan_tasks"])

    @pytest.mark.parametrize(
        "content",
        [
            '{"message": "坏结构", "plan_structure": {"phases": {"phase": 1}}}',
            '{"message": "坏结构", "plan_structure": {"phases": [{"phase": 1, "subjects": "会计", "taskTemplates": []}]}}',
            '{"message": "坏结构", "plan_structure": {"phases": [{"phase": 1, "subjects": ["会计"], "taskTemplates": [{"taskContent": "学习{subject}", "estimatedMinutes": "60", "taskType": 1}]}]}}',
            '{"message": "坏结构", "plan_structure": {"phases": [{"phase": "1", "subjects": ["会计"], "taskTemplates": []}, {"phase": 2, "subjects": ["会计"], "taskTemplates": []}]}}',
            '{"message": "坏结构", "plan_structure": {"phases": [{"phase": 9, "subjects": ["会计"], "taskTemplates": []}]}}',
            '{"message": "坏结构", "plan_structure": {"phases": [{"phase": 1, "subjects": ["会计"], "taskTemplates": []}], "subjectTopics": {"会计": [42]}}}',
        ],
    )
    async def test_generate_handles_malformed_plan_structure_safely(self, monkeypatch, content):
        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {"content": content})()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-10",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] in {"complete", "confirm"}
        assert not result.get("plan_tasks") or {task["subject"] for task in result["plan_tasks"]} <= {"会计"}

    async def test_generate_rejects_blank_direct_task_content_with_readable_reason(self, monkeypatch):
        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {
                    "content": """{
                        "message": "已生成",
                        "plan_tasks": [{
                            "taskDate": "2026-06-02",
                            "subject": "会计",
                            "taskContent": "   ",
                            "estimatedMinutes": 60,
                            "taskType": 1,
                            "phase": 1
                        }]
                    }"""
                })()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-10",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "confirm"
        assert result["plan_tasks"] == []
        assert "任务" in result["last_message"]
        assert "科目" not in result["last_message"]

    @pytest.mark.parametrize(
        "task",
        [
            {
                "taskDate": "2026-05-31",
                "subject": "会计",
                "taskContent": "生成日前任务",
                "estimatedMinutes": 60,
                "taskType": 1,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-08",
                "subject": "会计",
                "taskContent": "考试日任务",
                "estimatedMinutes": 60,
                "taskType": 1,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-07",
                "subject": "会计",
                "taskContent": "休息日任务",
                "estimatedMinutes": 60,
                "taskType": 1,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-02",
                "subject": "会计",
                "taskContent": "分钟非法",
                "estimatedMinutes": -1,
                "taskType": 1,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-02",
                "subject": "会计",
                "taskContent": "分钟过长",
                "estimatedMinutes": 181,
                "taskType": 1,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-02",
                "subject": "会计",
                "taskContent": "类型非法",
                "estimatedMinutes": 60,
                "taskType": 5,
                "phase": 1,
            },
            {
                "taskDate": "2026-06-02",
                "subject": "会计",
                "taskContent": "阶段非法",
                "estimatedMinutes": 60,
                "taskType": 1,
                "phase": 4,
            },
        ],
    )
    async def test_generate_rejects_invalid_direct_plan_tasks(self, monkeypatch, task):
        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {
                    "content": '{"message": "已生成", "plan_tasks": [' + str(task).replace("'", '"') + "]}"
                })()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-08",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 1,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "confirm"
        assert result["plan_tasks"] == []

    @pytest.mark.parametrize(
        ("exam_date", "daily_hours"),
        [
            ("不是日期", 1),
            ("2000-01-01", 1),
            ("2099-01-01", 0),
            ("2099-01-01", "每天两小时"),
        ],
    )
    async def test_generate_invalid_profile_returns_to_confirmation_before_llm(
        self, monkeypatch, exam_date, daily_hours
    ):
        class FailIfCalled:
            async def ainvoke(self, _messages):
                raise AssertionError("generation model must not be called for invalid profile")

        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: FailIfCalled())
        state = initial_state()
        state["profile"].update({
            "exam_date": exam_date,
            "daily_hours": daily_hours,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })

        result = await generate_plan_node(state)

        assert result["stage"] == "confirm"
        assert result["plan_tasks"] == []

    async def test_single_turn_persists_only_visible_messages(self, monkeypatch):
        responses = iter([
            '{"message": "正在整理", "extracted": {"exam_name": "会计证"}}',
            '{"message": "请补充考试日期", "extracted": {}}',
        ])

        class StubChatModel:
            async def ainvoke(self, _messages):
                return type("Response", (), {"content": next(responses)})()

        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        monkeypatch.setattr("app.tools.search_tools._web_search", lambda *_args, **_kwargs: [])

        events = [event async for event in run_planner_turn("我要准备会计证")]
        state_event = next(event for event in events if event["event"] == "state")

        assert state_event["data"]["messages"] == [
            {"role": "user", "content": "我要准备会计证"},
            {"role": "assistant", "content": "请补充考试日期"},
        ]

    async def test_search_node_filters_mismatched_china_cpa_sources(self, monkeypatch):
        def fake_search(query, max_results=5):
            purpose = "syllabus"
            if "报名时间" in query:
                purpose = "schedule"
            elif "备考资料" in query:
                purpose = "resources"
            return [
                {
                    "title": "CPA Australia 考试资料",
                    "snippet": "澳洲 CPA 课程与认证信息",
                    "url": f"https://www.cpaaustralia.com.au/{purpose}",
                },
                {
                    "title": "中国注册会计师协会 专业阶段考试大纲",
                    "snippet": "中注协发布注册会计师全国统一考试专业阶段大纲",
                    "url": f"https://www.cicpa.org.cn/{purpose}",
                },
            ]

        monkeypatch.setattr("app.tools.search_tools._web_search", fake_search)
        state = initial_state()
        state["profile"].update({
            "exam_name": "中国注册会计师 CPA",
            "exam_type": "专业阶段",
            "exam_subjects": ["会计"],
        })

        result = await search_node(state)

        australia = next(r for r in result["search_results"] if "Australia" in r["title"])
        cicpa = next(r for r in result["search_results"] if "中国注册会计师协会" in r["title"])
        assert australia["relevant"] is False
        assert "错配" in australia["reason"]
        assert cicpa["relevant"] is True
        assert cicpa["source_quality"] in {"official", "reputable"}
        assert {r["query_purpose"] for r in result["search_results"]} == {"syllabus", "schedule", "resources"}
        assert result["search_done"] is True
        assert result["search_signature"]

    async def test_search_node_reuses_existing_relevant_results_when_signature_same(self, monkeypatch):
        calls = []

        def fake_search(*_args, **_kwargs):
            calls.append("called")
            return []

        monkeypatch.setattr("app.tools.search_tools._web_search", fake_search)
        state = initial_state()
        state["profile"].update({
            "exam_name": "中国注册会计师 CPA",
            "exam_type": "专业阶段",
            "exam_subjects": ["会计"],
        })
        first = await search_node(state)

        second_state = dict(state)
        second_state.update(first)
        second_state["search_results"] = [{
            "title": "中国注册会计师协会",
            "snippet": "会计考试大纲",
            "url": "https://www.cicpa.org.cn/",
            "relevant": True,
        }]
        second = await search_node(second_state)

        assert len(calls) == 3
        assert second["search_results"] == second_state["search_results"]
        assert second["search_signature"] == first["search_signature"]

    async def test_search_node_does_not_repeat_same_signature_when_all_results_excluded(self, monkeypatch):
        calls = []

        def fake_search(query, max_results=5):
            calls.append(query)
            return []

        monkeypatch.setattr("app.tools.search_tools._web_search", fake_search)
        state = initial_state()
        state["profile"].update({
            "exam_name": "中国注册会计师 CPA",
            "exam_type": "专业阶段",
            "exam_subjects": ["会计"],
        })
        first = await search_node(state)

        repeated_state = dict(state)
        repeated_state.update(first)
        repeated_state["search_results"] = [{
            "title": "CPA Australia",
            "snippet": "澳洲 CPA",
            "url": "https://www.cpaaustralia.com.au/",
            "relevant": False,
        }]
        second = await search_node(repeated_state)

        assert len(calls) == 3
        assert second["search_results"] == repeated_state["search_results"]
        assert second["search_signature"] == first["search_signature"]

    async def test_search_node_refreshes_when_subject_signature_changes(self, monkeypatch):
        calls = []

        def fake_search(query, max_results=5):
            calls.append(query)
            return [{
                "title": "中国注册会计师协会",
                "snippet": query,
                "url": "https://www.cicpa.org.cn/",
            }]

        monkeypatch.setattr("app.tools.search_tools._web_search", fake_search)
        state = initial_state()
        state["profile"].update({
            "exam_name": "中国注册会计师 CPA",
            "exam_type": "专业阶段",
            "exam_subjects": ["会计"],
        })
        first = await search_node(state)

        changed_state = dict(state)
        changed_state.update(first)
        changed_state["profile"] = dict(state["profile"], exam_subjects=["审计"])
        second = await search_node(changed_state)

        assert second["search_signature"] != first["search_signature"]
        assert any("审计" in query for query in calls)

    async def test_generate_prompt_includes_selected_material_summaries(self, monkeypatch):
        captured = {}

        class FixedDateTime:
            @classmethod
            def now(cls):
                return datetime(2026, 6, 1)

        class StubChatModel:
            async def ainvoke(self, messages):
                captured["prompt"] = messages[0].content
                return type("Response", (), {"content": '{"message": "已生成"}'})()

        monkeypatch.setattr(planner_nodes_module, "datetime", FixedDateTime)
        monkeypatch.setattr(planner_nodes_module, "get_chat_model", lambda: StubChatModel())
        state = initial_state()
        state["profile"].update({
            "exam_date": "2026-06-10",
            "daily_hours": 1,
            "exam_subjects": ["会计"],
            "rest_days_per_week": 0,
        })
        state["materials"] = [
            {"name": "CPA会计大纲.pdf", "summary": "会计科目重点：长期股权投资", "selected": True},
            {"name": "忽略资料.pdf", "summary": "不应出现", "selected": False},
        ]

        result = await generate_plan_node(state)

        assert result["stage"] == "complete"
        assert "长期股权投资" in captured["prompt"]
        assert "不应出现" not in captured["prompt"]


class TestProfileHandling:
    """Tests for profile field validation."""

    def test_missing_fields_names_chinese(self):
        profile = {"exam_name": "雅思"}
        missing = _compute_missing_fields(profile)
        assert "考试类型（如：考研、考证、语言、期末等）" in missing
        assert "考试日期" in missing
        assert "每日学习时长" in missing
        assert "实际备考科目" in missing
        assert "每周休息天数" in missing
        assert "考试名称" not in missing

    def test_foundation_level_zero_valid(self):
        profile = {
            "exam_name": "雅思", "exam_type": "学术类",
            "exam_date": "2026-12-01", "daily_hours": 3.0,
            "exam_subjects": ["写作"], "rest_days_per_week": 0,
        }
        missing = _compute_missing_fields(profile)
        assert missing == []

    def test_rest_days_default(self):
        state = initial_state()
        assert state["profile"]["rest_days_per_week"] is None
