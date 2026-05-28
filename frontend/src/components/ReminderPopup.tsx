import type { ReminderNotificationPermission } from '@/hooks/reminderPresentation'
import type { ReminderPopupMessage } from '@/store/reminderStore'

interface ReminderPopupProps {
  popup?: ReminderPopupMessage
  pendingCount: number
  notificationPermission: ReminderNotificationPermission
  onDismiss: () => void
  onEnableNotifications: () => void
}

export default function ReminderPopup({
  popup,
  pendingCount,
  notificationPermission,
  onDismiss,
  onEnableNotifications,
}: ReminderPopupProps) {
  if (!popup) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 px-4">
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminder-popup-title"
        className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-blue-500">实时提醒</p>
            <h2 id="reminder-popup-title" className="mt-1 text-lg font-bold text-gray-800">
              小搭提醒
            </h2>
          </div>
          {pendingCount > 1 && (
            <span className="shrink-0 rounded-full bg-red-50 px-2 py-1 text-xs text-red-500">
              还有 {pendingCount - 1} 条提醒
            </span>
          )}
        </div>

        <p className="mt-4 max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words text-sm leading-6 text-gray-700">
          {popup.content || '（无内容）'}
        </p>

        {popup.taskNames && popup.taskNames.length > 0 && (
          <div className="mt-4 rounded-xl bg-blue-50 px-3 py-2">
            <p className="text-xs font-medium text-blue-500">关联任务</p>
            <ul className="mt-1 space-y-1 text-sm text-gray-700">
              {popup.taskNames.map((taskName) => (
                <li key={taskName} className="break-words">
                  {taskName}
                </li>
              ))}
            </ul>
          </div>
        )}

        {notificationPermission === 'default' && (
          <button
            type="button"
            onClick={onEnableNotifications}
            className="mt-4 w-full rounded-xl bg-blue-50 py-2 text-sm font-medium text-blue-600 transition hover:bg-blue-100"
          >
            开启系统通知
          </button>
        )}

        <button
          type="button"
          onClick={onDismiss}
          className="mt-3 w-full rounded-xl bg-blue-500 py-3 font-medium text-white transition hover:bg-blue-600"
        >
          关闭提醒
        </button>
      </section>
    </div>
  )
}
