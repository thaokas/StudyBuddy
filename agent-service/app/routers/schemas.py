"""
Pydantic schemas for API request/response
"""
from pydantic import BaseModel, Field
from typing import Optional, List, Dict, Any
from datetime import date, datetime
from enum import IntEnum


# Enums
class SupervisionMode(IntEnum):
    SILENT = 0
    GENTLE = 1
    INTENSIVE = 2
    MONKING = 3


class Phase(IntEnum):
    FOUNDATION = 1
    REINFORCEMENT = 2
    SPRINT = 3


class TaskType(IntEnum):
    LEARN = 1
    REVIEW = 2
    PRACTICE = 3
    MOCK_EXAM = 4


class TaskStatus(IntEnum):
    NOT_STARTED = 0
    IN_PROGRESS = 1
    COMPLETED = 2
    SKIPPED = 3


# Request schemas
class ChatRequest(BaseModel):
    """对话请求"""
    user_id: str
    message: str
    context: Optional[Dict[str, Any]] = None


class CheckinRequest(BaseModel):
    """打卡请求"""
    completed_content: str = Field(..., description="今日完成的计划内容描述")
    overall_completion_rate: float = Field(..., ge=0, le=100, description="整体备考完成率（0-100）")
    image_url: Optional[str] = Field(default=None, description="打卡图片URL（可选）")


# Response schemas
class ChatResponse(BaseModel):
    """对话响应"""
    response: str
    action: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


class TaskSchema(BaseModel):
    """任务数据"""
    task_id: str
    task_date: date
    subject: str
    task_content: str
    estimated_minutes: int
    task_type: int
    phase: int
    status: int

    class Config:
        from_attributes = True


class CheckinResponse(BaseModel):
    """打卡响应"""
    encouragement: str


class ReminderGenerateRequest(BaseModel):
    """提醒生成请求"""
    today_total_tasks: List[Dict[str, Any]] = Field(..., description="今日全部任务")
    today_incomplete_tasks: List[Dict[str, Any]] = Field(..., description="今日未完成任务")
    exam_total_tasks: List[Dict[str, Any]] = Field(..., description="备考全部任务")
    exam_completed_tasks: List[Dict[str, Any]] = Field(..., description="备考已完成任务")
    elapsed_study_days: float = Field(..., ge=0, description="已消耗备考天数")
    total_study_days: float = Field(..., gt=0, description="备考总天数")
    strictness_mode: str = Field("gentle", description="silent/gentle/intensive/nightmare/tangseng")


class ReminderGenerateResponse(BaseModel):
    """提醒生成响应"""
    content: str


class TodayTasksResponse(BaseModel):
    """今日任务响应"""
    tasks: List[TaskSchema]
    completed_count: int
    total_count: int
    completion_rate: float


class ReminderSettingsRequest(BaseModel):
    """提醒设置请求"""
    mode: int = Field(1, ge=0, le=3, description="提醒模式：0-静默 1-温柔 2-强化 3-唐僧")
    custom_times: List[str] = []
    monking_interval: int = Field(30, ge=5, le=120)


class ReminderSettingsResponse(BaseModel):
    """提醒设置响应"""
    mode: int
    custom_times: List[str]
    monking_interval: int
    is_active: bool


class WeeklyReportRequest(BaseModel):
    """学习报告生成请求（支持任意日期范围，不限于自然周）"""
    user_id: str
    week_start: str = Field(..., description="起始日期，YYYY-MM-DD")
    week_end: Optional[str] = Field(default=None, description="结束日期，YYYY-MM-DD，不传则自动推算为起始+6天")
    total_plan: List[Dict[str, Any]] = Field(..., description="期间计划任务列表")
    weekly_completed: List[Dict[str, Any]] = Field(..., description="期间已完成的任务列表")


class WeeklyReportResponse(BaseModel):
    """学习报告响应"""
    report_id: Optional[str] = None
    user_id: str
    week_start: str
    week_end: str
    total_rate: float
    html_content: str
    summary: str
    total_planned: int = 0
    total_completed: int = 0
    completed_hours: float = 0.0
    streak_days: int = 0
    subject_stats: List[Dict[str, Any]] = []
    suggestions: List[str] = []
    report_title: str = ""
    grade: str = ""
    daily_breakdown: List[Dict[str, Any]] = []


class PlannerChatRequest(BaseModel):
    """SSE streaming plan generation request."""
    message: str = Field(..., description="User message for this turn")
    thread_id: Optional[str] = Field(None, description="Thread ID for multi-turn continuation")
    state: Optional[Dict[str, Any]] = Field(None, description="Previous agent state for multi-turn conversations")


class PlannerMaterialLinkRequest(BaseModel):
    """Public web material supplied for planner context."""
    url: str = Field(..., description="Public HTTP(S) URL containing readable study material")


class PlannerMaterialResponse(BaseModel):
    """A summarized material that can be included in a study plan."""
    id: str
    kind: str
    name: str
    source: Optional[str] = None
    mime_type: Optional[str] = None
    summary: str
    selected: bool = True
