/**
 * Frontend performance benchmarks.
 * Tests: SSE parsing, state store ops, JSON serialization, reminder dedup logic.
 * Run: node tests/performance.test.mjs
 */
import { bench, group, summary } from './benchHelper.mjs';

// ─── 1. SSE Frame Parsing (simulating handleFrame in agent.ts) ───

function parseSSEFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) {
      event = line.slice(6).trim() || 'message';
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return null;
  try {
    const data = JSON.parse(dataLines.join('\n'));
    if (event === 'done') return { type: 'done' };
    if (event === 'error') return { type: 'error', message: data.message };
    return { type: event, data };
  } catch {
    return null;
  }
}

// Build test frames
const tinyFrame = 'event:message\ndata:{"ok":true}\n\n';
const typicalFrame = 'event:plan_update\ndata:' + JSON.stringify({
  phase: 'generate_plan',
  tasks: Array.from({ length: 7 }, (_, i) => ({
    day: i + 1, subject: '数学', content: `完成第${i + 1}章练习题`
  })),
  progress: 0.65,
}) + '\n\n';
const largeFrame = 'event:plan_complete\ndata:' + JSON.stringify({
  plan_id: 'plan-001',
  tasks: (() => {
    const tasks = [];
    for (let d = 1; d <= 90; d++) {
      for (const [s, m] of [['数学', 60], ['英语', 30], ['政治', 45]]) {
        tasks.push({ day: d, subject: s, content: `第${d}天${s}学习任务`, estimated_minutes: m });
      }
    }
    return tasks;
  })(),
}) + '\n\n';

// Buffer with 50 frames (simulates streaming chunk)
const fiftyFrameBuffer = Array(50).fill(tinyFrame).join('');

console.log('--- 1. SSE Frame Parsing ---');
group('SSE Frame Parsing', () => {
  bench('parse tiny frame', () => parseSSEFrame(tinyFrame), 50000);
  bench('parse typical frame (7 tasks)', () => parseSSEFrame(typicalFrame), 20000);
  bench('parse large frame (270 tasks)', () => parseSSEFrame(largeFrame), 2000);

  // Simulate buffer splitting and parsing
  bench('split buffer 50 frames + parse 10', () => {
    const frames = fiftyFrameBuffer.split(/\r?\n\r?\n/);
    for (let i = 0; i < Math.min(10, frames.length); i++) {
      parseSSEFrame(frames[i] + '\n\n');
    }
  }, 2000);
});

// ─── 2. JSON Operations ───

const smallPayload = {
  user_id: 'user-001',
  plan_id: 'plan-001',
  mode: 2,
  today_total_tasks: Array.from({ length: 5 }, () => ({
    subject: '数学', name: '第三章习题', estimated_minutes: 60
  })),
  today_incomplete_tasks: Array.from({ length: 3 }, () => ({
    subject: '数学', name: '第三章习题', estimated_minutes: 60
  })),
};
const smallJson = JSON.stringify(smallPayload);

const largePayload = {
  plan_id: 'plan-001',
  tasks: (() => {
    const tasks = [];
    for (let d = 1; d <= 90; d++) {
      for (const [s, m] of [['数学', 60], ['英语', 30], ['政治', 45]]) {
        tasks.push({ day: d, subject: s, content: `第${d}天${s}学习`, estimated_minutes: m });
      }
    }
    return tasks;
  })(),
};
const largeJson = JSON.stringify(largePayload);

console.log('\n--- 2. JSON Serialization ---');
group('JSON Operations', () => {
  bench('JSON.stringify (small ~500B)', () => JSON.stringify(smallPayload), 50000);
  bench('JSON.parse (small ~500B)', () => JSON.parse(smallJson), 50000);
  bench('JSON.stringify (large ~80KB)', () => JSON.stringify(largePayload), 2000);
  bench('JSON.parse (large ~80KB)', () => JSON.parse(largeJson), 2000);
});

// ─── 3. Reminder Store Operations ───

// Simulate Zustand-style store operations
function createMockStore(initial) {
  let state = { ...initial };
  return {
    getState: () => state,
    setState: (update) => {
      if (typeof update === 'function') {
        state = { ...state, ...update(state) };
      } else {
        state = { ...state, ...update };
      }
    },
  };
}

