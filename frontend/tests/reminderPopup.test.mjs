import assert from 'node:assert/strict'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { maybeLoadSourceModule } from './loadModule.mjs'

test('persistent popup renders full reminder text and a manual close action', async () => {
  const popupModule = await maybeLoadSourceModule('src/components/ReminderPopup.tsx')
  assert.equal(typeof popupModule?.default, 'function', 'global reminder popup must exist')

  const markup = renderToStaticMarkup(
    React.createElement(popupModule.default, {
      popup: {
        reminderId: 'R1',
        content: 'full reminder details',
        taskNames: ['数学 - 专项练习'],
        timestamp: 1,
      },
      pendingCount: 2,
      notificationPermission: 'default',
      onDismiss: () => {},
      onEnableNotifications: () => {},
    })
  )

  assert.match(markup, /full reminder details/)
  assert.match(markup, /关联任务/)
  assert.match(markup, /数学 - 专项练习/)
  assert.match(markup, /关闭提醒/)
  assert.match(markup, /还有 1 条提醒/)
})
