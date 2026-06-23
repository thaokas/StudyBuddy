import type { AxiosAdapter, AxiosResponse, InternalAxiosRequestConfig } from 'axios'
import client from '@/api/client'
import type { ApiResponse, PlanResponse, TaskResponse, WeeklyReportRequest } from '@/types'
import {
  manualCheckinHistory,
  manualCheckinResult,
  manualPlans,
  manualReminderHistory,
  manualReminderSettings,
  manualTasks,
  manualUser,
  manualWeeklyReport,
} from './mockData'

export function installManualMocks(scene: string) {
  client.defaults.adapter = createManualAdapter(scene)
  window.fetch = createManualFetch()
}

function createManualAdapter(scene: string): AxiosAdapter {
  return async (config) => {
    const method = (config.method || 'get').toUpperCase()
    const url = config.url || ''
    const params = (config.params || {}) as Record<string, unknown>
    const body = parseBody(config.data)

    let data: unknown

    if (method === 'GET' && url === '/auth/me') {
      data = ok(manualUser)
    } else if (method === 'POST' && url === '/auth/login') {
      data = ok({ user: manualUser, accessToken: 'manual-token', refreshToken: 'manual-refresh', tokenType: 'Bearer', expiresIn: 604800 })
    } else if (method === 'POST' && url === '/auth/register') {
      data = ok({ user: manualUser, accessToken: 'manual-token', refreshToken: 'manual-refresh', tokenType: 'Bearer', expiresIn: 604800 })
    } else if (method === 'GET' && url.startsWith('/plans/user/')) {
      data = ok(manualPlans)
    } else if (method === 'GET' && url.startsWith('/plans/')) {
      const planId = url.split('/').pop() || 'plan-408'
      data = ok(findPlan(planId))
    } else if (method === 'PUT' && url.includes('/mode')) {
      const planId = url.split('/')[2]
      data = ok({ ...findPlan(planId), currentMode: Number(params.mode ?? 1) })
    } else if (method === 'POST' && url === '/plans/with-tasks') {
      data = ok({ ...manualPlans[0], planId: 'plan-generated', examName: String(body.examName || '新建备考计划') })
    } else if (method === 'DELETE' && url.startsWith('/plans/')) {
      data = ok(null)
    } else if (method === 'GET' && url === '/tasks/today/all') {
      data = ok(manualTasks.filter((task) => task.taskDate === currentDate()))
    } else if (method === 'GET' && url === '/tasks/today') {
      const planId = String(params.planId || 'plan-408')
      data = ok(manualTasks.filter((task) => task.planId === planId && task.taskDate === currentDate()))
    } else if (method === 'GET' && url.startsWith('/tasks/plan/')) {
      const planId = url.split('/').pop() || 'plan-408'
      data = ok(manualTasks.filter((task) => task.planId === planId))
    } else if (method === 'POST' && url.includes('/complete')) {
      const taskId = url.split('/')[2]
      data = ok({ ...findTask(taskId), status: 2 })
    } else if (method === 'PUT' && url.includes('/status')) {
      const taskId = url.split('/')[2]
      data = ok({ ...findTask(taskId), status: Number(params.status ?? 2) })
    } else if (method === 'GET' && url === '/checkins/today') {
      data = ok(null)
    } else if (method === 'POST' && url === '/checkins') {
      data = ok(manualCheckinResult)
    } else if (method === 'POST' && url === '/checkins/upload-image') {
      data = ok({ imageUrl: './logo.png' })
    } else if (method === 'GET' && url === '/checkins/history') {
      data = ok(manualCheckinHistory())
    } else if (method === 'GET' && url === '/checkins/streak') {
      data = ok(manualUser.currentStreak)
    } else if (method === 'GET' && url === '/users/user-demo/stats') {
      data = ok({ totalCheckins: manualUser.totalCheckins, currentStreak: manualUser.currentStreak, maxStreak: manualUser.maxStreak })
    } else if (method === 'PUT' && url === '/users/user-demo') {
      data = ok({ ...manualUser, ...body })
    } else if (method === 'GET' && url === '/reminders/settings') {
      data = ok(manualReminderSettings)
    } else if (method === 'PUT' && url === '/reminders/config') {
      data = ok({ ...manualPlans[0], currentMode: Number(body.mode ?? manualPlans[0].currentMode) })
    } else if (method === 'GET' && url === '/reminders/history') {
      data = ok(manualReminderHistory)
    } else if (method === 'GET' && url === '/reminders/pending') {
      data = ok(manualReminderHistory.filter((reminder) => reminder.status === 'PENDING'))
    } else if (method === 'GET' && url === '/reminders/unread') {
      data = ok(scene === 'reminder-popup' ? manualReminderHistory.filter((r) => !r.isRead) : [])
    } else if (method === 'POST' && url === '/reminders/custom') {
      data = ok(manualReminderHistory[2])
    } else if ((method === 'PUT' || method === 'DELETE') && url.startsWith('/reminders/')) {
      data = ok(null)
    } else if (method === 'POST' && url === '/agent/report/weekly') {
      data = ok(manualWeeklyReport(body as unknown as WeeklyReportRequest))
    } else if (method === 'POST' && url.startsWith('/agent/planner/materials/')) {
      data = {
        id: 'material-demo',
        kind: 'document',
        name: '408 考纲.pdf',
        summary: '包含考试科目、题型比例和参考教材信息。',
        selected: true,
      }
    } else {
      data = ok(null)
    }

    return response(config, data)
  }
}

