import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function readSource(relativePath) {
  return readFile(path.join(frontendRoot, relativePath), 'utf8')
}

test('shared protected layout switches from mobile bottom nav to desktop sidebar at lg width', async () => {
  const source = await readSource('src/components/Layout.tsx')

  assert.match(source, /function MobileBottomNav/)
  assert.match(source, /function DesktopSidebar/)
  assert.match(source, /lg:hidden/)
  assert.match(source, /hidden lg:flex/)
  assert.match(source, /lg:pl-64/)
  assert.match(source, /max-w-md lg:max-w-none/)
  assert.doesNotMatch(source, /landscape:max-w-6xl/)
})

test('login and register remain public routes outside the protected responsive shell', async () => {
  const source = await readSource('src/app.tsx')

  const loginIndex = source.indexOf('<Route path="/login" element={<Login />} />')
  const registerIndex = source.indexOf('<Route path="/register" element={<Register />} />')
  const protectedIndex = source.indexOf('<ProtectedRoute>')

  assert.ok(loginIndex >= 0)
  assert.ok(registerIndex >= 0)
  assert.ok(protectedIndex >= 0)
  assert.ok(loginIndex < protectedIndex)
  assert.ok(registerIndex < protectedIndex)
})

test('plan creation page keeps mobile chat flow and adds desktop chat plus insights columns', async () => {
  const source = await readSource('src/pages/PlanCreate.tsx')

  assert.match(source, /lg:grid lg:grid-cols-\[minmax\(0,1fr\)_22rem\]/)
  assert.match(source, /lg:hidden/)
  assert.match(source, /hidden lg:block/)
  assert.match(source, /function PlannerInsightsPanel/)
  assert.match(source, /function ProfileSummaryCard/)
  assert.match(source, /function ReferenceSummaryCard/)
  assert.match(source, /function GenerationStatusCard/)
})

test('primary business pages expose lg responsive workspace markers', async () => {
  const files = {
    home: await readSource('src/pages/Home.tsx'),
    plans: await readSource('src/pages/Plans.tsx'),
    tasks: await readSource('src/pages/Tasks.tsx'),
    planDetail: await readSource('src/pages/PlanDetail.tsx'),
    checkin: await readSource('src/pages/Checkin.tsx'),
    reminders: await readSource('src/pages/Reminders.tsx'),
    report: await readSource('src/pages/Report.tsx'),
    profile: await readSource('src/pages/Profile.tsx'),
  }

  assert.match(files.home, /lg:grid lg:grid-cols-\[minmax\(0,1\.35fr\)_minmax\(20rem,0\.65fr\)\]/)
  assert.match(files.plans, /lg:grid lg:grid-cols-2 xl:grid-cols-3/)
  assert.match(files.tasks, /lg:grid lg:grid-cols-\[18rem_minmax\(0,1fr\)\]/)
  assert.match(files.planDetail, /lg:grid lg:grid-cols-\[minmax\(18rem,0\.8fr\)_minmax\(0,1\.2fr\)\]/)
  assert.match(files.checkin, /lg:grid lg:grid-cols-\[minmax\(0,0\.95fr\)_minmax\(0,1\.05fr\)\]/)
  assert.match(files.reminders, /lg:grid lg:grid-cols-\[minmax\(0,0\.9fr\)_minmax\(18rem,0\.7fr\)\]/)
  assert.match(files.report, /lg:grid lg:grid-cols-\[20rem_minmax\(0,1fr\)\]/)
  assert.match(files.profile, /lg:grid lg:grid-cols-\[minmax\(18rem,0\.8fr\)_minmax\(0,1\.2fr\)\]/)
})
