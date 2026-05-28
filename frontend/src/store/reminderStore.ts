import { create } from 'zustand'

export interface ReminderPopupMessage {
  reminderId: string
  content: string
  taskNames?: string[]
  timestamp: number
}

interface ReminderState {
  unreadCount: number
  popupQueue: ReminderPopupMessage[]
  presentedReminderIds: string[]
  realtimeRevision: number
  setUnreadCount: (n: number) => void
  acceptRealtimeReminder: (message: ReminderPopupMessage) => boolean
  enqueuePopup: (message: ReminderPopupMessage) => void
  dismissPopup: () => void
}

export const useReminderStore = create<ReminderState>((set, get) => ({
  unreadCount: 0,
  popupQueue: [],
  presentedReminderIds: [],
  realtimeRevision: 0,

  setUnreadCount: (n) => set({ unreadCount: n }),

  acceptRealtimeReminder: (message) => {
    if (get().presentedReminderIds.includes(message.reminderId)) {
      return false
    }
    set((s) => ({
      presentedReminderIds: [...s.presentedReminderIds, message.reminderId],
      realtimeRevision: s.realtimeRevision + 1,
    }))
    return true
  },

  enqueuePopup: (message) =>
    set((s) => ({
      popupQueue: s.popupQueue.some((popup) => popup.reminderId === message.reminderId)
        ? s.popupQueue
        : [...s.popupQueue, message],
    })),

  dismissPopup: () => set((s) => ({ popupQueue: s.popupQueue.slice(1) })),
}))