// Simulate reminder dedup logic (from reminderStore.ts)
class ReminderDedupSet {
  constructor(maxSize = 500) {
    this.ids = new Set();
    this.maxSize = maxSize;
  }
  has(id) { return this.ids.has(id); }
  add(id) {
    if (this.ids.size >= this.maxSize) {
      // Evict oldest (simplified: just clear half)
      const entries = [...this.ids];
      this.ids = new Set(entries.slice(entries.length / 2));
    }
    this.ids.add(id);
  }
}

console.log('\n--- 3. Reminder Store Operations ---');
group('Reminder Store', () => {
  const store = createMockStore({
    reminders: [],
    presentedReminderIds: [],
    unreadCount: 0,
  });

  bench('setState (simple merge)', () => {
    store.setState({ unreadCount: store.getState().unreadCount + 1 });
  }, 100000);

  bench('push reminder to array (100 items)', () => {
    const s = store.getState();
    s.reminders = [...s.reminders, { id: 'rem-' + Date.now(), content: 'test' }].slice(-100);
  }, 50000);

  // Dedup set operations
  const dedup = new ReminderDedupSet();
  const testIds = Array.from({ length: 500 }, (_, i) => `rem-${i}`);

  bench('Set.has (hit)', () => {
    dedup.ids.has('rem-250');
  }, 200000);

  bench('Set.has (miss)', () => {
    dedup.ids.has('rem-999');
  }, 200000);

  bench('Set.add (with size check)', () => {
    dedup.add(`rem-${Math.floor(Math.random() * 1000)}`);
  }, 100000);

  // Bulk dedup check (simulating incoming reminders)
  bench('dedup check 10 incoming reminders', () => {
    const incoming = Array.from({ length: 10 }, (_, i) => `rem-new-${i}`);
    for (const id of incoming) {
      if (!dedup.ids.has(id)) {
        dedup.ids.add(id);
      }
    }
  }, 20000);
});

// ─── 4. Auth Token Interceptor Logic ───

console.log('\n--- 4. Auth Token Operations ---');
group('Auth Token', () => {
  const token = 'eyJhbGciOiJIUzI1NiJ9.' + 'x'.repeat(200) + '.sig';

  bench('localStorage.getItem', () => {
    return 'mock-token-value';
  }, 200000);

  bench('String.startsWith (Bearer check)', () => {
    return token.startsWith('eyJ');
  }, 200000);

  bench('JWT expiry check (regex + Date)', () => {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      const expired = payload.exp * 1000 < Date.now();
    } catch { /* ignore */ }
  }, 50000);
});

// ─── 5. Array Operations (Task Lists) ───

console.log('\n--- 5. Task Array Operations ---');
group('Task Array Operations', () => {
  const tasks = Array.from({ length: 200 }, (_, i) => ({
    task_id: `task-${i + 1}`,
    subject: ['数学', '英语', '政治'][i % 3],
    task_content: `学习任务${i + 1}`,
    status: [0, 1, 2, 3][i % 4],
    estimated_minutes: 30 + (i % 4) * 15,
  }));

  bench('filter by status (200 items)', () => {
    return tasks.filter(t => t.status !== 3);
  }, 10000);

  bench('filter + map (200 items)', () => {
    return tasks
      .filter(t => t.status !== 3)
      .map(t => ({ id: t.task_id, subject: t.subject, name: t.task_content }));
  }, 10000);

  bench('reduce for stats (200 items)', () => {
    return tasks.reduce((acc, t) => {
      acc.totalMinutes += t.estimated_minutes;
      if (t.status === 2) acc.completedMinutes += t.estimated_minutes;
      return acc;
    }, { totalMinutes: 0, completedMinutes: 0 });
  }, 10000);

  bench('sort by date (200 items)', () => {
    return [...tasks].sort((a, b) => a.task_id.localeCompare(b.task_id));
  }, 5000);

  bench('find by id (200 items)', () => {
    return tasks.find(t => t.task_id === 'task-150');
  }, 50000);
});

// ─── 6. Build & Bundle Size ───

// These are measured separately via npm run build

// ─── Print summary ───
console.log('\n' + '='.repeat(80));
summary();
console.log('='.repeat(80));
