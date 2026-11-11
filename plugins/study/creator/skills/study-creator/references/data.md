# Reading and writing learning data

StudyBuddy owns the learning facts. A generated page is a client of the study
service, not a second store. There are exactly two entry points.

## Browser half: `POST /api/study/<namespace>/<method>`

Same-origin `fetch` with the page's own cookie is authenticated by the running
Host; do not read a token from the URL or localStorage. The body is a JSON
object optionally carrying `requestId` and `expectedRevision`. Success is
`{ ok: true, value, revision }`; failure is
`{ ok: false, code, message, details }` with `code ∈ {invalid, conflict,
not_found, unavailable}`. A `conflict` can carry the latest revision, so show the
message and let the student retry; do not silently reload over their input.

```js
async function studyCall(namespace, method, payload = {}) {
  const response = await fetch(`/api/study/${namespace}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const envelope = await response.json();
  if (envelope?.ok === true) return envelope; // { ok, value, revision }
  const error = new Error(typeof envelope?.message === 'string' ? envelope.message : `HTTP ${response.status}`);
  error.code = typeof envelope?.code === 'string' ? envelope.code : 'malformed';
  throw error;
}
```

```js
const { value: day } = await studyCall('tasks', 'day', {});
// day.date, day.blocks (fixed/弹性/关联任务), day.tasks, day.summary
```

Show loading, empty, error and success states. Preserve `value` fields exactly
(do not re-derive task completion from `blocks`; use the progress records the
service returns).

## Host half: `ctx.study.call(namespace, method, payload, options)`

A generated Host plugin may declare `inject: ['study']` when the page needs
data that the browser cannot reach directly (for example, it must combine
several namespaces before responding). Prefer the browser route when one call
is enough.

```js
export const inject = ['study'];

export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/study-page/today',
    methods: ['GET'],
    fetch: async () => {
      const result = await ctx.study.call('tasks', 'day', {}, { actor: 'agent' });
      if (result.ok !== true) {
        return Response.json({ ok: false, code: result.code, message: result.message }, { status: 503 });
      }
      return Response.json({ ok: true, value: result.value, revision: result.revision });
    },
  }), 'study-page: today route');
}
```

`ctx.connection` exists only on the Web/Desktop profile. If it is absent, do not
invent a fallback; report the page as unavailable rather than reading a file.
`actor` is `'ui'` for a page's own reads and writes and `'agent'` for the Host
plugin acting for the model; do not claim `'system'`.

## Read methods that need no extra permission

| Namespace | Methods |
| --- | --- |
| `kernel` | `status` |
| `tasks` | `getTask`, `listTasks`, `progress`, `day`, `week` |
| `plans` | `list`, `get`, `revisions`, `today`, `week`, `progress` |
| `materials` | `list`, `get`, `outline`, `chunks`, `search`, `locate`, `getGoal`, `listGoals` |
| `outcomes` | `day`, `week`, `month` |
| `followup` | `due`, `getSettings`, `reviewStatus` |
| `timer` | `status` |
| `memory` | `recall` (the only read; `remember` and `forget` are writes) |

`tasks.listTasks` accepts status/subject filters; `materials.search` is lexical
(Chinese bigrams, ASCII words) and returns `chunks` with `page`/`chapter` only
when the source proves them. Do not fill a missing page number or invent a
citation.

## Writes

A page may write only when the accepted brief asked for it. Send a fresh
`requestId` per user action and the `revision` the page was rendered from as
`expectedRevision`; on `conflict`, show the service message and let the student
retry with the new revision instead of overwriting.

```js
await studyCall('tasks', 'recordProgress', {
  taskId, status: 'done', confirmed: true,
  requestId: crypto.randomUUID(), expectedRevision: revision,
});
```

Do not write `study_task` rows, `change_log`, `day_snapshot`, or the plan
revision tables directly. Do not set `day_snapshot`, do not backdate a progress
record, and do not turn "not recorded" into "not started".

## Boundary

Never open, copy, hash, or parse these paths from a generated plugin:

- `study/study.db`, `study.db-wal`, `study.db-shm`, `study/memory.json`
- `home/credentials.dpapi`, `home/profiles/**`, session logs, `request_log`
- any file under the data root, even read-only

Never print a Key, cookie, token or credentials document into the page, logs or
a generated file. The page is not a sandbox: installed plugins run with the
Creator's existing permissions, so a page that would need broader access must
finish with `structured_output {"ready": false}` and say what access is missing.
