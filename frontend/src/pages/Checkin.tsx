import { useEffect, useRef, useState } from 'react'
import { planApi, checkinApi, taskApi } from '@/api'
import { useAuthStore } from '@/store/authStore'
import type { PlanResponse, TaskResponse, CheckinResponse } from '@/types'
import Loading from '@/components/Loading'
import dayjs from 'dayjs'

const TASK_TYPE_LABELS: Record<number, string> = { 1: '学习', 2: '复习', 3: '刷题', 4: '模考' }

export default function Checkin() {
  const user = useAuthStore((s) => s.user)
  const [plans, setPlans] = useState<PlanResponse[]>([])
  const [selectedPlanId, setSelectedPlanId] = useState<string | null>(null)
  const [allTodayTasks, setAllTodayTasks] = useState<TaskResponse[]>([])
  const [todayCheckin, setTodayCheckin] = useState<CheckinResponse | null>(null)
  const [content, setContent] = useState('')
  const [selectedTasks, setSelectedTasks] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState<CheckinResponse | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const userId = user?.userId ?? localStorage.getItem('userId')
    if (!userId) return
    planApi.getByUser(userId).then((res) => {
      const active = res.data.data.filter((p) => p.planStatus === 0)
      setPlans(active)
      if (active.length > 0) {
        setSelectedPlanId(active[0].planId)
      } else {
        setLoading(false)
      }
    })
  }, [user])

  useEffect(() => {
    if (!selectedPlanId) return
    setLoading(true)
    Promise.all([
      taskApi.getTodayAll(),
      checkinApi.getToday(selectedPlanId),
    ]).then(([tasksRes, checkinRes]) => {
      setAllTodayTasks(tasksRes.data.data || [])
      setTodayCheckin(checkinRes.data.data)
    }).finally(() => setLoading(false))
  }, [selectedPlanId])

  const handleTaskToggle = (taskId: string) => {
    setSelectedTasks((prev) =>
      prev.includes(taskId) ? prev.filter((id) => id !== taskId) : [...prev, taskId]
    )
  }

  const handleImageSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    if (!file.type.startsWith('image/')) {
      alert('请选择图片文件')
      return
    }
    setImageFile(file)
    const reader = new FileReader()
    reader.onloadend = () => setImagePreview(reader.result as string)
    reader.readAsDataURL(file)
  }

  const removeImage = () => {
    setImageFile(null)
    setImagePreview(null)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSubmit = async () => {
    if (!selectedPlanId) return
    if (!content.trim() && !imageFile) {
      alert('请填写打卡内容或上传打卡图片')
      return
    }
    setSubmitting(true)
    try {
      let imageUrl: string | undefined
      if (imageFile) {
        setUploadingImage(true)
        const uploadRes = await checkinApi.uploadImage(imageFile)
        imageUrl = uploadRes.data.data.imageUrl
        setUploadingImage(false)
      }

      const res = await checkinApi.submit({
        planId: selectedPlanId,
        content,
        imageUrl,
        checkinType: imageFile ? 2 : 1,
        taskIds: selectedTasks,
      })
      setResult(res.data.data)
      setTodayCheckin(res.data.data)
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      alert(msg || '打卡失败，请稍后重试')
    } finally {
      setSubmitting(false)
      setUploadingImage(false)
    }
  }

  const planMap = new Map(plans.map((p) => [p.planId, p.examName]))

  if (loading) return <Loading />

  // Success state
  if (result) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] space-y-4">
        <div className="text-6xl">🎉</div>
        <h2 className="text-xl font-bold text-gray-800">打卡成功！</h2>
        <div className="bg-blue-50 rounded-2xl p-5 w-full text-center">
          <p className="text-blue-600 font-medium">{result.encouragement || '今天也很努力，继续加油！'}</p>
          <div className="flex justify-center gap-6 mt-4">
            <div>
              <p className="text-2xl font-bold text-blue-500">{result.currentStreak}</p>
              <p className="text-xs text-gray-400">连续打卡</p>
            </div>
            <div>
              <p className="text-2xl font-bold text-green-500">
                {Math.round(result.completionRate)}%
              </p>
              <p className="text-xs text-gray-400">完成率</p>
            </div>
          </div>
        </div>
        {result.easterEgg && (
          <div className="bg-yellow-50 border border-yellow-200 rounded-2xl p-4 w-full">
            <p className="text-yellow-600 font-medium text-sm">彩蛋解锁！</p>
            <p className="text-yellow-500 text-sm mt-1">{result.easterEgg.content}</p>
          </div>
        )}
        <button
          onClick={() => setResult(null)}
          className="w-full border border-gray-200 text-gray-600 py-3 rounded-xl hover:bg-gray-50 transition"
        >
          返回
        </button>
      </div>
    )
  }

  // Already checked in
  if (todayCheckin) {
    return (
      <div className="space-y-4 pb-4">
        <h2 className="text-lg font-bold text-gray-800">每日打卡</h2>
        <div className="bg-green-50 border border-green-200 rounded-2xl p-5 text-center">
          <div className="text-4xl mb-2">✅</div>
          <p className="font-medium text-green-700">今日已打卡</p>
          <p className="text-sm text-gray-500 mt-1">
            {dayjs().format('M月D日')} · 完成率 {Math.round(todayCheckin.completionRate)}%
          </p>
          {todayCheckin.encouragement && (
            <p className="text-sm text-blue-600 mt-2">{todayCheckin.encouragement}</p>
          )}
        </div>
        <div className="bg-white rounded-2xl p-4 shadow-sm text-center">
          <p className="text-3xl font-bold text-blue-500">{todayCheckin.currentStreak}</p>
          <p className="text-sm text-gray-400">连续打卡天数</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4 pb-4">
      <h2 className="text-lg font-bold text-gray-800">今日打卡</h2>
      <p className="text-sm text-gray-400">{dayjs().format('YYYY年M月D日')}</p>

      {/* Plan selector */}
      {plans.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {plans.map((plan) => (
            <button
              key={plan.planId}
              onClick={() => setSelectedPlanId(plan.planId)}
              className={`flex-shrink-0 px-3 py-1.5 rounded-xl text-sm border transition ${
                selectedPlanId === plan.planId
                  ? 'bg-blue-500 text-white border-blue-500'
                  : 'bg-white text-gray-600 border-gray-200'
              }`}
            >
              {plan.examName}
            </button>
          ))}
        </div>
      )}

      {plans.length === 0 ? (
        <div className="text-center py-16 text-gray-400 text-sm">暂无进行中的计划</div>
      ) : (
        <>
          {/* All today's tasks with scrollable preview */}
          {allTodayTasks.length > 0 && (
            <div className="bg-white rounded-2xl p-4 shadow-sm">
              <p className="font-medium text-gray-700 mb-3">
                今日任务 ({allTodayTasks.length})
              </p>
              <div className="max-h-60 overflow-y-auto space-y-2 pr-1">
                {allTodayTasks.map((task) => (
                  <label
                    key={task.taskId}
                    className="flex items-center gap-3 cursor-pointer py-1.5 px-2 rounded-lg hover:bg-gray-50 transition"
                  >
                    <input
                      type="checkbox"
                      checked={selectedTasks.includes(task.taskId)}
                      onChange={() => handleTaskToggle(task.taskId)}
                      className="w-4 h-4 accent-blue-500 rounded flex-shrink-0"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-xs px-1.5 py-0.5 rounded bg-gray-100 text-gray-500 flex-shrink-0">
                          {TASK_TYPE_LABELS[task.taskType] || '任务'}
                        </span>
                        <span className="text-sm text-gray-700 truncate">{task.taskContent || task.subject}</span>
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        <span className="text-xs text-gray-400">{task.subject}</span>
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-400">{task.estimatedMinutes}min</span>
                        <span className="text-xs text-gray-300">·</span>
                        <span className="text-xs text-gray-400">{planMap.get(task.planId) || ''}</span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* Content input */}
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <p className="font-medium text-gray-700 mb-2">今日打卡内容</p>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="记录今天的学习收获、遇到的困难或心情..."
              rows={4}
              className="w-full text-sm text-gray-700 placeholder-gray-300 resize-none focus:outline-none"
            />
          </div>

          {/* Image upload */}
          <div className="bg-white rounded-2xl p-4 shadow-sm">
            <p className="font-medium text-gray-700 mb-2">打卡图片（可选）</p>
            {imagePreview ? (
              <div className="relative">
                <img
                  src={imagePreview}
                  alt="打卡图片预览"
                  className="w-full h-40 object-cover rounded-xl border border-gray-200"
                />
                <button
                  onClick={removeImage}
                  className="absolute top-2 right-2 bg-black/50 text-white w-6 h-6 rounded-full text-sm flex items-center justify-center hover:bg-black/70 transition"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="w-full border-2 border-dashed border-gray-300 rounded-xl py-6 text-gray-400 text-sm hover:border-blue-400 hover:text-blue-400 transition"
              >
                📷 点击上传学习打卡图片
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              onChange={handleImageSelect}
              className="hidden"
            />
          </div>

          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="w-full bg-blue-500 disabled:bg-blue-300 text-white py-3 rounded-xl font-medium hover:bg-blue-600 transition"
          >
            {uploadingImage ? '上传图片中...' : submitting ? '提交中...' : '✅ 完成打卡'}
          </button>
        </>
      )}
    </div>
  )
}
