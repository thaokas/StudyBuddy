# Allowed placements

A personalized page is installed into the StudyBuddy profile. The profile runs
the DSH Web shell plus the StudyBuddy plugin, so use an existing DSH slot and
keep the StudyBuddy chrome intact.

## Allowed locations

| Card location | Where it renders | Register |
| --- | --- | --- |
| `page` (Session tab) | A tab beside Chat and Trajectory in the current Session. | `ctx.slots.inject('conversation.view', …)` |
| `sidebar-left` (global page) | A main-area page opened from a left-sidebar entry. | `ctx.slots.inject('main', …)` and `ctx.slots.inject('sidebar.panellist', …)` |
| `sidebar-right` (right sidebar) | A viewer beside the conversation on wide windows. | `ctx.slots.inject('sidebar.right.pane.tab', …)` and `ctx.slots.inject('sidebar.right.pane.tab.title', …)` plus `ctx.sidebarRightTabs.register` |
| A written custom location | Whatever the user wrote, resolved with the same DSH slots. | Inspect the named slot first; refuse if it does not exist. |

Use `page` for a list or chart that belongs to one conversation's task context.
Use `sidebar-left` for a record the student must reopen across conversations.
Use `sidebar-right` only when the content must stay visible while chatting; the
StudyBuddy window can be narrow, so a right-sidebar page must still work around
280–400px wide.

## Never use

- The StudyBuddy workbench page or its compact display, its
  `study.workbench.*` / `study.layout.*` storage, or any StudyBuddy page key
  outside your own package prefix. The workbench is owned by the study plugin;
  its compact display already serves the at-a-glance role.
- A new app frame, a replacement `#root`, an `<iframe>`, or a standalone HTML
  file. The page must be a registered slot contribution in the running shell.
- A second permanent study column or a change to the conversation/Session
  header.
- `sidebar.panellist` without a matching `main` page, or a launcher whose page
  is not registered. The launcher and its target are two registrations; both
  must appear and both must be removed on unload.

## Minimum shape

A single-file browser plugin uses the module-loader form. `package.json` must
declare `dsh.client.platform: "web"`, export a built `./client` file, and its
bundle patch may insert only rows whose ids start with the package name:

```json
{
  "name": "@dsh-local/view-<id>",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./index.js", "./client": "./client.js" },
  "files": ["index.js", "client.js", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" }
  }
}
```

```js
window.__ModuleLoader__.load({
  id: '@dsh-local/view-<id>',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Page() {
      return h('main', { style: { padding: 24 } }, '学习清单');
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view', id: 'study-list', order: 20, label: '学习清单',
        }, Page));
      },
    };
  },
});
```

The tab body receives Session props (`sessionId`, `useSession`, …). Use the
Session binding for Session-scoped data and never show another Session's data
after a switch. For a global page, register `main` with a unique `key` and the
matching `sidebar.panellist` entry with the same id, and let the shell's layout
service select the panel (do not call `document` or navigate the whole window).

## Teardown

`ctx.slots.inject` returns a disposer and removes the contribution when the
declaration disappears. Use `ctx.effect` for timers, listeners and locale
registrations. On unload the removed plugin must disappear; an unrelated tab or
sidebar entry must remain usable.
