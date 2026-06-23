import { useEffect } from 'react'
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom'
import Layout from '@/components/Layout'
import Login from '@/pages/Login'
import Register from '@/pages/Register'
import Home from '@/pages/Home'
import Plans from '@/pages/Plans'
import PlanCreate from '@/pages/PlanCreate'
import PlanDetail from '@/pages/PlanDetail'
import Tasks from '@/pages/Tasks'
import Checkin from '@/pages/Checkin'
import Profile from '@/pages/Profile'
import Reminders from '@/pages/Reminders'
import Report from '@/pages/Report'
import { useReminderStore } from '@/store/reminderStore'

const ROUTES: Record<string, string> = {
  register: '/register',
  login: '/login',
  'home-dashboard': '/',
  'plan-create-chat': '/plans/create',
  'plan-list': '/plans',
  'plan-detail': '/plans/plan-408',
  'tasks-today': '/tasks',
  checkin: '/checkin',
  'checkin-success': '/checkin',
  'reminder-settings': '/reminders',
  'reminder-popup': '/reminders',
  'weekly-report': '/report',
  profile: '/profile',
}

export default function ManualScreenshotsApp({ scene }: { scene: string }) {
  const route = ROUTES[scene] || '/'

  return (
    <MemoryRouter initialEntries={[route]}>
      <ManualScenarioDriver scene={scene} />
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route element={<Layout />}>
          <Route path="/" element={<Home />} />
          <Route path="/plans" element={<Plans />} />
          <Route path="/plans/create" element={<PlanCreate />} />
          <Route path="/plans/:planId" element={<PlanDetail />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/checkin" element={<Checkin />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/reminders" element={<Reminders />} />
          <Route path="/report" element={<Report />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </MemoryRouter>
  )
}

function ManualScenarioDriver({ scene }: { scene: string }) {
  const enqueuePopup = useReminderStore((state) => state.enqueuePopup)
  const setUnreadCount = useReminderStore((state) => state.setUnreadCount)

  useEffect(() => {
    const observer = new MutationObserver(fixRootRelativeAssets)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] })
    fixRootRelativeAssets()
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (scene !== 'reminder-popup') return
    setUnreadCount(2)
    const timer = window.setTimeout(() => {
      enqueuePopup({
        reminderId: 'manual-popup',
        content:
          '现在是今日复盘时间。先完成高数定积分错题整理，再把英语阅读的长难句标出来。任务不用一下子全做完，先推进最小的一步。',
        taskNames: ['高等数学：定积分综合题 10 道', '英语：List 12 单词与阅读精读'],
        timestamp: Date.now(),
      })
    }, 120)
    return () => window.clearTimeout(timer)
  }, [enqueuePopup, scene, setUnreadCount])

  useEffect(() => {
    void runSceneAutomation(scene)
  }, [scene])

  return null
}

async function runSceneAutomation(scene: string) {
  if (scene === 'register') {
    await fillInputs([
      ['input[type="text"]', '张三'],
      ['input[type="email"]', 'zhangsan@example.com'],
      ['input[type="password"]', 'studybuddy123'],
    ])
  }

  if (scene === 'login') {
    await fillInputs([
      ['input[type="email"]', 'zhangsan@example.com'],
      ['input[type="password"]', 'studybuddy123'],
    ])
  }

  if (scene === 'plan-create-chat') {
    const textarea = await waitFor<HTMLTextAreaElement>('textarea[placeholder="输入你的备考需求..."]')
    setNativeValue(
      textarea,
      '我要参加 2026 年 12 月的研究生入学考试（计算机专业），每天能学 4-5 小时，数学基础较好但英语和计算机网络比较薄弱。',
    )
    await delay(80)
    const sendButton = textarea.parentElement?.querySelector<HTMLButtonElement>('button:last-of-type')
    sendButton?.click()
  }

  if (scene === 'checkin-success') {
    const textarea = await waitFor<HTMLTextAreaElement>('textarea[placeholder^="记录今天"]')
    setNativeValue(textarea, '今天完成了数据结构栈与队列、高数定积分错题，以及英语阅读精读。网络部分还需要再复盘一次。')
    await delay(80)
    findButton('完成打卡')?.click()
  }

  if (scene === 'weekly-report') {
    await waitFor('button')
    await delay(120)
    findButton('生成报告')?.click()
  }
}

async function fillInputs(pairs: Array<[string, string]>) {
  for (const [selector, value] of pairs) {
    const input = await waitFor<HTMLInputElement>(selector)
    setNativeValue(input, value)
  }
}

function fixRootRelativeAssets() {
  document.querySelectorAll<HTMLImageElement>('img[src^="/"]').forEach((image) => {
    const src = image.getAttribute('src')
    if (src?.startsWith('/')) {
      image.setAttribute('src', `..${src}`)
    }
  })
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent?.includes(text),
  )
}

function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function waitFor<T extends Element>(selector: string, timeout = 4000): Promise<T> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeout) {
    const element = document.querySelector<T>(selector)
    if (element) return element
    await delay(50)
  }
  throw new Error(`Manual screenshot element not found: ${selector}`)
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}
