import client from './client'
import type { ApiResponse, PlannerMaterial, WeeklyReportRequest, WeeklyReportResponse } from '@/types'

/**
 * Connect to the planner SSE stream.
 *
 * Uses fetch() with ReadableStream instead of EventSource because:
 * 1. EventSource doesn't support POST
 * 2. EventSource doesn't support custom headers (needed for JWT)
 */
export function connectPlannerSSE(
  message: string,
  threadId: string | null,
  state: Record<string, unknown> | null,
  onEvent: (event: string, data: unknown) => void,
  onError: (error: string) => void,
  onComplete: () => void,
): AbortController {
  const controller = new AbortController()
  const token = localStorage.getItem('accessToken')

  fetch('/api/agent/planner/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      message,
      thread_id: threadId,
      state,
    }),
    signal: controller.signal,
  })
    .then(async (response) => {
      if (!response.ok) {
        const text = await response.text()
        onError(`HTTP ${response.status}: ${text}`)
        return
      }

      const reader = response.body?.getReader()
      if (!reader) {
        onError('No response body')
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      const handleFrame = (frame: string): boolean => {
        let event = 'message'
        const dataLines: string[] = []

        for (const line of frame.split(/\r?\n/)) {
          if (line.startsWith('event:')) {
            event = line.slice(6).trim() || 'message'
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5).replace(/^ /, ''))
          }
        }

        if (dataLines.length === 0) return false

        try {
          const data = JSON.parse(dataLines.join('\n'))
          if (event === 'done') {
            onComplete()
            return true
          }
          if (event === 'error') {
            onError(data.message || 'Unknown error')
            return true
          }
          onEvent(event, data)
        } catch {
          // Non-JSON event data is not part of the planner protocol.
        }
        return false
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        const frames = buffer.split(/\r?\n\r?\n/)
        buffer = frames.pop() || ''
        for (const frame of frames) {
          if (handleFrame(frame)) return
        }
      }

      buffer += decoder.decode()
      if (buffer.trim() && handleFrame(buffer)) return
      onComplete()
    })
    .catch((err) => {
      if (err.name !== 'AbortError') {
        onError(err.message || 'Network error')
      }
    })

  return controller
}

export const agentApi = {
  getWeeklyReport: (data: WeeklyReportRequest) =>
    client.post<ApiResponse<WeeklyReportResponse>>('/agent/report/weekly', data),

  parsePlannerFile: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return client.post<PlannerMaterial>('/agent/planner/materials/file', body)
  },

  parsePlannerLink: (url: string) =>
    client.post<PlannerMaterial>('/agent/planner/materials/link', { url }),

  /** Cancel an in-progress planner generation */
  cancelPlannerChat: (threadId: string) =>
    client.post('/agent/planner/chat/cancel', { thread_id: threadId }),
}
