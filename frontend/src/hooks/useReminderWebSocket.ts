import { useEffect, useRef, useCallback } from 'react'
import { reminderApi } from '@/api'
import { useReminderStore, type ReminderPopupMessage } from '@/store/reminderStore'
import {
  getRealtimePresentationChannel,
  showBrowserNotification,
} from '@/hooks/reminderPresentation'
import { claimRealtimePresentation } from '@/hooks/reminderRealtimeClaim'

interface ReminderMessage extends ReminderPopupMessage {
  type: 'reminder'
  taskNames: string[]
}

export function useReminderWebSocket() {
  const wsRef = useRef<WebSocket | null>(null)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const reconnectDelayRef = useRef(1000)
  const activeRef = useRef(false)
  const acceptRealtimeReminder = useReminderStore((s) => s.acceptRealtimeReminder)
  const enqueuePopup = useReminderStore((s) => s.enqueuePopup)
  const setUnreadCount = useReminderStore((s) => s.setUnreadCount)

  const refreshUnreadCount = useCallback(async () => {
    try {
      const response = await reminderApi.getUnread()
      setUnreadCount(response.data.data.length)
    } catch {
      // 保留最后一次成功的服务端快照
    }
  }, [setUnreadCount])

  const connect = useCallback(() => {
    const token = localStorage.getItem('accessToken')
    if (!token) return
    if (wsRef.current) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const host = window.location.host
    const url = `${protocol}//${host}/ws?token=${token}`

    const ws = new WebSocket(url)
    wsRef.current = ws

    ws.onopen = () => {
      console.log('[WS] 提醒推送已连接')
      reconnectDelayRef.current = 1000
    }

    ws.onmessage = async (event) => {
      try {
        const msg: ReminderMessage = JSON.parse(event.data)
        if (msg.type === 'reminder') {
          const popupMessage = {
            reminderId: msg.reminderId,
            content: msg.content,
            taskNames: msg.taskNames,
            timestamp: msg.timestamp,
          }
          if (!acceptRealtimeReminder(popupMessage)) return
          void refreshUnreadCount()
          if (!(await claimRealtimePresentation(popupMessage.reminderId))) return
          if (getRealtimePresentationChannel(
            'Notification' in window ? Notification.permission : 'unsupported'
          ) === 'notification') {
            showBrowserNotification(popupMessage)
          } else {
            enqueuePopup(popupMessage)
          }
        }
      } catch {
        // 忽略解析错误
      }
    }

    ws.onclose = (e) => {
      console.log('[WS] 连接关闭:', e.code, e.reason)
      if (wsRef.current !== ws) return
      wsRef.current = null
      if (activeRef.current && e.code !== 1000) {
        scheduleReconnect()
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [acceptRealtimeReminder, enqueuePopup, refreshUnreadCount])

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) return
    const delay = reconnectDelayRef.current
    reconnectDelayRef.current = Math.min(delay * 2, 30_000)
    console.log(`[WS] ${delay / 1000}s 后重连...`)
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = undefined
      connect()
    }, delay)
  }, [connect])

  useEffect(() => {
    activeRef.current = true
    connect()
    return () => {
      activeRef.current = false
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = undefined
      }
      if (wsRef.current) {
        const current = wsRef.current
        wsRef.current = null
        current.close(1000)
      }
    }
  }, [connect])
}
