import client from './client'
import type { ApiResponse, Reminder, ReminderSettingsResponse, ReminderConfigRequest, PlanResponse, CreateReminderRequest } from '@/types'

export const reminderApi = {
  getAll: () =>
    client.get<ApiResponse<Reminder[]>>('/reminders'),

  getSettings: () =>
    client.get<ApiResponse<ReminderSettingsResponse>>('/reminders/settings'),

  updateConfig: (data: ReminderConfigRequest) =>
    client.put<ApiResponse<PlanResponse>>('/reminders/config', data),

  getHistory: () =>
    client.get<ApiResponse<Reminder[]>>('/reminders/history'),

  // 新增
  create: (data: CreateReminderRequest) =>
    client.post<ApiResponse<Reminder>>('/reminders/custom', data),

  cancel: (reminderId: string) =>
    client.delete<ApiResponse<null>>(`/reminders/${reminderId}`),

  getPending: () =>
    client.get<ApiResponse<Reminder[]>>('/reminders/pending'),

  getUnread: () =>
    client.get<ApiResponse<Reminder[]>>('/reminders/unread'),

  markAsRead: (reminderId: string) =>
    client.put<ApiResponse<null>>(`/reminders/${reminderId}/read`),

  deleteHistory: (reminderId: string) =>
    client.delete<ApiResponse<null>>(`/reminders/history/${reminderId}`),
}
