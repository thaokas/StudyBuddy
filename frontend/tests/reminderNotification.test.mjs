import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSourceModule } from './loadModule.mjs'

test('system notifications request display until the user dismisses them', async () => {
  const reminderModule = await loadSourceModule('src/hooks/reminderPresentation.ts')
  assert.equal(
    typeof reminderModule.showBrowserNotification,
    'function',
    'browser-notification behavior must be independently verifiable'
  )

  const calls = []
  class NotificationStub {
    static permission = 'granted'

    constructor(title, options) {
      calls.push({ title, options })
    }
  }

  const originalWindow = globalThis.window
  const originalNotification = globalThis.Notification
  globalThis.window = { Notification: NotificationStub }
  globalThis.Notification = NotificationStub

  try {
    reminderModule.showBrowserNotification({
      reminderId: 'R1',
      content: 'read this reminder',
      timestamp: 1,
    })
  } finally {
    globalThis.window = originalWindow
    globalThis.Notification = originalNotification
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0].options.requireInteraction, true)
  assert.equal(calls[0].options.tag, 'R1')
})
