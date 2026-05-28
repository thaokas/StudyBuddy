import type { ReminderPopupMessage } from '@/store/reminderStore'

export type ReminderNotificationPermission = NotificationPermission | 'unsupported'
export type ReminderPresentationChannel = 'notification' | 'popup'

export async function requestNotificationPermission(): Promise<ReminderNotificationPermission> {
  if (!('Notification' in window)) return 'unsupported'
  if (Notification.permission === 'default') {
    return Notification.requestPermission()
  }
  return Notification.permission
}

export function showBrowserNotification(message: ReminderPopupMessage) {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return

  try {
    new Notification('小搭提醒', {
      body: message.content.slice(0, 200),
      icon: '/favicon.ico',
      requireInteraction: true,
      tag: message.reminderId,
    })
  } catch {
    // Ignore optional system-notification failures; the history record remains available.
  }
}

export function getRealtimePresentationChannel(
  permission: ReminderNotificationPermission
): ReminderPresentationChannel {
  return permission === 'granted' ? 'notification' : 'popup'
}
