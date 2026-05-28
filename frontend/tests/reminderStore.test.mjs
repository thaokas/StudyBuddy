import assert from 'node:assert/strict'
import test from 'node:test'
import { loadSourceModule } from './loadModule.mjs'

test('queues realtime popup messages until each one is dismissed', async () => {
  const { useReminderStore } = await loadSourceModule('src/store/reminderStore.ts')
  const store = useReminderStore.getState()

  assert.equal(typeof store.enqueuePopup, 'function', 'popup messages must be queueable')
  assert.equal(typeof store.dismissPopup, 'function', 'popup messages must be dismissible')

  useReminderStore.setState({ popupQueue: [], unreadCount: 0 })
  store.enqueuePopup({ reminderId: 'R1', content: 'first', taskNames: ['数学 - 专项练习'], timestamp: 1 })
  store.enqueuePopup({ reminderId: 'R2', content: 'second', timestamp: 2 })

  assert.equal(useReminderStore.getState().popupQueue[0].reminderId, 'R1')
  assert.deepEqual(useReminderStore.getState().popupQueue[0].taskNames, ['数学 - 专项练习'])
  useReminderStore.getState().dismissPopup()
  assert.equal(useReminderStore.getState().popupQueue[0].reminderId, 'R2')
})
