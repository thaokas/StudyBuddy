---
name: study-creator
description: StudyBuddy page rules for Creator mode. Use with personalized-pages when building, changing, or reviewing a StudyBuddy page plugin: allowed page locations, reading learning data only through the study service, and the install/restart/undo checks.
---

# StudyBuddy page rules

Use this reference only inside Creator mode, after the `personalized-pages`
skill has planned a page and the user accepted it. It adds StudyBuddy-specific
placement and data rules to `cordis-plugin-development`; it does not replace
that procedure or the location reference the card handed over.

Read these two files relative to this skill's base directory before writing a
package:

- `references/locations.md` — allowed placements, slots, and layout ownership.
- `references/data.md` — `ctx.study` and `/api/study/…` examples, the data
  boundary, and which calls a generated page may make.

## Non-negotiables

1. **Keep every read and write in the study service.** The browser half calls
   `POST /api/study/<namespace>/<method>` with the page cookie; a Host half uses
   `ctx.study.call(namespace, method, payload, { actor: 'agent' })`. Never open
   `study.db`, `study.db-wal`, `memory.json`, `credentials.dpapi`, session log
   files, `request_log`, or any other file under the data root. Never copy a
   learning fact into the plugin's own storage when the service already owns it.
2. **Use an allowed placement.** A generated page may take a Session tab, a
   global page reached from the left sidebar, or a right-sidebar viewer. Do not
   take over the StudyBuddy workbench page or its compact display, replace the
   app frame, add an iframe or a second HTML root, or edit the study plugin.
3. **Read before you write.** A page that only displays existing learning data
   must call only read methods. Do not add writing controls unless the accepted
   brief explicitly asked for them; a write needs `requestId` (and
   `expectedRevision` when the page read one) exactly as `references/data.md`
   shows.
4. **Stay removable.** Register every slot, locale entry, timer and subscription
   through `ctx.effect` or the registration disposer, and remove only this
   plugin's UI on unload. Leave Chat, Trajectory and existing StudyBuddy pages
   untouched.
5. **Do not install yourself.** Generate and build the package inside the
   assigned directory, then finish with `structured_output {"ready": true}`.
   The caller validates and installs it. If the placement or the data meaning is
   impossible to implement faithfully, finish with `{"ready": false}` and say
   what is missing; never substitute another placement silently.
