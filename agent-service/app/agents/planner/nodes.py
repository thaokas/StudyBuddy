"""LangGraph nodes for the planner agent — ported from frontend agents/planGenerator.ts."""
import json
import logging
import math
import re
import hashlib
from datetime import date, datetime, timedelta

from langchain_core.messages import SystemMessage, HumanMessage

from app.agents.planner.state import PlannerState
from app.agents.planner.prompts import (
    EXTRACT_INTENT_PROMPT,
    ASK_MISSING_PROMPT,
    CONFIRM_PROMPT,
    GENERATE_PLAN_PROMPT,
)
from app.llm import get_chat_model

logger = logging.getLogger(__name__)

REQUIRED_FIELDS = [
    "exam_name",
    "exam_type",
    "exam_date",
    "daily_hours",
    "exam_subjects",
    "rest_days_per_week",
]
FIELD_LABELS = {
    "exam_name": "考试名称",
    "exam_type": "考试类型（如：考研、考证、语言、期末等）",
    "exam_date": "考试日期",
    "daily_hours": "每日学习时长",
    "exam_subjects": "实际备考科目",
    "rest_days_per_week": "每周休息天数",
}


def _parse_llm_json(text: str) -> dict:
    """Parse LLM output that should be JSON, with fallback strategies."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    code_block = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    if code_block:
        try:
            return json.loads(code_block.group(1).strip())
        except json.JSONDecodeError:
            pass

    brace_match = re.search(r"\{[\s\S]*\}", text)
    if brace_match:
        try:
            return json.loads(brace_match.group(0))
        except json.JSONDecodeError:
            pass

    return {"message": text}


def _is_future_iso_date(value: object, today: date | None = None) -> bool:
    if not isinstance(value, str):
        return False
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        return False
    return parsed > (today or date.today())


def _is_positive_hours(value: object) -> bool:
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and value > 0
    )


def _compute_missing_fields(profile: dict) -> list[str]:
    missing = []
    for field in REQUIRED_FIELDS:
        val = profile.get(field)
        if field == "exam_date":
            absent = not _is_future_iso_date(val)
        elif field == "daily_hours":
            absent = not _is_positive_hours(val)
        else:
            absent = val is None or val == "" or (field == "exam_subjects" and not val)
        if absent:
            missing.append(FIELD_LABELS.get(field, field))
    return missing


def _merge_profile(profile: dict, extracted: dict) -> dict:
    next_profile = dict(profile)
    if extracted.get("exam_name"):
        next_profile["exam_name"] = extracted["exam_name"]
    if extracted.get("exam_type"):
        next_profile["exam_type"] = extracted["exam_type"]
    if extracted.get("exam_date") is not None:
        next_profile["exam_date"] = extracted["exam_date"] if _is_future_iso_date(extracted["exam_date"]) else None
    if extracted.get("daily_hours") is not None:
        next_profile["daily_hours"] = extracted["daily_hours"] if _is_positive_hours(extracted["daily_hours"]) else None
    if extracted.get("foundation_level") is not None:
        next_profile["foundation_level"] = extracted["foundation_level"]
    if "exam_subjects" in extracted and isinstance(extracted["exam_subjects"], list):
        next_profile["exam_subjects"] = extracted["exam_subjects"]
    if "weak_subjects" in extracted and isinstance(extracted["weak_subjects"], list):
        next_profile["weak_subjects"] = extracted["weak_subjects"]
    if extracted.get("rest_days_per_week") is not None:
        try:
            next_profile["rest_days_per_week"] = max(0, min(3, int(extracted["rest_days_per_week"])))
        except (TypeError, ValueError):
            pass
    next_profile["missing_fields"] = _compute_missing_fields(next_profile)
    return next_profile


def _selected_materials(materials: list[dict] | None) -> list[dict]:
    return [material for material in materials or [] if material.get("selected") is not False]


def _materials_summary(materials: list[dict] | None) -> str:
    selected = _selected_materials(materials)
    if not selected:
        return "暂无用户补充资料。"
    lines = []
    for material in selected[:8]:
        name = material.get("name") or material.get("source") or "未命名资料"
        summary = str(material.get("summary", "")).strip()
        if summary:
            lines.append(f"- {name}: {summary[:1200]}")
    return "\n".join(lines) if lines else "暂无用户补充资料。"


def _build_search_signature(profile: dict, materials: list[dict] | None = None) -> str:
    payload = {
        "exam_name": profile.get("exam_name") or "",
        "exam_type": profile.get("exam_type") or "",
        "exam_subjects": sorted(str(subject) for subject in profile.get("exam_subjects") or []),
        "materials": [
            {
                "name": material.get("name") or "",
                "source": material.get("source") or "",
                "summary": str(material.get("summary", ""))[:500],
            }
            for material in _selected_materials(materials)
        ],
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()


def _build_search_queries(profile: dict, materials: list[dict] | None = None) -> list[tuple[str, str]]:
    subjects = " ".join(str(subject) for subject in profile.get("exam_subjects") or [])
    base_parts = [
        profile.get("exam_name") or "",
        profile.get("exam_type") or "",
        subjects,
    ]
    material_hint = " ".join(
        str(material.get("name") or material.get("summary", ""))[:40]
        for material in _selected_materials(materials)[:3]
    )
    base = " ".join(part for part in base_parts if part).strip()
    if material_hint:
        base = f"{base} {material_hint}".strip()
    return [
        ("syllabus", f"{base} 考试大纲 考试科目 考试范围 官方".strip()),
        ("schedule", f"{base} 报名时间 考试时间 考试要求 官方".strip()),
        ("resources", f"{base} 备考资料 教材 真题 网课 推荐".strip()),
    ]


def _has_relevant_results(results: list[dict] | None) -> bool:
    return any(result.get("relevant", True) for result in results or [])


def _should_refresh_search(state: PlannerState, signature: str) -> bool:
    if not state.get("search_done"):
        return True
    if state.get("search_signature") != signature:
        return True
    return not state.get("search_results")


def _is_china_cpa_profile(profile: dict) -> bool:
    text = f"{profile.get('exam_name', '')} {profile.get('exam_type', '')}".lower()
    return ("注册会计师" in text or "cpa" in text or "注会" in text) and not any(
        token in text for token in ["澳洲", "australia", "hkicpa", "香港"]
    )


def _classify_search_result(result: dict, profile: dict) -> dict:
    title = result.get("title", "")
    snippet = result.get("snippet", "")
    url = result.get("url", "")
    haystack = f"{title} {snippet} {url}".lower()
    relevant = True
    reason = "与考试名称、类型或备考资料关键词匹配。"
    if _is_china_cpa_profile(profile) and any(
        token in haystack
        for token in ["澳洲", "australia", "cpa australia", "hkicpa", "香港", "hong kong"]
    ):
        relevant = False
        reason = "疑似近名考试或地区错配，默认不采用。"

    source_quality = "general"
    official_tokens = ["财政部", "中注协", "中国注册会计师协会", "教育部", "考试院", "官网", "official", "gov.cn"]
    reputable_tokens = ["协会", "大学", "教育", "网校", "研究院"]
    if any(token.lower() in haystack for token in official_tokens):
        source_quality = "official"
    elif any(token.lower() in haystack for token in reputable_tokens):
        source_quality = "reputable"

    return {
        "title": title,
        "snippet": snippet,
        "url": url,
        "relevant": relevant,
        "source_quality": source_quality,
        "reason": reason,
    }


def _build_default_plan_structure(profile: dict) -> dict:
    subjects = profile.get("exam_subjects") or profile.get("weak_subjects") or []
    all_subjects = list(subjects)

    foundation_level = profile.get("foundation_level", 1)
    if foundation_level is None:
        foundation_level = 1
    phase_percents = {
        0: [50, 30, 20],
        1: [35, 40, 25],
        2: [25, 45, 30],
    }.get(foundation_level, [35, 40, 25])

    return {
        "phases": [
            {
                "phase": 1,
                "name": "基础阶段",
                "durationPercent": phase_percents[0],
                "description": "系统学习各科核心知识，建立完整知识框架",
                "subjects": list(subjects),
                "taskTemplates": [
                    {"taskContent": "学习{subject}：{topic}，理解核心概念与基本原理", "estimatedMinutes": 90, "taskType": 1},
                    {"taskContent": "完成{subject}基础练习题，巩固当天所学内容", "estimatedMinutes": 60, "taskType": 3},
                    {"taskContent": "整理{subject}笔记，回顾重点与难点", "estimatedMinutes": 30, "taskType": 2},
                ],
            },
            {
                "phase": 2,
                "name": "强化阶段",
                "durationPercent": phase_percents[1],
                "description": "针对薄弱科目专项突破，大量刷题提高解题能力",
                "subjects": list(reversed(subjects)),
                "taskTemplates": [
                    {"taskContent": "深入学习{subject}：{topic}，掌握高频考点与解题技巧", "estimatedMinutes": 60, "taskType": 1},
                    {"taskContent": "刷{subject}真题与模拟题，限时训练提高解题速度", "estimatedMinutes": 90, "taskType": 3},
                    {"taskContent": "分析错题，总结{subject}解题思路与易错点", "estimatedMinutes": 30, "taskType": 2},
                ],
            },
            {
                "phase": 3,
                "name": "冲刺阶段",
                "durationPercent": phase_percents[2],
                "description": "全真模拟考试，查漏补缺，调整应试状态",
                "subjects": all_subjects,
                "taskTemplates": [
                    {"taskContent": "完成一套全真模拟题，严格按考试时间作答", "estimatedMinutes": 120, "taskType": 4},
                    {"taskContent": "批改模拟题并针对性复习{subject}错题知识点", "estimatedMinutes": 60, "taskType": 2},
                ],
            },
        ],
        "subjectTopics": dict((s, [f"{s}核心知识点"]) for s in subjects),
    }


def _expand_plan_structure(plan_structure: dict, profile: dict, today_date: str) -> list[dict]:
    """Expand LLM plan structure into concrete daily tasks. Ported from expandPlanStructure()."""
    tasks: list[dict] = []
    exam_date_str = profile.get("exam_date")
    if not exam_date_str:
        return tasks

    try:
        today = date.fromisoformat(today_date)
    except ValueError:
        return tasks
    if not _is_future_iso_date(exam_date_str, today) or not _is_positive_hours(profile.get("daily_hours")):
        return tasks

    exam_date = date.fromisoformat(exam_date_str)
    daily_hours = profile["daily_hours"]
    target_daily_minutes = int(daily_hours * 60)
    rest_days_per_week = profile.get("rest_days_per_week")
    rest_count = max(0, min(3, int(rest_days_per_week))) if rest_days_per_week is not None else 0

    # Python weekday indexes: Friday=4, Saturday=5, Sunday=6.
    rest_days = set()
    if rest_count >= 1:
        rest_days.add(6)
    if rest_count >= 2:
        rest_days.add(5)
    if rest_count >= 3:
        rest_days.add(4)

    # Collect learning days
    learning_days: list[date] = []
    cursor = today
    while cursor < exam_date:
        if cursor.weekday() not in rest_days:
            learning_days.append(cursor)
        cursor = cursor + timedelta(days=1)

    if not learning_days:
        return tasks

    # Allocate days to phases
    phases = sorted(plan_structure.get("phases", []), key=lambda p: p.get("phase", 0))
    if not phases:
        return tasks

    remaining_days = len(learning_days)
    phase_day_counts: list[int] = []
    for i, phase in enumerate(phases):
        if remaining_days <= 0:
            phase_day_counts.append(0)
            continue
        if i == len(phases) - 1:
            count = remaining_days
        else:
            pct = phase.get("durationPercent", 33)
            count = min(remaining_days, max(1, int(len(learning_days) * pct / 100)))
        phase_day_counts.append(count)
        remaining_days -= count

    # Track topic progress per subject
    topic_index: dict[str, int] = {}
    subject_topics = plan_structure.get("subjectTopics", {})

    def get_next_topic(subject: str) -> str:
        topics = subject_topics.get(subject, [])
        if not topics:
            return f"{subject}重点内容"
        idx = topic_index.get(subject, 0)
        topic_index[subject] = idx + 1
        return topics[idx % len(topics)]

    day_offset = 0
    for pi, phase in enumerate(phases):
        phase_days = phase_day_counts[pi]
        permitted_subjects = profile.get("exam_subjects") or profile.get("weak_subjects") or []
        subjects = [subject for subject in phase.get("subjects", []) if subject in permitted_subjects]
        subjects = subjects or list(permitted_subjects)
        if not subjects:
            continue
        templates = phase.get("taskTemplates", [])
        if not templates:
            templates = [{"taskContent": "学习{subject}：{topic}", "estimatedMinutes": target_daily_minutes, "taskType": 1}]

        template_total_min = sum(t.get("estimatedMinutes", 0) for t in templates)
        scale = target_daily_minutes / template_total_min if template_total_min > 0 else 1

        for d in range(phase_days):
            day = learning_days[day_offset + d]
            subject = subjects[d % len(subjects)]
            topic = get_next_topic(subject)

            for template in templates:
                mins = round(template.get("estimatedMinutes", 60) * scale)
                tasks.append({
                    "taskDate": day.isoformat(),
                    "subject": subject,
                    "taskContent": template.get("taskContent", "")
                        .replace("{subject}", subject)
                        .replace("{topic}", topic),
                    "estimatedMinutes": max(15, min(180, mins)),
                    "taskType": template.get("taskType", 1),
                    "phase": phase.get("phase", 1),
                })
        day_offset += phase_days

    # Replace last learning day's tasks with pre-exam review
    if tasks:
        last_date = tasks[-1]["taskDate"]
        last_subject = tasks[-1]["subject"]
        tasks = [t for t in tasks if t["taskDate"] != last_date]
        tasks.append({
            "taskDate": last_date,
            "subject": last_subject,
            "taskContent": "整理考试用品，回顾重点公式和知识点，保持良好心态，早睡早起",
            "estimatedMinutes": max(15, min(180, target_daily_minutes)),
            "taskType": 2,
            "phase": 3,
        })

    return tasks


def _is_valid_plan_structure(plan_structure: object) -> bool:
    if not isinstance(plan_structure, dict):
        return False
    phases = plan_structure.get("phases")
    if not isinstance(phases, list) or not phases:
        return False
    subject_topics = plan_structure.get("subjectTopics", {})
    if not isinstance(subject_topics, dict):
        return False
    if any(
        not isinstance(subject, str)
        or not isinstance(topics, list)
        or any(not isinstance(topic, str) for topic in topics)
        for subject, topics in subject_topics.items()
    ):
        return False
    for phase in phases:
        if not isinstance(phase, dict) or not isinstance(phase.get("subjects", []), list):
            return False
        phase_number = phase.get("phase")
        if not isinstance(phase_number, int) or isinstance(phase_number, bool) or phase_number not in range(1, 4):
            return False
        duration = phase.get("durationPercent", 33)
        if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration):
            return False
        templates = phase.get("taskTemplates", [])
        if not isinstance(templates, list):
            return False
        for template in templates:
            if not isinstance(template, dict):
                return False
            minutes = template.get("estimatedMinutes", 60)
            if not isinstance(minutes, (int, float)) or isinstance(minutes, bool) or not math.isfinite(minutes):
                return False
            if not isinstance(template.get("taskContent", ""), str):
                return False
    return True


def _plan_tasks_validation_error(tasks: list[dict], profile: dict, today_date: str) -> str | None:
    if not tasks:
        return "未能生成有效的学习任务，请确认信息后重新生成计划。"

    confirmed_subjects = set(profile.get("exam_subjects") or [])
    try:
        start_date = date.fromisoformat(today_date)
        exam_date = date.fromisoformat(profile.get("exam_date", ""))
    except (TypeError, ValueError):
        return "考试日期无效，请确认日期后重新生成计划。"

    rest_count = profile.get("rest_days_per_week")
    rest_count = max(0, min(3, int(rest_count))) if rest_count is not None else 0
    rest_days = {6} if rest_count >= 1 else set()
    if rest_count >= 2:
        rest_days.add(5)
    if rest_count >= 3:
        rest_days.add(4)

    for task in tasks:
        try:
            task_date = date.fromisoformat(task.get("taskDate", ""))
        except (TypeError, ValueError):
            return "生成任务包含无效日期，请重新生成计划。"
        minutes = task.get("estimatedMinutes")
        task_type = task.get("taskType")
        phase = task.get("phase")
        if task.get("subject") not in confirmed_subjects:
            return "生成任务包含未确认的科目，请确认实际备考科目后重新生成计划。"
        if task_date < start_date or task_date >= exam_date or task_date.weekday() in rest_days:
            return "生成任务日期超出学习日范围，请重新生成计划。"
        if not isinstance(minutes, (int, float)) or isinstance(minutes, bool) or not math.isfinite(minutes):
            return "生成任务包含无效时长，请重新生成计划。"
        if not 15 <= minutes <= 180:
            return "生成任务时长必须在15到180分钟之间，请重新生成计划。"
        if not isinstance(task.get("taskContent"), str) or not task["taskContent"].strip():
            return "生成任务包含空白任务内容，请重新生成计划。"
        if not isinstance(task_type, int) or isinstance(task_type, bool) or task_type not in range(1, 5):
            return "生成任务类型无效，请重新生成计划。"
        if not isinstance(phase, int) or isinstance(phase, bool) or phase not in range(1, 4):
            return "生成任务阶段无效，请重新生成计划。"
    return None


def _determine_stage(state: PlannerState) -> str:
    profile = state.get("profile", {})
    stage = state.get("stage", "extract_intent")

    if stage == "complete":
        return "complete"

    if not profile.get("exam_name"):
        return "extract_intent"

    if not state.get("search_done") and stage != "generate":
        return "extract_intent"  # will trigger search

    if profile.get("missing_fields") and len(profile.get("missing_fields", [])) > 0:
        return "ask_missing"

    if not profile.get("is_ready"):
        return "confirm"

    if profile.get("is_ready") and not state.get("plan_tasks"):
        return "generate"

    return "complete"


def _get_relevant_search_text(results: list[dict]) -> str:
    relevant = [r for r in results if r.get("relevant", True)]
    if not relevant:
        return "暂无考试相关信息，请根据考试通用备考经验生成计划。"
    return "\n".join(
        f"[{r.get('query_purpose', 'evidence')}/{r.get('source_quality', 'general')}] "
        f"{r.get('title', '')}: {r.get('snippet', '')} ({r.get('url', '')})"
        for r in relevant
    )


# ── LangGraph Nodes ──

async def extract_intent_node(state: PlannerState) -> dict:
    """Node 1: Extract exam info from user message."""
    llm = get_chat_model()
    user_message = state.get("latest_user_message", "")
    messages = [HumanMessage(content=user_message)]
    system_msg = SystemMessage(content=EXTRACT_INTENT_PROMPT)

    resp = await llm.ainvoke([system_msg] + messages)
    parsed = _parse_llm_json(resp.content)
    extracted = parsed.get("extracted", {}) or {}

    profile = _merge_profile(state.get("profile", {}), extracted)
    return {
        "profile": profile,
        "last_message": parsed.get("message", "收到！让我来帮你规划备考计划。"),
        "messages": state.get("messages", []) + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": parsed.get("message", "")},
        ],
    }


async def search_node(state: PlannerState) -> dict:
    """Node 2: Search web for exam info."""
    from app.tools.search_tools import _web_search

    profile = state.get("profile", {})
    materials = state.get("materials", [])
    signature = _build_search_signature(profile, materials)
    if not _should_refresh_search(state, signature):
        return {
            "search_results": state.get("search_results", []),
            "search_done": True,
            "search_signature": signature,
        }

    search_results = []
    seen_urls = set()
    for purpose, query in _build_search_queries(profile, materials):
        raw_results = _web_search(query, max_results=5)
        for raw in raw_results:
            url = raw.get("url", "")
            dedupe_key = url or f"{raw.get('title', '')}|{raw.get('snippet', '')}"
            if dedupe_key in seen_urls:
                continue
            seen_urls.add(dedupe_key)
            item = _classify_search_result(raw, profile)
            item["query_purpose"] = purpose
            item["query"] = query
            search_results.append(item)

    return {
        "search_results": search_results,
        "search_done": True,
        "search_signature": signature,
    }


async def ask_missing_node(state: PlannerState) -> dict:
    """Node 3: Ask user for missing information."""
    llm = get_chat_model()
    profile = state.get("profile", {})
    search_results = state.get("search_results", [])
    materials = state.get("materials", [])
    user_message = state.get("latest_user_message", "")

    search_summary = "\n".join(r.get("snippet", "") for r in search_results[:5]) if search_results else "暂无搜索结果"
    missing_fields = "、".join(profile.get("missing_fields", []))

    prompt = ASK_MISSING_PROMPT.replace("{profile_json}", json.dumps(profile, ensure_ascii=False, indent=2))
    prompt = prompt.replace("{search_summary}", search_summary)
    prompt = prompt.replace("{materials_summary}", _materials_summary(materials))
    prompt = prompt.replace("{missing_fields}", missing_fields)

    resp = await llm.ainvoke([SystemMessage(content=prompt), HumanMessage(content=user_message)])
    parsed = _parse_llm_json(resp.content)
    extracted = parsed.get("extracted", {}) or {}

    profile = _merge_profile(profile, extracted)
    return {
        "profile": profile,
        "last_message": parsed.get("message", "明白了！还有其他信息需要补充吗？"),
        "messages": state.get("messages", []) + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": parsed.get("message", "")},
        ],
    }


async def confirm_node(state: PlannerState) -> dict:
    """Node 4: Summarize and confirm collected info."""
    llm = get_chat_model()
    profile = state.get("profile", {})
    search_results = state.get("search_results", [])
    materials = state.get("materials", [])
    user_message = state.get("latest_user_message", "")

    search_summary = "\n".join(
        r.get("snippet", "") for r in search_results[:5] if r.get("relevant", True)
    ) if search_results else "暂无"
    today_date = datetime.now().strftime("%Y年%m月%d日")

    prompt = CONFIRM_PROMPT.replace("{profile_json}", json.dumps(profile, ensure_ascii=False, indent=2))
    prompt = prompt.replace("{search_summary}", search_summary)
    prompt = prompt.replace("{materials_summary}", _materials_summary(materials))
    prompt = prompt.replace("{today_date}", today_date)

    resp = await llm.ainvoke([SystemMessage(content=prompt), HumanMessage(content=user_message)])
    parsed = _parse_llm_json(resp.content)
    extracted = parsed.get("extracted", {}) or {}

    if extracted:
        profile = _merge_profile(profile, extracted)

    if parsed.get("confirmation"):
        profile["is_ready"] = True
        profile["missing_fields"] = []
        new_stage = "generate"
    else:
        profile["is_ready"] = False
        profile["missing_fields"] = _compute_missing_fields(profile)
        new_stage = "confirm"

    return {
        "profile": profile,
        "stage": new_stage,
        "last_message": parsed.get("message", "以上是收集到的信息，请确认是否正确？"),
        "messages": state.get("messages", []) + [
            {"role": "user", "content": user_message},
            {"role": "assistant", "content": parsed.get("message", "")},
        ],
    }


async def generate_plan_node(state: PlannerState) -> dict:
    """Node 5: Generate the study plan with daily tasks."""
    profile = state.get("profile", {})
    confirmed_subjects = profile.get("exam_subjects") or []
    invalid_inputs = not _is_future_iso_date(profile.get("exam_date")) or not _is_positive_hours(profile.get("daily_hours"))
    if not confirmed_subjects or invalid_inputs:
        profile = dict(profile)
        profile["is_ready"] = False
        profile["missing_fields"] = _compute_missing_fields(profile)
        return {
            "profile": profile,
            "stage": "confirm",
            "plan_tasks": [],
            "last_message": "请先补充有效的考试日期、每日学习时长和实际备考科目，我才能生成学习计划。",
            "ui_action": "show_confirm",
        }

    llm = get_chat_model()
    search_results = state.get("search_results", [])
    materials = state.get("materials", [])

    today_date = datetime.now().strftime("%Y-%m-%d")
    search_text = _get_relevant_search_text(search_results)
    weak_subjects = "、".join(profile.get("weak_subjects", [])) or "无特别薄弱科目"
    foundation_level = profile.get("foundation_level", 1)

    prompt = GENERATE_PLAN_PROMPT.replace("{profile_json}", json.dumps(profile, ensure_ascii=False, indent=2))
    prompt = prompt.replace("{search_results_text}", search_text)
    prompt = prompt.replace("{materials_summary}", _materials_summary(materials))
    prompt = prompt.replace("{today_date}", today_date)
    prompt = prompt.replace("{rest_days_per_week}", str(profile.get("rest_days_per_week", 1)))
    prompt = prompt.replace("{daily_hours}", str(profile.get("daily_hours", 2)))
    prompt = prompt.replace("{weak_subjects}", weak_subjects)
    prompt = prompt.replace("{exam_subjects}", "、".join(confirmed_subjects))
    prompt = prompt.replace("{foundation_level}", str(foundation_level))

    resp = await llm.ainvoke([SystemMessage(content=prompt)])
    parsed = _parse_llm_json(resp.content)

    plan_structure = parsed.get("plan_structure")
    if _is_valid_plan_structure(plan_structure):
        tasks = _expand_plan_structure(plan_structure, profile, today_date)
    elif parsed.get("plan_tasks"):
        tasks = [
            {
                "taskDate": t.get("taskDate", ""),
                "subject": t.get("subject", ""),
                "taskContent": t.get("taskContent", ""),
                "estimatedMinutes": t.get("estimatedMinutes", 60),
                "taskType": t.get("taskType", 1),
                "phase": t.get("phase", 1),
            }
            for t in parsed["plan_tasks"]
        ]
    else:
        default_structure = _build_default_plan_structure(profile)
        tasks = _expand_plan_structure(default_structure, profile, today_date)

    task_error = _plan_tasks_validation_error(tasks, profile, today_date)
    if task_error:
        return {
            "profile": profile,
            "stage": "confirm",
            "plan_tasks": [],
            "last_message": task_error,
            "ui_action": "show_confirm",
        }

    return {
        "stage": "complete",
        "plan_tasks": tasks,
        "last_message": parsed.get("message", "你的专属备考计划已经生成完毕！"),
        "ui_action": "show_plan_card",
    }
