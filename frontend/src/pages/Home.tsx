import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { planApi, taskApi, checkinApi, authApi } from '@/api'
import { useAuthStore } from '@/store/authStore'
import type { PlanResponse, TaskResponse } from '@/types'
import { TASK_TYPE_LABELS } from '@/types'
import Loading from '@/components/Loading'
import dayjs from 'dayjs'

export default function Home() {
  const navigate = useNavigate()
  const { user, setUser } = useAuthStore()
  const [plans, setPlans] = useState<PlanResponse[]>([])
  const [todayTasks, setTodayTasks] = useState<TaskResponse[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)

  const activePlans = plans.filter((p) => p.planStatus === 0)
  const planNameMap = Object.fromEntries(plans.map((p) => [p.planId, p.examName]))

  useEffect(() => {
    const init = async () => {
      try {
        if (!user) {
          const meRes = await authApi.me()
          setUser(meRes.data.data)
        }
        const userId = user?.userId ?? localStorage.getItem('userId')
        if (!userId) return

        const [plansRes, streakRes] = await Promise.all([
          planApi.getByUser(userId),
          checkinApi.getStreak(),
        ])
        const fetchedPlans = plansRes.data.data
        setPlans(fetchedPlans)
        setStreak(streakRes.data.data)

        const runningPlans = fetchedPlans.filter((p: PlanResponse) => p.planStatus === 0)
        if (runningPlans.length > 0) {
          const tasksResults = await Promise.all(
            runningPlans.map((p: PlanResponse) => taskApi.getToday(p.planId)),
          )
          const allTasks = tasksResults.flatMap((res) => res.data.data)
          setTodayTasks(allTasks)
        }
      } catch (_) {
        // noop
      } finally {
        setLoading(false)
      }
    }
    init()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const completedToday = todayTasks.filter((t) => t.status === 2).length

  if (loading) return <Loading />

  return (
    <div className="space-y-4 pb-4 lg:grid lg:grid-cols-[1fr_minmax(17rem,0.35fr)] lg:items-start lg:gap-6 lg:space-y-0">
      {/* Header greeting */}
      <div className="bg-gradient-to-r from-blue-500 to-indigo-600 text-white rounded-2xl p-5 flex items-center justify-between lg:col-span-2">
        <div>
          <p className="text-blue-100 text-sm">你好，{user?.nickname ?? '同学'} 👋</p>
          <h2 className="text-xl font-bold mt-1">
            {dayjs().format('M月D日')} {getGreeting()}
          </h2>
          <div className="flex items-center gap-4 mt-3">
            <div className="text-center">
              <p className="text-2xl font-bold">{streak}</p>
              <p className="text-blue-100 text-xs">连续打卡天数</p>
            </div>
            <div className="w-px h-10 bg-blue-300" />
            <div className="text-center">
              <p className="text-2xl font-bold">{user?.totalCheckins ?? 0}</p>
              <p className="text-blue-100 text-xs">累计打卡</p>
            </div>
            <div className="w-px h-10 bg-blue-300" />
            <div className="text-center">
              <p className="text-2xl font-bold">{user?.maxStreak ?? 0}</p>
              <p className="text-blue-100 text-xs">最长连续</p>
            </div>
          </div>
        </div>
        <img src="/logo.png" alt="logo" className="w-24 h-24 rounded-xl flex-shrink-0 ml-4" />
      </div>

      {/* Today's tasks - enlarged, scrollable */}
      {activePlans.length > 0 ? (
        <div className="bg-white rounded-2xl p-5 shadow-sm lg:self-stretch">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-gray-800">今日计划</h3>
            {todayTasks.length > 0 && (
              <span className="text-sm text-gray-400">{completedToday}/{todayTasks.length}</span>
            )}
          </div>
          {todayTasks.length > 0 ? (
            <div className="space-y-2 max-h-[28rem] lg:max-h-[calc(100vh-16rem)] overflow-y-auto pr-1">
              {todayTasks.map((task) => (
                <div
                  key={task.taskId}
                  className="flex items-center gap-3 p-3 bg-gray-50 rounded-xl"
                >
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${
                    task.status === 2 ? 'bg-green-400' :
                    task.status === 1 ? 'bg-yellow-400' : 'bg-gray-300'
                  }`} />
                  <div className="flex-1 min-w-0">
                    <p className={`text-sm font-medium truncate ${task.status === 2 ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                      {task.subject}
                    </p>
                    <p className="text-xs text-gray-400 truncate">{task.taskContent}</p>
                  </div>
                  <div className="flex flex-col items-end gap-0.5 flex-shrink-0">
                    <span className="text-xs text-blue-400 bg-blue-50 px-1.5 py-0.5 rounded">
                      {planNameMap[task.planId]}
                    </span>
                    <span className="text-xs text-gray-400">
                      {TASK_TYPE_LABELS[task.taskType]}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center py-16 text-center">
              <p className="text-gray-400 text-sm mb-3">今天暂无学习任务</p>
              <button
                onClick={() => navigate('/plans/create')}
                className="bg-blue-500 text-white px-6 py-2 rounded-xl text-sm hover:bg-blue-600 transition"
              >
                + 创建备考计划
              </button>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl p-5 shadow-sm lg:self-stretch">
          <h3 className="font-semibold text-gray-800 mb-3">今日计划</h3>
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <p className="text-gray-400 text-sm mb-3">你还没有进行中的备考计划</p>
            <button
              onClick={() => navigate('/plans/create')}
              className="bg-blue-500 text-white px-6 py-2 rounded-xl text-sm hover:bg-blue-600 transition"
            >
              + 创建备考计划
            </button>
          </div>
        </div>
      )}

      {/* Quick actions */}
      <div className="grid grid-cols-3 gap-3 lg:flex lg:flex-col lg:gap-3">
        <Link to="/plans" className="bg-white rounded-2xl p-4 shadow-sm flex flex-col items-center gap-1 hover:shadow-md transition lg:flex-row lg:items-center lg:gap-4">
          <span className="text-2xl">📋</span>
          <div className="text-center lg:text-left">
            <p className="font-medium text-gray-800 text-sm">备考计划</p>
            <p className="text-xs text-gray-400">{plans.length} 个</p>
          </div>
        </Link>
        <Link to="/chat" className="bg-white rounded-2xl p-4 shadow-sm flex flex-col items-center gap-1 hover:shadow-md transition lg:flex-row lg:items-center lg:gap-4">
          <img src="/logo.png" alt="小搭" className="w-10 h-10 lg:w-9 lg:h-9 rounded-xl" />
          <div className="text-center lg:text-left">
            <p className="font-medium text-gray-800 text-sm">小搭</p>
            <p className="text-xs text-gray-400">随时提问</p>
          </div>
        </Link>
        <Link to="/report" className="bg-white rounded-2xl p-4 shadow-sm flex flex-col items-center gap-1 hover:shadow-md transition lg:flex-row lg:items-center lg:gap-4">
          <span className="text-2xl">📊</span>
          <div className="text-center lg:text-left">
            <p className="font-medium text-gray-800 text-sm">学习报告</p>
            <p className="text-xs text-gray-400">查看周报</p>
          </div>
        </Link>
      </div>
    </div>
  )
}

function getGreeting() {
  const hour = new Date().getHours()
  if (hour < 6) return '凌晨好，夜猫子！'
  if (hour < 12) return '早上好，加油！'
  if (hour < 14) return '中午好，别忘了休息~'
  if (hour < 18) return '下午好，继续冲！'
  if (hour < 22) return '晚上好，加把劲！'
  return '深夜了，注意休息哦'
}
