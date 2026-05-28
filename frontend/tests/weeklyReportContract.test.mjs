import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(frontendRoot, '..')

test('weekly report keeps the ApiResponse envelope expected by the page', async () => {
  const controller = await readFile(
    path.join(repoRoot, 'backend/src/main/java/com/prepkeeper/controller/AgentProxyController.java'),
    'utf8',
  )
  const agentApi = await readFile(path.join(frontendRoot, 'src/api/agent.ts'), 'utf8')
  const reportPage = await readFile(path.join(frontendRoot, 'src/pages/Report.tsx'), 'utf8')

  assert.match(controller, /import com\.prepkeeper\.dto\.response\.ApiResponse;/)
  assert.match(controller, /ResponseEntity<ApiResponse<Map<String, Object>>> generateWeeklyReport/)
  assert.match(controller, /return ResponseEntity\.ok\(ApiResponse\.success\(response\)\);/)
  assert.match(agentApi, /client\.post<ApiResponse<WeeklyReportResponse>>\('\/agent\/report\/weekly', data\)/)
  assert.match(reportPage, /setReport\(res\.data\.data\)/)
})