function createManualFetch(): typeof window.fetch {
  return async (input) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input)
    if (!url.includes('/api/agent/planner/chat')) {
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })
    }

    const encoder = new TextEncoder()
    const frames = plannerFrames().map((frame) => encoder.encode(frame))
    return new Response(
      new ReadableStream({
        async start(controller) {
          for (const frame of frames) {
            await delay(30)
            controller.enqueue(frame)
          }
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )
  }
}

function plannerFrames() {
  return [
    sse('message', {
      content:
        '我先帮你提取关键信息：目标是 2026 年考研计算机，每天可投入 4-5 小时；数学基础较好，英语和计算机网络需要重点照顾。接下来我会结合考纲和可用资料确认计划边界。',
    }),
    sse('search_results', {
      results: [
        {
          title: '全国硕士研究生招生考试计算机学科专业基础综合考试大纲',
          snippet: '覆盖数据结构、计算机组成原理、操作系统与计算机网络四个部分。',
          url: 'https://example.edu/syllabus',
          relevant: true,
          query_purpose: 'syllabus',
          source_quality: 'official',
          reason: '用于确认 408 考试范围。',
        },
        {
          title: '408 近年真题题型与复习建议',
          snippet: '整理选择题与综合题常见考点，适合作为强化阶段刷题依据。',
          url: 'https://example.edu/papers',
          relevant: true,
          query_purpose: 'resources',
          source_quality: 'reputable',
          reason: '用于估算刷题节奏。',
        },
      ],
    }),
    sse('confirm', {
      profile: {
        exam_name: '全国硕士研究生入学考试',
        exam_type: '计算机专业 408',
        exam_date: '2026-12-20',
        daily_hours: 5,
        foundation_level: 1,
        exam_subjects: ['政治', '英语', '数学一', '408 专业课'],
        weak_subjects: ['英语阅读', '计算机网络'],
        rest_days_per_week: 1,
        missing_fields: [],
        is_ready: true,
      },
      materials: [
        {
          id: 'material-408',
          kind: 'document',
          name: '408 考纲.pdf',
          summary: '考试范围、题型比例和推荐教材摘要。',
          selected: true,
        },
      ],
    }),
    sse('done', {}),
  ]
}

function sse(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function ok<T>(data: T): ApiResponse<T> {
  return { code: 0, message: 'success', data }
}

function response(config: InternalAxiosRequestConfig, data: unknown): AxiosResponse {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config,
  }
}

function findPlan(planId: string): PlanResponse {
  return manualPlans.find((plan) => plan.planId === planId) || manualPlans[0]
}

function findTask(taskId: string): TaskResponse {
  return manualTasks.find((task) => task.taskId === taskId) || manualTasks[0]
}

function parseBody(data: unknown): Record<string, unknown> {
  if (typeof data === 'string') {
    try {
      return JSON.parse(data)
    } catch {
      return {}
    }
  }
  return (data || {}) as Record<string, unknown>
}

function currentDate() {
  const date = new Date()
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
