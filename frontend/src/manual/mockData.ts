import dayjs from 'dayjs'
import type {
  CheckinHistoryItem,
  CheckinResponse,
  PlanResponse,
  Reminder,
  ReminderSettingsResponse,
  TaskResponse,
  User,
  WeeklyReportRequest,
  WeeklyReportResponse,
} from '@/types'

const today = dayjs().format('YYYY-MM-DD')

export const manualUser: User = {
  userId: 'user-demo',
  nickname: '张三',
  email: 'zhangsan@example.com',
  totalCheckins: 35,
  currentStreak: 12,
  maxStreak: 21,
  createdAt: '2026-03-10T08:00:00',
}

export const manualPlans: PlanResponse[] = [
  {
    planId: 'plan-408',
    userId: manualUser.userId,
    examName: '2026 考研计算机',
    examType: '全国硕士研究生入学考试',
    examDate: '2026-12-20',
    dailyHours: 5,
    foundationLevel: 1,
    weakSubjects: ['英语阅读', '计算机网络'],
    currentMode: 3,
    planStatus: 0,
    currentPhase: 1,
    createdAt: '2026-05-01T09:00:00',
    totalTasks: 150,
    completedTasks: 42,
    completionRate: 0.28,
  },
  {
    planId: 'plan-cet6',
    userId: manualUser.userId,
    examName: '大学英语六级',
    examType: '语言考试',
    examDate: '2026-06-14',
    dailyHours: 2,
    foundationLevel: 2,
    weakSubjects: ['听力', '写作'],
    currentMode: 1,
    planStatus: 0,
    currentPhase: 2,
    createdAt: '2026-04-18T10:30:00',
    totalTasks: 72,
    completedTasks: 48,
    completionRate: 0.67,
  },
  {
    planId: 'plan-past',
    userId: manualUser.userId,
    examName: '软考中级',
    examType: '资格考试',
    examDate: '2026-05-25',
    dailyHours: 3,
    foundationLevel: 1,
    weakSubjects: ['案例分析'],
    currentMode: 0,
    planStatus: 1,
    currentPhase: 3,
    createdAt: '2026-02-02T10:00:00',
    totalTasks: 90,
    completedTasks: 90,
    completionRate: 1,
  },
]

export const manualTasks: TaskResponse[] = [
  task('task-1', 'plan-408', today, '数据结构', '第三章 栈与队列：完成知识点梳理与例题复盘', 90, 1, 1, 0),
  task('task-2', 'plan-408', today, '英语', '背诵 List 12 单词并完成 2 篇阅读精读', 75, 2, 1, 2),
  task('task-3', 'plan-408', today, '高等数学', '定积分综合题 10 道，标记错题原因', 120, 3, 1, 1),
  task('task-4', 'plan-408', today, '计算机网络', '学习 TCP 拥塞控制，整理一页笔记', 80, 1, 1, 0),
  task('task-5', 'plan-cet6', today, '听力', '完成一套短篇新闻听力训练并订正', 45, 3, 2, 0),
  task('task-6', 'plan-cet6', today, '写作', '完成议论文模板默写与一篇限时作文', 60, 3, 2, 2),
  task('task-7', 'plan-408', dayjs().add(1, 'day').format('YYYY-MM-DD'), '组成原理', 'CPU 数据通路章节预习', 90, 1, 1, 0),
]

export const manualReminderSettings: ReminderSettingsResponse = {
  mode: 3,
  customTimes: ['21:00', '22:00'],
  monkingInterval: 30,
  hellInterval: 15,
  isActive: true,
}

export const manualReminderHistory: Reminder[] = [
  reminder('reminder-1', 'plan-408', 2, 'MODE', dayjs().hour(21).minute(0), '今天的高数任务还差最后一组题，先把错题原因写下来，再收尾会更稳。', 1, 1),
  reminder('reminder-2', 'plan-408', 2, 'MODE', dayjs().hour(21).minute(30), '距离休息还有一小段时间，英语阅读精读别只看答案，把定位句和干扰项也圈出来。', 1, 0),
  reminder('reminder-3', 'plan-cet6', 1, 'REPEATING', dayjs().add(1, 'day').hour(7).minute(30), '早上 7:30 记得完成六级听力训练。', 0, 0),
]

