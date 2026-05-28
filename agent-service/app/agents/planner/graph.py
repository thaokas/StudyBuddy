"""LangGraph state graph for the planner agent — multi-turn plan generation workflow."""
import logging
from typing import AsyncIterator

from langgraph.graph import StateGraph, END

from app.agents.planner.state import PlannerState, initial_state
from app.agents.planner.nodes import (
    extract_intent_node,
    search_node,
    ask_missing_node,
    confirm_node,
    generate_plan_node,
    _determine_stage,
    _build_search_signature,
    _should_refresh_search,
)

logger = logging.getLogger(__name__)


def _route_after_extract(state: PlannerState) -> str:
    """After extracting intent: search if we have exam_name, otherwise end."""
    profile = state.get("profile", {})
    signature = _build_search_signature(profile, state.get("materials", []))
    if profile.get("exam_name") and _should_refresh_search(state, signature):
        return "search"
    return "determine_stage"


def _route_after_search(state: PlannerState) -> str:
    """After search: determine next stage."""
    return "determine_stage"


def _route_after_ask(state: PlannerState) -> str:
    """After asking for missing info: stop and wait for user input."""
    return "end"


def _route_after_confirm(state: PlannerState) -> str:
    """After confirm: if user confirmed, go to generate; otherwise wait for user input."""
    if state.get("stage") == "generate":
        return "determine_stage"
    return "end"


def _determine_stage_route(state: PlannerState) -> str:
    """Route to appropriate stage based on profile completeness."""
    profile = state.get("profile", {})
    stage = state.get("stage", "extract_intent")

    if stage == "complete":
        return "end"

    if stage == "generate":
        return "generate_plan"

    if not profile.get("exam_name"):
        return "end"  # Need more user input

    if profile.get("is_ready"):
        return "generate_plan"

    missing = profile.get("missing_fields", [])
    if missing and len(missing) > 0:
        return "ask_missing"

    return "confirm"


# Build the graph
_builder = StateGraph(PlannerState)

_builder.add_node("extract_intent", extract_intent_node)
_builder.add_node("search", search_node)
_builder.add_node("ask_missing", ask_missing_node)
_builder.add_node("confirm", confirm_node)
_builder.add_node("generate_plan", generate_plan_node)

_builder.set_entry_point("extract_intent")

_builder.add_conditional_edges("extract_intent", _route_after_extract, {
    "search": "search",
    "determine_stage": "determine_stage",
    "end": END,
})
_builder.add_conditional_edges("search", _route_after_search, {
    "determine_stage": "determine_stage",
})
_builder.add_conditional_edges("ask_missing", _route_after_ask, {
    "determine_stage": "determine_stage",
    "end": END,
})
_builder.add_conditional_edges("confirm", _route_after_confirm, {
    "determine_stage": "determine_stage",
    "end": END,
})

# This is a virtual routing node — LangGraph needs it to be a real node
def _noop(state: PlannerState) -> dict:
    return {}

_builder.add_node("determine_stage", _noop)
_builder.add_conditional_edges("determine_stage", _determine_stage_route, {
    "ask_missing": "ask_missing",
    "confirm": "confirm",
    "generate_plan": "generate_plan",
    "end": END,
})

_builder.add_edge("generate_plan", END)

planner_graph = _builder.compile()


async def run_planner_turn(
    user_message: str,
    existing_state: dict | None = None,
) -> AsyncIterator[dict]:
    """Run one turn of the planner agent and yield SSE events.

    Args:
        user_message: The latest user input.
        existing_state: Previous state for multi-turn conversation (None for new conversation).

    Yields:
        SSE event dicts: {"event": "...", "data": {...}}
    """
    # Build initial state
    if existing_state:
        state = dict(existing_state)
        state["latest_user_message"] = user_message
        state["stage"] = existing_state.get("stage", "extract_intent")
        state["error"] = None
        state["ui_action"] = "none"
    else:
        state = initial_state()
        state["latest_user_message"] = user_message

    try:
        # Run the graph
        result = await planner_graph.ainvoke(state)

        # Emit events based on what happened in the graph
        if result.get("error"):
            yield {"event": "error", "data": {"message": result["error"]}}
            yield {"event": "done", "data": {}}
            return

        stage = result.get("stage", "extract_intent")
        search_results = result.get("search_results", [])
        materials = result.get("materials", state.get("materials", []))
        profile = result.get("profile", {})
        plan_tasks = result.get("plan_tasks", [])
        search_signature = result.get("search_signature", state.get("search_signature"))

        # Show search results on the first search or whenever refreshed evidence differs.
        previous_results = (existing_state or {}).get("search_results", [])
        if search_results and search_results != previous_results:
            yield {"event": "search_start", "data": {}}
            yield {"event": "search_results", "data": {"results": search_results}}

        # Emit assistant message
        last_msg = result.get("last_message", "")
        stored_messages = list((existing_state or {}).get("messages", []))
        if last_msg:
            yield {"event": "message", "data": {"content": last_msg}}
            stored_messages.extend([
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": last_msg},
            ])

        # Stage-specific UI actions
        if stage == "confirm":
            yield {
                "event": "confirm",
                "data": {
                    "profile": profile,
                    "materials": materials,
                    "search_results": search_results,
                },
            }
        elif stage == "complete" and plan_tasks:
            yield {
                "event": "plan_generated",
                "data": {
                    "tasks": plan_tasks,
                    "summary": last_msg,
                    "profile": profile,
                },
            }

        # Yield final state for client to persist
        yield {
            "event": "state",
            "data": {
                "stage": stage,
                "profile": profile,
                "search_results": search_results,
                "materials": materials,
                "search_signature": search_signature,
                "search_done": result.get("search_done", False),
                "plan_tasks": plan_tasks,
                "messages": stored_messages,
            },
        }

        yield {"event": "done", "data": {}}

    except Exception as e:
        logger.error(f"Planner agent error: {e}", exc_info=True)
        yield {"event": "error", "data": {"message": str(e)}}
        yield {"event": "done", "data": {}}
