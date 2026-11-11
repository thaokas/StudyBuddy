/**
 * T03 route 3 evidence: read-only cost estimate for a second main column.
 *
 * Reads the pinned `ui-layout` files (no writes to the source tree), records
 * their current size, and writes the estimate used by `docs/decisions/layout.md`
 * to `probes/layout/evidence/route3.json`.
 *
 * Run: `node probes/layout/estimate-route3.mjs`
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROBE_ROOT = dirname(fileURLToPath(import.meta.url));
const SOURCE = fileURLToPath(new URL('../../source/deepseek-harness/', import.meta.url));
const EVIDENCE = join(PROBE_ROOT, 'evidence');

const FILES = [
  { path: 'packages/client/ui-layout/src/client/AppFrame.tsx', role: 'frame', added: 22 },
  { path: 'packages/client/ui-layout/src/client/AppFrame.module.css', role: 'frame styles', added: 8 },
  { path: 'packages/client/ui-layout/src/client/stores.ts', role: 'layout state', added: 10 },
  { path: 'packages/client/ui-layout/src/client/service.ts', role: 'ctx.layout face', added: 9 },
  { path: 'packages/client/ui-layout/src/client/index.ts', role: 'slot declaration', added: 13 },
  { path: 'packages/client/ui-layout/tests/app-frame.client.spec.tsx', role: 'frame tests', added: 75 },
  { path: 'packages/client/ui-layout/tests/layout-store.client.spec.ts', role: 'store tests', added: 20 },
  { path: 'packages/client/ui-layout/tests/apply.client.spec.ts', role: 'registration tests', added: 4 },
  { path: 'packages/client/ui-layout/README.md', role: 'English docs', added: 12 },
  { path: 'packages/client/ui-layout/README.zh.md', role: 'Chinese docs', added: 12 },
];

let sourceBytes = 0;
let sourceLines = 0;
const files = [];
for (const file of FILES) {
  const text = await readFile(join(SOURCE, file.path), 'utf8');
  const lines = text.split(/\r?\n/).length;
  sourceBytes += Buffer.byteLength(text);
  sourceLines += lines;
  files.push({ ...file, lines });
}

const sourceAdded = files
  .filter(f => !f.role.endsWith('tests') && !f.role.endsWith('docs'))
  .reduce((sum, f) => sum + f.added, 0);
const testsAdded = files.filter(f => f.role.endsWith('tests')).reduce((sum, f) => sum + f.added, 0);
const docsAdded = files.filter(f => f.role.endsWith('docs')).reduce((sum, f) => sum + f.added, 0);

const estimate = {
  task: 'T03',
  route: '3-minimal-core-patch',
  kind: 'read-only estimate',
  capturedAt: new Date().toISOString(),
  sourceTree: 'source/deepseek-harness (pinned 0.2.2-rc.1, not modified)',
  design: {
    summary: 'Add a root-scoped `studyleft` slot inside the existing center column; no fourth grid track and no columns.ts change.',
    defaultWidth: 560,
    hideRules: ['viewport < SIDEBAR_AUTO_COLLAPSE (1024)', 'center column < CENTER_MIN (400) + LEFTBAR_MIN (320)'],
    widthOwner: 'plugins/study registers the slot and persists its own width; AppFrame clamps and owns the drag handle.',
    noSession: 'The slot is rendered by AppFrame outside the session-bound `main` key, so it survives a blank session and global panels.',
    slotOwnerProps: ['width', 'viewportWidth', 'canShow'],
    newLayoutMethod: 'ctx.layout.setLeftmain(px)',
  },
  files,
  sourceTreeSize: { files: files.length, lines: sourceLines, bytes: sourceBytes },
  additions: {
    source: sourceAdded,
    tests: testsAdded,
    docs: docsAdded,
    agentNote: 25,
    patchArtifact: 210,
    total: sourceAdded + testsAdded + docsAdded + 25,
  },
  budget: { planCoreSourceLimit: 100, sourceWithinBudget: sourceAdded <= 100 },
  unchanged: {
    columnsTs: 'no change: the center keeps the existing three-column solve',
    localeKeys: 0,
    sessionFormat: 'no change',
    snapshots: 'no model-visible or session-format change; upstream test:web replay should not need re-recording',
  },
  checks: {
    tests: ['pnpm run test:gui', 'focused ui-layout vitest specs'],
    upgrade: 'Regenerate patches/0002-second-main-column.patch after a DSH upgrade; run pnpm run test:gui and git apply --check -R.',
    rollback: [
      'git -C source/deepseek-harness apply -R patches/0002-second-main-column.patch',
      'remove the 0002 row from patches/README.md and delete the patch file',
      'pnpm --filter @deepseek-ai/dsh-client-ui-layout bundle',
      'pnpm run build:artifacts',
    ],
    fallbackInStudyPlugin: 'If ctx.layout.setLeftmain is absent, use the route 1 right-sidebar tab.',
  },
  chosen: true,
  evidence: {
    route1: 'probes/layout/evidence/route1/route1.json',
    route2: 'probes/layout/evidence/route2/route2.json',
    decision: 'docs/decisions/layout.md',
  },
};

await mkdir(EVIDENCE, { recursive: true });
await writeFile(join(EVIDENCE, 'route3.json'), `${JSON.stringify(estimate, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  sourceAdded,
  testsAdded,
  docsAdded,
  sourceFiles: files.length,
  output: 'probes/layout/evidence/route3.json',
}, null, 2));