export const manualCheckinResult: CheckinResponse = {
  checkinId: 'checkin-success',
  planId: 'plan-408',
  checkinDate: today,
  completedTasks: 4,
  totalTasks: 5,
  completionRate: 80,
  currentStreak: 13,
  encouragement:
    '今天推进得很扎实，尤其是把错题原因写清楚这一点很关键。保持这种复盘密度，基础阶段会越走越稳。',
  easterEgg: {
    eggType: 'streak_13',
    content: '连续 13 天已达成：你已经把“开始学习”变成了日常动作。',
  },
}

export function manualCheckinHistory(): CheckinHistoryItem[] {
  return Array.from({ length: 30 }, (_, i) => {
    const date = dayjs().subtract(29 - i, 'day')
    const checked = ![3, 9, 16, 24].includes(i)
    return {
      checkinId: `history-${i}`,
      checkinDate: date.format('YYYY-MM-DD'),
      completedTasks: checked ? 3 + (i % 3) : 0,
      totalTasks: 5,
      completionRate: checked ? 60 + (i % 5) * 8 : 0,
      isMakeup: 0,
      streakBroken: checked ? 0 : 1,
    }
  })
}

export function manualWeeklyReport(request: WeeklyReportRequest): WeeklyReportResponse {
  const start = dayjs(request.weekStart)
  const dailyBreakdown = Array.from({ length: 7 }, (_, i) => {
    const date = start.add(i, 'day')
    const planned = [5, 4, 5, 4, 5, 3, 2][i]
    const completed = [5, 3, 4, 4, 5, 2, 1][i]
    return {
      date: date.format('YYYY-MM-DD'),
      planned_count: planned,
      completed_count: completed,
      planned_minutes: planned * 75,
      completed_minutes: completed * 70,
      rate: Math.round((completed / planned) * 100),
    }
  })

  return {
    weekStart: request.weekStart,
    weekEnd: request.weekEnd,
    reportTitle: '张三的本周学习报告',
    grade: 'A',
    totalTasks: 28,
    completedTasks: 24,
    completionRate: 86,
    totalHours: 31,
    streakDays: 7,
    subjectBreakdown: {
      数据结构: 9,
      英语: 7,
      高等数学: 8,
      计算机网络: 5,
      写作: 2,
    },
    subjectStats: [
      { subject: '数据结构', planned: 8, completed: 8, rate: 100, planned_minutes: 720, completed_minutes: 700 },
      { subject: '英语', planned: 7, completed: 5, rate: 71, planned_minutes: 525, completed_minutes: 390 },
      { subject: '高等数学', planned: 8, completed: 7, rate: 88, planned_minutes: 720, completed_minutes: 640 },
      { subject: '计算机网络', planned: 5, completed: 4, rate: 80, planned_minutes: 375, completed_minutes: 310 },
    ],
    dailyBreakdown,
    summary:
      '本周整体节奏稳定，数据结构和高数完成质量较高。英语阅读的完成率略低，建议把长难句复盘拆成更小颗粒度。',
    suggestions: [
      '英语阅读安排在精力更好的上午，减少临睡前硬啃文章的情况。',
      '高数错题继续保留“错误原因 + 同类题型”两列，方便周末集中复盘。',
      '计算机网络建议配合画图记忆，TCP/拥塞控制这类主题尤其适合流程图。',
    ],
  }
}

function task(
  taskId: string,
  planId: string,
  taskDate: string,
  subject: string,
  taskContent: string,
  estimatedMinutes: number,
  taskType: 1 | 2 | 3 | 4,
  phase: 1 | 2 | 3,
  status: 0 | 1 | 2 | 3,
): TaskResponse {
  return { taskId, planId, taskDate, subject, taskContent, estimatedMinutes, taskType, phase, status }
}

function reminder(
  reminderId: string,
  planId: string,
  reminderType: 1 | 2 | 3,
  scheduleType: 'MODE' | 'INTERVAL' | 'ABSOLUTE' | 'REPEATING',
  triggerAt: dayjs.Dayjs,
  content: string,
  isSent: number,
  isRead: number,
): Reminder {
  return {
    reminderId,
    userId: manualUser.userId,
    planId,
    reminderType,
    scheduleType,
    triggerTime: triggerAt.toISOString(),
    repeatDaily: scheduleType === 'REPEATING',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    content,
    isSent,
    sentAt: isSent ? triggerAt.add(1, 'minute').toISOString() : undefined,
    status: isSent ? 'TRIGGERED' : 'PENDING',
    isRead,
    taskIds: 'task-1,task-3',
    createdAt: triggerAt.subtract(1, 'hour').toISOString(),
  }
}
