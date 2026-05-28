import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { loadSourceModule, maybeLoadSourceModule } from './loadModule.mjs'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

test('custom repeating reminders submit one daily schedule with a UTC trigger instant', async () => {
  const formState = await maybeLoadSourceModule('src/pages/reminderFormState.ts')

  assert.ok(formState, 'expected reminder form payload helper to exist')

  const request = formState.buildCreateReminderRequest({
    planId: 'P1',
    scheduleType: 'REPEATING',
    taskIds: ['T1'],
    intervalMinutes: 30,
    triggerTime: '23:45',
    timezone: 'Asia/Shanghai',
    now: new Date('2026-05-27T01:00:00.000Z'),
  })

  assert.equal(request.scheduleType, 'REPEATING')
  assert.equal(request.repeatDaily, true)
  assert.equal(request.intervalMinutes, undefined)
  assert.deepEqual(request.taskIds, ['T1'])
  assert.match(request.triggerTime, /Z$/)
})

test('custom absolute reminders convert the selected local datetime to UTC before submission', async () => {
  const formState = await maybeLoadSourceModule('src/pages/reminderFormState.ts')

  assert.ok(formState, 'expected reminder form payload helper to exist')

  const request = formState.buildCreateReminderRequest({
    planId: 'P1',
    scheduleType: 'ABSOLUTE',
    taskIds: [],
    intervalMinutes: 30,
    triggerDate: '2026-06-01',
    triggerTime: '14:30',
    timezone: 'Asia/Shanghai',
    now: new Date('2026-05-27T01:00:00.000Z'),
  })

  assert.equal(request.scheduleType, 'ABSOLUTE')
  assert.equal(request.repeatDaily, undefined)
  assert.match(request.triggerTime, /Z$/)
})

test('realtime reminder delivery is idempotent and creates one refresh revision', async () => {
  const { useReminderStore } = await loadSourceModule('src/store/reminderStore.ts')
  const message = { reminderId: 'R1', content: '开始学习', timestamp: 1 }

  useReminderStore.setState({
    unreadCount: 9,
    popupQueue: [],
    presentedReminderIds: [],
    realtimeRevision: 0,
  })

  assert.equal(useReminderStore.getState().acceptRealtimeReminder(message), true)
  assert.equal(useReminderStore.getState().acceptRealtimeReminder(message), false)
  assert.equal(useReminderStore.getState().realtimeRevision, 1)

  useReminderStore.getState().setUnreadCount(2)
  assert.equal(useReminderStore.getState().unreadCount, 2)
})

test('websocket popup messages preserve associated task names from the backend', async () => {
  const hook = await readFile(path.join(frontendRoot, 'src/hooks/useReminderWebSocket.ts'), 'utf8')

  assert.match(hook, /taskNames:\s*msg\.taskNames/)
})

test('browser tabs share one persisted claim for each realtime reminder', async () => {
  const claims = await maybeLoadSourceModule('src/hooks/reminderRealtimeClaim.ts')
  assert.ok(claims, 'expected a shared realtime presentation claim helper to exist')
  const hook = await readFile(path.join(frontendRoot, 'src/hooks/useReminderWebSocket.ts'), 'utf8')

  const memory = new Map()
  const storage = {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => memory.set(key, value),
  }

  assert.equal(claims.claimStoredReminderPresentation('R1', storage, 1000), true)
  assert.equal(claims.claimStoredReminderPresentation('R1', storage, 1001), false)
  assert.equal(claims.claimStoredReminderPresentation('R2', storage, 1002), true)
  assert.match(hook, /claimRealtimePresentation\(popupMessage\.reminderId\)/)
})

test('realtime presentation chooses exactly one immediate channel', async () => {
  const notification = await loadSourceModule('src/hooks/reminderPresentation.ts')

  assert.equal(notification.getRealtimePresentationChannel('granted'), 'notification')
  assert.equal(notification.getRealtimePresentationChannel('default'), 'popup')
  assert.equal(notification.getRealtimePresentationChannel('unsupported'), 'popup')
})

test('layout initializes unread totals from the server snapshot', async () => {
  const layout = await readFile(path.join(frontendRoot, 'src/components/Layout.tsx'), 'utf8')

  assert.match(layout, /reminderApi\.getUnread\(\)/)
  assert.match(layout, /setUnreadCount/)
})
