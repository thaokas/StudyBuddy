import type { CreateReminderRequest, ScheduleType } from '@/types'

export interface ReminderFormInput {
  planId: string
  scheduleType: ScheduleType
  taskIds: string[]
  intervalMinutes: number
  triggerDate?: string
  triggerTime?: string
  timezone: string
  now?: Date
}

export function buildCreateReminderRequest(input: ReminderFormInput): CreateReminderRequest {
  const base: CreateReminderRequest = {
    planId: input.planId,
    scheduleType: input.scheduleType,
    taskIds: input.taskIds.length > 0 ? input.taskIds : undefined,
    timezone: input.timezone,
  }

  if (input.scheduleType === 'INTERVAL') {
    return { ...base, intervalMinutes: input.intervalMinutes }
  }

  if (!input.triggerTime) {
    throw new Error('请选择触发时间')
  }

  if (input.scheduleType === 'ABSOLUTE') {
    if (!input.triggerDate) {
      throw new Error('请选择触发日期')
    }
    return {
      ...base,
      triggerTime: new Date(`${input.triggerDate}T${input.triggerTime}:00`).toISOString(),
    }
  }

  const now = input.now ?? new Date()
  const nextTrigger = new Date(`${formatLocalDate(now)}T${input.triggerTime}:00`)
  if (nextTrigger.getTime() <= now.getTime()) {
    nextTrigger.setDate(nextTrigger.getDate() + 1)
  }

  return {
    ...base,
    repeatDaily: true,
    triggerTime: nextTrigger.toISOString(),
  }
}

function formatLocalDate(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
