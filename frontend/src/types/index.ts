// ==================== Auth Types ====================
export interface User {
  userId: string
  nickname: string
  email: string
  avatarUrl?: string
  totalCheckins: number
  currentStreak: number
  maxStreak: number
  createdAt: string
}

export interface AuthResponse {
  accessToken: string
  refreshToken: string
  tokenType: string
  expiresIn: number
  user: User
}

export interface RegisterRequest {
  email: string
  password: string
  nickname: string
}

export interface LoginRequest {
  email: string
  password: string
}

// ==================== Plan Types ====================
export type SupervisionMode = 0 | 1 | 2 | 3 | 4
export type PlanStatus = 0 | 1 | 2
export type Phase = 1 | 2 | 3
export type FoundationLevel = 0 | 1 | 2

export interface PlanCreateRequest {
  examName: string
  examType: string
  examDate: string
  dailyHours: number
  foundationLevel: FoundationLevel
  weakSubjects: string[]
  currentMode: SupervisionMode
}

export interface PlanResponse {
  planId: string
  userId: string
  examName: string
  examType: string
  examDate: string
  dailyHours: number
  foundationLevel: FoundationLevel
  weakSubjects: string[]
  currentMode: SupervisionMode
  planStatus: PlanStatus
  currentPhase: Phase
  createdAt: string
  totalTasks: number
  completedTasks: number
  completionRate: number
}

// ==================== Task Types ====================
export type TaskType = 1 | 2 | 3 | 4
export type TaskStatus = 0 | 1 | 2 | 3
export type CheckinType = 1 | 2

export interface TaskResponse {
  taskId: string
  planId: string
  taskDate: string
  subject: string
  taskContent: string
  estimatedMinutes: number
  taskType: TaskType
  phase: Phase
  status: TaskStatus
  completedAt?: string
  checkinType?: CheckinType
}

// ==================== Checkin Types ====================
export interface CheckinRequest {
  planId: string
  content: string
  imageUrl?: string
  checkinType: CheckinType
  taskIds?: string[]
}

export interface EasterEggResponse {
  eggType: string
  content: string
}

export interface CheckinResponse {
  checkinId: string
  planId: string
  checkinDate: string
  completedTasks: number
  totalTasks: number
  completionRate: number
  currentStreak: number
  encouragement: string
  easterEgg?: EasterEggResponse
}

export interface CheckinHistoryItem {
  checkinId: string
  checkinDate: string
  completedTasks: number
  totalTasks: number
  completionRate: number
  isMakeup: number
  streakBroken: number
}

// ==================== Reminder Types ====================
export type ReminderType = 1 | 2 | 3
export type ScheduleType = 'MODE' | 'INTERVAL' | 'ABSOLUTE' | 'REPEATING'
export type ReminderStatus = 'PENDING' | 'PROCESSING' | 'TRIGGERED' | 'CANCELLED'

export interface Reminder {
  reminderId: string
  userId: string
  planId: string
  reminderType: ReminderType
  scheduleType: ScheduleType
  triggerTime: string
  intervalMinutes?: number
  repeatDaily: boolean
  timezone: string
  content: string
  isSent: number
  sentAt?: string
  status: ReminderStatus
  isRead: number
  taskIds?: string
  createdAt?: string
  updatedAt?: string
}

export interface ReminderSettingsResponse {
  mode: number
  customTimes: string[]
  monkingInterval: number
  hellInterval: number
  isActive: boolean
}

export interface ReminderConfigRequest {
  planId: string
  mode: number
  customTimes: string[]
  monkingInterval: number
  hellInterval: number
  isActive: boolean
}

export interface CreateReminderRequest {
  planId: string
  scheduleType: ScheduleType
  taskIds?: string[]
  intervalMinutes?: number
  triggerTime?: string
  timezone?: string
  repeatDaily?: boolean
}

// ==================== Chat / Planner Types ====================

export interface ChatMessageItem {
  role: 'user' | 'assistant'
  content: string
}

export interface SearchResultItem {
  title: string
  snippet: string
  url: string
  relevant: boolean
  query_purpose?: 'syllabus' | 'schedule' | 'resources'
  source_quality?: 'official' | 'reputable' | 'general'
  reason?: string
}

