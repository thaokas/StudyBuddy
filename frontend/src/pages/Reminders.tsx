import { useEffect, useState } from 'react'
import { reminderApi, planApi, taskApi } from '@/api'
import { useAuthStore } from '@/store/authStore'
import { useReminderStore } from '@/store/reminderStore'
import type {
  Reminder,
  ReminderSettingsResponse,
  PlanResponse,
  TaskResponse,
  CreateReminderRequest,
  SupervisionMode,
  ScheduleType,
} from '@/types'
import {
  REMINDER_TYPE_LABELS,
  SUPERVISION_MODE_LABELS,
  SUPERVISION_MODE_DESC,
  SCHEDULE_TYPE_LABELS,
} from '@/types'
import Loading from '@/components/Loading'
import Empty from '@/components/Empty'
import { buildCreateReminderRequest } from '@/pages/reminderFormState'
import { removeReminderFromHistory, toggleExpandedReminderIds } from '@/pages/reminderHistoryState'
import dayjs from 'dayjs'

type Tab = 'settings' | 'custom' | 'history'

export default function Reminders() {
  const user = useAuthStore((s) => s.user)
  const unreadCount = useReminderStore((s) => s.unreadCount)
  const [activeTab, setActiveTab] = useState<Tab>('settings')
  const [loading, setLoading] = useState(true)

  return (
    <div className="space-y-4 pb-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-800">提醒管理</h2>
        {unreadCount > 0 && (
          <span className="bg-red-500 text-white text-xs px-2 py-1 rounded-full">
            {unreadCount} 条未读
          </span>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
        {([
          ['settings', '提醒设置'],
          ['custom', '自定义提醒'],
          ['history', '提醒历史'],
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`flex-1 py-2 rounded-lg text-sm font-medium transition ${
              activeTab === key ? 'bg-white text-blue-500 shadow-sm' : 'text-gray-500'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'settings' ? (
        <ReminderSettings onLoaded={() => setLoading(false)} />
      ) : activeTab === 'custom' ? (
        <CustomReminders onLoaded={() => setLoading(false)} />
      ) : (
        <ReminderHistory onLoaded={() => setLoading(false)} />
      )}

      {loading && <Loading />}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Tab 1: 提醒设置（预设模式）
// ═══════════════════════════════════════════════════════════════
function ReminderSettings({ onLoaded }: { onLoaded: () => void }) {
  const user = useAuthStore((s) => s.user)

  const [plans, setPlans] = useState<PlanResponse[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [settings, setSettings] = useState<ReminderSettingsResponse | null>(null)
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')

  const [mode, setMode] = useState<SupervisionMode>(1)
  const [customTimes, setCustomTimes] = useState<string[]>(['21:00'])
  const [monkingInterval, setMonkingInterval] = useState(30)
  const [hellInterval, setHellInterval] = useState(15)
  const [isActive, setIsActive] = useState(true)

  useEffect(() => {
    const userId = user?.userId ?? localStorage.getItem('userId')
    if (!userId) return

    planApi.getByUser(userId).then((planRes) => {
      const active = planRes.data.data.filter((p) => p.planStatus === 0)
      setPlans(active)
      if (active.length > 0) {
        setSelectedPlanId(active[0].planId)
      }
    })

    reminderApi.getSettings().then((res) => {
      const s = res.data.data
      setSettings(s)
      setMode((s.mode ?? 1) as SupervisionMode)
      setCustomTimes(s.customTimes?.length ? s.customTimes : ['21:00'])
      setMonkingInterval(s.monkingInterval ?? 30)
      setHellInterval(s.hellInterval ?? 15)
      setIsActive(s.isActive)
    }).finally(() => onLoaded())
  }, [user])

  const handleAddTime = () => {
    if (customTimes.length >= 5) return
    setCustomTimes([...customTimes, ''])
  }

  const handleRemoveTime = (idx: number) => {
    setCustomTimes(customTimes.filter((_, i) => i !== idx))
  }

  const handleTimeChange = (idx: number, val: string) => {
    setCustomTimes(customTimes.map((t, i) => (i === idx ? val : t)))
  }

  const handleSave = async () => {
    if (!selectedPlanId) {
      setMsg('请先选择一个备考计划')
      return
    }
    const validTimes = customTimes.filter((t) => t.trim())
    if (validTimes.length === 0) {
      setMsg('请至少设置一个提醒时间')
      return
    }
    setSaving(true)
    setMsg('')
    try {
      await reminderApi.updateConfig({
        planId: selectedPlanId,
        mode,
        customTimes: validTimes,
        monkingInterval,
        hellInterval,
        isActive,
      })
      setMsg('设置已保存')
    } catch {
      setMsg('保存失败，请稍后重试')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      {/* Plan selector */}
      {plans.length > 1 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-2">关联计划</label>
          <div className="flex gap-2 flex-wrap">
            {plans.map((plan) => (
              <button
                key={plan.planId}
                onClick={() => setSelectedPlanId(plan.planId)}
                className={`px-3 py-1.5 rounded-xl text-sm border transition ${
                  selectedPlanId === plan.planId
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white text-gray-600 border-gray-200'
                }`}
              >
                {plan.examName}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mode selector */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">督促模式</label>
        <div className="space-y-2">
          {([0, 1, 2, 3, 4] as SupervisionMode[]).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`w-full text-left px-4 py-3 rounded-xl border transition ${
                mode === m ? 'bg-blue-50 border-blue-400' : 'bg-white border-gray-200'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm">{SUPERVISION_MODE_LABELS[m]}</span>
                {mode === m && <span className="text-blue-500">✓</span>}
              </div>
              <p className="text-xs text-gray-400 mt-0.5">{SUPERVISION_MODE_DESC[m]}</p>
            </button>
          ))}
        </div>
      </div>

      {/* Custom times */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-medium text-gray-700">自定义提醒时间</label>
          <button
            onClick={handleAddTime}
            disabled={customTimes.length >= 5}
            className="text-xs text-blue-500 disabled:text-gray-300"
          >
            + 添加时间
          </button>
        </div>
        <div className="space-y-2">
          {customTimes.map((time, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <input
                type="time"
                value={time}
                onChange={(e) => handleTimeChange(idx, e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {customTimes.length > 1 && (
                <button
                  onClick={() => handleRemoveTime(idx)}
                  className="text-red-400 text-sm px-2"
                >
                  删除
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Monking interval (唐僧模式) */}
      {mode === 3 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            唐僧模式间隔：{monkingInterval} 分钟
          </label>
          <input
            type="range"
            min={5}
            max={120}
            step={5}
            value={monkingInterval}
            onChange={(e) => setMonkingInterval(Number(e.target.value))}
            className="w-full accent-blue-500"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>5分钟</span>
            <span>120分钟</span>
          </div>
        </div>
      )}

      {/* Hell interval (地狱模式) */}
      {mode === 4 && (
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            地狱模式间隔：{hellInterval} 分钟
          </label>
          <input
            type="range"
            min={5}
            max={60}
            step={5}
            value={hellInterval}
            onChange={(e) => setHellInterval(Number(e.target.value))}
            className="w-full accent-red-500"
          />
          <div className="flex justify-between text-xs text-gray-400">
            <span>5分钟</span>
            <span>60分钟</span>
          </div>
        </div>
      )}

      {/* Active toggle */}
      <div className="flex items-center justify-between bg-white rounded-xl p-3 shadow-sm">
        <span className="text-sm font-medium text-gray-700">启用提醒</span>
        <button
          onClick={() => setIsActive(!isActive)}
          className={`w-12 h-7 rounded-full transition relative ${
            isActive ? 'bg-blue-500' : 'bg-gray-300'
          }`}
        >
          <div
            className={`w-5 h-5 bg-white rounded-full absolute top-1 transition ${
              isActive ? 'left-6' : 'left-1'
            }`}
          />
        </button>
      </div>

      {/* Message */}
      {msg && (
        <div
          className={`text-sm px-4 py-3 rounded-xl ${
            msg.includes('失败') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'
          }`}
        >
          {msg}
        </div>
      )}

      {/* Save button */}
      <button
        onClick={handleSave}
        disabled={saving}
        className="w-full bg-blue-500 disabled:bg-blue-300 text-white py-3 rounded-xl font-medium hover:bg-blue-600 transition"
      >
        {saving ? '保存中...' : '保存设置'}
      </button>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Tab 2: 自定义提醒
// ═══════════════════════════════════════════════════════════════
function CustomReminders({ onLoaded }: { onLoaded: () => void }) {
  const user = useAuthStore((s) => s.user)

  const [plans, setPlans] = useState<PlanResponse[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState('')
  const [todayTasks, setTodayTasks] = useState<TaskResponse[]>([])
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([])

  const [scheduleType, setScheduleType] = useState<ScheduleType>('INTERVAL')
  const [intervalMinutes, setIntervalMinutes] = useState(30)
  const [triggerDate, setTriggerDate] = useState('')
  const [triggerTime, setTriggerTime] = useState('')

  const [pendingReminders, setPendingReminders] = useState<Reminder[]>([])
  const [creating, setCreating] = useState(false)
  const [msg, setMsg] = useState('')
  const realtimeRevision = useReminderStore((s) => s.realtimeRevision)

  useEffect(() => {
    const userId = user?.userId ?? localStorage.getItem('userId')
    if (!userId) return

    planApi.getByUser(userId).then((planRes) => {
      const active = planRes.data.data.filter((p) => p.planStatus === 0)
      setPlans(active)
      if (active.length > 0) {
        const planId = active[0].planId
        setSelectedPlanId(planId)
        loadTasks(planId)
      }
    })

    loadPendingReminders()
    onLoaded()
  }, [user])

  const loadTasks = (planId: string) => {
    taskApi.getByPlan(planId).then((res) => {
      const today = dayjs().format('YYYY-MM-DD')
      const tasks = res.data.data.filter(
        (t: TaskResponse) => t.taskDate === today && t.status !== 2 && t.status !== 3
      )
      setTodayTasks(tasks)
    }).catch(() => {})
  }

  const loadPendingReminders = () => {
    reminderApi.getPending().then((res) => {
      setPendingReminders(res.data.data.filter((reminder) => reminder.status === 'PENDING'))
    }).catch(() => {})
  }

  useEffect(() => {
    if (realtimeRevision > 0) {
      loadPendingReminders()
    }
  }, [realtimeRevision])

  const handlePlanChange = (planId: string) => {
    setSelectedPlanId(planId)
    setSelectedTaskIds([])
    loadTasks(planId)
  }

  const toggleTask = (taskId: string) => {
    setSelectedTaskIds((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    )
  }

  const handleCreate = async () => {
    if (!selectedPlanId) {
      setMsg('请先选择一个备考计划')
      return
    }
    if (scheduleType === 'INTERVAL' && (!intervalMinutes || intervalMinutes <= 0)) {
      setMsg('请输入有效的间隔分钟数')
      return
    }
    if (scheduleType === 'ABSOLUTE' && (!triggerDate || !triggerTime)) {
      setMsg('请选择触发日期和时间')
      return
    }
    if (scheduleType === 'REPEATING' && !triggerTime) {
      setMsg('请选择每天触发的时间')
      return
    }

    setCreating(true)
    setMsg('')

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone

    const body: CreateReminderRequest = buildCreateReminderRequest({
      planId: selectedPlanId,
      scheduleType,
      taskIds: selectedTaskIds,
      intervalMinutes,
      triggerDate,
      triggerTime,
      timezone,
    })

    try {
      await reminderApi.create(body)
      setMsg('提醒创建成功')
      setSelectedTaskIds([])
      loadPendingReminders()
    } catch {
      setMsg('创建失败，请稍后重试')
    } finally {
      setCreating(false)
    }
  }

  const handleCancel = async (reminderId: string) => {
    try {
      await reminderApi.cancel(reminderId)
      loadPendingReminders()
    } catch {
      // 忽略
    }
  }

  return (
    <div className="space-y-4">
      {/* Create form */}
      <div className="bg-white rounded-xl p-4 shadow-sm space-y-3">
        <h3 className="font-medium text-sm text-gray-700">创建新提醒</h3>

        {/* Plan selector */}
        {plans.length > 0 && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">关联计划</label>
            <div className="flex gap-2 flex-wrap">
              {plans.map((plan) => (
                <button
                  key={plan.planId}
                  onClick={() => handlePlanChange(plan.planId)}
                  className={`px-3 py-1 rounded-lg text-xs border ${
                    selectedPlanId === plan.planId
                      ? 'bg-blue-500 text-white border-blue-500'
                      : 'bg-white text-gray-600 border-gray-200'
                  }`}
                >
                  {plan.examName}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Schedule type selector */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">提醒类型</label>
          <div className="flex gap-2">
            {(['INTERVAL', 'ABSOLUTE', 'REPEATING'] as ScheduleType[]).map((t) => (
              <button
                key={t}
                onClick={() => setScheduleType(t)}
                className={`px-3 py-1.5 rounded-lg text-xs border transition ${
                  scheduleType === t
                    ? 'bg-blue-500 text-white border-blue-500'
                    : 'bg-white text-gray-600 border-gray-200'
                }`}
              >
                {SCHEDULE_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Time inputs */}
        {scheduleType === 'INTERVAL' ? (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">间隔分钟数</label>
            <input
              type="number"
              min={1}
              max={1440}
              value={intervalMinutes}
              onChange={(e) => setIntervalMinutes(Number(e.target.value))}
              className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="例如: 30"
            />
          </div>
        ) : (
          <div className={`grid gap-2 ${scheduleType === 'ABSOLUTE' ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {scheduleType === 'ABSOLUTE' && (
              <div>
                <label className="text-xs text-gray-400 mb-1 block">日期</label>
                <input
                  type="date"
                  value={triggerDate}
                  onChange={(e) => setTriggerDate(e.target.value)}
                  min={dayjs().format('YYYY-MM-DD')}
                  className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}
            <div>
              <label className="text-xs text-gray-400 mb-1 block">
                {scheduleType === 'REPEATING' ? '每天提醒时间' : '时间'}
              </label>
              <input
                type="time"
                value={triggerTime}
                onChange={(e) => setTriggerTime(e.target.value)}
                className="w-full px-3 py-2 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
        )}

        {/* Task selector */}
        {todayTasks.length > 0 && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              关联任务（可多选，不选则提醒所有未完成任务）
            </label>
            <div className="max-h-32 overflow-y-auto space-y-1">
              {todayTasks.map((task) => (
                <button
                  key={task.taskId}
                  onClick={() => toggleTask(task.taskId)}
                  className={`w-full text-left px-3 py-1.5 rounded-lg text-xs border transition ${
                    selectedTaskIds.includes(task.taskId)
                      ? 'bg-blue-50 border-blue-400 text-blue-600'
                      : 'bg-white border-gray-100 text-gray-600'
                  }`}
                >
                  <span className="font-medium">{task.subject}</span>
                  <span className="mx-1">-</span>
                  {task.taskContent}
                  <span className="text-gray-300 ml-1">({task.estimatedMinutes}分钟)</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {msg && (
          <div
            className={`text-xs px-3 py-2 rounded-lg ${
              msg.includes('失败') ? 'bg-red-50 text-red-600' : 'bg-green-50 text-green-600'
            }`}
          >
            {msg}
          </div>
        )}

        <button
          onClick={handleCreate}
          disabled={creating}
          className="w-full bg-blue-500 disabled:bg-blue-300 text-white py-2.5 rounded-xl text-sm font-medium hover:bg-blue-600 transition"
        >
          {creating ? '创建中...' : '创建提醒'}
        </button>
      </div>

      {/* Pending reminders list */}
      <div>
        <h3 className="font-medium text-sm text-gray-700 mb-2">
          待触发提醒 ({pendingReminders.length})
        </h3>
        {pendingReminders.length === 0 ? (
          <Empty text="暂无待触发的提醒" />
        ) : (
          <div className="space-y-2">
            {pendingReminders.map((r) => (
              <div key={r.reminderId} className="bg-white rounded-xl p-3 shadow-sm flex items-center justify-between">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-yellow-50 text-yellow-600 px-2 py-0.5 rounded-full">
                      {SCHEDULE_TYPE_LABELS[r.scheduleType] || r.scheduleType}
                    </span>
                    <span className="text-xs text-gray-400">
                      {dayjs(r.triggerTime).format('M月D日 HH:mm')}
                    </span>
                  </div>
                  {r.intervalMinutes && (
                    <p className="text-xs text-gray-400 mt-1">
                      间隔: {r.intervalMinutes} 分钟
                      {r.repeatDaily ? ' (每天重复)' : ''}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => handleCancel(r.reminderId)}
                  className="text-xs text-red-400 px-3 py-1 rounded-lg hover:bg-red-50 transition shrink-0"
                >
                  取消
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════
// Tab 3: 提醒历史
// ═══════════════════════════════════════════════════════════════
function ReminderHistory({ onLoaded }: { onLoaded: () => void }) {
  const [history, setHistory] = useState<Reminder[]>([])
  const [expandedReminderIds, setExpandedReminderIds] = useState<Set<string>>(() => new Set())
  const setUnreadCount = useReminderStore((s) => s.setUnreadCount)

  useEffect(() => {
    reminderApi.getHistory()
      .then((res) => setHistory(res.data.data))
      .finally(() => onLoaded())
    reminderApi.getUnread()
      .then((res) => setUnreadCount(res.data.data.length))
      .catch(() => {})
  }, [])

  const handleMarkRead = async (reminder: Reminder) => {
    if (reminder.isRead) return
    try {
      await reminderApi.markAsRead(reminder.reminderId)
      setHistory((prev) =>
        prev.map((r) => (r.reminderId === reminder.reminderId ? { ...r, isRead: 1 } : r))
      )
      const unread = await reminderApi.getUnread()
      setUnreadCount(unread.data.data.length)
    } catch {
      // 忽略
    }
  }

  const handleSelectReminder = (reminder: Reminder) => {
    setExpandedReminderIds((prev) => toggleExpandedReminderIds(prev, reminder.reminderId))
    void handleMarkRead(reminder)
  }

  const handleDeleteReminder = async (reminder: Reminder) => {
    if (!window.confirm('确定要删除这条提醒历史吗？')) return

    try {
      try {
        await reminderApi.deleteHistory(reminder.reminderId)
      } catch {
        // 兼容旧后端路由：历史删除失败时，回退到通用取消入口
        await reminderApi.cancel(reminder.reminderId)
      }
      setHistory((prev) => removeReminderFromHistory(prev, reminder.reminderId))
      setExpandedReminderIds((prev) => {
        const next = new Set(prev)
        next.delete(reminder.reminderId)
        return next
      })
      const unread = await reminderApi.getUnread()
      setUnreadCount(unread.data.data.length)
    } catch {
      alert('删除失败，请稍后重试')
    }
  }

  if (history.length === 0) return <Empty text="暂无提醒记录" />

  return (
    <div className="space-y-2">
      {history.map((r) => {
        const isExpanded = expandedReminderIds.has(r.reminderId)

        return (
          <div
            key={r.reminderId}
            className={`w-full text-left bg-white rounded-xl p-4 shadow-sm transition ${
              !r.isRead ? 'ring-2 ring-red-200' : ''
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <span className="text-xs bg-blue-50 text-blue-500 px-2 py-0.5 rounded-full">
                  {REMINDER_TYPE_LABELS[r.reminderType] || `类型${r.reminderType}`}
                </span>
                {r.scheduleType && r.scheduleType !== 'MODE' && (
                  <span className="text-xs bg-purple-50 text-purple-500 px-2 py-0.5 rounded-full">
                    {SCHEDULE_TYPE_LABELS[r.scheduleType]}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {r.isRead === 0 && (
                  <span className="text-xs bg-red-50 text-red-500 px-2 py-0.5 rounded-full">未读</span>
                )}
                <span className={`text-xs ${r.isSent ? 'text-green-500' : 'text-gray-400'}`}>
                  {r.isSent ? '已发送' : '未发送'}
                </span>
              </div>
            </div>
            <button
              type="button"
              aria-expanded={isExpanded}
              onClick={() => handleSelectReminder(r)}
              className={`block w-full text-left text-sm text-gray-700 mt-2 ${
                isExpanded ? 'whitespace-pre-wrap break-words' : 'line-clamp-3'
              }`}
            >
              {r.content || '（无内容）'}
            </button>
            <div className="flex items-center justify-between mt-2">
              <span className="text-xs text-gray-400">
                {dayjs(r.triggerTime).format('M月D日 HH:mm')}
              </span>
              <div className="flex items-center gap-2">
                {r.sentAt && (
                  <span className="text-xs text-gray-400">
                    发送于 {dayjs(r.sentAt).format('HH:mm')}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleSelectReminder(r)}
                  className="text-xs text-blue-500"
                >
                  {isExpanded ? '收起全文' : '查看全文'}
                </button>
                <button
                  type="button"
                  onClick={() => handleDeleteReminder(r)}
                  className="text-xs text-red-400"
                >
                  删除
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
