"""Test configuration & shared fixtures."""
import pytest
from datetime import date, timedelta

from app.agents.planner.state import initial_state


@pytest.fixture
def sample_checkin_state():
    """Initial state for check-in tests."""
    return {
        "completed_content": "完成了高数第三章不定积分的学习和习题",
        "overall_completion_rate": 45.0,
        "image_url": None,
        "encouragement": "",
        "error": None,
    }


@pytest.fixture
def sample_planner_state():
    """Initial planner state with complete exam info."""
    exam_date = (date.today() + timedelta(days=90)).strftime("%Y-%m-%d")
    state = initial_state()
    state["profile"] = {
        "exam_name": "考研数学一",
        "exam_type": "考研",
        "exam_date": exam_date,
        "daily_hours": 3.0,
        "foundation_level": 0,
        "exam_subjects": ["高等数学", "线性代数"],
        "weak_subjects": ["线性代数"],
        "rest_days_per_week": 1,
        "missing_fields": [],
        "is_ready": True,
    }
    state["messages"] = [
        {"role": "user", "content": "帮我制定一个考研数学一的备考计划"},
        {"role": "assistant", "content": "好的！"},
    ]
    return state


@pytest.fixture
def sample_reminder_state():
    """Initial state for reminder tests."""
    return {
        "today_total_tasks": [
            {"subject": "数学", "name": "完成第三章习题", "estimated_minutes": 60},
            {"subject": "英语", "name": "背单词50个", "estimated_minutes": 30},
            {"subject": "政治", "name": "复习第二章", "estimated_minutes": 45},
        ],
        "today_incomplete_tasks": [
            {"subject": "数学", "name": "完成第三章习题", "estimated_minutes": 60},
            {"subject": "政治", "name": "复习第二章", "estimated_minutes": 45},
        ],
        "exam_total_tasks": [{"id": str(i)} for i in range(1, 51)],
        "exam_completed_tasks": [{"id": str(i)} for i in range(1, 16)],
        "elapsed_study_days": 30.0,
        "total_study_days": 90.0,
        "strictness_mode": "gentle",
        "current_time": None,
        "content": "",
        "error": None,
    }


@pytest.fixture
def sample_report_state():
    """Initial state for weekly report tests."""
    week_start = (date.today() - timedelta(days=date.today().weekday())).strftime("%Y-%m-%d")
    week_end = (date.today() - timedelta(days=date.today().weekday()) + timedelta(days=6)).strftime("%Y-%m-%d")
    return {
        "user_id": "test-user-001",
        "week_start": week_start,
        "week_end": week_end,
        "total_plan": [
            {"task_date": str(date.today() - timedelta(days=i)), "subject": "数学", "estimated_minutes": 60}
            for i in range(5)
        ] + [
            {"task_date": str(date.today() - timedelta(days=i)), "subject": "英语", "estimated_minutes": 30}
            for i in range(3)
        ] + [
            {"task_date": str(date.today() - timedelta(days=i)), "subject": "政治", "estimated_minutes": 45}
            for i in range(2)
        ],
        "weekly_completed": [
            {"task_date": str(date.today() - timedelta(days=i)), "subject": "数学", "estimated_minutes": 60}
            for i in range(4)
        ] + [
            {"task_date": str(date.today() - timedelta(days=i)), "subject": "英语", "estimated_minutes": 30}
            for i in range(2)
        ],
        "subject_stats": [],
        "total_planned": 0,
        "total_completed": 0,
        "total_rate": 0.0,
        "estimated_minutes_total": 0,
        "completed_minutes": 0,
        "streak_days": 0,
        "highlights": [],
        "issues": [],
        "html_content": "",
        "summary": "",
        "report_id": None,
        "error": None,
    }