export interface PlannerMaterial {
  id: string
  kind: 'file' | 'image' | 'document' | 'link'
  name: string
  source?: string
  mime_type?: string
  summary: string
  selected: boolean
}

/** SSE event types from the planner agent */
export type SseEventType =
  | 'message'
  | 'search_start'
  | 'search_results'
  | 'confirm'
  | 'plan_generating'
  | 'plan_generated'
  | 'state'
  | 'done'
  | 'error'

export interface SseMessageData { content: string }
export interface SseSearchResultsData { results: SearchResultItem[] }
export interface SseConfirmData {
  profile: {
    exam_name?: string
    exam_type?: string
    exam_date?: string
    daily_hours?: number
    foundation_level?: number
    exam_subjects?: string[]
    weak_subjects: string[]
    rest_days_per_week: number | null
    missing_fields: string[]
    is_ready: boolean
  }
  materials?: PlannerMaterial[]
  search_results?: SearchResultItem[]
}
export interface SsePlanGeneratedData {
  tasks: GeneratedTask[]
  summary: string
  profile: Record<string, unknown>
}
export interface SseStateData {
  stage: string
  profile: Record<string, unknown>
  search_results: SearchResultItem[]
  materials?: PlannerMaterial[]
  search_signature?: string
  search_done: boolean
  plan_tasks: GeneratedTask[]
  messages: ChatMessageItem[]
}
export interface SseErrorData { message: string }

export interface GeneratedTask {
  taskDate: string
  subject: string
  taskContent: string
  estimatedMinutes: number
  taskType: number
  phase: number
}

// ==================== Report Types ====================
export interface WeeklyReportRequest {
  weekStart: string
  weekEnd: string
}

export interface SubjectStat {
  subject: string
  planned: number
  completed: number
  rate: number
  planned_minutes: number
  completed_minutes: number
}

export interface DailyBreakdown {
  date: string
  planned_count: number
  completed_count: number
  planned_minutes: number
  completed_minutes: number
  rate: number
}

export interface WeeklyReportResponse {
  weekStart?: string
  weekEnd?: string
  reportTitle?: string
  grade?: string
  totalTasks?: number
  completedTasks?: number
  completionRate?: number
  totalHours?: number
  streakDays?: number
  subjectBreakdown?: Record<string, number>
  subjectStats?: SubjectStat[]
  dailyBreakdown?: DailyBreakdown[]
  suggestions?: string[]
  summary?: string
  htmlContent?: string
  [key: string]: unknown
}

// ==================== API Response Wrapper ====================
export interface ApiResponse<T> {
  code: number
  message: string
  data: T
}

// ==================== UI Helper Constants ====================
export const SUPERVISION_MODE_LABELS: Record<SupervisionMode, string> = {
  0: '静默模式',
  1: '温柔模式',
  2: '强化模式',
  3: '唐僧模式',
  4: '地狱模式',
}

export const SUPERVISION_MODE_DESC: Record<SupervisionMode, string> = {
  0: '不打扰，自律学习',
  1: '每晚22:00温柔提醒',
  2: '21:00和22:00双提醒',
  3: '每30分钟督促，直到完成',
  4: '每15分钟毒舌督促，直到完成',
}

export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  0: '进行中',
  1: '已完成',
  2: '已暂停',
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  1: '学习',
  2: '复习',
  3: '刷题',
  4: '模考',
}

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  0: '未开始',
  1: '进行中',
  2: '已完成',
  3: '已跳过',
}

export const PHASE_LABELS: Record<Phase, string> = {
  1: '基础阶段',
  2: '强化阶段',
  3: '冲刺阶段',
}

export const FOUNDATION_LABELS: Record<FoundationLevel, string> = {
  0: '零基础',
  1: '有一定基础',
  2: '基础较好',
}

export const REMINDER_TYPE_LABELS: Record<ReminderType, string> = {
  1: '每日提醒',
  2: '督促提醒',
  3: '每周报告',
}

export const SCHEDULE_TYPE_LABELS: Record<ScheduleType, string> = {
  MODE: '预设模式',
  INTERVAL: '间隔提醒',
  ABSOLUTE: '定时提醒',
  REPEATING: '周期提醒',
}
