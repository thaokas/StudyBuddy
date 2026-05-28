import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { authApi, reminderApi } from '@/api'
import { useAuthStore } from '@/store/authStore'
import { useReminderWebSocket } from '@/hooks/useReminderWebSocket'
import {
  requestNotificationPermission,
  type ReminderNotificationPermission,
} from '@/hooks/reminderPresentation'
import { useReminderStore } from '@/store/reminderStore'
import ReminderPopup from '@/components/ReminderPopup'

const NAV_ITEMS = [
  { to: '/', label: '首页', icon: HomeIcon },
  { to: '/plans', label: '计划', icon: PlanIcon },
  { to: '/checkin', label: '打卡', icon: CheckinIcon, primary: true },
  { to: '/tasks', label: '任务', icon: TaskIcon },
  { to: '/profile', label: '我的', icon: ProfileIcon },
]

export default function Layout() {
  const { setUser, user } = useAuthStore()
  const navigate = useNavigate()
  const popupQueue = useReminderStore((s) => s.popupQueue)
  const dismissPopup = useReminderStore((s) => s.dismissPopup)
  const setUnreadCount = useReminderStore((s) => s.setUnreadCount)
  const [notificationPermission, setNotificationPermission] = useState<ReminderNotificationPermission>(
    () => getNotificationPermission()
  )

  // WebSocket 连接（登录后自动建立）
  useReminderWebSocket()

  const handleEnableNotifications = async () => {
    setNotificationPermission(await requestNotificationPermission())
  }

  useEffect(() => {
    if (!user) {
      authApi.me()
        .then((res) => setUser(res.data.data))
        .catch(() => {
          navigate('/login', { replace: true })
        })
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    reminderApi.getUnread()
      .then((res) => setUnreadCount(res.data.data.length))
      .catch(() => {})
  }, [setUnreadCount])

  return (
    <div className="min-h-screen min-h-[100dvh] w-full bg-slate-100 lg:bg-slate-50">
      <DesktopSidebar />

      <div className="min-h-screen min-h-[100dvh] max-w-md lg:max-w-none mx-auto lg:mx-0 lg:pl-64">
        <main className="min-h-screen min-h-[100dvh] px-4 pt-4 pb-24 lg:px-8 lg:py-8">
          <div className="w-full lg:max-w-7xl lg:mx-auto">
            <Outlet />
          </div>
        </main>
      </div>

      <MobileBottomNav />

      <ReminderPopup
        popup={popupQueue[0]}
        pendingCount={popupQueue.length}
        notificationPermission={notificationPermission}
        onDismiss={dismissPopup}
        onEnableNotifications={handleEnableNotifications}
      />
    </div>
  )
}

function MobileBottomNav() {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-30 max-w-md mx-auto bg-white border-t border-gray-100 safe-bottom lg:hidden">
      <div className="flex items-end h-16 px-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon, primary }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center justify-center gap-0.5 py-2 transition ${
                primary
                  ? ''
                  : isActive
                  ? 'text-blue-500'
                  : 'text-gray-400 hover:text-gray-600'
              }`
            }
          >
            {({ isActive }) =>
              primary ? (
                <div className="w-12 h-12 bg-blue-500 rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200 -mt-4">
                  <Icon active={isActive} className="w-6 h-6 text-white" />
                </div>
              ) : (
                <>
                  <Icon active={isActive} className="w-6 h-6" />
                  <span className="text-xs">{label}</span>
                </>
              )
            }
          </NavLink>
        ))}
      </div>
    </nav>
  )
}

function DesktopSidebar() {
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden lg:flex w-64 flex-col border-r border-slate-200 bg-white/95 px-4 py-6 shadow-sm">
      <div className="flex items-center gap-3 px-2">
        <img src="/logo.png" alt="小搭" className="h-11 w-11 rounded-2xl object-cover" />
        <div>
          <p className="text-base font-bold text-slate-900">小搭</p>
          <p className="text-xs text-slate-400">PrepKeeper</p>
        </div>
      </div>

      <nav className="mt-8 flex flex-1 flex-col gap-2">
        {NAV_ITEMS.map(({ to, label, icon: Icon, primary }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                isActive
                  ? 'bg-blue-50 text-blue-600 shadow-sm shadow-blue-100'
                  : primary
                  ? 'text-slate-600 hover:bg-slate-50 hover:text-blue-500'
                  : 'text-slate-500 hover:bg-slate-50 hover:text-slate-800'
              }`
            }
          >
            {({ isActive }) => (
              <>
                <Icon active={isActive} className="h-5 w-5" />
                <span>{label}</span>
              </>
            )}
          </NavLink>
        ))}
      </nav>

      <div className="rounded-3xl bg-gradient-to-br from-blue-50 to-cyan-50 p-4">
        <p className="text-sm font-semibold text-slate-800">今天也稳稳推进</p>
        <p className="mt-1 text-xs leading-5 text-slate-500">
          宽屏工作台会保留学习上下文，窄屏继续保持手机体验。
        </p>
      </div>
    </aside>
  )
}

function getNotificationPermission(): ReminderNotificationPermission {
  if (!('Notification' in window)) return 'unsupported'
  return Notification.permission
}

// Icon components
function HomeIcon({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  )
}

function PlanIcon({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
    </svg>
  )
}

function CheckinIcon({ className }: { className?: string; active: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
    </svg>
  )
}

function TaskIcon({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  )
}

function ProfileIcon({ className, active }: { className?: string; active: boolean }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill={active ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth={1.8}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
    </svg>
  )
}
