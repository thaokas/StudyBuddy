import assert from 'node:assert/strict'
import test from 'node:test'
import { maybeLoadSourceModule } from './loadModule.mjs'

test('history expansion state toggles reminder entries independently', async () => {
  const stateModule = await maybeLoadSourceModule('src/pages/reminderHistoryState.ts')
  assert.equal(
    typeof stateModule?.toggleExpandedReminderIds,
    'function',
    'history must expose per-entry expansion behavior'
  )

  let expanded = stateModule.toggleExpandedReminderIds(new Set(), 'R1')
  expanded = stateModule.toggleExpandedReminderIds(expanded, 'R2')
  assert.equal(expanded.has('R1'), true)
  assert.equal(expanded.has('R2'), true)

  expanded = stateModule.toggleExpandedReminderIds(expanded, 'R1')
  assert.equal(expanded.has('R1'), false)
  assert.equal(expanded.has('R2'), true)
})

test('history deletion removes only the selected reminder entry', async () => {
  const stateModule = await maybeLoadSourceModule('src/pages/reminderHistoryState.ts')
  assert.equal(
    typeof stateModule?.removeReminderFromHistory,
    'function',
    'history must expose per-entry deletion state behavior'
  )

  const history = [
    { reminderId: 'R1', content: 'first' },
    { reminderId: 'R2', content: 'second' },
  ]
  const next = stateModule.removeReminderFromHistory(history, 'R1')

  assert.deepEqual(next.map((item) => item.reminderId), ['R2'])
})
