"""Planner agent state definition."""
from typing import TypedDict, Optional


class PlannerState(TypedDict):
    # Conversation
    messages: list[dict]          # [{role, content}, ...]
    latest_user_message: str      # Most recent user input

    # Extracted profile
    profile: dict                 # exam_name, exam_type, exam_date, daily_hours, foundation_level, exam_subjects, weak_subjects, rest_days_per_week, missing_fields, is_ready

    # Search
    search_results: list[dict]    # [{title, snippet, url, relevant}, ...]
    search_done: bool
    search_signature: str | None  # Signature of profile/material facts used for search
    materials: list[dict]         # Uploaded or linked reference-material summaries

    # Stage tracking
    stage: str                    # extract_intent | ask_missing | confirm | generate | complete

    # Output
    plan_tasks: list[dict]        # Generated daily tasks
    last_message: str             # Assistant response for this turn
    ui_action: str                # none | show_search_results | show_confirm | show_plan_card

    # Error
    error: Optional[str]


def initial_state() -> PlannerState:
    return {
        "messages": [],
        "latest_user_message": "",
        "profile": {
            "exam_name": None,
            "exam_type": None,
            "exam_date": None,
            "daily_hours": None,
            "foundation_level": None,
            "exam_subjects": [],
            "weak_subjects": [],
            "rest_days_per_week": None,
            "missing_fields": [],
            "is_ready": False,
        },
        "search_results": [],
        "search_done": False,
        "search_signature": None,
        "materials": [],
        "stage": "extract_intent",
        "plan_tasks": [],
        "last_message": "",
        "ui_action": "none",
        "error": None,
    }
